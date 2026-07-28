#!/usr/bin/env node
/**
 * OneBridge desktop shell.
 *
 * Keyboard-critical design: the workspace noVNC page is the MAIN window
 * webContents (so macOS delivers keystrokes to it). The title bar is a
 * BrowserView overlay on top. Boot UI is a temporary full-window load.
 */
const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  shell,
  Menu,
} = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const CONTROL = "http://127.0.0.1:3847";
const DESKTOP = "http://127.0.0.1:6081/novnc-onebridge.html";
const TITLEBAR_H = 44;

let mainWindow = null;
let titleBarView = null;
let hostChild = null;
let bootPollTimer = null;
let desktopLive = false;
let lastResizeKey = "";
let forwardingKeys = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchJson = async (url, opts = {}, timeoutMs = 2500) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err };
  } finally {
    clearTimeout(t);
  }
};

const fetchOk = async (url, timeoutMs = 2500) => {
  const r = await fetchJson(url, {}, timeoutMs);
  return r.ok;
};

const waitFor = async (url, label, attempts = 60) => {
  for (let i = 0; i < attempts; i++) {
    if (await fetchOk(url)) return true;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label} (${url})`);
};

const sendBoot = (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("onebridge:boot", payload);
  }
};

const layoutTitleBar = () => {
  if (!mainWindow || mainWindow.isDestroyed() || !titleBarView) return;
  const [w] = mainWindow.getContentSize();
  titleBarView.setBounds({ x: 0, y: 0, width: Math.max(100, w), height: TITLEBAR_H });
};

const syncRemoteDisplay = () => {
  if (!mainWindow || mainWindow.isDestroyed() || !desktopLive) return;
  const [w, h] = mainWindow.getContentSize();
  let width = Math.max(800, Math.floor(w));
  let height = Math.max(600, Math.floor(h - TITLEBAR_H));
  width -= width % 2;
  height -= height % 2;
  const key = `${width}x${height}`;
  if (key === lastResizeKey) return;
  void fetchJson(
    `${CONTROL}/api/ui/resize-desktop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ width, height }),
    },
    8000,
  ).then((r) => {
    if (r.ok && r.body?.ok) lastResizeKey = key;
  });
};

const focusDesktop = () => {
  if (!mainWindow || mainWindow.isDestroyed() || !desktopLive) return;
  try {
    mainWindow.webContents.focus();
  } catch (_) {}
  void mainWindow.webContents
    .executeJavaScript(
      `(() => {
        try {
          const r = window.__onebridgeRfb;
          const s = document.getElementById('screen');
          if (s) { s.tabIndex = 0; s.focus(); }
          if (r) {
            if (r._canvas) r._canvas.tabIndex = 0;
            if (r._keyboard) {
              try { r._keyboard.ungrab(); } catch (e) {}
              r._keyboard._target = window;
              try { r._keyboard.grab(); } catch (e) {}
            }
            if (r.focus) r.focus();
          }
          window.focus();
        } catch (e) {}
      })()`,
      true,
    )
    .catch(() => {});
};

/** Persistent xdotool pipe — bypasses noVNC keyboard (unreliable in Electron). */
let keyPump = null;
let keyPumpBuf = "";

const XDOTOOL_SPECIAL = {
  Backspace: "BackSpace",
  Enter: "Return",
  Escape: "Escape",
  Tab: "Tab",
  Delete: "Delete",
  ArrowLeft: "Left",
  ArrowUp: "Up",
  ArrowRight: "Right",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  Insert: "Insert",
  " ": "space",
};

const ensureKeyPump = () => {
  if (keyPump && !keyPump.killed) return keyPump;
  keyPump = spawn(
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
  keyPump.on("exit", () => {
    keyPump = null;
  });
  return keyPump;
};

const injectKeyToX = (input) => {
  if (!desktopLive) return;
  // xdotool generates press+release; only act on keyDown.
  if (input.type !== "keyDown") return;
  if (input.isAutoRepeat) return;
  if (
    input.key === "Shift" ||
    input.key === "Control" ||
    input.key === "Alt" ||
    input.key === "Meta"
  ) {
    return;
  }

  const pump = ensureKeyPump();
  if (!pump?.stdin?.writable) return;

  const mods = [];
  if (input.control) mods.push("ctrl");
  if (input.alt) mods.push("alt");
  // Meta/Cmd on Mac → ctrl for Linux browser shortcuts often expected as ctrl
  if (input.meta) mods.push("ctrl");

  let line;
  if (input.key && input.key.length === 1 && !input.control && !input.alt && !input.meta) {
    line = `TYPE ${input.key}\n`;
  } else {
    const base = XDOTOOL_SPECIAL[input.key] || (input.key.length === 1 ? input.key : null);
    if (!base) return;
    const combo = mods.length ? `${mods.join("+")}+${base}` : base;
    line = `KEY ${combo}\n`;
  }
  try {
    fs.appendFileSync("/tmp/onebridge-keys.log", `${new Date().toISOString()} ${line}`);
  } catch (_) {}
  pump.stdin.write(line);
};

const attachKeyBridge = (webContents) => {
  webContents.on("before-input-event", (event, input) => {
    if (!desktopLive || forwardingKeys) return;
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    if (
      input.key === "Shift" ||
      input.key === "Control" ||
      input.key === "Alt" ||
      input.key === "Meta"
    ) {
      return;
    }
    // Steal the event from Chromium/noVNC and inject into the remote X session.
    event.preventDefault();
    forwardingKeys = true;
    try {
      injectKeyToX(input);
    } finally {
      forwardingKeys = false;
    }
  });
};

const showTitleBar = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!titleBarView) {
    titleBarView = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    titleBarView.setBackgroundColor("#121a17");
    titleBarView.webContents.setIgnoreMenuShortcuts(true);
    void titleBarView.webContents.loadFile(path.join(__dirname, "titlebar.html"));
    // Typing while the titlebar has focus must still reach the desktop.
    titleBarView.webContents.on("before-input-event", (event, input) => {
      if (!desktopLive) return;
      if (input.type !== "keyDown" && input.type !== "keyUp") return;
      if (
        input.key === "Shift" ||
        input.key === "Control" ||
        input.key === "Alt" ||
        input.key === "Meta"
      ) {
        return;
      }
      event.preventDefault();
      focusDesktop();
      injectKeyToX(input);
    });
  }
  mainWindow.setBrowserView(titleBarView);
  layoutTitleBar();
};

const hideTitleBar = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBrowserView(null);
};

const startHostIfNeeded = async () => {
  sendBoot({
    phase: "host",
    progress: 3,
    message: "Starting control plane…",
  });
  if (await fetchOk(`${CONTROL}/api/health`)) {
    return { already: true };
  }
  const logPath = "/tmp/onebridge-desktop-host.log";
  const out = fs.openSync(logPath, "a");
  const nodeBin = process.env.NODE_BINARY || "node";
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  hostChild = spawn(nodeBin, ["host/index.js"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  hostChild.unref();
  await waitFor(`${CONTROL}/api/health`, "control plane");
  return { already: false, logPath };
};

/** Ensure control plane is reachable; restart it if it died mid-boot. */
const ensureControlPlane = async () => {
  if (await fetchOk(`${CONTROL}/api/health`)) return;
  sendBoot({
    phase: "host",
    progress: 4,
    message: "Control plane stopped — restarting…",
  });
  await startHostIfNeeded();
};

const pollBootStatus = () => {
  if (bootPollTimer) return;
  bootPollTimer = setInterval(async () => {
    const r = await fetchJson(`${CONTROL}/api/container/boot`, {}, 1500);
    if (r.ok && r.body?.boot) {
      const b = r.body.boot;
      sendBoot({
        phase: b.phase,
        progress: b.progress,
        message: b.message,
        building: b.building,
        ready: b.ready,
        error: b.error,
      });
    }
  }, 400);
};

const stopBootPoll = () => {
  if (bootPollTimer) {
    clearInterval(bootPollTimer);
    bootPollTimer = null;
  }
};

const ensureWorkspace = async () => {
  sendBoot({
    phase: "checking",
    progress: 6,
    message: "Checking workspace image…",
  });
  pollBootStatus();

  await ensureControlPlane();

  let ensure = await fetchJson(
    `${CONTROL}/api/container/ensure`,
    { method: "POST" },
    45 * 60_000,
  );

  // Host may have died between health check and ensure — one restart+retry.
  if (!ensure.ok && /fetch failed|abort|ECONNREFUSED/i.test(String(ensure.error?.message || ""))) {
    sendBoot({
      phase: "host",
      progress: 5,
      message: "Reconnecting to control plane…",
    });
    await startHostIfNeeded();
    await ensureControlPlane();
    ensure = await fetchJson(
      `${CONTROL}/api/container/ensure`,
      { method: "POST" },
      45 * 60_000,
    );
  }

  if (!ensure.ok) {
    const detail =
      ensure.body?.error ||
      ensure.body?.boot?.error ||
      ensure.error?.message ||
      "Failed to start workspace";
    sendBoot({
      phase: "error",
      progress: ensure.body?.boot?.progress || 0,
      message: detail,
      error: detail,
      ready: false,
    });
    throw new Error(detail);
  }

  sendBoot({
    phase: "desktop_wait",
    progress: 96,
    message: "Opening desktop…",
  });
  await waitFor(DESKTOP, "workspace desktop", 90);
};

const openDesktop = async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  desktopLive = false;
  hideTitleBar();
  await mainWindow.loadURL(DESKTOP);
  desktopLive = true;
  showTitleBar();
  // Leave a top margin so the titlebar doesn't cover XFCE content:
  // remote FB is sized to (window - titlebar). noVNC scales into full window
  // including under titlebar — add CSS padding via injection.
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      const s = document.getElementById('screen');
      if (s) {
        s.style.top = '${TITLEBAR_H}px';
        s.style.height = 'calc(100% - ${TITLEBAR_H}px)';
      }
      document.documentElement.style.background = '#0b0b0b';
    })()`,
    true,
  );
  syncRemoteDisplay();
  setTimeout(focusDesktop, 100);
  setTimeout(focusDesktop, 500);
  setTimeout(syncRemoteDisplay, 400);
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "OneBridge",
    backgroundColor: "#0f1412",
    show: true,
    center: true,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.webContents.setIgnoreMenuShortcuts(true);
  attachKeyBridge(mainWindow.webContents);

  mainWindow.loadFile(path.join(__dirname, "shell.html"));

  const bringFront = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === "darwin" && app.dock) app.dock.show();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 1200);
  };

  mainWindow.once("ready-to-show", bringFront);
  mainWindow.webContents.once("did-finish-load", bringFront);
  mainWindow.on("resize", () => {
    layoutTitleBar();
    syncRemoteDisplay();
  });
  mainWindow.on("enter-full-screen", () => {
    layoutTitleBar();
    syncRemoteDisplay();
  });
  mainWindow.on("leave-full-screen", () => {
    layoutTitleBar();
    syncRemoteDisplay();
  });
  mainWindow.on("focus", () => {
    if (desktopLive) setTimeout(focusDesktop, 30);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("http://127.0.0.1:") ||
      url.startsWith("https://127.0.0.1:")
    ) {
      return { action: "allow" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    stopBootPoll();
    titleBarView = null;
    desktopLive = false;
    mainWindow = null;
  });
};

ipcMain.handle("onebridge:urls", () => ({
  desktop: DESKTOP,
  control: CONTROL,
}));

ipcMain.handle("onebridge:ready", async () => {
  try {
    await startHostIfNeeded();
    await ensureWorkspace();
    sendBoot({
      phase: "ready",
      progress: 100,
      message: "Ready",
      ready: true,
    });
    return { desktop: DESKTOP, control: CONTROL };
  } finally {
    stopBootPoll();
  }
});

ipcMain.handle("onebridge:show-desktop", async () => {
  await openDesktop();
  return { ok: true };
});

ipcMain.handle("onebridge:hide-desktop", async () => {
  // Used when opening modals — reload shell overlay by hiding titlebar only.
  // API key dialog lives in shell; reopen shell on top if needed.
  return { ok: true };
});

ipcMain.handle("onebridge:focus-desktop", async () => {
  focusDesktop();
  return { ok: true };
});

ipcMain.handle("onebridge:open-api-key", async () => {
  // Load shell API-key page in a small modal window so desktop keeps main focus path.
  const dlg = new BrowserWindow({
    width: 460,
    height: 520,
    parent: mainWindow || undefined,
    modal: true,
    show: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "API key",
    backgroundColor: "#151f1b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void dlg.loadFile(path.join(__dirname, "apikey.html"));
  dlg.on("closed", () => focusDesktop());
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopBootPoll();
  hostChild = null;
  if (process.platform !== "darwin") app.quit();
});
