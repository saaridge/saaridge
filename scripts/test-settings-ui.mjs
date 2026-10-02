#!/usr/bin/env node
/**
 * Settings window must never go blank when a policy mode is clicked.
 * Drives the real desktop/settings.html in Electron against a stub policy API
 * (no host or container needed).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "desktop", "node_modules", ".bin", "electron");
const MAIN = path.join(ROOT, "scripts", "lib", "settings-ui-electron.cjs");

console.log("== settings: mode click keeps the window painted ==");
if (!existsSync(ELECTRON)) {
  console.error("  FAIL  desktop Electron missing — run `npm run app:install`");
  process.exit(1);
}

const child = spawn(ELECTRON, [MAIN], {
  cwd: ROOT,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", () => {});
const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);

child.on("close", () => {
  clearTimeout(killer);
  const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) {
    console.error("  FAIL  Electron exited without a result");
    process.exit(1);
  }
  const result = JSON.parse(line.slice("RESULT:".length));
  if (result.ok) {
    console.log("  OK  every policy mode click keeps Settings in view");
    console.log("\nDone. failures=0");
    process.exit(0);
  }
  for (const f of result.failures) console.error(`  FAIL  ${f}`);
  console.log(`\nDone. failures=${result.failures.length}`);
  process.exit(1);
});
