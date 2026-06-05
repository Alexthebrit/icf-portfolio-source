// Preload — exposes a tiny safe API surface to the renderer.
// Renderer code can call window.icfPortfolio.* without direct ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

// The preload script runs in a Node.js context. In Node.js 18+, unhandled
// promise rejections exit the process with code 1 (which kills the renderer).
// Suppress that default behavior here — the renderer's own error handlers
// will surface any real errors to the console.
process.on('unhandledRejection', (reason) => {
  console.error('[preload] unhandledRejection:', reason && (reason.stack || reason));
});

contextBridge.exposeInMainWorld('icfPortfolio', {
  isDesktopApp: true,

  // Box folder management
  changeBoxFolder: () => ipcRenderer.invoke('changeBoxFolder'),
  getBoxFolder: () => ipcRenderer.invoke('getBoxFolder'),

  // Server mode (build/serve pipeline on this machine)
  serverStart: (opts) => ipcRenderer.invoke('serverStart', opts || {}),
  serverStop: () => ipcRenderer.invoke('serverStop'),
  serverStatus: () => ipcRenderer.invoke('serverStatus'),
  onServerState: (cb) => {
    const handler = (_evt, data) => cb(data);
    ipcRenderer.on('server-state', handler);
    return () => ipcRenderer.removeListener('server-state', handler);
  },

  // Admin auth — Feature 1
  adminReadList: () => ipcRenderer.invoke('admin-read-list'),
  adminVerify: (name, password) => ipcRenderer.invoke('admin-verify', { name, password }),
  adminAdd: (name, password) => ipcRenderer.invoke('admin-add', { name, password }),
  adminRemove: (id) => ipcRenderer.invoke('admin-remove', { id }),
  adminChangePassword: (id, newPassword) => ipcRenderer.invoke('admin-change-password', { id, newPassword }),
  adminGetSavedSession: () => ipcRenderer.invoke('admin-get-saved-session'),
  adminSaveSession: (id) => ipcRenderer.invoke('admin-save-session', { id }),
  adminClearSession: () => ipcRenderer.invoke('admin-clear-session'),

  // Asset keywords — Feature 2
  keywordsRead: () => ipcRenderer.invoke('keywords-read'),
  keywordsSave: (keywords) => ipcRenderer.invoke('keywords-save', { keywords }),

  // PDF export — Feature 3
  showSaveDialog: (defaultName) => ipcRenderer.invoke('show-save-dialog', { defaultName }),
  exportPdf: (filePath, opts) => ipcRenderer.invoke('export-pdf', { filePath, ...(opts || {}) }),

  // Notes — Feature 4
  notesRead: () => ipcRenderer.invoke('notes-read'),
  notesSave: (notePayload) => ipcRenderer.invoke('notes-save', { notePayload }),
  notesDelete: (id) => ipcRenderer.invoke('notes-delete', { id }),

  // Favorites & Awards — Feature 5
  favoritesRead: () => ipcRenderer.invoke('favorites-read'),
  favoritesSave: (data) => ipcRenderer.invoke('favorites-save', { data }),

  // Auto-updater
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (cb) => {
    const handler = (_evt, version) => cb(version);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  onUpdateDownloadProgress: (cb) => {
    const handler = (_evt, pct) => cb(pct);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },
  onUpdateDownloaded: (cb) => {
    const handler = (_evt, version) => cb(version);
    ipcRenderer.on('update-downloaded', handler);
    return () => ipcRenderer.removeListener('update-downloaded', handler);
  },
});

