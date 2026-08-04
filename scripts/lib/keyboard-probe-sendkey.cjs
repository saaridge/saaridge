#!/usr/bin/env node
const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await w.loadURL("http://127.0.0.1:6081/novnc-onebridge.html?titlebar=44");
  await new Promise((r) => setTimeout(r, 3500));
  const n = await w.webContents.executeJavaScript(`(() => {
    const r = window.__onebridgeRfb;
    let n = 0;
    const o = r.sendKey.bind(r);
    r.sendKey = (...a) => { n++; return o(...a); };
    if (r._keyboard) {
      try { r._keyboard.ungrab(); } catch (e) {}
      r._keyboard._target = window;
      r._keyboard.grab();
    }
    const t = window;
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", bubbles: true, cancelable: true }));
    t.dispatchEvent(new KeyboardEvent("keyup", { key: "x", code: "KeyX", bubbles: true, cancelable: true }));
    return n;
  })()`, true);
  console.log("sendKey_calls", n);
  w.destroy();
  app.exit(0);
});

app.on("window-all-closed", () => {});
