/**
 * Workspace desktop stream (Xvfb → x11vnc → websockify → host :6081).
 * Retail boot must verify RFB liveness — HTML on :6081 can be up while :5900 is dead.
 */
import net from "node:net";
import { dockerExec, dockerCp } from "./docker.js";
import { CONTAINER_NAME, ROOT } from "./paths.js";
import { logError, logStep } from "./logger.js";
import path from "node:path";

const NOVNC_HTTP = process.env.ONEBRIDGE_NOVNC_URL || "http://127.0.0.1:6081";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Inside-container checks: Xvfb, :5900 RFB banner, :6080 listen. */
export const inspectStreamInsideContainer = async () => {
  const res = await dockerExec(
    [
      "bash",
      "-lc",
      `
XVFB=0; RFB=0; WS=0
for pid in $(pgrep -x Xvfb || true); do
  st=$(ps -o state= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$st" ] && [ "$st" != "Z" ]; then XVFB=1; break; fi
done
ss -lnt 2>/dev/null | grep -q ':6080 ' && WS=1 || true
if python3 - <<'PY'
import socket, sys
try:
    s = socket.create_connection(("127.0.0.1", 5900), 2)
    b = s.recv(12)
    s.close()
    sys.exit(0 if b.startswith(b"RFB ") else 1)
except Exception:
    sys.exit(1)
PY
then RFB=1; else RFB=0; fi
echo "XVFB=$XVFB RFB=$RFB WS=$WS"
`.trim(),
    ],
    { timeoutMs: 10000 },
  );
  const line = (res.stdout || "").trim().split("\n").pop() || "";
  const xvfb = /XVFB=1/.test(line);
  const rfb = /RFB=1/.test(line);
  const websockify = /WS=1/.test(line);
  return {
    ok: xvfb && rfb && websockify,
    xvfb,
    rfb,
    websockify,
    detail: line || (res.stderr || "").trim() || `exit ${res.code}`,
  };
};

export const getStreamHealth = async () => {
  const novncHttp = await probeHttp(`${NOVNC_HTTP}/novnc-onebridge.html`);
  const hostWsPort = await probeTcp("127.0.0.1", 6081);
  const inside = await inspectStreamInsideContainer();
  return {
    ok: Boolean(novncHttp && hostWsPort && inside.ok),
    novncHttp,
    hostWsPort,
    ...inside,
  };
};

const syncFixScript = async () => {
  await dockerCp(
    path.join(ROOT, "container", "fix-vnc-stack.py"),
    `${CONTAINER_NAME}:/opt/bridge/fix-vnc-stack.py`,
  );
  await dockerExec([
    "bash",
    "-lc",
    "chmod 755 /opt/bridge/fix-vnc-stack.py",
  ]);
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

  if (!before.xvfb) {
    const detail =
      "Display server (Xvfb) is not running — workspace container needs a restart";
    logError(detail, { health: before });
    return { ok: false, repaired: false, error: detail, health: before };
  }

  logStep("Repairing desktop stream (x11vnc / websockify)", {
    force,
    health: before,
  });
  await syncFixScript();
  const fix = await dockerExec(
    [
      "bash",
      "-lc",
      `python3 /opt/bridge/fix-vnc-stack.py${force ? " --force" : ""}`,
    ],
    { timeoutMs: 20000 },
  );

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
  const detail =
    (fix.stderr || "").trim() ||
    (fix.stdout || "").trim() ||
    "Desktop stream did not become ready";
  logError("Desktop stream repair failed", { detail, health });
  return { ok: false, repaired: true, error: detail, health, fix };
};
