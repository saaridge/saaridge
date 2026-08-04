#!/usr/bin/env node
/**
 * OneBridge desktop shell.
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
} = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");
const { createHash } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const CONTROL = "http://127.0.0.1:3847";
const DESKTOP = "http://127.0.0.1:6081/novnc-onebridge.html?titlebar=44";
const CHROME_INJECT = fs.readFileSync(
  path.join(__dirname, "inject-workspace-chrome.js"),
  "utf8",
);

let mainWindow = null;
let hostChild = null;
let bootPollTimer = null;
let consentPollTimer = null;
let consentDialog = null;
let desktopLive = false;
let streamHealTimer = null;
let streamHealInFlight = false;
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

const broadcastMicStatus = (payload) => {
  micStatus = { ...micStatus, ...payload };
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("onebridge:mic-status-broadcast", micStatus);
    } catch (_) {}
  }
};

const stopMicCapture = () => {
  if (micCaptureWin && !micCaptureWin.isDestroyed()) {
    try {
      micCaptureWin.webContents.send("onebridge:mic-command", "stop");
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
      micCaptureWin.webContents.send("onebridge:mic-command", "start");
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
    mainWindow.webContents.send("onebridge:boot", payload);
  }
};

const injectWorkspaceChrome = async () => {
  if (!mainWindow || mainWindow.isDestroyed() || !desktopLive) return;
  try {
    await mainWindow.webContents.executeJavaScript(CHROME_INJECT, true);
  } catch (_) {}
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

const ensureMousePump = () => {
  if (mousePump && !mousePump.killed) return mousePump;
  mousePump = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "browser",
      "-e",
      "DISPLAY=:1",
      "agent-bridge-box",
      "/opt/bridge/mouse-pump.sh",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  mousePump.on("exit", () => {
    mousePump = null;
  });
  return mousePump;
};

const ensureClipboardPump = () => {
  if (clipboardPump && !clipboardPump.killed) return clipboardPump;
  clipboardPump = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "browser",
      "-e",
      "DISPLAY=:1",
      "agent-bridge-box",
      "stdbuf",
      "-oL",
      "-eL",
      "/opt/bridge/clipboard-pump.sh",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
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
        "[onebridge] clipboard sync skipped: text exceeds 512KiB cap",
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
  desktopLive = false;
  await mainWindow.loadURL(DESKTOP);
  desktopLive = true;
  await injectWorkspaceChrome();
  restartInputPumps();
  // Titlebar inset is already applied by novnc-onebridge.html (?titlebar=44).
  setTimeout(focusDesktop, 100);
  setTimeout(focusDesktop, 500);
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
      env: process.env,
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
          message: line.replace(/^\[onebridge\]\s*/i, ""),
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
          message: line.replace(/^\[onebridge\]\s*/i, ""),
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
              "Docker is required. Install Docker Desktop, then open OneBridge again.",
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

const startHostIfNeeded = async () => {
  sendBoot({
    phase: "host",
    progress: 3,
    message: "Starting control plane…",
  });

  const modulesOk = async () => {
    const r = await fetchJson(`${CONTROL}/api/desktop/stream-health`, {}, 5000);
    // 200/503 = stream-stack loaded; 500 = import/syntax crash
    return r.status === 200 || r.status === 503;
  };

  if ((await fetchOk(`${CONTROL}/api/health`)) && (await modulesOk())) {
    return { already: true };
  }

  // Prefer the supervised start-host.sh so crashes are recovered automatically.
  const logPath = "/tmp/onebridge-desktop-host.log";
  const out = fs.openSync(logPath, "a");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const startHostSh = path.join(ROOT, "scripts", "start-host.sh");
  hostChild = spawn("bash", [startHostSh], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  hostChild.unref();

  for (let i = 0; i < 60; i++) {
    if ((await fetchOk(`${CONTROL}/api/health`)) && (await modulesOk())) {
      return { already: false, logPath };
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for control plane (${CONTROL}). See ${logPath} and /tmp/onebridge-host.log`,
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

  installAppMenu();
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
  mainWindow.webContents.on("did-finish-load", () => {
    if (!desktopLive || !mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (url.includes("novnc-onebridge")) {
      void injectWorkspaceChrome();
    }
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
    stopStreamHeal();
    stopClipboardSync();
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
    await ensureDocker();
    await startHostIfNeeded();
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

ipcMain.handle("onebridge:show-desktop", async () => {
  await ensureStreamReady().catch(() => {});
  await openDesktop();
  startStreamHeal();
  return { ok: true };
});

ipcMain.handle("onebridge:hide-desktop", async () => {
  return { ok: true };
});

ipcMain.handle("onebridge:focus-desktop", async () => {
  focusDesktop();
  return { ok: true };
});

ipcMain.on("onebridge:mouse", (_event, payload) => {
  injectMouseToX(payload);
});

const openSettingsWindow = (pane = "policies") => {
  const safePane =
    pane === "apikey"
      ? "apikey"
      : pane === "microphone"
        ? "microphone"
        : "policies";
  // Same pattern as the committed API-key dialog: child modal only —
  // Child modal — does not affect workspace chrome in the main window.
  const dlg = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    parent: mainWindow || undefined,
    modal: true,
    show: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: "Settings",
    backgroundColor: "#151f1b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void dlg.loadFile(path.join(__dirname, "settings.html"), {
    query: { pane: safePane },
  });
  dlg.on("closed", () => focusDesktop());
  return { ok: true };
};

ipcMain.handle("onebridge:open-settings", async (_event, pane) =>
  openSettingsWindow(pane),
);

ipcMain.handle("onebridge:open-api-key", async () =>
  openSettingsWindow("apikey"),
);

ipcMain.handle("onebridge:open-policies", async () =>
  openSettingsWindow("policies"),
);

ipcMain.handle("onebridge:mic-prefs-get", async () => ({
  ...readMicPrefs(),
  status: micStatus,
}));

ipcMain.handle("onebridge:mic-prefs-set", async (_event, prefs) => {
  const next = writeMicPrefs(prefs);
  syncMicSharing(next.shareMic);
  return { ok: true, ...next, status: micStatus };
});

ipcMain.on("onebridge:mic-status", (_event, payload) => {
  broadcastMicStatus(payload || {});
  if (payload?.state === "denied" || payload?.state === "error") {
    // Keep preference on so user can retry; status reflects failure.
  }
});

ipcMain.handle("onebridge:open-microphone", async () =>
  openSettingsWindow("microphone"),
);

const openHostHomeConsent = async (pending) => {
  if (!pending?.agentId) return;
  // Consume so we don't re-open every poll tick.
  await fetchJson(`${CONTROL}/api/ui/consume-host-home-consent`, {
    method: "POST",
  });

  // Native dialog (reliable; no HTML window required).
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const choice = await dialog.showMessageBox(win || undefined, {
    type: "warning",
    buttons: ["Allow home write", "Deny"],
    defaultId: 0,
    cancelId: 1,
    title: "Allow write to host home?",
    message: `${pending.agentName || pending.agentId} wants to write under your Mac home folder.`,
    detail:
      (pending.path ? `Path: ${pending.path}\n\n` : "") +
      "This is a OneBridge host-user grant — not container sudo. Do not use Cursor’s “Retry as Sudo”.",
  });
  if (choice.response === 0) {
    const r = await fetchJson(
      `${CONTROL}/api/agents/${encodeURIComponent(pending.agentId)}/host-home-write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant: true }),
      },
      5000,
    );
    if (!r.ok) {
      await dialog.showMessageBox(win || undefined, {
        type: "error",
        message: "Could not save home-write grant",
        detail: r.body?.error || String(r.status),
      });
    }
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

/** Self-heal black screen if x11vnc dies while the app is open. */
const startStreamHeal = () => {
  if (streamHealTimer) return;
  streamHealTimer = setInterval(async () => {
    if (!desktopLive || streamHealInFlight) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    streamHealInFlight = true;
    try {
      const health = await fetchJson(
        `${CONTROL}/api/desktop/stream-health`,
        {},
        4000,
      );
      if (health.status === 404) return; // older host — skip
      if (health.ok && health.body?.ok) return;
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
        await openDesktop();
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