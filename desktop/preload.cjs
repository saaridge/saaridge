const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("onebridge", {
  platform: process.platform,
  getUrls: () => ipcRenderer.invoke("onebridge:urls"),
  waitReady: () => ipcRenderer.invoke("onebridge:ready"),
  showDesktop: () => ipcRenderer.invoke("onebridge:show-desktop"),
  hideDesktop: () => ipcRenderer.invoke("onebridge:hide-desktop"),
  focusDesktop: () => ipcRenderer.invoke("onebridge:focus-desktop"),
  /** @param {"policies"|"apikey"|"microphone"} [pane] */
  openSettings: (pane) =>
    ipcRenderer.invoke("onebridge:open-settings", pane || "policies"),
  // Back-compat aliases
  openApiKey: () => ipcRenderer.invoke("onebridge:open-settings", "apikey"),
  openPolicies: () => ipcRenderer.invoke("onebridge:open-settings", "policies"),
  getMicPrefs: () => ipcRenderer.invoke("onebridge:mic-prefs-get"),
  setMicPrefs: (prefs) => ipcRenderer.invoke("onebridge:mic-prefs-set", prefs),
  /** Capture page → main status updates */
  micStatus: (payload) => {
    try {
      ipcRenderer.send("onebridge:mic-status", payload);
    } catch (_) {}
  },
  onMicCommand: (cb) => {
    const handler = (_event, cmd) => {
      try {
        cb(cmd);
      } catch (_) {}
    };
    ipcRenderer.on("onebridge:mic-command", handler);
    return () => ipcRenderer.removeListener("onebridge:mic-command", handler);
  },
  onMicStatus: (cb) => {
    const handler = (_event, payload) => {
      try {
        cb(payload);
      } catch (_) {}
    };
    ipcRenderer.on("onebridge:mic-status-broadcast", handler);
    return () =>
      ipcRenderer.removeListener("onebridge:mic-status-broadcast", handler);
  },
  /** Inject mouse into remote X (bypasses noVNC coordinate bugs). */
  injectMouse: (payload) => {
    try {
      ipcRenderer.send("onebridge:mouse", payload);
    } catch (_) {}
  },
  onBoot: (cb) => {
    const handler = (_event, payload) => {
      try {
        cb(payload);
      } catch (_) {}
    };
    ipcRenderer.on("onebridge:boot", handler);
    return () => ipcRenderer.removeListener("onebridge:boot", handler);
  },
});
