import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.js";
import { dockerExec, containerRunning } from "./docker.js";
import { logStep, logError } from "./logger.js";

const UI_FILE = path.join(STATE_DIR, "ui-commands.json");

const readUi = () => {
  try {
    if (!fs.existsSync(UI_FILE)) return { openInstallAt: null };
    return {
      openInstallAt: null,
      ...JSON.parse(fs.readFileSync(UI_FILE, "utf8")),
    };
  } catch {
    return { openInstallAt: null };
  }
};

const writeUi = (data) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(UI_FILE, JSON.stringify(data, null, 2));
};

export const requestOpenInstallAssistant = () => {
  const data = readUi();
  data.openInstallAt = new Date().toISOString();
  writeUi(data);
  return { ok: true, openInstallAt: data.openInstallAt };
};

export const getUiCommands = () => readUi();

export const consumeOpenInstallAssistant = () => {
  const data = readUi();
  const at = data.openInstallAt;
  if (!at) return { open: false };
  data.openInstallAt = null;
  writeUi(data);
  return { open: true, openInstallAt: at };
};

/** Open Install Assistant inside the XFCE desktop (not on the host). */
export const openInstallAssistantInDesktop = async () => {
  const flagged = requestOpenInstallAssistant();
  if (!(await containerRunning())) {
    return { ok: false, error: "Workspace is not running", ...flagged };
  }

  const res = await dockerExec(
    [
      "bash",
      "-lc",
      [
        "export HOME=/home/browser",
        "export DISPLAY=:1",
        "export XDG_RUNTIME_DIR=/tmp/runtime-browser",
        "export BRIDGE_CREDENTIALS_FILE=/home/browser/.bridge-credentials",
        "if [[ -S /tmp/runtime-browser/bus ]]; then export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/runtime-browser/bus; fi",
        // Avoid pkill -f patterns that match this bash -lc command line (SIGTERM/143).
        "nohup /opt/bridge/open-install-assistant.sh >>/tmp/open-install-assistant.log 2>&1 &",
        "echo OPENED",
      ].join("\n"),
    ],
    { user: "browser", timeoutMs: 8000 },
  );

  if (res.code !== 0 && !(res.stdout || "").includes("OPENED")) {
    logError("Failed to open Install Assistant in desktop", {
      detail: res.stderr || res.stdout,
    });
    return {
      ...flagged,
      ok: false,
      error: res.stderr || res.stdout || "Could not open Install Assistant",
    };
  }

  logStep("Opened Install Assistant inside workspace desktop");
  return { ...flagged, ok: true };
};

/** Match the Xvfb framebuffer to the Electron viewer pane (1:1 clicks). */
export const resizeDesktopDisplay = async (width, height) => {
  const w = Math.max(800, Math.min(3840, Math.floor(Number(width) || 0)));
  const h = Math.max(600, Math.min(2160, Math.floor(Number(height) || 0)));
  if (!(await containerRunning())) {
    return { ok: false, error: "Workspace is not running" };
  }

  const res = await dockerExec(
    ["bash", "/opt/bridge/resize-display.sh", String(w), String(h)],
    { user: "root", timeoutMs: 10000 },
  );

  if (res.code !== 0) {
    logError("Desktop display resize failed", {
      size: `${w}x${h}`,
      detail: res.stderr || res.stdout,
    });
    return {
      ok: false,
      error: res.stderr || res.stdout || "resize failed",
      width: w,
      height: h,
    };
  }

  return { ok: true, width: w, height: h, detail: (res.stdout || "").trim() };
};
