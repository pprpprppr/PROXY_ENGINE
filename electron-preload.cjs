const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proxysuiteDesktop', {
  isDesktop: true,
  getAppInfo: () => ipcRenderer.invoke('proxysuite:get-app-info'),
  openDataDir: () => ipcRenderer.invoke('proxysuite:open-data-dir'),
});
