#!/usr/bin/env node
/**
 * Re-entrancy check: DOM dispatch must not recurse before-input-event.
 */
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { forwardKeyViaDom } = require(
  path.join(__dirname, "..", "..", "desktop", "key-forward.cjs"),
);

const URL = "http://127.0.0.1:6081/novnc-saaridge.html?titlebar=44";
let forwardingKeys = false;
let depth = 0;

const attachKeyBridge = (webContents) => {
  webContents.on("before-input-event", (event, input) => {
    depth += 1;
    if (depth > 20) {
      console.error("DEPTH_EXCEEDED", depth);
      app.exit(2);
      return;
    }
    if (forwardingKeys) return;
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    event.preventDefault();
    forwardingKeys = true;
    try {
      forwardKeyViaDom(webContents, input, { live: true });
    } finally {
      forwardingKeys = false;
      depth -= 1;
    }
  });
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  attachKeyBridge(win.webContents);
  await win.loadURL(URL);
  await new Promise((r) => setTimeout(r, 2500));
  forwardKeyViaDom(
    win.webContents,
    {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      control: false,
      alt: false,
      meta: false,
      shift: false,
      isAutoRepeat: false,
    },
    { live: true },
  );
  console.log("RECURSE_OK depth=", depth);
  win.destroy();
  app.exit(0);
});

app.on("window-all-closed", () => {});
