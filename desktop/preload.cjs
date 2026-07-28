const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("onebridge", {
  platform: process.platform,
  getUrls: () => ipcRenderer.invoke("onebridge:urls"),
  waitReady: () => ipcRenderer.invoke("onebridge:ready"),
  showDesktop: () => ipcRenderer.invoke("onebridge:show-desktop"),
  hideDesktop: () => ipcRenderer.invoke("onebridge:hide-desktop"),
  focusDesktop: () => ipcRenderer.invoke("onebridge:focus-desktop"),
  openApiKey: () => ipcRenderer.invoke("onebridge:open-api-key"),
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
