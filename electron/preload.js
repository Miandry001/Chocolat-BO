const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: process.versions,
  openCatalogWindow: () => ipcRenderer.invoke('catalog:open'),
  closeCatalogWindow: () => ipcRenderer.invoke('catalog:close'),
  syncConfig: {
    enabled: process.env.SYNC_ENABLED === '1' || process.env.SYNC_ENABLED === 'true',
    url: process.env.SYNC_URL || 'http://127.0.0.1:3002',
  },
});
