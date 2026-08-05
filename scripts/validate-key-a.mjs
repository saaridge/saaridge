#!/usr/bin/env node
/**
 * Reproduce keyboard 'a' behavior in Electron — logs quit/close and typed output.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const electron = path.join(ROOT, "desktop", "node_modules", ".bin", "electron");
const harness = path.join(__dirname, "lib", "keyboard-validate-a.cjs");

const prep = spawnSync(
  "docker",
  [
    "exec",
    "-u",
    "browser",
    "saaridge-box",
    "bash",
    "-lc",
    [
      "export DISPLAY=:1",
      "pkill -x xterm 2>/dev/null || true",
      "sleep 0.2",
      "rm -f /home/browser/kb-validate.txt",
      "xterm -title KB-VALIDATE -geometry 60x8+400+400 -e 'cat > /home/browser/kb-validate.txt' &",
      "sleep 1",
      "WID=$(xdotool search --name KB-VALIDATE | tail -1)",
      "xdotool windowactivate --sync \"$WID\"",
      "echo READY",
    ].join("\n"),
  ],
  { encoding: "utf8" },
);
console.log("container prep:", (prep.stdout || prep.stderr || "").trim());

const run = spawnSync(electron, [harness, process.argv[2] || "sendInputEvent"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 45000,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
});
console.log("--- electron stdout ---");
console.log(run.stdout || "");
console.log("--- electron stderr ---");
console.log(run.stderr || "");
console.log("exit:", run.status, run.error?.message || "");

const out = spawnSync(
  "docker",
  [
    "exec",
    "-u",
    "browser",
    "saaridge-box",
    "cat",
    "/home/browser/kb-validate.txt",
  ],
  { encoding: "utf8" },
);
console.log("--- typed file ---");
console.log(JSON.stringify((out.stdout || "").trim()));
