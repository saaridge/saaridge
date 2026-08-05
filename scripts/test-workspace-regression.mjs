#!/usr/bin/env node
/**
 * Functional workspace regression suite.
 *
 * Tests observable behavior (mounts, ports, proxy bodies, VNC, keyboard, mic)
 * instead of grepping implementation details in source files.
 *
 * Docker checks run automatically when saaridge-box is running.
 * Set TEST_WORKSPACE_SKIP_DOCKER=1 to skip container checks.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunner,
  dockerBoxRunning,
  dockerCp,
  dockerExec,
  fetchOk,
  runNodeScript,
} from "./lib/test-harness.mjs";
import { FIXTURE_MARKER, startGzipFixtureServer } from "./lib/gzip-fixture-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { ok, fail, skip, section, done } = createRunner("workspace-regression");

const dockerEnabled =
  process.env.TEST_WORKSPACE_SKIP_DOCKER !== "1" && dockerBoxRunning();

section("keyboard");
try {
  const kb = runNodeScript("scripts/test-keyboard.mjs", { cwd: ROOT });
  if (kb.status !== 0) {
    throw new Error(kb.stdout?.split("\n").filter(Boolean).slice(-6).join("\n") || kb.stderr);
  }
  ok("keyboard suite");
} catch (e) {
  fail("keyboard suite", e);
}

section("desktop stream HTTP");
try {
  const res = await fetchOk("http://127.0.0.1:6081/novnc-saaridge.html");
  if (!res) throw new Error("novnc-saaridge.html not reachable on :6081");
  const html = await res.text();
  if (!html.includes("new RFB(")) throw new Error("page is not a noVNC client");
  ok("noVNC desktop page is served");
} catch (e) {
  fail("desktop stream HTTP", e);
}

if (!dockerEnabled) {
  skip(
    "container workspace",
    dockerBoxRunning()
      ? "TEST_WORKSPACE_SKIP_DOCKER=1"
      : "saaridge-box not running",
  );
} else {
  section("container /host FUSE mount");
  try {
    dockerExec("test -r /host && ls /host/workspaces >/dev/null");
    const mount = dockerExec(
      "findmnt -T /host 2>/dev/null | grep -q fuse && echo MOUNTED || echo NO",
    );
    if (!mount.includes("MOUNTED")) throw new Error("/host is not a FUSE mount");
    ok("/host FUSE mount is readable");
  } catch (e) {
    fail("container /host FUSE mount", e);
  }

  section("container FUSE orphan guard");
  try {
    const fuseCount = Number(
      dockerExec(
        String.raw`pgrep -fc 'python3 /opt/bridge/hostfs-fuse\.py /host' 2>/dev/null || echo 0`,
      ),
    );
    if (!Number.isFinite(fuseCount) || fuseCount < 1 || fuseCount > 2) {
      throw new Error(`expected 1-2 live FUSE processes, got ${fuseCount}`);
    }
    ok(`FUSE process count healthy (${fuseCount})`);
  } catch (e) {
    fail("container FUSE orphan guard", e);
  }

  section("source: FUSE never tree-hydrates /host/home");
  try {
    const src = fs.readFileSync(
      path.join(ROOT, "container", "hostfs-fuse.py"),
      "utf8",
    );
    const ensure = src.match(/def _ensure_listing[\s\S]*?\n    def _stat_bridge/);
    if (!ensure) throw new Error("_ensure_listing block not found");
    const block = ensure[0];
    if (!block.includes('p == "/home"') || !block.includes('p.startswith("/home/")')) {
      throw new Error("_ensure_listing must special-case /home and /home/…");
    }
    if (!block.includes("_list_shallow")) {
      throw new Error("_ensure_listing must call _list_shallow for home");
    }
    // Home branch must not call hydrate_tree (only the else / non-home path may).
    const homeBranch = block.match(
      /if p == "\/home"[\s\S]*?else:\s*\n\s+listed = self\._hydrate_tree/,
    );
    if (!homeBranch) {
      throw new Error("expected /home → _list_shallow, else → _hydrate_tree");
    }
    if (/_hydrate_tree/.test(homeBranch[0].split("else:")[0])) {
      throw new Error("/home branch must not call _hydrate_tree");
    }
    ok("hostfs-fuse shallow-lists under /home");
  } catch (e) {
    fail("FUSE home shallow source guard", e);
  }

  section("container FUSE /host/home list stays fast");
  try {
    // Watchdog browse budget is 3s; home list must not wedge the FUSE loop.
    const out = dockerExec(
      `python3 - <<'PY'
import os, time
t0 = time.time()
n = len(os.listdir("/host/home"))
dt = time.time() - t0
print(f"HOME_LIST {dt:.3f} {n}")
if dt > 3.0:
    raise SystemExit(f"home listdir too slow: {dt:.3f}s (FUSE tree-hydrate regression?)")
t1 = time.time()
ws = len(os.listdir("/host/workspaces"))
dt2 = time.time() - t1
print(f"WS_LIST {dt2:.3f} {ws}")
if dt2 > 3.0:
    raise SystemExit(f"workspaces listdir blocked: {dt2:.3f}s")
PY`,
      { timeoutMs: 10000 },
    );
    if (!/HOME_LIST /.test(out)) throw new Error(out || "no HOME_LIST output");
    ok(`FUSE /host/home list within budget (${out.trim().split("\n")[0]})`);
  } catch (e) {
    fail("container FUSE /host/home latency", e);
  }

  section("source: Cursor process keeps sandbox HOME");
  try {
    const src = fs.readFileSync(
      path.join(ROOT, "container", "launch-cursor.sh"),
      "utf8",
    );
    if (!/export HOME="\$\{SAARIDGE_SANDBOX_HOME\}"/.test(src)) {
      throw new Error(
        "launch-cursor must pin Cursor process HOME to sandbox (not /host/home FUSE)",
      );
    }
    ok("launch-cursor uses sandbox HOME for Electron");
  } catch (e) {
    fail("Cursor sandbox HOME source guard", e);
  }

  section("container FUSE remount after kill (optional)");
  if (process.env.TEST_FUSE_REMOUNT !== "1") {
    skip("FUSE remount", "set TEST_FUSE_REMOUNT=1 (disruptive)");
  } else {
    try {
      try {
        dockerExec("pkill -f 'python3 /opt/bridge/hostfs-fuse.py /host' || true", {
          timeoutMs: 5000,
        });
      } catch {
        /* pkill may exit non-zero when process already dead */
      }
      let remounted = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          dockerExec("ls /host/workspaces >/dev/null");
          remounted = true;
          break;
        } catch {
          /* retry */
        }
      }
      if (!remounted) throw new Error("watchdog did not remount /host within 20s");
      ok("FUSE remounts after process kill");
    } catch (e) {
      fail("container FUSE remount", e);
    }
  }

  section("container VNC stream");
  try {
    const wsCount = Number(
      dockerExec("ss -lntp 2>/dev/null | grep ':6080 ' | grep -c websockify || echo 0"),
    );
    if (wsCount !== 1) throw new Error(`expected 1 websockify on :6080, got ${wsCount}`);

    dockerExec(
      `python3 - <<'PY'
import socket
s = socket.create_connection(("127.0.0.1", 5900), 2)
b = s.recv(12)
s.close()
assert b.startswith(b"RFB "), b
print("RFB_OK")
PY`,
    );
    ok("single websockify + x11vnc RFB endpoint");
  } catch (e) {
    fail("container VNC stream", e);
  }

  section("container Cursor launcher");
  try {
    dockerExec("test -x /opt/bridge/launch-cursor.sh");
    dockerExec("test -f /opt/bridge/certs/saaridge-mitm-ca.crt");
    dockerExec(
      'bash -c \'test -n "${NODE_EXTRA_CA_CERTS:-/opt/bridge/certs/saaridge-mitm-ca.crt}"\'',
    );
    ok("Cursor launcher installed with MITM CA available");
  } catch (e) {
    fail("container Cursor launcher", e);
  }

  section("container Chromium getUserMedia");
  try {
    const pid = dockerExec(
      "pgrep -u browser -f 'chromium.*user-data' 2>/dev/null | head -1 || true",
    );
    if (!pid) {
      skip("Chromium getUserMedia flags", "Chromium not running in container");
    } else {
      const cmd = dockerExec(`tr '\\0' ' ' < /proc/${pid}/cmdline`);
      // Prefer profile auto-allow (no yellow --use-fake-ui-for-media-stream banner).
      if (cmd.includes("--use-fake-ui-for-media-stream")) {
        ok("running Chromium still has legacy fake-ui media flag");
      } else {
        const prefs = dockerExec(
          "test -f /home/browser/chromium-bridge-profile/Default/Preferences && echo OK || echo NO",
        );
        if (!prefs.includes("OK")) {
          throw new Error("Chromium Preferences missing for media auto-allow");
        }
        ok("running Chromium uses profile media allow (no fake-ui banner)");
      }
    }
  } catch (e) {
    fail("container Chromium getUserMedia", e);
  }

  section("container mic ingress");
  try {
    const listen = dockerExec(
      "ss -lntp 2>/dev/null | grep -c ':6083 ' || echo 0",
    );
    if (Number(listen) < 1) throw new Error("mic ingress not listening on :6083");
    const banner = dockerExec("curl -fsS --max-time 3 http://127.0.0.1:6083/ || true");
    if (!banner.includes("mic ingress")) {
      throw new Error(`unexpected mic ingress banner: ${banner}`);
    }
    ok("mic ingress websocket port responds");
  } catch (e) {
    fail("container mic ingress", e);
  }

  section("container MITM proxy HTTPS");
  try {
    dockerCp(
      path.join(ROOT, "scripts/lib/proxy-https-docker-check.sh"),
      "/opt/bridge/proxy-https-docker-check.sh",
    );
    dockerExec("chmod +x /opt/bridge/proxy-https-docker-check.sh");
    const out = dockerExec("/opt/bridge/proxy-https-docker-check.sh", { timeoutMs: 30000 });
    if (!out.includes("PROXY_HTTPS_OK")) throw new Error(out || "proxy HTTPS fetch failed");
    ok("MITM proxy fetches live HTTPS content");
  } catch (e) {
    fail("container MITM proxy HTTPS", e);
  }

  if (process.env.TEST_PROXY_GZIP === "1") {
    section("container MITM proxy gzip bodies (optional)");
    let fixture = null;
    try {
      fixture = await startGzipFixtureServer({ host: "localhost" });
      dockerCp(
        path.join(ROOT, "scripts/lib/proxy-gzip-docker-check.sh"),
        "/opt/bridge/proxy-gzip-docker-check.sh",
      );
      dockerExec("chmod +x /opt/bridge/proxy-gzip-docker-check.sh");
      const out = dockerExec(
        `/opt/bridge/proxy-gzip-docker-check.sh ${fixture.port} ${FIXTURE_MARKER}`,
        { timeoutMs: 45000 },
      );
      if (!out.includes("PROXY_GZIP_OK")) throw new Error(out || "proxy gzip body missing marker");
      ok("MITM proxy delivers gzip body without Content-Length");
    } catch (e) {
      fail("container MITM proxy gzip bodies", e);
    } finally {
      fixture?.cleanup();
    }
  } else {
    skip("MITM proxy gzip SPA bodies", "set TEST_PROXY_GZIP=1 to run host fixture test");
  }

  // Best-effort heal if a prior optional test left /host unmounted.
  try {
    dockerExec("ls /host/workspaces >/dev/null");
  } catch {
    try {
      dockerExec(
        "nohup /opt/bridge/hostfs-watchdog.sh >/tmp/heal-watchdog.log 2>&1 & sleep 8; ls /host/workspaces >/dev/null",
        { timeoutMs: 20000 },
      );
    } catch {
      /* leave for operator — documented optional tests can disrupt mount */
    }
  }
}

process.exit(done() ? 1 : 0);
