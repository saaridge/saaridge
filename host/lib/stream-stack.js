/**
 * Workspace desktop stream (Xvfb → x11vnc → websockify → host :6081).
 * Retail boot must verify RFB liveness — HTML on :6081 can be up while :5900 is dead.
 *
 * Health checks must never hang on FUSE: use bash -c (not -lc), bound docker
 * timeouts, and prefer a host-side RFB-over-websockify probe (no container STAT).
 */
import net from "node:net";
import crypto from "node:crypto";
import { dockerExec, dockerCp } from "./docker.js";
import { CONTAINER_NAME, ROOT } from "./paths.js";
import { logError, logStep } from "./logger.js";
import path from "node:path";

const NOVNC_HTTP = process.env.SAARIDGE_NOVNC_URL || "http://127.0.0.1:6081";
const NOVNC_HOST = process.env.SAARIDGE_NOVNC_HOST || "127.0.0.1";
const NOVNC_WS_PORT = Number(process.env.SAARIDGE_NOVNC_WS_PORT || 6081);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hostStreamUsable = (h) =>
  Boolean(h?.novncHttp && h?.hostWsPort && h?.hostRfb);

const probeTcp = (host, port, timeoutMs = 1500) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      try {
        socket.destroy();
      } catch (_) {}
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    socket.on("connect", () => {
      clearTimeout(t);
      done(true);
    });
    socket.on("error", () => {
      clearTimeout(t);
      done(false);
    });
  });

const probeHttp = async (url, timeoutMs = 2000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
};

/**
 * Desktop app connects via websockify on :6081. Probing RFB here proves the
 * user-visible stream without docker exec (which can hang on FUSE/login shells).
 */
export const probeRfbViaWebsockify = (
  host = NOVNC_HOST,
  port = NOVNC_WS_PORT,
  timeoutMs = 2500,
) =>
  new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.connect({ host, port });
    let settled = false;
    let buf = Buffer.alloc(0);
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (_) {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("error", () => done(false));
    socket.on("connect", () => {
      socket.write(
        `GET /websockify HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Protocol: binary\r\n` +
          `\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = buf.subarray(0, sep).toString("latin1");
      if (!/^HTTP\/1\.\d 101/i.test(header.split("\r\n", 1)[0] || "")) {
        done(false);
        return;
      }
      const body = buf.subarray(sep + 4);
      // Binary WS frame payload includes ASCII "RFB …\n"
      if (body.toString("latin1").includes("RFB ")) {
        done(true);
      }
    });
  });

/** Inside-container checks: Xvfb, :5900 RFB banner, :6080 listen. */
export const inspectStreamInsideContainer = async () => {
  // Use bash -c (not -lc): login shells source /etc/profile.d/saaridge.sh →
  // agent-env.sh which STATs /host (FUSE) and can hang forever when hostfs is wedged.
  const res = await dockerExec(
    [
      "bash",
      "-c",
      `
XVFB=0; RFB=0; WS=0
for pid in $(pgrep -x Xvfb || true); do
  st=$(ps -o state= -p "\$pid" 2>/dev/null | tr -d ' ')
  if [ -n "\$st" ] && [ "\$st" != "Z" ]; then XVFB=1; break; fi
done
ss -lnt 2>/dev/null | grep -q ':6080 ' && WS=1 || true
if python3 - <<'PY'
import socket, sys
try:
    s = socket.create_connection(("127.0.0.1", 5900), 2)
    s.settimeout(2)
    b = s.recv(12)
    s.close()
    sys.exit(0 if b.startswith(b"RFB ") else 1)
except Exception:
    sys.exit(1)
PY
then RFB=1; else RFB=0; fi
# pgrep -fc prints 0 AND exits 1, so '|| echo 0' used to emit a second line ("0"),
# which the parser read as the status line. wc -l keeps this to exactly one value.
# [s] keeps pgrep from matching this inspect shell's own command line.
FUSE=$(pgrep -f '(/opt/bridge/[s]aaridge-hostfs|python3.*hostfs-fuse[.]py)' 2>/dev/null | wc -l | tr -d ' ')
echo "XVFB=\$XVFB RFB=\$RFB WS=\$WS FUSE=\$FUSE"
`.trim(),
    ],
    { timeoutMs: 10000 },
  );
  const lines = (res.stdout || "").trim().split("\n").filter(Boolean);
  const line =
    lines.find((l) => /^XVFB=/.test(l)) || lines.at(-1) || "";
  const xvfb = /XVFB=1/.test(line);
  const rfb = /RFB=1/.test(line);
  const websockify = /WS=1/.test(line);
  const fuseMatch = line.match(/FUSE=(\d+)/);
  const fuseCount = fuseMatch ? Number(fuseMatch[1]) : 0;
  return {
    ok: xvfb && rfb && websockify,
    xvfb,
    rfb,
    websockify,
    fuseCount,
    detail: line || (res.stderr || "").trim() || `exit ${res.code}`,
  };
};

export const getStreamHealth = async () => {
  // Host-side probes first — enough to know the Electron viewer can connect.
  const [novncHttp, hostWsPort, hostRfb] = await Promise.all([
    probeHttp(`${NOVNC_HTTP}/novnc-saaridge.html`),
    probeTcp(NOVNC_HOST, NOVNC_WS_PORT),
    probeRfbViaWebsockify(),
  ]);

  let inside = {
    ok: false,
    xvfb: false,
    rfb: false,
    websockify: false,
    fuseCount: 0,
    detail: "inside-inspect-skipped",
  };
  try {
    inside = await inspectStreamInsideContainer();
  } catch (err) {
    inside = {
      ok: false,
      xvfb: false,
      rfb: false,
      websockify: false,
      fuseCount: 0,
      detail: `inside-inspect-error: ${err?.message || err}`,
    };
  }

  // Usable stream = noVNC page + WS port + (host RFB banner OR full inside stack).
  const streamOk = Boolean(novncHttp && hostWsPort && (hostRfb || inside.ok));
  // Do not `...inside` before `ok` — inside.ok is stricter and would clobber streamOk
  // when host RFB-over-websockify is live but in-container inspect is flaky (XVFB=0).
  const { ok: _insideOk, ...insideDetail } = inside;
  return {
    novncHttp,
    hostWsPort,
    hostRfb,
    ...insideDetail,
    ok: streamOk,
  };
};

// Repair can run before (or long after) the startup copy, so push the current
// script instead of trusting whatever the image or a previous boot left behind.
const syncHostfsRestart = async () => {
  for (const file of ["hostfs-restart.sh", "hostfs-watchdog.sh"]) {
    await dockerCp(
      path.join(ROOT, "container", file),
      `${CONTAINER_NAME}:/opt/bridge/${file}`,
    );
  }
  await dockerExec(
    ["bash", "-c", "chmod 755 /opt/bridge/hostfs-restart.sh /opt/bridge/hostfs-watchdog.sh"],
    { timeoutMs: 5000 },
  );
};

const syncFixScript = async () => {
  await dockerCp(
    path.join(ROOT, "container", "fix-vnc-stack.py"),
    `${CONTAINER_NAME}:/opt/bridge/fix-vnc-stack.py`,
  );
  await dockerExec(
    ["bash", "-c", "chmod 755 /opt/bridge/fix-vnc-stack.py"],
    { timeoutMs: 5000 },
  );
};

/**
 * Make the desktop stream usable. Safe to call on every app load.
 * @param {{ force?: boolean }} [opts]
 */
export const ensureStreamStack = async (opts = {}) => {
  const force = Boolean(opts.force);
  const before = await getStreamHealth();
  if (before.ok && !force) {
    logStep("Desktop stream already healthy");
    return { ok: true, repaired: false, health: before };
  }

  // Killing x11vnc/websockify drops the viewer's live WebSocket and blanks the
  // desktop. An end-to-end RFB banner through :6081 proves the stack works, so a
  // flaky in-container inspect must never trigger a restart on its own.
  if (!force && hostStreamUsable(before)) {
    logStep("Desktop stream usable (host RFB live) — skipping restart", {
      detail: before.detail,
    });
    return { ok: true, repaired: false, health: { ...before, ok: true } };
  }

  // In-container inspect can disagree while host RFB-over-websockify is live.
  if (
    !hostStreamUsable(before) &&
    /XVFB=0/.test(before.detail || "") &&
    before.xvfb === false
  ) {
    const detail =
      "Display server (Xvfb) is not running — workspace container needs a restart";
    logError(detail, { health: before });
    return { ok: false, repaired: false, error: detail, health: before };
  }

  logStep("Repairing desktop stream (x11vnc / websockify)", {
    force,
    health: before,
  });

  // Orphaned FUSE children exhaust RAM and stall the desktop; restart watchdog.
  if (before.fuseCount > 1) {
    logStep("Pruning orphaned FUSE processes", { fuseCount: before.fuseCount });
    // Must run as its own script: an inline `pkill -f hostfs-watchdog.sh` also
    // matches this exec's command line and SIGTERMs the shell (exit 143), so the
    // prune would appear to succeed while the remount never ran.
    await syncHostfsRestart();
    await dockerExec(
      ["bash", "-c", "/opt/bridge/hostfs-restart.sh 2>&1 | tail -5"],
      { timeoutMs: 40000 },
    );
    await sleep(1500);
  }

  await syncFixScript();
  const fix = await dockerExec(
    [
      "bash",
      "-c",
      `python3 /opt/bridge/fix-vnc-stack.py${force ? " --force" : ""}`,
    ],
    { timeoutMs: 20000 },
  );
  const fixOut = `${fix.stdout || ""}\n${fix.stderr || ""}`.trim();
  if (fix.code === 0 && /ok (already-healthy|repaired)/.test(fixOut)) {
    const immediate = await getStreamHealth();
    if (immediate.ok || hostStreamUsable(immediate)) {
      logStep("Desktop stream ready");
      return {
        ok: true,
        repaired: /ok repaired/.test(fixOut),
        health: { ...immediate, ok: true },
        fix: fixOut,
      };
    }
  }

  for (let i = 0; i < 24; i++) {
    const health = await getStreamHealth();
    if (health.ok) {
      logStep("Desktop stream ready");
      return {
        ok: true,
        repaired: true,
        health,
        fix: (fix.stdout || "").trim(),
      };
    }
    await sleep(250);
  }

  const health = await getStreamHealth();
  if (
    fix.code === 0 &&
    /ok already-healthy/.test(fixOut) &&
    hostStreamUsable(health)
  ) {
    logStep("Desktop stream ready (container stack healthy; host probes live)");
    return {
      ok: true,
      repaired: false,
      health: { ...health, ok: true },
      fix: fixOut,
    };
  }
  const detail =
    (fix.stderr || "").trim() ||
    (fix.stdout || "").trim() ||
    "Desktop stream did not become ready";
  logError("Desktop stream repair failed", { detail, health });
  return { ok: false, repaired: true, error: detail, health, fix };
};
