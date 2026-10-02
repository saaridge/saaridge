#!/usr/bin/env node
/**
 * Desktop stream reliability regression.
 *
 * Catches the black-boot-screen class of bugs:
 * - stream health/repair must not use bash -lc (FUSE hang via agent-env)
 * - profile.d must not source agent-env for non-interactive shells
 * - agent-env must bound FUSE STAT for HOME remap
 * - host-side RFB-over-websockify probe must work when :6081 is up
 * - getStreamHealth must return within a budget (no forever hang)
 *
 * Live container checks run when saaridge-box is up.
 * Set TEST_DESKTOP_STREAM_SKIP_DOCKER=1 to skip them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createRunner,
  dockerBoxRunning,
  fetchOk,
} from "./lib/test-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { ok, fail, skip, section, done } = createRunner("desktop-stream");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

section("source: stream-stack avoids login-shell health hangs");
try {
  const src = read("host/lib/stream-stack.js");
  if (!src.includes("probeRfbViaWebsockify")) {
    throw new Error("missing host-side probeRfbViaWebsockify");
  }
  if (!/"bash"\s*,\s*\n?\s*"\-c"/.test(src) && !/\["bash", "-c"/.test(src)) {
    throw new Error("inspect/repair must invoke bash -c");
  }
  if (/"bash"\s*,\s*\n?\s*"\-lc"/.test(src) || /\["bash", "-lc"/.test(src)) {
    throw new Error("stream-stack must not use bash -lc (FUSE/login hang)");
  }
  if (!/s\.settimeout\(\s*2\s*\)/.test(src)) {
    throw new Error("inside RFB probe must settimeout on recv");
  }
  if (!/streamOk/.test(src) || !/ok:\s*streamOk/.test(src)) {
    throw new Error("getStreamHealth must set ok last (inside.ok must not clobber host RFB)");
  }
  // Must appear as \$pid in source so the JS template literal does not interpolate.
  if (!/"\\\$pid"/.test(src)) {
    throw new Error("inside inspect must escape $pid for JS template literal");
  }
  if (!/lines\.find\(\(l\) => \/\^XVFB=\//.test(src)) {
    throw new Error("inside inspect must parse XVFB= line, not trailing noise");
  }
  // `pgrep -fc` prints 0 AND exits 1, so `|| echo 0` emitted a second line ("0").
  // The parser then read "0" as the status line -> xvfb/rfb/ws all false ->
  // spurious "Repairing desktop stream" that killed the live stream (blank UI).
  if (/FUSE=\$\(pgrep -fc/.test(src)) {
    throw new Error(
      "FUSE count must not use `pgrep -fc ... || echo 0` (emits a second line)",
    );
  }
  // Written as `[s]aaridge-hostfs` so pgrep cannot match the probe's own shell.
  if (!/\[s\]aaridge-hostfs|saaridge-hostfs/.test(src)) {
    throw new Error("FUSE count must include the Rust saaridge-hostfs mount");
  }
  if (!/!force && hostStreamUsable\(before\)/.test(src)) {
    throw new Error(
      "ensureStreamStack must not restart x11vnc/websockify when host RFB is live",
    );
  }
  ok("stream-stack uses bash -c + host RFB probe + recv timeout");
} catch (e) {
  fail("stream-stack source guards", e);
}

section("source: desktop must not repair the stream on a probe timeout");
try {
  const src = read("desktop/main.cjs");
  if (!/if \(!health\.ok \|\| !health\.body\) return;/.test(src)) {
    throw new Error(
      "stream heal must ignore timeouts/transport errors (no body = no verdict)",
    );
  }
  const budget = src.match(
    /stream-health`,\s*\{\},\s*([0-9_]+),/,
  );
  if (!budget || Number(budget[1].replace(/_/g, "")) < 12000) {
    throw new Error(
      "stream-health poll budget must exceed the host in-container inspect (10s)",
    );
  }
  ok("desktop repairs only on a definite unhealthy verdict");
} catch (e) {
  fail("desktop stream-heal timeout guard", e);
}

section("source: profile.d interactive-only agent-env");
try {
  const src = read("container/trust-mitm-ca.sh");
  if (!src.includes("case $- in") || !src.includes("*i*)")) {
    throw new Error("saaridge.sh must gate agent-env on interactive $-");
  }
  if (!src.includes("never block docker health")) {
    throw new Error("missing comment documenting non-interactive skip");
  }
  ok("trust-mitm-ca installs interactive-only profile.d");
} catch (e) {
  fail("profile.d interactive guard", e);
}

section("source: agent-env bounds FUSE home STAT");
try {
  const src = read("container/agent-env.sh");
  if (!/timeout\s+1\s+test\s+-d\s+"\$SAARIDGE_HOST_HOME"/.test(src)) {
    throw new Error("HOME remap must use timeout 1 test -d on host home");
  }
  ok("agent-env FUSE home check is time-bounded");
} catch (e) {
  fail("agent-env FUSE timeout", e);
}

section("source: desktop runtime stream heal exists");
try {
  const src = read("desktop/main.cjs");
  if (!src.includes("startStreamHeal") || !src.includes("ensure-stream")) {
    throw new Error("desktop must poll stream-health and call ensure-stream");
  }
  if (!src.includes("ensureStreamReady")) {
    throw new Error("desktop boot must ensureStreamReady");
  }
  if (!/settingsWindow/.test(src) || !/pendingDesktopReload/.test(src)) {
    throw new Error("desktop must defer noVNC reload while Settings is open");
  }
  if (!/settingsWindow && !settingsWindow.isDestroyed\(\)\) return/.test(src)) {
    throw new Error("focusDesktop must not steal focus while Settings is open");
  }
  if (/setAlwaysOnTop\(true,\s*["']floating["']\)/.test(src)) {
    throw new Error("Settings must not use always-on-top floating on macOS");
  }
  if (!/process\.platform !== "darwin"/.test(src)) {
    throw new Error("Settings must not use modal parent on macOS (blank noVNC)");
  }
  if (
    !/settingsWindow && !settingsWindow.isDestroyed\(\)\) return/.test(src) ||
    !/const bringFront = \(\) => \{[\s\S]{0,220}settingsWindow/.test(src)
  ) {
    throw new Error("bringFront must not flash main window while Settings is open");
  }
  ok("desktop startup ensure + runtime stream heal present");
} catch (e) {
  fail("desktop stream heal", e);
}

section("display sleep must rebuild a blank Electron surface");
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const wake = require(path.join(ROOT, "desktop/display-wake.cjs"));
  const src = read("desktop/main.cjs");
  const page = read("container/novnc-saaridge.html");

  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const work = { x: 0, y: 25, width: 1920, height: 1055 };
  if (wake.windowOnScreen({ x: 80, y: 80, width: 1440, height: 900 }, [display])) {
    // on the live display
  } else {
    throw new Error("expected a normal window to count as on-screen");
  }
  if (wake.windowOnScreen({ x: 0, y: 0, width: 1920, height: 24 }, [display])) {
    throw new Error("a menu-bar-sized strip must not count as the desktop window");
  }
  const parked = { x: 4000, y: 100, width: 1440, height: 900 };
  if (wake.windowOnScreen(parked, [display])) {
    throw new Error("a window left on a removed display must be off-screen");
  }
  const moved = wake.replacementBounds(parked, [display], work);
  if (!moved || moved.x < work.x || moved.x + moved.width > work.x + work.width) {
    throw new Error(`replacement bounds missed the live display: ${JSON.stringify(moved)}`);
  }
  if (wake.replacementBounds({ x: 80, y: 80, width: 1440, height: 900 }, [display], work)) {
    throw new Error("on-screen windows must not be moved");
  }
  const nudged = wake.nudgeSize({ x: 10, y: 20, width: 800, height: 600 });
  if (nudged.width !== 801 || nudged.height !== 600) {
    throw new Error("nudge must grow width by 1px to force a new IOSurface");
  }

  const locked = wake.planDisplayWake({
    surfaceStale: true,
    screenLocked: true,
    hasDisplay: true,
    desktopLive: true,
  });
  if (locked.recover || locked.reloadDesktop) {
    throw new Error("dark wake while locked must not rebuild (display id still invalid)");
  }
  const idle = wake.planDisplayWake({
    surfaceStale: false,
    screenLocked: false,
    hasDisplay: true,
    desktopLive: true,
  });
  if (idle.recover) throw new Error("a fresh surface must not reload");
  const wakePlan = wake.planDisplayWake({
    surfaceStale: true,
    screenLocked: false,
    hasDisplay: true,
    desktopLive: true,
    settingsOpen: false,
  });
  if (!wakePlan.recover || !wakePlan.nudge || !wakePlan.reloadDesktop) {
    throw new Error(`unlock must reload the viewer, got ${JSON.stringify(wakePlan)}`);
  }
  const settings = wake.planDisplayWake({
    surfaceStale: true,
    screenLocked: false,
    hasDisplay: true,
    desktopLive: true,
    settingsOpen: true,
  });
  if (settings.reloadDesktop || !settings.deferDesktopReload) {
    throw new Error("Settings must defer the noVNC reload across display wake");
  }

  for (const needle of [
    'powerMonitor.on("suspend"',
    'powerMonitor.on("resume"',
    'powerMonitor.on("lock-screen"',
    'powerMonitor.on("unlock-screen"',
    'screen.on("display-removed"',
    'screen.on("display-added"',
    "installDisplayWakeRecovery",
    "disable-backgrounding-occluded-windows",
    "MacWebContentsOcclusion",
  ]) {
    if (!src.includes(needle)) throw new Error(`main.cjs missing ${needle}`);
  }
  const heal = src.slice(src.indexOf("const startStreamHeal"));
  const crashedAt = heal.indexOf("isCrashed()");
  const okReturn = heal.indexOf("if (health.body.ok) return");
  if (crashedAt < 0 || okReturn < 0 || crashedAt > okReturn) {
    throw new Error("stream heal must reload a crashed renderer before trusting stream-health");
  }
  if (!page.includes("__saaridgeDisplayWake")) {
    throw new Error("noVNC page must expose a display-wake reconnect");
  }
  if (!page.includes("generation !== connectGeneration")) {
    throw new Error("noVNC reconnect must ignore a socket replaced by a newer connect()");
  }
  if (/if\s*\(\s*!e\.detail\.clean\s*\)/.test(page)) {
    throw new Error("noVNC must reconnect after a clean websocket close (display sleep)");
  }
  if (!page.includes("awayMs >= 1500")) {
    throw new Error("noVNC must rebuild the framebuffer after the page was hidden");
  }
  ok("display wake restores the surface and reconnects noVNC");
} catch (e) {
  fail("display-wake blank window", e);
}

section("source: settings policies UI must not blank on mode change");
try {
  const settings = read("desktop/settings.js");
  if (/globalRoot\.innerHTML\s*=\s*["'][\s]*["']/.test(settings)) {
    throw new Error("reloadPolicies must not clear globalRows before rebuild");
  }
  const modeSave = settings.match(
    /\/api\/policies\/mode"[\s\S]{0,1800}?renderCoverageSummary\(policyCache/,
  );
  if (!modeSave?.[0] || /await reloadPolicies\(\)/.test(modeSave[0])) {
    throw new Error("mode save must update in place, not reloadPolicies()");
  }
  if (!/policiesLoadSeq/.test(settings) || !/prev !== "policies"/.test(settings)) {
    throw new Error("showPane must not re-fetch policies when already on Policies tab");
  }
  ok("settings mode change avoids list wipe + redundant reload");
} catch (e) {
  fail("settings blank-on-redact guards", e);
}

section("source: XFCE dock launchers must not be empty gear placeholders");
try {
  const script = read("container/ensure-panel-launchers.sh");
  if (!/seed_launcher 17/.test(script) || !/xfce4-terminal-emulator\.desktop/.test(script)) {
    throw new Error("must seed panel-2 launcher-17 (terminal)");
  }
  if (!/seed_launcher 18/.test(script) || !/seed_launcher 19/.test(script) || !/seed_launcher 20/.test(script)) {
    throw new Error("must seed files/browser/appfinder launchers 18-20");
  }
  if (!/SAARIDGE_SANDBOX_HOME/.test(script)) {
    throw new Error("panel launcher seed must force sandbox HOME (not FUSE /host/home)");
  }
  if (!/hicolor\/48x48\/apps/.test(script) || !/Icon=\{cand\}/.test(script)) {
    throw new Error("seeded launchers must rewrite Icon= to an absolute PNG path");
  }
  const start = read("container/start-desktop.sh");
  const repair = read("container/repair-desktop.sh");
  if (!start.includes("ensure-panel-launchers.sh")) {
    throw new Error("start-desktop must seed panel launchers after the panel is up");
  }
  if (!repair.includes("ensure-panel-launchers.sh")) {
    throw new Error("repair-desktop must re-seed panel launchers");
  }
  const desk = read("host/lib/desktop.js");
  if (!desk.includes("ensure-panel-launchers.sh")) {
    throw new Error("host desktop.js must dockerCp ensure-panel-launchers.sh");
  }
  ok("panel launchers seeded with absolute icons at start and repair");
} catch (e) {
  fail("panel launcher placeholder guards", e);
}

section("source: launch ensures Docker + control plane");
try {
  const launch = read("desktop/launch-mac.sh");
  if (!launch.includes("ensure_docker") || !launch.includes("ensure_control_plane")) {
    throw new Error("launch-mac must ensure Docker and control plane");
  }
  // The readiness probe itself lives in host-stack.sh, which launch-mac sources.
  if (!launch.includes("lib/host-stack.sh")) {
    throw new Error("launch-mac must source scripts/lib/host-stack.sh");
  }
  const stack = read("scripts/lib/host-stack.sh");
  if (!stack.includes("stream-health") || !stack.includes("saaridge_modules_ok")) {
    throw new Error("host-stack must probe stream-health for module readiness");
  }
  ok("launch-mac startup ensures Docker + host modules");
} catch (e) {
  fail("launch-mac startup ensure", e);
}

section("source: auth-proxy CONNECT does not drop post-handshake bytes");
try {
  const src = read("container/auth-proxy.mjs");
  if (!src.includes("upstream.pause()") || !src.includes("upstream.resume()")) {
    throw new Error("CONNECT handler must pause/resume around pipe setup");
  }
  if (!src.includes("blank pages") && !src.includes("not dropped")) {
    // comment optional
  }
  ok("auth-proxy CONNECT pauses before pipe to avoid byte loss");
} catch (e) {
  fail("auth-proxy CONNECT race guard", e);
}

section("source: chunked text/html is not treated as SSE");
try {
  const src = read("host/bridge/proxy.js");
  if (/text\/.*&& chunked && direction === "response"/.test(src) ||
      /\/text\\\/\/i\.test\(ctype\) && chunked/.test(src)) {
    throw new Error("proxy must not classify all chunked text/* as SSE");
  }
  if (!src.includes("text\\/event-stream") && !src.includes("text/event-stream")) {
    throw new Error("SSE detection must still recognize text/event-stream");
  }
  // Ensure the bad dual-condition is gone.
  const isSseBlock = src.match(/const isSse =[\s\S]{0,200};/);
  if (isSseBlock && /text\/(?!event-stream)/.test(isSseBlock[0]) && /chunked/.test(isSseBlock[0])) {
    throw new Error(`isSse still too broad: ${isSseBlock[0]}`);
  }
  ok("chunked HTML uses buffer-mediate path, not SSE stream");
} catch (e) {
  fail("chunked HTML vs SSE guard", e);
}

section("host RFB-over-websockify probe");
try {
  const { probeRfbViaWebsockify } = await import(
    path.join(ROOT, "host/lib/stream-stack.js")
  );
  const page = await fetchOk("http://127.0.0.1:6081/novnc-saaridge.html", {
    timeoutMs: 3000,
  });
  if (!page) {
    skip("RFB via websockify", ":6081 novnc not reachable");
  } else {
    const t0 = Date.now();
    const live = await probeRfbViaWebsockify();
    const ms = Date.now() - t0;
    if (!live) throw new Error("websockify did not yield RFB banner");
    if (ms > 5000) throw new Error(`RFB probe too slow: ${ms}ms`);
    ok(`host RFB via :6081 websockify (${ms}ms)`);
  }
} catch (e) {
  fail("host RFB via websockify", e);
}

const dockerEnabled =
  process.env.TEST_DESKTOP_STREAM_SKIP_DOCKER !== "1" && dockerBoxRunning();

if (!dockerEnabled) {
  skip(
    "container stream checks",
    dockerBoxRunning()
      ? "TEST_DESKTOP_STREAM_SKIP_DOCKER=1"
      : "saaridge-box not running",
  );
} else {
  section("non-interactive bash -lc must not hang");
  try {
    const t0 = Date.now();
    const res = spawnSync(
      "docker",
      ["exec", "saaridge-box", "bash", "-lc", "echo lc_ok"],
      { encoding: "utf8", timeout: 5000 },
    );
    const ms = Date.now() - t0;
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || "").trim() || `exit ${res.status}`);
    }
    if (!String(res.stdout).includes("lc_ok")) {
      throw new Error("unexpected stdout");
    }
    if (ms > 4000) throw new Error(`bash -lc took ${ms}ms (FUSE/login hang?)`);
    ok(`bash -lc non-interactive returns quickly (${ms}ms)`);
  } catch (e) {
    fail("bash -lc non-interactive", e);
  }

  section("live profile.d interactive guard");
  try {
    const res = spawnSync(
      "docker",
      [
        "exec",
        "saaridge-box",
        "bash",
        "-c",
        "grep -E 'case \\$-|\\*i\\*\\)' /etc/profile.d/saaridge.sh",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (res.status !== 0 || !String(res.stdout).includes("case $-")) {
      throw new Error("live /etc/profile.d/saaridge.sh missing interactive gate");
    }
    ok("live saaridge.sh gates on interactive shell");
  } catch (e) {
    fail("live profile.d", e);
  }

  section("auth-proxy HTTPS body non-empty (chunked HTML)");
  try {
    const res = spawnSync(
      "docker",
      [
        "exec",
        "saaridge-box",
        "bash",
        "-c",
        `curl -sS -m 25 -x http://127.0.0.1:17999 -A Mozilla -o /tmp/ob-ldc.out -w '%{http_code} %{size_download}' 'https://cursor.com/loginDeepControl?challenge=test&uuid=test&mode=login'`,
      ],
      { encoding: "utf8", timeout: 35000 },
    );
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || "").trim() || `exit ${res.status}`);
    }
    const out = String(res.stdout || "").trim();
    const m = out.match(/^(\d+)\s+(\d+)$/);
    if (!m) throw new Error(`unexpected curl output: ${out}`);
    const code = Number(m[1]);
    const size = Number(m[2]);
    if (code !== 200) throw new Error(`expected 200, got ${code}`);
    if (size < 10_000) {
      throw new Error(
        `auth-proxy returned near-empty body (${size} bytes) — CONNECT byte-loss / blank page`,
      );
    }
    ok(`auth-proxy chunked HTML body ${size} bytes`);
  } catch (e) {
    fail("auth-proxy HTTPS body", e);
  }

  section("in-container inspect emits one clean status line");
  try {
    const { inspectStreamInsideContainer } = await import(
      path.join(ROOT, "host/lib/stream-stack.js")
    );
    const inside = await inspectStreamInsideContainer();
    const detail = String(inside.detail || "");
    if (!/^XVFB=\d+ RFB=\d+ WS=\d+ FUSE=\d+$/.test(detail)) {
      throw new Error(`malformed inspect detail: ${JSON.stringify(detail)}`);
    }
    // The old `|| echo 0` bug surfaced as a bare "0" line that the parser read
    // as the status line, making a healthy stream look dead.
    if (/^\d+$/.test(detail.trim())) {
      throw new Error("inspect detail is a bare number (trailing-line bug)");
    }
    if (!Number.isFinite(inside.fuseCount) || inside.fuseCount < 1) {
      throw new Error(
        `fuseCount must see the live FUSE mount, got ${inside.fuseCount}`,
      );
    }
    ok(`inspect detail clean (${detail})`);
  } catch (e) {
    fail("in-container inspect status line", e);
  }

  section("getStreamHealth budget + ok");
  try {
    const { getStreamHealth, ensureStreamStack } = await import(
      path.join(ROOT, "host/lib/stream-stack.js")
    );
    const t0 = Date.now();
    let health = await getStreamHealth();
    const ms = Date.now() - t0;
    if (ms > 15000) {
      throw new Error(`getStreamHealth hung/too slow: ${ms}ms`);
    }
    if (!health.ok) {
      const repaired = await ensureStreamStack({ force: true });
      if (!repaired.ok) {
        throw new Error(
          `stream unhealthy and repair failed: ${JSON.stringify(repaired.health || health)}`,
        );
      }
      health = repaired.health;
    }
    if (!health.hostRfb && !health.ok) {
      throw new Error(`expected healthy stream, got ${JSON.stringify(health)}`);
    }
    ok(`getStreamHealth ok within budget (${ms}ms, hostRfb=${health.hostRfb})`);
  } catch (e) {
    fail("getStreamHealth", e);
  }

  section("control plane stream-health responds");
  try {
    const ctrl = process.env.SAARIDGE_CONTROL_URL || "http://127.0.0.1:3847";
    const t0 = Date.now();
    const res = await fetch(`${ctrl}/api/desktop/stream-health`, {
      signal: AbortSignal.timeout(12000),
    });
    const ms = Date.now() - t0;
    if (![200, 503].includes(res.status)) {
      throw new Error(`unexpected status ${res.status}`);
    }
    const body = await res.json();
    if (typeof body?.ok !== "boolean") {
      throw new Error("missing ok boolean");
    }
    if (ms > 12000) throw new Error(`API too slow: ${ms}ms`);
    ok(`GET /api/desktop/stream-health → ${res.status} in ${ms}ms`);
  } catch (e) {
    // Host may be down in unit-only environments
    if (String(e?.message || e).includes("fetch failed") || e?.name === "TimeoutError") {
      skip("control plane stream-health", "host control plane not reachable");
    } else {
      fail("control plane stream-health", e);
    }
  }

  section("live XFCE dock launchers have real icons, not empty slots");
  try {
    const res = spawnSync(
      "docker",
      [
        "exec",
        "-u",
        "browser",
        "-e",
        "HOME=/home/browser",
        "saaridge-box",
        "bash",
        "-c",
        `python3 - <<'PY'
import glob, os
root = "/home/browser/.config/xfce4/panel"
want = {
    "launcher-17": "xfce4-terminal-emulator.desktop",
    "launcher-18": "xfce4-file-manager.desktop",
    "launcher-19": "xfce4-web-browser.desktop",
    "launcher-20": "xfce4-appfinder.desktop",
}
missing = []
for folder, name in want.items():
    path = os.path.join(root, folder, name)
    if not os.path.isfile(path):
        missing.append(path)
        continue
    text = open(path, encoding="utf-8", errors="replace").read()
    icon = ""
    for line in text.splitlines():
        if line.startswith("Icon="):
            icon = line[5:].strip()
            break
    if not icon.startswith("/") or not os.path.isfile(icon):
        missing.append(f"{path} Icon={icon!r}")
print("MISSING:" + ";".join(missing) if missing else "OK")
PY`,
      ],
      { encoding: "utf8", timeout: 8000 },
    );
    if (res.error) throw res.error;
    const out = String(res.stdout || "").trim();
    if (res.status !== 0) {
      throw new Error((res.stderr || out || `exit ${res.status}`).trim());
    }
    if (out.startsWith("MISSING:")) {
      throw new Error(`empty gear placeholders: ${out.slice(8)}`);
    }
    if (out !== "OK") throw new Error(`unexpected: ${out}`);
    ok("dock launchers 17-20 exist with absolute Icon= files");
  } catch (e) {
    fail("live panel launchers", e);
  }
}

const failed = done();
process.exit(failed ? 1 : 0);
