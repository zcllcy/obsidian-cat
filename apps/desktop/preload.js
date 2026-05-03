const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("catVaultAgent", {
  platform: process.platform,
  feedFiles: (files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("feed-files", paths);
  },
  feedUrl: (url) => ipcRenderer.invoke("feed-url", url),
  feedText: (text, source) => ipcRenderer.invoke("feed-text", { text, source }),
  openConsole: () => ipcRenderer.invoke("open-console")
});
