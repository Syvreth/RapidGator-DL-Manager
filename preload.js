const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webdl', {
  getState: () => ipcRenderer.invoke('state:get'),
  start: (payload) => ipcRenderer.invoke('downloads:start', payload),
  cancel: () => ipcRenderer.invoke('downloads:cancel'),
  fetchLists: () => ipcRenderer.invoke('proxies:fetch'),
  test: (payload) => ipcRenderer.invoke('proxies:test', payload),
  forget: () => ipcRenderer.invoke('proxies:forget'),
  forgetWorking: () => ipcRenderer.invoke('proxies:forget-working'),
  saveProxies: (payload) => ipcRenderer.invoke('proxies:save', payload),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  openFolder: (folder) => ipcRenderer.invoke('folder:open', folder),
  openFile: (file) => ipcRenderer.invoke('file:open', file),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
});
