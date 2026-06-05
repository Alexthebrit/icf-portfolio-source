const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashAPI', {
  onProgress: (callback) => {
    const handler = (_evt, progress) => callback(progress);
    ipcRenderer.on('splash-progress', handler);
    return () => ipcRenderer.removeListener('splash-progress', handler);
  },
  skip: () => ipcRenderer.send('splash-skip'),
});
