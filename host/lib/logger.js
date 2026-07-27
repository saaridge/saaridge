import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./paths.js";

fs.mkdirSync(LOG_DIR, { recursive: true });

const write = (file, entry) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFileSync(path.join(LOG_DIR, file), line);
  const msg = `[${entry.level || "info"}] ${entry.message}`;
  if (entry.level === "error") console.error(msg, entry.detail || "");
  else console.log(msg);
};

export const logStep = (message, detail = {}) =>
  write("control-plane.log", { level: "info", message, ...detail });

export const logError = (message, detail = {}) =>
  write("control-plane.log", { level: "error", message, ...detail });

export const logBridge = (message, detail = {}) =>
  write("bridge.log", { level: "info", message, ...detail });

export const readLogs = (name = "control-plane.log", limit = 200) => {
  const file = path.join(LOG_DIR, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line };
      }
    });
};
