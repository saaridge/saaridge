#!/usr/bin/env node
/**
 * Keyboard tests — must prove typed text appears in a real remote window.
 * Path under test: Electron before-input → key-pump.sh → xdotool → X app.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createRunner,
  dockerBoxRunning,
  dockerExec,
} from "./lib/test-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const E2E_TEXT = "xyz";
const E2E_SHIFT = "a@b!c";
const TITLE = "Saaridge-KB-E2E";
const OUT = "/tmp/saaridge-kb-e2e.out";

const { ok, fail, skip, section, done } = createRunner("keyboard");

const dockerExecBrowser = (script, { timeoutMs = 30000 } = {}) => {
  // Use non-login bash: login shells remap HOME→/host/home (identity), which
  // makes XFCE/xdotool STAT FUSE and can hang prepareTarget.
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
      "-e",
      "SAARIDGE_SANDBOX_HOME=/home/browser",
      "saaridge-box",
      "bash",
      "--noprofile",
      "--norc",
      "-c",
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
      "saaridge-box",
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
  if (!main.includes("key-inject.cjs")) {
    throw new Error("desktop/main.cjs must use key-inject.cjs mapping");
  }
  if (main.includes("forwardKeyViaDom")) {
    throw new Error("desktop/main.cjs still depends on broken RFB DOM forward path");
  }
  ok("main.cjs uses HEAD key-pump path");
} catch (e) {
  fail("key-pump script exists", e);
}

section("Shift punctuation maps to TYPE (not KEY shift+@)");
try {
  const { buildKeyPumpCommand: build } = require(
    path.join(ROOT, "desktop", "key-inject.cjs"),
  );
  const cases = [
    [{ type: "keyDown", key: "@", shift: true }, "TYPE @\n"],
    [{ type: "keyDown", key: "!", shift: true }, "TYPE !\n"],
    [{ type: "keyDown", key: "#", shift: true }, "TYPE #\n"],
    [{ type: "keyDown", key: "A", shift: true }, "TYPE A\n"],
    [{ type: "keyDown", key: "a", shift: false }, "TYPE a\n"],
    [{ type: "keyDown", key: "z", control: true, shift: true }, "KEY ctrl+shift+z\n"],
    [{ type: "keyDown", key: "z", meta: true }, "KEY ctrl+z\n"],
  ];
  for (const [input, expect] of cases) {
    const got = build(input);
    if (got !== expect) {
      throw new Error(
        `${JSON.stringify(input)} → ${JSON.stringify(got)} want ${JSON.stringify(expect)}`,
      );
    }
  }
  for (const key of ["@", "!", "#", "$"]) {
    const got = build({ type: "keyDown", key, shift: true });
    if (String(got).startsWith("KEY ")) {
      throw new Error(`shifted ${key} must TYPE, got ${String(got).trim()}`);
    }
  }
  ok("Shift+@/!/# TYPE; chords still KEY");
} catch (e) {
  fail("Shift punctuation mapping", e);
}

if (!dockerBoxRunning()) {
  skip("keyboard E2E", "saaridge-box not running");
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

    // Shift punctuation characters (@ !) must TYPE, not KEY shift+symbol.
    prepareTarget();
    for (const ch of E2E_SHIFT) {
      pump.stdin.write(`TYPE ${ch}\n`);
    }
    pump.stdin.write("KEY Return\n");
    await new Promise((r) => setTimeout(r, 800));
    const shifted = dockerExec(`cat ${OUT} 2>/dev/null || true`);
    if (shifted !== E2E_SHIFT) {
      throw new Error(
        `shifted punctuation not typed (expected ${JSON.stringify(E2E_SHIFT)}, got ${JSON.stringify(shifted)})`,
      );
    }
    ok(`remote terminal shows shifted punctuation "${E2E_SHIFT}"`);

    // Auto-repeat: multiple BackSpace injections must delete characters.
    prepareTarget();
    for (const ch of "abcd") {
      pump.stdin.write(`TYPE ${ch}\n`);
    }
    for (let i = 0; i < 3; i++) {
      pump.stdin.write("KEY BackSpace\n");
    }
    pump.stdin.write("KEY Return\n");
    await new Promise((r) => setTimeout(r, 1200));
    const afterBs = dockerExec(`cat ${OUT} 2>/dev/null || true`);
    if (afterBs !== "a") {
      throw new Error(
        `auto-repeat BackSpace failed (expected "a", got ${JSON.stringify(afterBs)})`,
      );
    }
    ok("repeated BackSpace deletes multiple characters");
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
