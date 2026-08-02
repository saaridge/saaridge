#!/usr/bin/env node
/**
 * Keyboard tests — must prove typed text appears in a real remote window.
 * Path under test: Electron before-input → key-pump.sh → xdotool → X app.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createRunner,
  dockerBoxRunning,
  dockerExec,
} from "./lib/test-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const E2E_TEXT = "xyz";
const TITLE = "OneBridge-KB-E2E";
const OUT = "/tmp/onebridge-kb-e2e.out";

const { ok, fail, skip, section, done } = createRunner("keyboard");

const dockerExecBrowser = (script, { timeoutMs = 30000 } = {}) => {
  const res = spawnSync(
    "docker",
    [
      "exec",
      "-u",
      "browser",
      "-e",
      "DISPLAY=:1",
      "-e",
      "HOME=/home/browser",
      "agent-bridge-box",
      "bash",
      "-lc",
      script,
    ],
    { encoding: "utf8", timeout: timeoutMs },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      (res.stderr || res.stdout || "").trim() || `docker exec exit ${res.status}`,
    );
  }
  return (res.stdout || "").trim();
};

const startKeyPump = () =>
  spawn(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "browser",
      "-e",
      "DISPLAY=:1",
      "agent-bridge-box",
      "/opt/bridge/key-pump.sh",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );

const prepareTarget = () => {
  dockerExecBrowser(
    [
      "set -euo pipefail",
      `rm -f ${OUT}`,
      `for w in $(xdotool search --name '${TITLE}' 2>/dev/null || true); do xdotool windowkill "$w" 2>/dev/null || true; done`,
      "sleep 0.2",
      `xfce4-terminal --title=${TITLE} --command="bash -c 'read -r line; printf %s \\"\\$line\\" > ${OUT}'" &`,
      "for i in $(seq 1 40); do",
      `  WID=$(xdotool search --onlyvisible --name '${TITLE}' 2>/dev/null | tail -1 || true)`,
      '  if [ -n "$WID" ]; then break; fi',
      "  sleep 0.2",
      "done",
      'if [ -z "${WID:-}" ]; then echo NO_TERMINAL; exit 4; fi',
      'xdotool windowactivate --sync "$WID"',
      "echo READY",
    ].join("\n"),
  );
};

const cleanupTarget = () => {
  try {
    dockerExecBrowser(
      `for w in $(xdotool search --name '${TITLE}' 2>/dev/null || true); do xdotool windowkill "$w" 2>/dev/null || true; done; rm -f ${OUT}`,
    );
  } catch {
    /* ignore */
  }
};

section("key-pump script exists");
try {
  if (!fs.existsSync(path.join(ROOT, "container", "key-pump.sh"))) {
    throw new Error("container/key-pump.sh missing");
  }
  const main = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf8");
  if (!main.includes("injectKeyToX") || !main.includes("ensureKeyPump")) {
    throw new Error("desktop/main.cjs no longer uses key-pump path");
  }
  if (main.includes("forwardKeyViaDom")) {
    throw new Error("desktop/main.cjs still depends on broken RFB DOM forward path");
  }
  ok("main.cjs uses HEAD key-pump path");
} catch (e) {
  fail("key-pump script exists", e);
}

if (!dockerBoxRunning()) {
  skip("keyboard E2E", "agent-bridge-box not running");
} else if (process.env.TEST_KEYBOARD_SKIP_DOCKER === "1") {
  skip("keyboard E2E", "TEST_KEYBOARD_SKIP_DOCKER=1");
} else {
  section("keyboard E2E (key-pump → remote terminal)");
  let pump = null;
  try {
    prepareTarget();
    pump = startKeyPump();
    await new Promise((r) => setTimeout(r, 300));
    if (!pump.stdin?.writable) throw new Error("key-pump stdin not writable");

    // Same lines Electron injectKeyToX writes for printable chars + Enter.
    for (const ch of E2E_TEXT) {
      pump.stdin.write(`TYPE ${ch}\n`);
    }
    pump.stdin.write("KEY Return\n");
    await new Promise((r) => setTimeout(r, 800));

    const typed = dockerExec(`cat ${OUT} 2>/dev/null || true`);
    if (!typed.includes(E2E_TEXT)) {
      throw new Error(
        `typed text not in remote terminal (got ${JSON.stringify(typed)})`,
      );
    }
    ok(`remote terminal shows "${E2E_TEXT}"`);
  } catch (e) {
    fail("keyboard E2E (key-pump → remote terminal)", e);
  } finally {
    try {
      pump?.stdin?.end();
      pump?.kill();
    } catch {
      /* ignore */
    }
    cleanupTarget();
  }
}

process.exit(done() ? 1 : 0);
