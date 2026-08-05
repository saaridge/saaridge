#!/usr/bin/env node
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { forwardKeyViaDom, sendPrintableSequence } = require(
  path.join(__dirname, "..", "..", "desktop", "key-forward.cjs"),
);

const MODE = process.argv[2] || "sendInputEvent";
const URL = "http://127.0.0.1:6081/novnc-saaridge.html?titlebar=44";

let quitReason = null;
app.on("before-quit", () => {
  quitReason = quitReason || "before-quit";
});
app.on("will-quit", () => {
  quitReason = quitReason || "will-quit";
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const focusCanvas = async (wc) => {
  await wc.executeJavaScript(
    `(() => {
      const r = window.__saaridgeRfb;
      const c = r?._canvas;
      if (c) {
        c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 420, clientY: 420 }));
        c.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 420, clientY: 420 }));
        c.focus();
      }
      if (r?._keyboard) {
        try { r._keyboard.ungrab(); } catch (_) {}
        r._keyboard._target = window;
        r._keyboard.grab();
      }
      if (r?.focus) r.focus();
      window.focus();
      return true;
    })()`,
    true,
  );
};

const dispatchDomKey = async (wc, ch) => {
  await wc.executeJavaScript(
    `(() => {
      const upper = ${JSON.stringify(ch.toUpperCase())};
      const ch = ${JSON.stringify(ch)};
      const code = "Key" + upper;
      const t = window.__saaridgeRfb?._keyboard?._target || window;
      const down = new KeyboardEvent("keydown", { key: ch, code, bubbles: true, cancelable: true });
      const up = new KeyboardEvent("keyup", { key: ch, code, bubbles: true, cancelable: true });
      t.dispatchEvent(down);
      t.dispatchEvent(up);
      return true;
    })()`,
    true,
  );
};

const simulateBeforeInput = (wc, type, key, code) => {
  forwardKeyViaDom(
    wc,
    { type, key, code, control: false, alt: false, meta: false, shift: false, isAutoRepeat: false },
    { live: true },
  );
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { backgroundThrottling: false, contextIsolation: true },
  });

  let closed = false;
  win.on("close", () => {
    closed = true;
    console.log("WINDOW_CLOSE_EVENT");
  });

  try {
    await win.loadURL(URL);
    await sleep(3500);
    await focusCanvas(win.webContents);
    await sleep(300);

    console.log("MODE", MODE);

    if (MODE === "sendInputEvent") {
      simulateBeforeInput(win.webContents, "keyDown", "a", "KeyA");
      simulateBeforeInput(win.webContents, "keyUp", "a", "KeyA");
    } else if (MODE === "sendPrintable") {
      sendPrintableSequence(win.webContents, "a");
    } else if (MODE === "dom") {
      await dispatchDomKey(win.webContents, "a");
    } else if (MODE === "native") {
      console.log("native mode: not simulating — manual only");
    }

    await sleep(800);
    console.log("quitReason", quitReason);
    console.log("windowClosed", closed);
    console.log("destroyed", win.isDestroyed());
  } catch (e) {
    console.error("ERR", e?.stack || e);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.exit(0);
  }
});

app.on("window-all-closed", () => {});
