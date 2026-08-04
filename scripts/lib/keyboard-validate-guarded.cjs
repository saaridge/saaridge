#!/usr/bin/env node
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { forwardKeyViaDom } = require(
  path.join(__dirname, "..", "..", "desktop", "key-forward.cjs"),
);

const URL = "http://127.0.0.1:6081/novnc-onebridge.html?titlebar=44";
let forwardingKeys = false;

const attachKeyBridge = (webContents) => {
  webContents.on("before-input-event", (event, input) => {
    if (forwardingKeys) return;
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    if (["Shift", "Control", "Alt", "Meta"].includes(input.key)) return;
    event.preventDefault();
    forwardingKeys = true;
    try {
      forwardKeyViaDom(webContents, input, { live: true });
    } finally {
      forwardingKeys = false;
    }
  });
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  attachKeyBridge(win.webContents);
  await win.loadURL(URL);
  await new Promise((r) => setTimeout(r, 3500));
  await win.webContents.executeJavaScript(`(() => {
    const r=window.__onebridgeRfb; const c=r?._canvas;
    if(c){c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:420,clientY:420}));
    c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:420,clientY:420}));c.focus();}
    if(r?.focus)r.focus(); return true;})()`, true);
  await new Promise((r) => setTimeout(r, 300));

  // Simulate OS delivering key 'a' through before-input-event path
  win.webContents.emit("before-input-event", { preventDefault() {} }, {
    type: "keyDown", key: "a", code: "KeyA", control: false, alt: false, meta: false, shift: false, isAutoRepeat: false,
  });
  win.webContents.emit("before-input-event", { preventDefault() {} }, {
    type: "keyUp", key: "a", code: "KeyA", control: false, alt: false, meta: false, shift: false, isAutoRepeat: false,
  });
  await new Promise((r) => setTimeout(r, 500));
  console.log("DONE");
  win.destroy();
  app.exit(0);
});

app.on("window-all-closed", () => {});
