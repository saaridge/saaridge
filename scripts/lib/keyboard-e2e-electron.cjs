#!/usr/bin/env node
/**
 * Electron E2E: same attachKeyBridge + __saaridgeKey path as desktop/main.cjs.
 * Types via webContents.sendInputEvent (real OS delivery) and verifies RFB probe.
 */
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { forwardKeyViaDom } = require(
  path.join(__dirname, "..", "..", "desktop", "key-forward.cjs"),
);

const TEXT = process.env.SAARIDGE_KB_E2E_TEXT || "xyz";
const URL =
  process.env.SAARIDGE_KB_E2E_URL ||
  "http://127.0.0.1:6081/novnc-saaridge.html?titlebar=44";
const TIMEOUT = Number(process.env.SAARIDGE_KB_E2E_TIMEOUT || 60000);

let keyForwardChain = Promise.resolve();
let quitReason = null;
app.on("before-quit", () => {
  quitReason = quitReason || "before-quit";
});

const isLocalAppShortcut = (input) => {
  if (input.type !== "keyDown") return false;
  if (process.platform !== "darwin" || !input.meta) return false;
  const key = String(input.key || "").toLowerCase();
  return key === "q" || key === "w" || key === "h" || key === "m";
};

const attachKeyBridge = (webContents) => {
  webContents.on("before-input-event", (event, input) => {
    if (isLocalAppShortcut(input)) {
      event.preventDefault();
      return;
    }
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    if (
      input.key === "Shift" ||
      input.key === "Control" ||
      input.key === "Alt" ||
      input.key === "Meta"
    ) {
      return;
    }
    if (input.isAutoRepeat) return;

    event.preventDefault();
    keyForwardChain = keyForwardChain
      .then(() => forwardKeyViaDom(webContents, input, { live: true }))
      .catch(() => {});
  });
};

const installProbe = (wc) =>
  wc.executeJavaScript(
    `(() => {
      const r = window.__saaridgeRfb;
      if (!r || window.__saaridgeKbProbe) return false;
      window.__saaridgeKbProbe = [];
      const orig = r.sendKey.bind(r);
      r.sendKey = (keysym, code, down) => {
        window.__saaridgeKbProbe.push({ keysym, code, down });
        return orig(keysym, code, down);
      };
      return true;
    })()`,
    true,
  );

const waitForRfb = (wc) =>
  wc.executeJavaScript(
    `new Promise((resolve) => {
      const deadline = Date.now() + ${TIMEOUT};
      const tick = () => {
        try {
          const r = window.__saaridgeRfb;
          if (r && r._rfbConnectionState === "connected") resolve(true);
          else if (Date.now() > deadline) resolve(false);
          else setTimeout(tick, 200);
        } catch (_) {
          resolve(false);
        }
      };
      tick();
    })`,
    true,
  );

/** Click inside the prepared xterm region without re-grabbing the keyboard target. */
const focusRemoteXterm = (wc) =>
  wc.executeJavaScript(
    `(() => {
      const r = window.__saaridgeRfb;
      const c = r?._canvas;
      if (!c || !r) return false;
      const x = 420;
      const y = 420;
      c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      c.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      if (r.focus) r.focus();
      return true;
    })()`,
    true,
  );

const readProbe = (wc) =>
  wc.executeJavaScript(`window.__saaridgeKbProbe || []`, true);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const osKeyCode = (ch) => {
  if (/^[a-z]$/i.test(ch)) return ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return ch;
  return ch;
};

const osDomCode = (ch) => {
  if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  return "";
};

/** Deliver keystrokes the same way macOS/Electron does for real typing. */
const sendOsPrintable = (wc, ch) => {
  const keyCode = osKeyCode(ch);
  const code = osDomCode(ch);
  wc.sendInputEvent({ type: "keyDown", keyCode, code });
  wc.sendInputEvent({ type: "keyUp", keyCode, code });
};

const drainKeyChain = () =>
  keyForwardChain.then(() => sleep(150));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { backgroundThrottling: false, contextIsolation: true },
  });
  attachKeyBridge(win.webContents);

  try {
    await win.loadURL(URL);
    const connected = await waitForRfb(win.webContents);
    if (!connected) {
      console.error("RFB not connected");
      process.exitCode = 2;
      return;
    }
    await installProbe(win.webContents);
    win.show();
    win.focus();
    // xterm is already focused in the container via prepareXtermTarget — do not
    // click the canvas here; that steals X focus away from the capture window.
    await sleep(500);

    for (const ch of TEXT) {
      sendOsPrintable(win.webContents, ch);
      await sleep(80);
    }
    win.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "Enter",
      code: "Enter",
    });
    win.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "Enter",
      code: "Enter",
    });
    await drainKeyChain();

    if (quitReason) {
      console.error(`app quit during typing: ${quitReason}`);
      process.exitCode = 5;
      return;
    }

    const probe = await readProbe(win.webContents);
    const downs = probe.filter((e) => e.down);
    const ups = probe.filter((e) => !e.down);
    if (downs.length < TEXT.length || ups.length < TEXT.length) {
      console.error(
        `RFB sendKey insufficient: downs=${downs.length} ups=${ups.length} need>=${TEXT.length}`,
      );
      process.exitCode = 4;
      return;
    }
    console.log(`TYPED_OK probe=${probe.length} text=${TEXT}`);
  } catch (err) {
    console.error(err?.stack || err);
    process.exitCode = 1;
  } finally {
    try {
      win.destroy();
    } catch (_) {}
    app.exit(process.exitCode || 0);
  }
});

app.on("window-all-closed", () => {});
