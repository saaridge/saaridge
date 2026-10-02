#!/usr/bin/env node
/**
 * Saaridge desktop shell.
 *
 * Keyboard-critical design: the workspace noVNC page is the MAIN window
 * webContents (so macOS delivers keystrokes to it). Chrome (Settings, etc.)
 * is injected into that same document — BrowserView overlays are unreliable
 * for clicks when the window is not maximized on macOS.
 *
 * Keys are stolen in before-input-event and injected via xdotool key-pump
 * into the focused X window (noVNC keyboard is unreliable in Electron).
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  dialog,
  session,
  clipboard,
  powerMonitor,
  screen,
} = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");
const { createHash } = require("node:crypto");
const {
  replacementBounds,
  nudgeSize,
  planDisplayWake,
} = require("./display-wake.cjs");

/** Repo root in dev; packaged install uses extraResources/saaridge-root. */
const resolveRoot = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "saaridge-root");
  }
  return path.resolve(__dirname, "..");
};

const ROOT = resolveRoot();
const CONTROL = "http://127.0.0.1:3847";
const DESKTOP = "http://127.0.0.1:6081/novnc-saaridge.html?titlebar=44";
const CHROME_INJECT = fs.readFileSync(
  path.join(__dirname, "inject-workspace-chrome.js"),
  "utf8",
);

app.setName("Saaridge");

// Display sleep frees the window IOSurface. Keep the renderer scheduled so a
// lock does not discard the layer before power/display recovery runs.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-features", "MacWebContentsOcclusion");
if (process.platform === "darwin") {
  app.setAboutPanelOptions({
    applicationName: "Saaridge",
    applicationVersion: app.getVersion?.() || "0.0.1",
    version: `${app.getVersion?.() || "0.0.1"} (alpha)`,
    copyright: "Copyright © 2026 Saariv",
  });
}

/** Avoid Electron's opaque "JavaScript error in the main process" dialog. */
let lastUncaughtDialogAt = 0;
process.on("uncaughtException", (err) => {
  const detail = String(err?.stack || err?.message || err);
  try {
    fs.appendFileSync("/tmp/saaridge-desktop-main.log", `[uncaught] ${detail}\n`);
  } catch (_) {}
  // docker CLI PATH misses are handled below — don't spam modal dialogs.
  if (/spawn docker ENOENT/i.test(detail)) return;
  const now = Date.now();
  if (now - lastUncaughtDialogAt < 15_000) return;
  lastUncaughtDialogAt = now;
  try {
    dialog.showErrorBox("Saaridge error", detail.slice(0, 1800));
  } catch (_) {}
});
process.on("unhandledRejection", (reason) => {
  const detail = String(reason?.stack || reason?.message || reason);
  try {
    fs.appendFileSync(
      "/tmp/saaridge-desktop-main.log",
      `[unhandledRejection] ${detail}\n`,
    );
  } catch (_) {}
});

/** Writable state for packaged apps (vault/policies/resources). */
const stateDir = () => path.join(app.getPath("userData"), "state");

/**
 * Packaged macOS apps get PATH=/usr/bin:/bin:/usr/sbin:/sbin — bare `docker`
 * fails with ENOENT. Resolve absolute CLI path like the host does.
 */
let cachedDockerBin = null;
const resolveDockerBin = () => {
  if (cachedDockerBin) return cachedDockerBin;
  if (process.env.DOCKER_BIN && fs.existsSync(process.env.DOCKER_BIN)) {
    cachedDockerBin = process.env.DOCKER_BIN;
    return cachedDockerBin;
  }
  const home = app.getPath("home");
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    path.join(home, "Applications/Docker.app/Contents/Resources/bin/docker"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedDockerBin = candidate;
        return cachedDockerBin;
      }
    } catch (_) {}
  }
  cachedDockerBin = "docker";
  return cachedDockerBin;
};

const withDockerPath = (env = process.env) => {
  const binDir = path.dirname(resolveDockerBin());
  const extras = [
    binDir,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
  ];
  const parts = String(env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin")
    .split(":")
    .filter(Boolean);
  for (const dir of extras.reverse()) {
    if (dir && !parts.includes(dir)) parts.unshift(dir);
  }
  return { ...env, PATH: parts.join(":") };
};

const hostEnv = () => {
  const env = withDockerPath({
    ...process.env,
    SAARIDGE_ROOT: ROOT,
    SAARIDGE_STATE_DIR: stateDir(),
    SAARIDGE_PACKAGED: app.isPackaged ? "1" : "0",
    SAARIDGE_PREFER_PULL: app.isPackaged ? "1" : process.env.SAARIDGE_PREFER_PULL || "0",
  });
  delete env.ELECTRON_RUN_AS_NODE;
  if (app.isPackaged) {
    env.SAARIDGE_NODE = process.execPath;
    env.SAARIDGE_ELECTRON_AS_NODE = "1";
  }
  return env;
};

let mainWindow = null;
let hostChild = null;
let bootPollTimer = null;
let consentPollTimer = null;
let consentDialog = null;
let desktopLive = false;
let streamHealTimer = null;
let streamHealInFlight = false;
/** SkyLight dropped the display id (lock / display sleep / system sleep). */
let surfaceStale = false;
/** True between lock-screen and unlock-screen. Dark wake must not rebuild yet. */
let screenLocked = false;
let wakeRecoverTimer = null;
let wakeRecoverInFlight = false;
/** Open Settings dialog — stream heal must not reload noVNC while this is set (macOS modal blanks parent). */
let settingsWindow = null;
let pendingDesktopReload = false;
let micCaptureWin = null;
let micStatus = { state: "off", message: "Microphone sharing is off" };

const micPrefsPath = () =>
  path.join(app.getPath("userData"), "mic-prefs.json");

const readMicPrefs = () => {
  try {
    const raw = fs.readFileSync(micPrefsPath(), "utf8");
    const j = JSON.parse(raw);
    return { shareMic: Boolean(j?.shareMic) };
  } catch {
    return { shareMic: false };
  }
};

const writeMicPrefs = (prefs) => {
  const next = { shareMic: Boolean(prefs?.shareMic) };
  fs.mkdirSync(path.dirname(micPrefsPath()), { recursive: true });
  fs.writeFileSync(micPrefsPath(), JSON.stringify(next, null, 2));
  return next;
};

const iconPath = () => {
  // Prefer packaged asar assets (build-resources is installer-only).
  const assetsPng = path.join(__dirname, "assets", "icon.png");
  if (fs.existsSync(assetsPng)) return assetsPng;
  if (process.platform === "darwin") {
    const icns = path.join(__dirname, "build-resources", "icon.icns");
    if (fs.existsSync(icns)) return icns;
  }
  if (process.platform === "win32") {
    const ico = path.join(__dirname, "build-resources", "icon.ico");
    if (fs.existsSync(ico)) return ico;
  }
  return assetsPng;
};

const APP_ICON = iconPath();

/** True once the user has confirmed workspace resource limits. */
const resourcesConfigured = async () => {
  const local = path.join(stateDir(), "private", "resources.json");
  if (fs.existsSync(local)) return true;
  const r = await fetchJson(`${CONTROL}/api/resources`, {}, 3000);
  return Boolean(r.ok && r.body?.configured);
};

/**
 * First launch: ask for memory/CPU/etc before creating the workspace.
 * Blocks until the user continues (saves prefs via control plane).
 */
let firstRunResourcesResolve = null;

const promptFirstRunResources = () =>
  new Promise((resolve) => {
    firstRunResourcesResolve = resolve;
    const dlg = new BrowserWindow({
      width: 560,
      height: 560,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      show: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      title: "Welcome to Saaridge",
      backgroundColor: "#0b100e",
      icon: APP_ICON,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (firstRunResourcesResolve === resolve) {
        firstRunResourcesResolve = null;
      }
      try {
        // Allow programmatic close after Continue.
        dlg.setClosable(true);
        if (!dlg.isDestroyed()) dlg.close();
      } catch (_) {}
      resolve();
    };
    dlg.on("closed", () => {
      if (!settled) {
        settled = true;
        if (firstRunResourcesResolve === resolve) {
          firstRunResourcesResolve = null;
        }
        resolve();
      }
    });
    void dlg.loadFile(path.join(__dirname, "first-run-resources.html"));
    promptFirstRunResources._finish = finish;
  });

const maybePromptFirstRunResources = async () => {
  if (await resourcesConfigured()) return;
  sendBoot({
    phase: "resources",
    progress: 18,
    message: "Choose workspace resources…",
  });
  await promptFirstRunResources();
};

const broadcastMicStatus = (payload) => {
  micStatus = { ...micStatus, ...payload };
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("saaridge:mic-status-broadcast", micStatus);
    } catch (_) {}
  }
};

const stopMicCapture = () => {
  if (micCaptureWin && !micCaptureWin.isDestroyed()) {
    try {
      micCaptureWin.webContents.send("saaridge:mic-command", "stop");
    } catch (_) {}
    try {
      micCaptureWin.destroy();
    } catch (_) {}
  }
  micCaptureWin = null;
};

const startMicCapture = () => {
  if (micCaptureWin && !micCaptureWin.isDestroyed()) {
    try {
      micCaptureWin.webContents.send("saaridge:mic-command", "start");
    } catch (_) {}
    return;
  }
  micCaptureWin = new BrowserWindow({
    width: 80,
    height: 80,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  micCaptureWin.on("closed", () => {
    micCaptureWin = null;
  });
  void micCaptureWin.loadFile(path.join(__dirname, "mic-capture.html"));
};

const syncMicSharing = (shareMic) => {
  if (shareMic) {
    broadcastMicStatus({
      state: "waiting",
      message: "Waiting for microphone permission…",
    });
    startMicCapture();
  } else {
    stopMicCapture();
    broadcastMicStatus({
      state: "off",
      message: "Microphone sharing is off",
    });
  }
};

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
    mainWindow.webContents.send("saaridge:boot", payload);
  }
};

const injectWorkspaceChrome = async () => {
  if (!mainWindow || mainWindow.isDestroyed() || !desktopLive) return;
  try {
    await mainWindow.webContents.executeJavaScript(CHROME_INJECT, true);
  } catch (_) {}
};

const focusDesktop = () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed() || !desktopLive) return;
  try {
    mainWindow.webContents.focus();
  } catch (_) {}
  void mainWindow.webContents
    .executeJavaScript(
      `(() => {
        try {
          const r = window.__saaridgeRfb;
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
let mousePump = null;
/** Clipboard pump: SETB64/GET ↔ X11 CLIPBOARD (stdio request/response). */
let clipboardPump = null;
let clipboardRl = null;
/** @type {Array<(line: string) => void>} */
let clipboardWaiters = [];
let clipboardChain = Promise.resolve();
let clipboardHostPollTimer = null;
let clipboardContainerPollTimer = null;
let lastHostClipFp = "";
let lastContainerClipFp = "";
let lastContainerPrimaryFp = "";
let lastHostPushedFp = "";
let lastContainerPulledFp = "";
let clipboardEchoUntil = 0;
let clipboardSizeWarned = false;

const CLIPBOARD_MAX_BYTES = 512 * 1024;
const CLIPBOARD_HOST_POLL_MS = 350;
const CLIPBOARD_CONTAINER_POLL_MS = 350;
const CLIPBOARD_ECHO_MS = 1200;
const CLIPBOARD_PASTE_SYNC_MS = 280;

const clipFingerprint = (text) =>
  createHash("sha256").update(String(text || ""), "utf8").digest("hex");

const stopInputPump = (pump) => {
  if (!pump || pump.killed) return;
  try {
    pump.stdin?.end();
  } catch (_) {}
  try {
    pump.kill();
  } catch (_) {}
};

const stopClipboardPump = () => {
  clipboardWaiters.splice(0).forEach((w) => {
    try {
      w("");
    } catch (_) {}
  });
  try {
    clipboardRl?.close();
  } catch (_) {}
  clipboardRl = null;
  stopInputPump(clipboardPump);
  clipboardPump = null;
};

const stopClipboardSync = () => {
  if (clipboardHostPollTimer) {
    clearInterval(clipboardHostPollTimer);
    clipboardHostPollTimer = null;
  }
  if (clipboardContainerPollTimer) {
    clearInterval(clipboardContainerPollTimer);
    clipboardContainerPollTimer = null;
  }
  stopClipboardPump();
};

const restartInputPumps = () => {
  stopInputPump(keyPump);
  stopInputPump(mousePump);
  keyPump = null;
  mousePump = null;
  ensureKeyPump();
  ensureMousePump();
  stopClipboardPump();
  ensureClipboardPump();
  startClipboardSync();
};

/** Keep macOS app shortcuts local — do not forward to the remote desktop. */
const isLocalAppShortcut = (input) => {
  if (input.type !== "keyDown") return false;
  if (process.platform !== "darwin" || !input.meta) return false;
  const key = String(input.key || "").toLowerCase();
  return key === "q" || key === "w" || key === "h" || key === "m";
};

const installAppMenu = () => {
  Menu.setApplicationMenu(null);
};

const ensureKeyPump = () => {
  if (keyPump && !keyPump.killed) return keyPump;
  keyPump = spawn(
    resolveDockerBin(),
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
    { stdio: ["pipe", "ignore", "ignore"], env: withDockerPath() },
  );
  keyPump.on("error", () => {
    keyPump = null;
  });
  keyPump.on("exit", () => {
    keyPump = null;
  });
  return keyPump;
};

const ensureMousePump = () => {
  if (mousePump && !mousePump.killed) return mousePump;
  mousePump = spawn(
    resolveDockerBin(),
    [
      "exec",
      "-i",
      "-u",
      "browser",
      "-e",
      "DISPLAY=:1",
      "saaridge-box",
      "/opt/bridge/mouse-pump.sh",
    ],
    { stdio: ["pipe", "ignore", "ignore"], env: withDockerPath() },
  );
  mousePump.on("error", () => {
    mousePump = null;
  });
  mousePump.on("exit", () => {
    mousePump = null;
  });
  return mousePump;
};

const ensureClipboardPump = () => {
  if (clipboardPump && !clipboardPump.killed) return clipboardPump;
  clipboardPump = spawn(
    resolveDockerBin(),
    [
      "exec",
      "-i",
      "-u",
      "browser",
      "-e",
      "DISPLAY=:1",
      "saaridge-box",
      "stdbuf",
      "-oL",
      "-eL",
      "/opt/bridge/clipboard-pump.sh",
    ],
    { stdio: ["pipe", "pipe", "ignore"], env: withDockerPath() },
  );
  clipboardPump.on("error", () => {
    clipboardPump = null;
    try {
      clipboardRl?.close();
    } catch (_) {}
    clipboardRl = null;
  });
  clipboardRl = readline.createInterface({
    input: clipboardPump.stdout,
    crlfDelay: Infinity,
  });
  clipboardRl.on("line", (line) => {
    const waiter = clipboardWaiters.shift();
    if (waiter) waiter(String(line || ""));
  });
  clipboardPump.on("exit", () => {
    clipboardPump = null;
    try {
      clipboardRl?.close();
    } catch (_) {}
    clipboardRl = null;
    clipboardWaiters.splice(0).forEach((w) => {
      try {
        w("");
      } catch (_) {}
    });
  });
  return clipboardPump;
};

/** Serialize clipboard pump request/response. */
const clipboardCommand = (line, timeoutMs = 1500) => {
  clipboardChain = clipboardChain
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve) => {
          const pump = ensureClipboardPump();
          if (!pump?.stdin?.writable) {
            resolve("");
            return;
          }
          let settled = false;
          const finish = (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(val);
          };
          const timer = setTimeout(() => finish(""), timeoutMs);
          clipboardWaiters.push(finish);
          try {
            pump.stdin.write(`${line}\n`);
          } catch (_) {
            // Drop waiter we just pushed
            const idx = clipboardWaiters.lastIndexOf(finish);
            if (idx >= 0) clipboardWaiters.splice(idx, 1);
            finish("");
          }
        }),
    );
  return clipboardChain;
};

const mediateHostClipboardText = async (text) => {
  const raw = String(text || "");
  if (!raw) return "";
  if (Buffer.byteLength(raw, "utf8") > CLIPBOARD_MAX_BYTES) {
    if (!clipboardSizeWarned) {
      clipboardSizeWarned = true;
      console.warn(
        "[saaridge] clipboard sync skipped: text exceeds 512KiB cap",
      );
    }
    return null; // signal skip
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 400);
    const res = await fetch(`${CONTROL}/api/desktop/mediate-clipboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: raw }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => ({}));
    if (j?.denied) return "";
    return j?.text == null ? "" : String(j.text);
  } catch (_) {
    return ""; // fail-closed
  }
};

const setContainerClipboard = async (text) => {
  const raw = String(text ?? "");
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const reply = await clipboardCommand(`SETB64 ${b64}`, 2000);
  if (String(reply).startsWith("OK")) {
    const fp = clipFingerprint(raw);
    lastHostPushedFp = fp;
    lastContainerClipFp = fp;
    lastContainerPrimaryFp = fp;
    clipboardEchoUntil = Date.now() + CLIPBOARD_ECHO_MS;
    return true;
  }
  return false;
};

/**
 * Read X11 CLIPBOARD + PRIMARY. Many Linux apps put Ctrl+C in CLIPBOARD;
 * selection-only / some terminals only update PRIMARY — we must watch both.
 * @returns {{ clipboard: string, primary: string } | null}
 */
const getContainerSelections = async () => {
  const reply = await clipboardCommand("GET", 2000);
  if (!String(reply).startsWith("OKB64")) return null;
  const rest = String(reply).slice(5).trim();
  let cB64 = "";
  let pB64 = "";
  // New: "c=<b64> p=<b64>"  Legacy: bare "<b64>" or empty
  const cm = rest.match(/(?:^|\s)c=([^\s]*)/);
  const pm = rest.match(/(?:^|\s)p=([^\s]*)/);
  if (cm || pm) {
    cB64 = cm ? cm[1] : "";
    pB64 = pm ? pm[1] : "";
  } else if (rest) {
    cB64 = rest;
  }
  const decode = (b) => {
    if (!b) return "";
    try {
      return Buffer.from(b, "base64").toString("utf8");
    } catch (_) {
      return "";
    }
  };
  return { clipboard: decode(cB64), primary: decode(pB64) };
};

const desktopWindowFocused = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isFocused();
};

const pushHostClipboardIfChanged = async () => {
  // Only push Mac→container while the workspace is focused (don't steal when
  // the user is in another host app).
  if (!desktopLive || !desktopWindowFocused()) return;
  let hostText = "";
  try {
    hostText = clipboard.readText() || "";
  } catch (_) {
    return;
  }
  const fp = clipFingerprint(hostText);
  if (fp === lastHostClipFp) return;
  lastHostClipFp = fp;
  if (Date.now() < clipboardEchoUntil && fp === lastContainerPulledFp) return;
  if (fp === lastHostPushedFp) return;
  const mediated = await mediateHostClipboardText(hostText);
  if (mediated === null) return; // oversize skip
  await setContainerClipboard(mediated);
};

const pullContainerClipboardIfChanged = async () => {
  // Pull whenever the desktop session is live — user often copies in-container
  // then immediately Cmd/Ctrl+Tabs to a host app to paste.
  if (!desktopLive) return;
  const sels = await getContainerSelections();
  if (!sels) return;

  const cFp = clipFingerprint(sels.clipboard);
  const pFp = clipFingerprint(sels.primary);
  const clipChanged = cFp !== lastContainerClipFp;
  const primChanged = pFp !== lastContainerPrimaryFp;
  if (!clipChanged && !primChanged) return;

  // Prefer the selection that actually changed; CLIPBOARD wins if both did.
  let remote = "";
  let usedFp = "";
  if (clipChanged && sels.clipboard) {
    remote = sels.clipboard;
    usedFp = cFp;
  } else if (primChanged && sels.primary) {
    remote = sels.primary;
    usedFp = pFp;
  } else if (clipChanged) {
    // Cleared clipboard — still update fingerprints, don't wipe host
    lastContainerClipFp = cFp;
    lastContainerPrimaryFp = pFp;
    return;
  } else {
    lastContainerClipFp = cFp;
    lastContainerPrimaryFp = pFp;
    return;
  }

  lastContainerClipFp = cFp;
  lastContainerPrimaryFp = pFp;

  if (Date.now() < clipboardEchoUntil && usedFp === lastHostPushedFp) return;
  if (usedFp === lastContainerPulledFp) return;
  try {
    clipboard.writeText(remote);
    lastContainerPulledFp = usedFp;
    lastHostClipFp = usedFp;
    clipboardEchoUntil = Date.now() + CLIPBOARD_ECHO_MS;
  } catch (_) {}
};

const startClipboardSync = () => {
  if (clipboardHostPollTimer) clearInterval(clipboardHostPollTimer);
  if (clipboardContainerPollTimer) clearInterval(clipboardContainerPollTimer);
  // Seed fingerprints so we don't immediately overwrite host with stale X clip.
  void (async () => {
    try {
      const hostText = clipboard.readText() || "";
      lastHostClipFp = clipFingerprint(hostText);
      lastHostPushedFp = lastHostClipFp;
      const sels = await getContainerSelections();
      if (sels) {
        lastContainerClipFp = clipFingerprint(sels.clipboard);
        lastContainerPrimaryFp = clipFingerprint(sels.primary);
        // Prefer not to yank stale X into host on boot; wait for a real change.
        lastContainerPulledFp = lastContainerClipFp || lastContainerPrimaryFp;
      }
    } catch (_) {}
  })();
  clipboardHostPollTimer = setInterval(() => {
    void pushHostClipboardIfChanged();
  }, CLIPBOARD_HOST_POLL_MS);
  clipboardContainerPollTimer = setInterval(() => {
    void pullContainerClipboardIfChanged();
  }, CLIPBOARD_CONTAINER_POLL_MS);
};

/** Sync host pasteboard into X before Ctrl/Cmd+V (never drop the key). */
const syncHostClipboardForPaste = async () => {
  let hostText = "";
  try {
    hostText = clipboard.readText() || "";
  } catch (_) {
    return;
  }
  // CONSTRAINTS: host→agent-visible text must pass control/lib (fail-closed).
  const mediated = await mediateHostClipboardText(hostText);
  if (mediated === null) return;
  await Promise.race([
    setContainerClipboard(mediated),
    new Promise((r) => setTimeout(r, CLIPBOARD_PASTE_SYNC_MS)),
  ]);
};

/**
 * Editing chords that must reach the Linux desktop as Ctrl+… (macOS Cmd ≡ Ctrl).
 * Only Cmd/Ctrl+V moves host pasteboard bytes into the container — that path is
 * mediated. A/Z/S/X/C/F are keystrokes only (no host text ingress).
 */
const EDITING_CHORD_KEYS = new Set([
  "a", // select all
  "z", // undo (Shift+Z → redo when shift held)
  "y", // redo (common)
  "x", // cut
  "c", // copy
  "v", // paste (mediated pre-sync)
  "s", // save
  "f", // find
]);

const isEditingChord = (input) => {
  if (input.type !== "keyDown") return false;
  if (!(input.control || input.meta)) return false;
  if (input.alt) return false;
  const key = String(input.key || "").toLowerCase();
  return EDITING_CHORD_KEYS.has(key);
};

/** Paste shortcuts: Ctrl+V everywhere; Cmd+V on macOS → same remote Ctrl+V. */
const isPasteShortcut = (input) => {
  if (input.type !== "keyDown") return false;
  const key = String(input.key || "").toLowerCase();
  if (key === "v" && (input.control || input.meta)) return true;
  if (key === "insert" && input.shift && !input.meta && !input.alt) return true;
  return false;
};

/** Copy/cut in the container → refresh host pasteboard promptly (host is trusted). */
const isCopyOrCutShortcut = (input) => {
  if (input.type !== "keyDown") return false;
  if (!(input.control || input.meta) || input.alt) return false;
  const key = String(input.key || "").toLowerCase();
  return key === "c" || key === "x";
};

const injectMouseToX = (payload) => {
  if (!desktopLive || !payload) return;
  const pump = ensureMousePump();
  if (!pump?.stdin?.writable) return;
  const type = String(payload.type || "");
  const x = Math.round(Number(payload.x) || 0);
  const y = Math.round(Number(payload.y) || 0);
  const button = Math.max(1, Math.min(5, Number(payload.button) || 1));
  let line = "";
  if (type === "move") line = `MOVE ${x} ${y}\n`;
  else if (type === "down") line = `MOVE ${x} ${y}\nDOWN ${button}\n`;
  else if (type === "up") line = `MOVE ${x} ${y}\nUP ${button}\n`;
  else if (type === "click") line = `MOVE ${x} ${y}\nCLICK ${button}\n`;
  else return;
  try {
    pump.stdin.write(line);
  } catch (_) {}
};

/** Electron steals keys → xdotool into focused X window (HEAD path). */
const injectKeyToX = (input) => {
  if (!desktopLive) return;
  const { buildKeyPumpCommand } = require("./key-inject.cjs");
  const line = buildKeyPumpCommand(input);
  if (!line) return;
  const pump = ensureKeyPump();
  if (!pump?.stdin?.writable) return;
  try {
    pump.stdin.write(line);
  } catch (_) {}
};

const attachKeyBridge = (webContents) => {
  webContents.on("before-input-event", (event, input) => {
    if (isLocalAppShortcut(input)) {
      event.preventDefault();
      const key = String(input.key || "").toLowerCase();
      if (key === "q") {
        app.quit();
      } else if (key === "w" && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      } else if (key === "h" && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      } else if (key === "m" && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
      }
      return;
    }

    if (!desktopLive) return;
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    if (
      input.key === "Shift" ||
      input.key === "Control" ||
      input.key === "Alt" ||
      input.key === "Meta"
    ) {
      // Still swallow so noVNC does not see bare modifiers without keyDown pairs.
      event.preventDefault();
      return;
    }

    // Always take keys so Electron/macOS/noVNC never eat Ctrl/Cmd editing chords.
    event.preventDefault();
    if (input.type !== "keyDown") return;
    // Drop auto-repeat for chords; keep repeat for plain characters via TYPE path.
    if (input.isAutoRepeat && (input.control || input.meta || input.alt)) return;

    if (isPasteShortcut(input)) {
      // Do not block the whole keyboard on clipboard sync — only this paste.
      void (async () => {
        try {
          await syncHostClipboardForPaste();
        } catch (_) {}
        injectKeyToX(input);
      })();
      return;
    }

    injectKeyToX(input);
    // After copy/cut in the guest, pull X CLIPBOARD/PRIMARY onto the host soon.
    if (isCopyOrCutShortcut(input)) {
      for (const ms of [80, 200, 450, 900]) {
        setTimeout(() => {
          void pullContainerClipboardIfChanged();
        }, ms);
      }
    }
  });
};

const openDesktop = async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    pendingDesktopReload = true;
    return;
  }
  desktopLive = false;
  await mainWindow.loadURL(DESKTOP);
  desktopLive = true;
  await injectWorkspaceChrome();
  restartInputPumps();
  // Titlebar inset is already applied by novnc-saaridge.html (?titlebar=44).
  setTimeout(focusDesktop, 100);
  setTimeout(focusDesktop, 500);
};

const flushPendingDesktopReload = async () => {
  if (!pendingDesktopReload) return;
  pendingDesktopReload = false;
  await openDesktop();
};

/** Retail boot: Docker must be up before the control plane can start the workspace. */
const ensureDocker = async () => {
  sendBoot({
    phase: "docker",
    progress: 1,
    message: "Checking Docker…",
  });
  const script = path.join(ROOT, "scripts", "ensure-docker.sh");
  await new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      cwd: ROOT,
      env: withDockerPath(),
    });
    let err = "";
    child.stdout?.on("data", (d) => {
      const line = String(d)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (line) {
        sendBoot({
          phase: "docker",
          progress: 2,
          message: line.replace(/^\[saaridge\]\s*/i, ""),
        });
      }
    });
    child.stderr?.on("data", (d) => {
      err += String(d);
      const line = String(d)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (line && !/display dialog/i.test(line)) {
        sendBoot({
          phase: "docker",
          progress: 2,
          message: line.replace(/^\[saaridge\]\s*/i, ""),
        });
      }
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            (err || "").trim() ||
              "Docker is required. Install Docker Desktop, then open Saaridge again.",
          ),
        );
      }
    });
  });
  sendBoot({
    phase: "docker",
    progress: 3,
    message: "Docker is ready",
  });
};

const startHostIfNeeded = async ({ forceRestart = false } = {}) => {
  sendBoot({
    phase: "host",
    progress: 3,
    message: forceRestart
      ? "Restarting control plane…"
      : "Starting control plane…",
  });

  const modulesOk = async () => {
    const r = await fetchJson(`${CONTROL}/api/desktop/stream-health`, {}, 5000);
    return r.status === 200 || r.status === 503;
  };

  const hostBrandOk = async () => {
    const r = await fetchJson(`${CONTROL}/api/health`, {}, 3000);
    if (!r.ok || !r.body?.ok) return false;
    return r.body?.brand?.container === "saaridge-box";
  };

  const hostReady = async () =>
    (await fetchOk(`${CONTROL}/api/health`)) &&
    (await modulesOk()) &&
    (await hostBrandOk());

  /** Old hosts reported hostRfb true but top-level ok false (inside spread bug). */
  const streamHealthLooksStale = async () => {
    const r = await fetchJson(`${CONTROL}/api/desktop/stream-health`, {}, 5000);
    const top = r.body?.ok;
    const h = r.body?.health;
    if (top === true) return false;
    if (!h || r.status === 404) return false;
    return Boolean(h.hostRfb && h.novncHttp && h.hostWsPort && h.ok === false);
  };

  const stale = await streamHealthLooksStale();
  if (!forceRestart && (await hostReady()) && !stale) {
    return { already: true };
  }
  if (stale) {
    forceRestart = true;
  }

  // One clean takeover: stop every supervisor/host (including fighting copies),
  // free ports, then start a single flock-guarded supervisor.
  sendBoot({
    phase: "host",
    progress: 3,
    message: "Resetting control plane…",
  });
  await new Promise((resolve) => {
    const stop = spawn(
      "bash",
      [
        "-lc",
        `SAARIDGE_ROOT=${JSON.stringify(ROOT)} source ${JSON.stringify(
          path.join(ROOT, "scripts/lib/host-stack.sh"),
        )} && saaridge_stop_host_stack`,
      ],
      { cwd: ROOT, stdio: "ignore" },
    );
    stop.on("close", () => resolve());
    stop.on("error", () => resolve());
  });

  const logPath = "/tmp/saaridge-desktop-host.log";
  const supervisorLog = "/tmp/saaridge-host-supervisor.log";
  const out = fs.openSync(logPath, "a");
  const env = hostEnv();
  const startHostSh = path.join(ROOT, "scripts", "start-host.sh");
  hostChild = spawn("bash", [startHostSh], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  hostChild.unref();

  sendBoot({
    phase: "host",
    progress: 4,
    message: "Waiting for control plane…",
  });

  // ~45s — host may need a retry after EADDRINUSE heal.
  for (let i = 0; i < 90; i++) {
    if (await hostReady()) {
      sendBoot({
        phase: "host",
        progress: 5,
        message: "Control plane ready",
      });
      return { already: false, logPath };
    }
    if (i === 20 || i === 40 || i === 60) {
      sendBoot({
        phase: "host",
        progress: 4,
        message: `Still starting control plane… (${Math.round(i * 0.5)}s)`,
      });
    }
    await sleep(500);
  }

  let tail = "";
  try {
    const hostLog = fs.readFileSync("/tmp/saaridge-host.log", "utf8");
    tail = hostLog.trim().split("\n").slice(-25).join("\n");
  } catch (_) {
    try {
      tail = fs.readFileSync(supervisorLog, "utf8").trim().split("\n").slice(-25).join("\n");
    } catch (__) {}
  }
  throw new Error(
    `Timed out waiting for control plane (${CONTROL}).` +
      (tail ? `\n\nLast host log:\n${tail}` : ` See ${logPath} and /tmp/saaridge-host.log`),
  );
};

/** Ensure control plane is reachable and modules load; restart if it died mid-boot. */
const ensureControlPlane = async () => {
  const modulesOk = async () => {
    const r = await fetchJson(`${CONTROL}/api/desktop/stream-health`, {}, 5000);
    return r.status === 200 || r.status === 503;
  };
  if ((await fetchOk(`${CONTROL}/api/health`)) && (await modulesOk())) return;
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
    const recoverable =
      /manifest unknown|not found|port is already allocated|address already in use|already in use by container|legacy/i.test(
        String(detail),
      );
    if (recoverable) {
      sendBoot({
        phase: "host",
        progress: 5,
        message: "Recovering from workspace migrate error…",
      });
      await startHostIfNeeded({ forceRestart: true });
      await ensureControlPlane();
      ensure = await fetchJson(
        `${CONTROL}/api/container/ensure`,
        { method: "POST" },
        45 * 60_000,
      );
    }
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

/** Verify RFB stream is live (not just noVNC HTML). Heal if needed. */
const ensureStreamReady = async () => {
  sendBoot({
    phase: "stream",
    progress: 97,
    message: "Checking desktop stream…",
  });
  let health = await fetchJson(`${CONTROL}/api/desktop/stream-health`, {}, 8000);
  if (health.ok && health.body?.ok) return health.body;

  sendBoot({
    phase: "stream",
    progress: 98,
    message: "Starting desktop stream…",
  });
  const ensure = await fetchJson(
    `${CONTROL}/api/desktop/ensure-stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
    },
    30_000,
  );
  if (!ensure.ok || !ensure.body?.ok) {
    // Older control plane without the route — fall back to full ensure.
    if (ensure.status === 404) {
      await fetchJson(
        `${CONTROL}/api/container/ensure`,
        { method: "POST" },
        45 * 60_000,
      );
    } else {
      const detail =
        ensure.body?.error ||
        ensure.error?.message ||
        "Desktop stream failed to start";
      sendBoot({
        phase: "error",
        progress: 98,
        message: detail,
        error: detail,
        ready: false,
      });
      throw new Error(detail);
    }
  }

  for (let i = 0; i < 40; i++) {
    health = await fetchJson(`${CONTROL}/api/desktop/stream-health`, {}, 5000);
    if (health.ok && health.body?.ok) return health.body;
    // 404 = host not yet restarted with new routes; HTML up is best-effort.
    if (health.status === 404 && (await fetchOk(DESKTOP))) return { ok: true };
    await sleep(250);
  }
  throw new Error("Timed out waiting for desktop stream");
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Saaridge",
    backgroundColor: "#0f1412",
    icon: APP_ICON,
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

  installAppMenu();
  mainWindow.webContents.setIgnoreMenuShortcuts(true);
  attachKeyBridge(mainWindow.webContents);

  mainWindow.loadFile(path.join(__dirname, "shell.html"));

  const bringFront = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (settingsWindow && !settingsWindow.isDestroyed()) return;
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
  mainWindow.webContents.on("did-finish-load", () => {
    if (!desktopLive || !mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (url.includes("novnc-saaridge")) {
      void injectWorkspaceChrome();
    }
  });
  mainWindow.on("focus", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) return;
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

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logDisplayWake(`renderer gone ${details?.reason || "unknown"}`);
    noteDisplaySleep("render-process-gone");
    scheduleDisplayWakeRecovery("render-process-gone");
  });
  const wakeIfSurfaceStale = () => scheduleDisplayWakeRecovery("window-show");
  mainWindow.on("show", wakeIfSurfaceStale);
  mainWindow.on("focus", wakeIfSurfaceStale);

  mainWindow.on("closed", () => {
    stopBootPoll();
    stopStreamHeal();
    stopClipboardSync();
    desktopLive = false;
    mainWindow = null;
  });
};

ipcMain.handle("saaridge:urls", () => ({
  desktop: DESKTOP,
  control: CONTROL,
}));

ipcMain.handle("saaridge:ready", async () => {
  try {
    await ensureDocker();
    await startHostIfNeeded();
    await maybePromptFirstRunResources();
    await ensureWorkspace();
    await ensureStreamReady();
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

ipcMain.handle("saaridge:complete-first-run-resources", async () => {
  if (typeof promptFirstRunResources._finish === "function") {
    promptFirstRunResources._finish();
  }
  return { ok: true };
});

ipcMain.handle("saaridge:show-desktop", async () => {
  await ensureStreamReady().catch(() => {});
  await openDesktop();
  startStreamHeal();
  return { ok: true };
});

ipcMain.handle("saaridge:hide-desktop", async () => {
  return { ok: true };
});

ipcMain.handle("saaridge:focus-desktop", async () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    return { ok: true, skipped: "settings-open" };
  }
  focusDesktop();
  return { ok: true };
});

ipcMain.on("saaridge:mouse", (_event, payload) => {
  injectMouseToX(payload);
});

const openSettingsWindow = (pane = "policies") => {
  const allowed = new Set(["policies", "microphone", "resources"]);
  const safePane = allowed.has(pane) ? pane : "policies";
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.webContents.send("saaridge:settings-pane", safePane);
    return { ok: true, reused: true };
  }
  // macOS: modal child of the noVNC window often blanks the parent WebContents.
  const useModal =
    process.platform !== "darwin" && mainWindow && !mainWindow.isDestroyed();
  const dlg = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    parent: useModal ? mainWindow : undefined,
    modal: useModal,
    show: false,
    paintWhenInitiallyHidden: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: "Settings",
    backgroundColor: "#151f1b",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  settingsWindow = dlg;
  void dlg.loadFile(path.join(__dirname, "settings.html"), {
    query: { pane: safePane },
  });
  dlg.once("ready-to-show", () => {
    if (dlg.isDestroyed()) return;
    dlg.show();
    dlg.focus();
  });
  dlg.on("closed", () => {
    settingsWindow = null;
    void flushPendingDesktopReload().then(() => focusDesktop());
  });
  return { ok: true };
};

ipcMain.handle("saaridge:open-settings", async (_event, pane) =>
  openSettingsWindow(pane),
);

ipcMain.handle("saaridge:open-policies", async () =>
  openSettingsWindow("policies"),
);

ipcMain.handle("saaridge:mic-prefs-get", async () => ({
  ...readMicPrefs(),
  status: micStatus,
}));

ipcMain.handle("saaridge:mic-prefs-set", async (_event, prefs) => {
  const next = writeMicPrefs(prefs);
  syncMicSharing(next.shareMic);
  return { ok: true, ...next, status: micStatus };
});

ipcMain.on("saaridge:mic-status", (_event, payload) => {
  broadcastMicStatus(payload || {});
  if (payload?.state === "denied" || payload?.state === "error") {
    // Keep preference on so user can retry; status reflects failure.
  }
});

ipcMain.handle("saaridge:open-microphone", async () =>
  openSettingsWindow("microphone"),
);

const saveHostHomeWrite = async (agentId, body) => {
  const r = await fetchJson(
    `${CONTROL}/api/agents/${encodeURIComponent(agentId)}/host-home-write`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    5000,
  );
  return r;
};

const openHostHomeConsent = async (pending) => {
  if (!pending?.agentId) return;
  if (consentDialog) return; // one prompt at a time
  consentDialog = true;
  try {
    // Consume so we don't re-open every poll tick.
    await fetchJson(`${CONTROL}/api/ui/consume-host-home-consent`, {
      method: "POST",
    });

    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const agentLabel = pending.agentName || pending.agentId;
    const pathLine = pending.path ? `Path: ${pending.path}\n\n` : "";

    const first = await dialog.showMessageBox(win || undefined, {
      type: "warning",
      buttons: ["Allow home write", "Deny"],
      defaultId: 0,
      cancelId: 1,
      title: "Allow write to host home?",
      message: `${agentLabel} wants to write under your Mac home folder.`,
      detail:
        pathLine +
        "Without this permission, the agent cannot create or edit files under your home folder. " +
        "Projects under ~/Saaridge still work.\n\n" +
        "This is a Saaridge host-user grant — not container sudo.",
    });

    if (first.response === 0) {
      const r = await saveHostHomeWrite(pending.agentId, { grant: true });
      if (!r.ok) {
        await dialog.showMessageBox(win || undefined, {
          type: "error",
          message: "Could not save home-write grant",
          detail: r.body?.error || String(r.status),
        });
      }
      return;
    }

    // Denied — explain impact and offer retry or skip.
    const follow = await dialog.showMessageBox(win || undefined, {
      type: "info",
      buttons: ["Allow home write", "Skip anyway"],
      defaultId: 0,
      cancelId: 1,
      title: "Home write denied",
      message: "The agent will not be able to write under your Mac home folder.",
      detail:
        "It can still read/browse home files and use ~/Saaridge projects.\n\n" +
        "• Allow home write — grant permission now\n" +
        "• Skip anyway — continue without write access (you can allow later if asked again)",
    });

    if (follow.response === 0) {
      const r = await saveHostHomeWrite(pending.agentId, { grant: true });
      if (!r.ok) {
        await dialog.showMessageBox(win || undefined, {
          type: "error",
          message: "Could not save home-write grant",
          detail: r.body?.error || String(r.status),
        });
      }
      return;
    }

    // Skip anyway — persist decline so we do not keep auto-prompting.
    const skip = await saveHostHomeWrite(pending.agentId, {
      grant: false,
      skipped: true,
    });
    if (!skip.ok) {
      await dialog.showMessageBox(win || undefined, {
        type: "error",
        message: "Could not save your choice",
        detail: skip.body?.error || String(skip.status),
      });
    }
  } finally {
    consentDialog = false;
  }
};

const startConsentPoll = () => {
  if (consentPollTimer) return;
  consentPollTimer = setInterval(async () => {
    const r = await fetchJson(`${CONTROL}/api/ui/commands`, {}, 1500);
    const pending = r.body?.hostHomeWriteConsent;
    if (pending?.agentId) {
      await openHostHomeConsent(pending);
    }
  }, 2000);
};

const stopConsentPoll = () => {
  if (consentPollTimer) {
    clearInterval(consentPollTimer);
    consentPollTimer = null;
  }
};

const logDisplayWake = (message) => {
  try {
    fs.appendFileSync(
      "/tmp/saaridge-desktop-main.log",
      `[display-wake] ${message}\n`,
    );
  } catch (_) {}
};

const noteDisplaySleep = (reason) => {
  surfaceStale = true;
  logDisplayWake(`surface stale (${reason})`);
};

const hasUsableDisplay = () =>
  screen.getAllDisplays().some(
    (d) => d.bounds && d.bounds.width > 100 && d.bounds.height > 100,
  );

const nudgeWindowSurface = (win) => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  const displays = screen.getAllDisplays();
  const current = win.getBounds();
  const moved = replacementBounds(
    current,
    displays,
    screen.getPrimaryDisplay().workArea,
  );
  const placed = moved || current;
  if (moved) win.setBounds(placed);
  // Width +1 allocates a new IOSurface after the display id was invalidated.
  win.setBounds(nudgeSize(placed));
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setBounds(placed);
    try {
      win.webContents.invalidate();
    } catch (_) {}
  }, 80);
};

const scheduleDisplayWakeRecovery = (reason) => {
  if (!surfaceStale || screenLocked || !hasUsableDisplay()) return;
  if (wakeRecoverTimer) clearTimeout(wakeRecoverTimer);
  wakeRecoverTimer = setTimeout(() => {
    wakeRecoverTimer = null;
    void recoverFromDisplayWake(reason);
  }, 600);
};

/**
 * Rebuild the blank window left behind when the Mac locks and the display
 * sleeps. Stream-health can stay ok across that, so this path reloads the
 * viewer itself instead of waiting for the x11vnc heal poll.
 */
const recoverFromDisplayWake = async (reason) => {
  if (wakeRecoverInFlight) {
    surfaceStale = true;
    return;
  }
  const plan = planDisplayWake({
    surfaceStale,
    screenLocked,
    hasDisplay: hasUsableDisplay(),
    desktopLive,
    settingsOpen: Boolean(settingsWindow && !settingsWindow.isDestroyed()),
    crashed: Boolean(
      mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.webContents.isCrashed(),
    ),
    shellLoaded: Boolean(mainWindow && !mainWindow.isDestroyed() && !desktopLive),
  });
  if (!plan.recover) return;
  // Clear before the bounds nudge so display-metrics-changed does not loop.
  surfaceStale = false;
  wakeRecoverInFlight = true;
  logDisplayWake(
    `recover ${reason} reloadDesktop=${plan.reloadDesktop} defer=${plan.deferDesktopReload}`,
  );
  try {
    for (const win of BrowserWindow.getAllWindows()) nudgeWindowSurface(win);
    await sleep(150);
    if (plan.deferDesktopReload) pendingDesktopReload = true;
    if (plan.reloadDesktop) {
      await openDesktop();
    } else if (
      plan.reloadShell &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.loadFile(path.join(__dirname, "shell.html"));
    }
  } catch (err) {
    surfaceStale = true;
    logDisplayWake(`recover failed ${err?.message || err}`);
  } finally {
    wakeRecoverInFlight = false;
    if (surfaceStale) scheduleDisplayWakeRecovery("coalesced");
  }
};

const installDisplayWakeRecovery = () => {
  powerMonitor.on("suspend", () => noteDisplaySleep("suspend"));
  powerMonitor.on("lock-screen", () => {
    screenLocked = true;
    noteDisplaySleep("lock-screen");
  });
  powerMonitor.on("resume", () => {
    noteDisplaySleep("resume");
    scheduleDisplayWakeRecovery("resume");
  });
  powerMonitor.on("unlock-screen", () => {
    screenLocked = false;
    noteDisplaySleep("unlock-screen");
    scheduleDisplayWakeRecovery("unlock-screen");
  });
  screen.on("display-removed", () => noteDisplaySleep("display-removed"));
  screen.on("display-added", () => scheduleDisplayWakeRecovery("display-added"));
  screen.on("display-metrics-changed", () => {
    if (surfaceStale) scheduleDisplayWakeRecovery("display-metrics-changed");
  });
  app.on("child-process-gone", (_event, details) => {
    if (details?.type !== "GPU") return;
    noteDisplaySleep("gpu-process-gone");
    scheduleDisplayWakeRecovery("gpu-process-gone");
  });
};

/** Self-heal black screen if x11vnc dies while the app is open. */
const startStreamHeal = () => {
  if (streamHealTimer) return;
  streamHealTimer = setInterval(async () => {
    if (!desktopLive || streamHealInFlight) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    streamHealInFlight = true;
    try {
      // Renderer death leaves a blank window while stream-health stays green.
      if (mainWindow.webContents.isCrashed()) {
        logDisplayWake("heal reloading crashed renderer");
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          pendingDesktopReload = true;
        } else {
          await openDesktop();
        }
        return;
      }
      // Budget must exceed the host's in-container inspect (10s docker exec);
      // a shorter timeout reads as "unhealthy" and provokes a needless repair.
      const health = await fetchJson(
        `${CONTROL}/api/desktop/stream-health`,
        {},
        15_000,
      );
      if (health.status === 404) return; // older host — skip
      // Only repair on a definite negative verdict. A timeout or transport error
      // says nothing about the stream, and repairing kills the live WebSocket.
      if (!health.ok || !health.body) return;
      if (health.body.ok) return;
      const ensure = await fetchJson(
        `${CONTROL}/api/desktop/ensure-stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: false }),
        },
        20_000,
      );
      if (ensure.ok && ensure.body?.ok) {
        restartInputPumps();
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          pendingDesktopReload = true;
        } else {
          await openDesktop();
        }
      }
    } finally {
      streamHealInFlight = false;
    }
  }, 8000);
};

const stopStreamHeal = () => {
  if (streamHealTimer) {
    clearInterval(streamHealTimer);
    streamHealTimer = null;
  }
};

app.whenReady().then(() => {
  // Allow mic permission prompts from the capture window.
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      if (permission === "media" || permission === "microphone") {
        callback(true);
        return;
      }
      callback(false);
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) =>
      permission === "media" ||
      permission === "microphone" ||
      permission === "mediaKeySystem",
  );
  createWindow();
  installDisplayWakeRecovery();
  startConsentPoll();
  if (readMicPrefs().shareMic) {
    syncMicSharing(true);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopBootPoll();
  stopConsentPoll();
  stopStreamHeal();
  stopMicCapture();
  hostChild = null;
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  stopMicCapture();
  stopClipboardSync();
});