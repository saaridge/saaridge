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
 * Live container checks run when agent-bridge-box is up.
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
  ok("stream-stack uses bash -c + host RFB probe + recv timeout");
} catch (e) {
  fail("stream-stack source guards", e);
}

section("source: profile.d interactive-only agent-env");
try {
  const src = read("container/trust-mitm-ca.sh");
  if (!src.includes("case $- in") || !src.includes("*i*)")) {
    throw new Error("onebridge.sh must gate agent-env on interactive $-");
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
  if (!/timeout\s+1\s+test\s+-d\s+"\$ONEBRIDGE_HOST_HOME"/.test(src)) {
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
  ok("desktop startup ensure + runtime stream heal present");
} catch (e) {
  fail("desktop stream heal", e);
}

section("source: launch ensures Docker + control plane");
try {
  const launch = read("desktop/launch-mac.sh");
  if (!launch.includes("ensure_docker") || !launch.includes("ensure_control_plane")) {
    throw new Error("launch-mac must ensure Docker and control plane");
  }
  if (!launch.includes("stream-health")) {
    throw new Error("launch-mac must probe stream-health modules");
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
  const page = await fetchOk("http://127.0.0.1:6081/novnc-onebridge.html", {
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
      : "agent-bridge-box not running",
  );
} else {
  section("non-interactive bash -lc must not hang");
  try {
    const t0 = Date.now();
    const res = spawnSync(
      "docker",
      ["exec", "agent-bridge-box", "bash", "-lc", "echo lc_ok"],
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
        "agent-bridge-box",
        "bash",
        "-c",
        "grep -E 'case \\$-|\\*i\\*\\)' /etc/profile.d/onebridge.sh",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (res.status !== 0 || !String(res.stdout).includes("case $-")) {
      throw new Error("live /etc/profile.d/onebridge.sh missing interactive gate");
    }
    ok("live onebridge.sh gates on interactive shell");
  } catch (e) {
    fail("live profile.d", e);
  }

  section("auth-proxy HTTPS body non-empty (chunked HTML)");
  try {
    const res = spawnSync(
      "docker",
      [
        "exec",
        "agent-bridge-box",
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
    const ctrl = process.env.ONEBRIDGE_CONTROL_URL || "http://127.0.0.1:3847";
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
}

const failed = done();
process.exit(failed ? 1 : 0);
