#!/usr/bin/env node
/**
 * Reproduce the "typing a closes the app" failure mode.
 * Uses sendInputEvent (real OS path) through the same bridge as main.cjs.
 */
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { forwardKeyViaDom } = require(
  path.join(__dirname, "..", "..", "desktop", "key-forward.cjs"),
);

const URL = "http://127.0.0.1:6081/novnc-saaridge.html?titlebar=44";

let keyForwardChain = Promise.resolve();
let quitReason = null;
let depth = 0;

app.on("before-quit", () => {
  quitReason = quitReason || "before-quit";
});

const attachKeyBridge = (webContents) => {
  webContents.on("before-input-event", (event, input) => {
    depth += 1;
    if (depth > 30) {
      console.error("DEPTH_EXCEEDED", depth);
      app.exit(2);
      return;
    }
    if (input.type !== "keyDown" && input.type !== "keyUp") {
      depth -= 1;
      return;
    }
    if (input.isAutoRepeat) {
      depth -= 1;
      return;
    }
    event.preventDefault();
    keyForwardChain = keyForwardChain
      .then(() => forwardKeyViaDom(webContents, input, { live: true }))
      .catch(() => {})
      .finally(() => {
        depth -= 1;
      });
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { backgroundThrottling: false, contextIsolation: true },
  });
  attachKeyBridge(win.webContents);

  try {
    await win.loadURL(URL);
    await sleep(2500);

    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", code: "KeyA" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", code: "KeyA" });
    await keyForwardChain;
    await sleep(300);

    if (quitReason) {
      console.error("CRASH_QUIT", quitReason);
      process.exitCode = 3;
      return;
    }
    if (depth > 0) {
      console.error("DEPTH_LEAK", depth);
      process.exitCode = 4;
      return;
    }
    if (win.isDestroyed()) {
      console.error("WINDOW_DESTROYED");
      process.exitCode = 5;
      return;
    }
    console.log("CRASH_A_OK");
  } catch (err) {
    console.error(err?.stack || err);
    process.exitCode = 1;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.exit(process.exitCode || 0);
  }
});

app.on("window-all-closed", () => {});
