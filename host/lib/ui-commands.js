import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { STATE_DIR, CONTAINER_NAME } from "./paths.js";
import { dockerExec, containerRunning } from "./docker.js";
import { logStep, logError } from "./logger.js";

const UI_FILE = path.join(STATE_DIR, "ui-commands.json");

const readUi = () => {
  try {
    if (!fs.existsSync(UI_FILE)) {
      return { openInstallAt: null, hostHomeWriteConsent: null };
    }
    return {
      openInstallAt: null,
      hostHomeWriteConsent: null,
      ...JSON.parse(fs.readFileSync(UI_FILE, "utf8")),
    };
  } catch {
    return { openInstallAt: null, hostHomeWriteConsent: null };
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

/**
 * Ask the host desktop user to grant home write for an agent.
 * Keeps a single pending prompt (refreshes path/timestamp if same agent).
 */
export const requestHostHomeWriteConsentPrompt = ({
  agentId,
  agentName,
  path: deniedPath,
} = {}) => {
  if (!agentId) return { ok: false };
  const data = readUi();
  const prev = data.hostHomeWriteConsent;
  if (
    prev &&
    prev.agentId === agentId &&
    prev.at &&
    Date.now() - Date.parse(prev.at) < 15_000
  ) {
    // Debounce spam from Cursor save retries.
    return { ok: true, debounced: true, hostHomeWriteConsent: prev };
  }
  data.hostHomeWriteConsent = {
    agentId,
    agentName: agentName || agentId,
    path: deniedPath || "",
    at: new Date().toISOString(),
  };
  writeUi(data);
  return { ok: true, hostHomeWriteConsent: data.hostHomeWriteConsent };
};

export const consumeHostHomeWriteConsentPrompt = () => {
  const data = readUi();
  const pending = data.hostHomeWriteConsent;
  if (!pending) return { open: false };
  data.hostHomeWriteConsent = null;
  writeUi(data);
  return { open: true, ...pending };
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

/** Long-lived xdotool mouse injector inside the workspace container. */
let mousePump = null;

const ensureDesktopMousePump = () => {
  if (mousePump && !mousePump.killed && mousePump.stdin?.writable) {
    return mousePump;
  }
  mousePump = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "browser",
      "-e",
      "DISPLAY=:1",
      CONTAINER_NAME || "saaridge-box",
      "/opt/bridge/mouse-pump.sh",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  mousePump.on("exit", () => {
    mousePump = null;
  });
  mousePump.on("error", () => {
    mousePump = null;
  });
  return mousePump;
};

/**
 * Inject a mouse event into the workspace X session.
 * type: move | down | up | click
 */
export const injectDesktopMouse = async ({
  type = "move",
  x = 0,
  y = 0,
  button = 1,
} = {}) => {
  if (!(await containerRunning())) {
    return { ok: false, error: "Workspace is not running" };
  }
  const xi = Math.max(0, Math.round(Number(x) || 0));
  const yi = Math.max(0, Math.round(Number(y) || 0));
  const btn = Math.max(1, Math.min(5, Number(button) || 1));
  const t = String(type || "move");

  const pump = ensureDesktopMousePump();
  if (!pump?.stdin?.writable) {
    return { ok: false, error: "mouse pump unavailable" };
  }

  let line = "";
  if (t === "move") line = `MOVE ${xi} ${yi}\n`;
  else if (t === "down") line = `MOVE ${xi} ${yi}\nDOWN ${btn}\n`;
  else if (t === "up") line = `MOVE ${xi} ${yi}\nUP ${btn}\n`;
  else if (t === "click") line = `MOVE ${xi} ${yi}\nCLICK ${btn}\n`;
  else return { ok: false, error: `unknown type ${t}` };

  try {
    pump.stdin.write(line);
    return { ok: true, x: xi, y: yi, type: t, button: btn };
  } catch (err) {
    mousePump = null;
    return { ok: false, error: String(err?.message || err) };
  }
};
