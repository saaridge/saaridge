const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("saaridge", {
  platform: process.platform,
  getUrls: () => ipcRenderer.invoke("saaridge:urls"),
  waitReady: () => ipcRenderer.invoke("saaridge:ready"),
  showDesktop: () => ipcRenderer.invoke("saaridge:show-desktop"),
  hideDesktop: () => ipcRenderer.invoke("saaridge:hide-desktop"),
  focusDesktop: () => ipcRenderer.invoke("saaridge:focus-desktop"),
  /** @param {"policies"|"microphone"|"resources"} [pane] */
  openSettings: (pane) =>
    ipcRenderer.invoke("saaridge:open-settings", pane || "policies"),
  openPolicies: () => ipcRenderer.invoke("saaridge:open-settings", "policies"),
  completeFirstRunResources: () =>
    ipcRenderer.invoke("saaridge:complete-first-run-resources"),
  getMicPrefs: () => ipcRenderer.invoke("saaridge:mic-prefs-get"),
  setMicPrefs: (prefs) => ipcRenderer.invoke("saaridge:mic-prefs-set", prefs),
  /** Capture page → main status updates */
  micStatus: (payload) => {
    try {
      ipcRenderer.send("saaridge:mic-status", payload);
    } catch (_) {}
  },
  onMicCommand: (cb) => {
    const handler = (_event, cmd) => {
      try {
        cb(cmd);
      } catch (_) {}
    };
    ipcRenderer.on("saaridge:mic-command", handler);
    return () => ipcRenderer.removeListener("saaridge:mic-command", handler);
  },
  onMicStatus: (cb) => {
    const handler = (_event, payload) => {
      try {
        cb(payload);
      } catch (_) {}
    };
    ipcRenderer.on("saaridge:mic-status-broadcast", handler);
    return () =>
      ipcRenderer.removeListener("saaridge:mic-status-broadcast", handler);
  },
  /** Inject mouse into remote X (bypasses noVNC coordinate bugs). */
  injectMouse: (payload) => {
    try {
      ipcRenderer.send("saaridge:mouse", payload);
    } catch (_) {}
  },
  onBoot: (cb) => {
    const handler = (_event, payload) => {
      try {
        cb(payload);
      } catch (_) {}
    };
    ipcRenderer.on("saaridge:boot", handler);
    return () => ipcRenderer.removeListener("saaridge:boot", handler);
  },
  onSettingsPane: (cb) => {
    const handler = (_event, pane) => {
      try {
        cb(pane);
      } catch (_) {}
    };
    ipcRenderer.on("saaridge:settings-pane", handler);
    return () =>
      ipcRenderer.removeListener("saaridge:settings-pane", handler);
  },
});
