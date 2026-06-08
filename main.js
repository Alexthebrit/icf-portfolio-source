// ICF Creative Portfolio — Electron main process.
//
// Architecture:
//   1. On first launch, ask the user where their Box folder is
//      (usually ~/Library/CloudStorage/Box-Box).
//   2. Open the portfolio's existing index.html, which lives inside the user's
//      Box folder at "Alex Gordon/portfolio-master/index.html" (because it's
//      already there as part of the synced output — no app-side bundling needed).
//   3. The window has `webSecurity: false` so the page can load assets from
//      anywhere on the user's filesystem via file://. This is acceptable for a
//      desktop app reading the user's own local files.

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');

// Swallow EPIPE errors globally so the main process doesn't crash
// when the terminal pipe closes (common when launched via nohup).
// This must come before any console.log calls.
process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', e => { if (e.code !== 'EPIPE') throw e; });
process.on('uncaughtException', e => {
  if (e.code === 'EPIPE') return; // silently ignore broken pipe
  // Log but don't re-throw — throwing inside uncaughtException kills the main
  // process immediately (which takes all renderer processes with it).
  try { process.stderr.write('[main] uncaughtException: ' + (e && e.stack || e) + '\n'); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { process.stderr.write('[main] unhandledRejection: ' + (reason && (reason.stack || reason)) + '\n'); } catch (_) {}
});

// Keep GPU acceleration enabled by default for smooth scrolling/rendering.
// If we relaunch with --disable-gpu after repeated renderer crashes, we switch
// back to software rendering as a safety fallback.
const FORCE_SOFTWARE_RENDERING =
  process.argv.includes('--disable-gpu') ||
  process.env.ICF_FORCE_SOFTWARE_RENDERING === '1';
if (FORCE_SOFTWARE_RENDERING) {
  app.disableHardwareAcceleration();
  console.warn('[perf] software rendering mode enabled');
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Store = require('electron-store');

const store = new Store();

let mainWindow = null;
let isAppQuitting = false;
let rendererRecoveryTimestamps = [];

// -----------------------------------------------------------------------------
// Auto-updater (electron-updater → GitHub Releases)
// -----------------------------------------------------------------------------
// Lazy-loaded. We defer the startup check until after the Box-hosted renderer
// has finished loading, which keeps window creation separate from any network
// call to GitHub Releases. The manual Check-for-updates button in Settings →
// About still uses the same flow and remains available as a fallback.
let _autoUpdaterCached = null;
let _startupUpdateCheckStarted = false;
function ensureAutoUpdater() {
  if (_autoUpdaterCached) return _autoUpdaterCached;
  const { autoUpdater } = require('electron-updater');
  try {
    autoUpdater.logger = require('electron-log');
    autoUpdater.logger.transports.file.level = 'info';
  } catch (_) { /* electron-log is optional */ }

  autoUpdater.on('checking-for-update', () => console.log('[updater] checking…'));
  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] up to date:', info && info.version);
  });
  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-available', info.version);
  });
  autoUpdater.on('download-progress', (p) => {
    if (mainWindow) mainWindow.webContents.send('update-download-progress', Math.round(p.percent));
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-downloaded', info.version);
  });
  autoUpdater.on('error', (err) => console.error('[updater] error:', err));

  _autoUpdaterCached = autoUpdater;
  return autoUpdater;
}

async function checkForUpdatesNow() {
  if (!app.isPackaged) return { ok: false, reason: 'dev-mode' };
  try {
    await ensureAutoUpdater().checkForUpdatesAndNotify();
    return { ok: true };
  } catch (err) {
    const reason = String((err && err.message) || err);
    console.error('[updater] check failed:', err);
    return { ok: false, reason };
  }
}

function scheduleStartupUpdateCheck(win) {
  if (_startupUpdateCheckStarted || !app.isPackaged || !win || win.isDestroyed()) return;

  const runUpdateCheck = () => {
    if (_startupUpdateCheckStarted) return;
    _startupUpdateCheckStarted = true;
    setTimeout(() => {
      checkForUpdatesNow().catch((err) => {
        console.error('[updater] startup check failed:', err);
      });
    }, 1500);
  };

  const isLoading = typeof win.webContents.isLoadingMainFrame === 'function'
    ? win.webContents.isLoadingMainFrame()
    : win.webContents.isLoading();

  if (isLoading) {
    win.webContents.once('did-finish-load', runUpdateCheck);
  } else {
    runUpdateCheck();
  }
}

// IPC handlers are registered at module load (not inside ensureAutoUpdater),
// so they're always available for the renderer even if the updater itself is
// never loaded.
ipcMain.handle('install-update', () => {
  try {
    // Stop the background server first so `before-quit` doesn't block the exit.
    if (serverState.running) stopServer();

    const updater = ensureAutoUpdater();
    // isSilent = false  → show the installer UI
    // isForceRunAfter = true → relaunch the app after installing
    updater.quitAndInstall(false, true);

    // Safety net: on macOS, quitAndInstall internally calls app.quit(), but
    // the 'window-all-closed' handler intentionally keeps the app alive
    // (standard Mac behavior). If the app hasn't exited after 3 seconds,
    // force-exit so the installer can proceed.
    setTimeout(() => {
      console.log('[updater] force-exiting for update install');
      app.exit(0);
    }, 3000);
  } catch (err) {
    console.error('[updater] install failed:', err);
  }
});
ipcMain.handle('check-for-updates', checkForUpdatesNow);

// -----------------------------------------------------------------------------
// Pick / verify the Box folder
// -----------------------------------------------------------------------------
async function pickBoxFolder() {
  const defaultPath = path.join(app.getPath('home'), 'Library/CloudStorage');
  const result = await dialog.showOpenDialog({
    title: 'Select your Box folder',
    message: 'This is usually inside ~/Library/CloudStorage and is named Box-Box. Pick that folder.',
    defaultPath,
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

// Find a `portfolio-master/index.html` inside `folder`. Returns the absolute
// path if found, or null.
//
// We only check a small list of KNOWN candidate locations rather than
// walking the directory tree, because walking a Box-Drive folder triggers
// Box to materialize every directory along the way — which can take
// minutes per build/launch and hangs the app before the window opens.
//
// As production usage evolves, add new candidate paths here. Order matters:
// the first match wins, so put the most likely locations first.
const CANDIDATE_SUBPATHS = [
  // The current canonical location (writable Box folder for Alex)
  ['Clients', 'BGE', 'portfolio-master', 'index.html'],
  // Legacy / old setups — left for backward compatibility
  ['ICF Creative Portfolio App', 'portfolio-master', 'index.html'],
  ['Alex Gordon', 'portfolio-master', 'index.html'],
  // If the user picked the portfolio-master folder directly:
  ['portfolio-master', 'index.html'],
  // If the user picked the folder CONTAINING index.html:
  ['index.html'],
];

function findPortfolioIndex(folder) {
  if (!folder) return null;
  for (const parts of CANDIDATE_SUBPATHS) {
    const candidate = path.join(folder, ...parts);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      // ignore — try the next candidate
    }
  }
  return null;
}

function isValidBoxFolder(folder) {
  // Valid if we can find a portfolio-master/index.html anywhere inside.
  return findPortfolioIndex(folder) !== null;
}

async function ensureBoxFolder() {
  let boxFolder = store.get('boxFolder');
  if (boxFolder && isValidBoxFolder(boxFolder)) return boxFolder;

  // Try a sensible default first (the most common Box mount on macOS)
  const guess = path.join(app.getPath('home'), 'Library/CloudStorage/Box-Box');
  if (isValidBoxFolder(guess)) {
    store.set('boxFolder', guess);
    return guess;
  }

  // Ask the user
  while (true) {
    const picked = await pickBoxFolder();
    if (!picked) {
      // User cancelled — exit gracefully
      const choice = await dialog.showMessageBox({
        type: 'warning',
        message: 'No folder selected',
        detail: 'The portfolio needs your Box folder to display content. Try again or quit?',
        buttons: ['Try again', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 1) {
        app.quit();
        return null;
      }
      continue;
    }
    if (isValidBoxFolder(picked)) {
      store.set('boxFolder', picked);
      return picked;
    }
    await dialog.showMessageBox({
      type: 'error',
      message: 'Couldn\'t find the portfolio in that folder',
      detail: 'I searched for a "portfolio-master" subfolder containing index.html ' +
              'and didn\'t find one.\n\n' +
              'Make sure:\n' +
              '  • You picked your top-level Box folder (usually Box-Box), or any parent folder of portfolio-master\n' +
              '  • The portfolio-master folder has finished syncing to your machine\n\n' +
              'If a teammate just shared the folder with you, give Box a few minutes to sync, then try again.',
      buttons: ['Try again'],
    });
  }
}

// -----------------------------------------------------------------------------
// Main window
// -----------------------------------------------------------------------------
function createWindow(boxFolder) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#090738',
    title: 'ICF Creative Portfolio',
    // Show immediately so the user always sees a window, even if the splash
    // or auto-updater is slow/blocked. Previously we used `show: false` and
    // waited for 'ready-to-show', but on machines where the data: splash URL
    // fails to render (some networks, some macOS variants) the event never
    // fires and the window stays hidden forever — looks like "the app didn't
    // open." A brief moment of empty window is a much better failure mode.
    show: true,
    webPreferences: {
      // Disabling web security lets the renderer load file:// resources from
      // anywhere on disk. Acceptable here because:
      //   1. This is a desktop app, not a public website
      //   2. The renderer code is fully under our control (no third-party scripts)
      //   3. We need cross-directory file:// access (HTML in portfolio-master/,
      //      assets in ../../Clients/) which the browser would otherwise block
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Open links (target="_blank", window.open) in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Keep the ready-to-show handler as a backup — if `show: true` failed
  // for some reason, this still ensures the window comes up.
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isVisible()) mainWindow.show();
  });

  const indexPath = findPortfolioIndex(boxFolder);

  // DEV OVERRIDE: if renderer/index.html exists next to main.js, load it
  // instead of the Box copy. This lets developers iterate locally without
  // touching the live Box file that all users see.
  const devIndexPath = path.join(__dirname, 'renderer', 'index.html');
  const useDevIndex = !app.isPackaged && fs.existsSync(devIndexPath);

  if (useDevIndex) {
    console.log('[dev] Loading local renderer/index.html (dev override)');
    if (indexPath) {
      // Copy dev HTML into Box portfolio-master so relative paths (clients.js,
      // manifest-*.js, thumbs/, etc.) resolve correctly.
      const devBoxPath = path.join(path.dirname(indexPath), 'dev-index.html');
      fs.copyFileSync(devIndexPath, devBoxPath);
      console.log('[dev] Copied to', devBoxPath);
      mainWindow.loadFile(devBoxPath);
    } else {
      mainWindow.loadFile(devIndexPath);
    }
    // Forward renderer console messages to the terminal log. Wrapped in try-catch
    // so EPIPE (broken pipe when terminal closes) doesn't kill the main process.
    mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      try {
        const tag = ['log','warn','error','debug'][level] || 'log';
        process.stdout.write(`[renderer:${tag}] ${message}  (${sourceId}:${line})\n`);
      } catch (_) { /* swallow EPIPE */ }
    });
  } else if (indexPath) {
    // Load the portfolio's index.html directly. We don't pre-warm Box stubs
    // and we don't show a splash — both added complexity that caused regressions
    // on some networks/Macs. If colleagues see a blank app because Box hasn't
    // materialized clients.js/manifest-*.js, they should right-click their
    // portfolio-master folder in Finder → "Make Available Offline" once.
    mainWindow.loadFile(indexPath);
  } else {
    // Defensive: ensureBoxFolder already validated, but just in case
    mainWindow.loadURL('data:text/html,<h2 style="font-family:sans-serif;padding:40px">Couldn\'t locate the portfolio in that folder.</h2>');
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  // Log renderer crash reason so we can diagnose blank-window issues
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[crash] render-process-gone — reason:', details.reason, '| exitCode:', details.exitCode);
    if (isAppQuitting) return;

    const now = Date.now();
    rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(ts => now - ts < 30000);
    if (rendererRecoveryTimestamps.length >= 3) {
      if (!FORCE_SOFTWARE_RENDERING) {
        console.error('[crash] repeated renderer exits; relaunching with --disable-gpu fallback');
        isAppQuitting = true;
        const relaunchArgs = process.argv.slice(1);
        if (!relaunchArgs.includes('--disable-gpu')) relaunchArgs.push('--disable-gpu');
        try { app.relaunch({ args: relaunchArgs }); } catch (_) { app.relaunch(); }
        app.exit(0);
        return;
      }
      console.error('[crash] renderer recovery halted after 3 exits in 30s');
      return;
    }
    rendererRecoveryTimestamps.push(now);

    // Recreate the window so users don't get left with a dead/blank app shell.
    setTimeout(() => {
      if (isAppQuitting) return;
      const activeBoxFolder = store.get('boxFolder');
      if (!activeBoxFolder) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.destroy(); } catch (_) { /* no-op */ }
      }
      mainWindow = null;
      createWindow(activeBoxFolder);
      scheduleStartupUpdateCheck(mainWindow);
    }, 250);
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[crash] renderer became unresponsive');
  });
}

// -----------------------------------------------------------------------------
// Admin auth — Feature 1
// -----------------------------------------------------------------------------
// Config lives in Box at portfolio-master/admin-config.json so all users share
// the same admin list automatically (Box sync propagates within seconds).
// Passwords are hashed with PBKDF2-SHA256 (100,000 iterations); salts are
// stored alongside the hash. No plaintext passwords ever touch disk.

const ADMIN_CONFIG_NAME = 'admin-config.json';

function adminConfigPath(boxFolder) {
  return path.join(boxFolder, 'Clients', 'BGE', 'portfolio-master', ADMIN_CONFIG_NAME);
}

function readAdminConfig(boxFolder) {
  try {
    return JSON.parse(fs.readFileSync(adminConfigPath(boxFolder), 'utf8'));
  } catch (_) {
    return { admins: [] };
  }
}

function writeAdminConfig(boxFolder, config) {
  fs.writeFileSync(adminConfigPath(boxFolder), JSON.stringify(config, null, 2));
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}

ipcMain.handle('admin-read-list', () => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  const config = readAdminConfig(boxFolder);
  return { ok: true, admins: config.admins.map(a => ({ id: a.id, name: a.name })) };
});

ipcMain.handle('admin-verify', (_evt, { name, password }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false };
  const config = readAdminConfig(boxFolder);
  const admin = config.admins.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!admin) return { ok: false };
  const hash = hashPassword(password, admin.salt);
  if (hash === admin.passwordHash) {
    store.set('adminSessionId', admin.id);
    return { ok: true };
  }
  return { ok: false };
});

// Restore a saved admin session (checks the stored ID still exists in config)
ipcMain.handle('admin-get-saved-session', () => {
  const savedId = store.get('adminSessionId');
  if (!savedId) return { ok: false };
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false };
  const config = readAdminConfig(boxFolder);
  const admin = config.admins.find(a => a.id === savedId);
  if (!admin) { store.delete('adminSessionId'); return { ok: false }; }
  return { ok: true, id: admin.id, name: admin.name };
});

ipcMain.handle('admin-save-session', (_evt, { id }) => {
  store.set('adminSessionId', id);
  return { ok: true };
});

ipcMain.handle('admin-clear-session', () => {
  store.delete('adminSessionId');
  return { ok: true };
});

ipcMain.handle('admin-add', (_evt, { name, password }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  const config = readAdminConfig(boxFolder);
  if (config.admins.some(a => a.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: 'duplicate-name' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const id = crypto.randomUUID();
  config.admins.push({ id, name, passwordHash, salt });
  writeAdminConfig(boxFolder, config);
  return { ok: true, admins: config.admins.map(a => ({ id: a.id, name: a.name })) };
});

ipcMain.handle('admin-remove', (_evt, { id }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  const config = readAdminConfig(boxFolder);
  config.admins = config.admins.filter(a => a.id !== id);
  writeAdminConfig(boxFolder, config);
  return { ok: true, admins: config.admins.map(a => ({ id: a.id, name: a.name })) };
});

ipcMain.handle('admin-change-password', (_evt, { id, newPassword }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  const config = readAdminConfig(boxFolder);
  const admin = config.admins.find(a => a.id === id);
  if (!admin) return { ok: false, reason: 'not-found' };
  const salt = crypto.randomBytes(16).toString('hex');
  admin.salt = salt;
  admin.passwordHash = hashPassword(newPassword, salt);
  writeAdminConfig(boxFolder, config);
  return { ok: true };
});

// -----------------------------------------------------------------------------
// Asset keywords — Feature 2
// -----------------------------------------------------------------------------
// Stored in Box at portfolio-master/asset-keywords.json. "RELEASE" is always
// active and is the default — it is NOT stored here (so it can't be deleted).
// Each entry has: { id, keyword, label, color }

const KEYWORDS_CONFIG_NAME = 'asset-keywords.json';

function keywordsConfigPath(boxFolder) {
  return path.join(boxFolder, 'Clients', 'BGE', 'portfolio-master', KEYWORDS_CONFIG_NAME);
}

function readKeywordsConfig(boxFolder) {
  try {
    return JSON.parse(fs.readFileSync(keywordsConfigPath(boxFolder), 'utf8'));
  } catch (_) {
    return { keywords: [] };
  }
}

ipcMain.handle('keywords-read', () => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  const config = readKeywordsConfig(boxFolder);
  return { ok: true, keywords: config.keywords };
});

ipcMain.handle('keywords-save', (_evt, { keywords }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  fs.writeFileSync(keywordsConfigPath(boxFolder), JSON.stringify({ keywords }, null, 2));
  return { ok: true };
});

// -----------------------------------------------------------------------------
// Notes — Feature 4
// -----------------------------------------------------------------------------
const NOTES_FILE_NAME = 'notes.json';
const FAVORITES_FILE_NAME = 'favorites.json';

function notesFilePath(boxFolder) {
  return path.join(boxFolder, 'Clients', 'BGE', 'portfolio-master', NOTES_FILE_NAME);
}

function readNotesFile(boxFolder) {
  try {
    const raw = fs.readFileSync(notesFilePath(boxFolder), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.notes)) parsed.notes = [];
    return parsed;
  } catch (_) {
    return { notes: [] };
  }
}

ipcMain.handle('notes-read', () => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  return { ok: true, data: readNotesFile(boxFolder) };
});

ipcMain.handle('notes-save', (_evt, { notePayload }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };

  const notesData = readNotesFile(boxFolder);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const user = os.userInfo().username;
  
  const existing = notesData.notes.find(n => n.id === notePayload.id);
  let saved;
  if (existing) {
    Object.assign(existing, {
      title: notePayload.title,
      body: notePayload.body,
      client: notePayload.client,
      year: notePayload.year,
      month: notePayload.month,
      modifiedAt: now,
      modifiedBy: user,
    });
    saved = existing;
  } else {
    saved = {
      id: notePayload.id || `n${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      title: notePayload.title,
      body: notePayload.body,
      client: notePayload.client,
      year: notePayload.year,
      month: notePayload.month,
      createdAt: now,
      modifiedAt: now,
      createdBy: user,
      modifiedBy: user,
    };
    notesData.notes.push(saved);
  }
  
  fs.writeFileSync(notesFilePath(boxFolder), JSON.stringify(notesData, null, 2));
  return { ok: true, note: saved };
});

ipcMain.handle('notes-delete', (_evt, { id }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  const notesData = readNotesFile(boxFolder);
  const before = notesData.notes.length;
  notesData.notes = notesData.notes.filter(n => n.id !== id);
  if (notesData.notes.length === before) return { ok: false, reason: 'not-found' };
  fs.writeFileSync(notesFilePath(boxFolder), JSON.stringify(notesData, null, 2));
  return { ok: true };
});

// -----------------------------------------------------------------------------
// Favorites & Awards — Feature 5
// -----------------------------------------------------------------------------

function favoritesFilePath(boxFolder) {
  return path.join(boxFolder, 'Clients', 'BGE', 'portfolio-master', FAVORITES_FILE_NAME);
}

function readFavoritesFile(boxFolder) {
  try {
    const raw = fs.readFileSync(favoritesFilePath(boxFolder), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.favorites !== 'object' || parsed.favorites === null) parsed.favorites = {};
    if (typeof parsed.awards !== 'object' || parsed.awards === null) parsed.awards = {};
    return parsed;
  } catch (_) {
    return { favorites: {}, awards: {} };
  }
}

ipcMain.handle('favorites-read', () => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  return { ok: true, data: readFavoritesFile(boxFolder) };
});

ipcMain.handle('favorites-save', (_evt, { data }) => {
  const boxFolder = store.get('boxFolder');
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };
  if (!data || typeof data !== 'object') return { ok: false, reason: 'bad-data' };
  const safe = {
    favorites: typeof data.favorites === 'object' && data.favorites ? data.favorites : {},
    awards: typeof data.awards === 'object' && data.awards ? data.awards : {},
  };
  fs.writeFileSync(favoritesFilePath(boxFolder), JSON.stringify(safe, null, 2));
  return { ok: true };
});

// -----------------------------------------------------------------------------
// PDF Export — Feature 3
// -----------------------------------------------------------------------------

ipcMain.handle('show-save-dialog', async (_evt, { defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Portfolio Export',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return result.canceled ? { ok: false } : { ok: true, filePath: result.filePath };
});

ipcMain.handle('export-pdf', async (_evt, { filePath, customPageSize, landscape }) => {
  try {
    const MAX_PDF_EDGE_MICRONS = 5_000_000; // Keep below typical 200in PDF viewer limit
    const hasValidCustomPage =
      customPageSize &&
      Number.isFinite(customPageSize.width) &&
      Number.isFinite(customPageSize.height) &&
      customPageSize.width > 0 &&
      customPageSize.height > 0 &&
      customPageSize.width <= MAX_PDF_EDGE_MICRONS &&
      customPageSize.height <= MAX_PDF_EDGE_MICRONS;

    const pdfOptions = {
      printBackground: true,
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      pageSize: 'Letter',
      landscape: (typeof landscape === 'boolean') ? landscape : true,
    };

    if (hasValidCustomPage) {
      // customPageSize is { width, height } in microns
      pdfOptions.pageSize = {
        width: Math.round(customPageSize.width),
        height: Math.round(customPageSize.height),
      };
      delete pdfOptions.landscape;
    } else if (customPageSize) {
      console.warn(
        '[pdf] custom page size out of range; using Letter landscape instead:',
        customPageSize
      );
    }
    const data = await mainWindow.webContents.printToPDF(pdfOptions);
    fs.writeFileSync(filePath, data);
    return { ok: true };
  } catch (err) {
    console.error('[pdf] export failed:', err);
    return { ok: false, reason: String(err && err.message || err) };
  }
});

// -----------------------------------------------------------------------------
// IPC for renderer
// -----------------------------------------------------------------------------
ipcMain.handle('changeBoxFolder', async () => {
  const picked = await pickBoxFolder();
  if (!picked) return { ok: false, reason: 'cancelled' };
  if (!isValidBoxFolder(picked)) {
    return { ok: false, reason: 'invalid' };
  }
  store.set('boxFolder', picked);
  // Reload with new folder
  if (mainWindow) {
    const indexPath = findPortfolioIndex(picked);
    if (indexPath) mainWindow.loadFile(indexPath);
  }
  return { ok: true, path: picked };
});

ipcMain.handle('getBoxFolder', () => store.get('boxFolder') || null);

// -----------------------------------------------------------------------------
// Server mode (run the build/serve pipeline on this machine)
// -----------------------------------------------------------------------------
//
// Layout: when packaged, py-scripts/ lives under process.resourcesPath. In dev
// it lives in the source folder.
//
// Coordination: a Box-level heartbeat file (.builder-active.json) prevents two
// machines from running the pipeline at the same time. The active builder
// rewrites it every 30s. If the file is stale (>2 min), any other machine can
// claim the role.

const LOCK_FILE_NAME = '.builder-active.json';
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;

let serverState = {
  running: false,
  buildProc: null,
  serveProc: null,
  fswatchProc: null,
  heartbeatTimer: null,
  lastBuildAt: null,
  lastBuildOk: null,
  lastBuildLine: '',
  s3SyncOk: null,
  s3SyncLine: '',
};

function getPythonCommand() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function pyScriptsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'py-scripts')
    : path.join(__dirname, 'py-scripts');
}

function portfolioMasterDir(boxFolder) {
  // Same canonical location the build script writes to.
  return path.join(boxFolder, 'Clients', 'BGE', 'portfolio-master');
}

function lockFilePath(boxFolder) {
  return path.join(portfolioMasterDir(boxFolder), LOCK_FILE_NAME);
}

function readBuilderLock(boxFolder) {
  try {
    const raw = fs.readFileSync(lockFilePath(boxFolder), 'utf8');
    const data = JSON.parse(raw);
    const age = Date.now() - new Date(data.lastSeen).getTime();
    return { ...data, ageMs: age, stale: age > LOCK_STALE_MS };
  } catch (err) {
    return null;
  }
}

function writeBuilderLock(boxFolder) {
  const payload = {
    machine: os.hostname(),
    user: os.userInfo().username,
    pid: process.pid,
    appVersion: app.getVersion(),
    lastSeen: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(lockFilePath(boxFolder), JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[server] failed to write lock:', err);
  }
}

function clearBuilderLock(boxFolder) {
  try { fs.unlinkSync(lockFilePath(boxFolder)); } catch (_) { /* ignore */ }
}

function emitServerState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const webContents = mainWindow.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  try {
    webContents.send('server-state', getServerStatePublic());
  } catch (err) {
    console.warn('[server] emitServerState skipped:', err && err.message ? err.message : err);
  }
}

function getServerStatePublic() {
  return {
    running: serverState.running,
    lastBuildAt: serverState.lastBuildAt,
    lastBuildOk: serverState.lastBuildOk,
    lastBuildLine: serverState.lastBuildLine,
    s3SyncOk: serverState.s3SyncOk,
    s3SyncLine: serverState.s3SyncLine,
  };
}

function startServer(boxFolder, { takeover = false } = {}) {
  if (serverState.running) return { ok: true, alreadyRunning: true };
  if (!boxFolder) return { ok: false, reason: 'no-box-folder' };

  // Check the Box-level lock unless takeover was explicitly requested.
  const existing = readBuilderLock(boxFolder);
  if (existing && !existing.stale && !takeover) {
    const sameMachine = existing.machine === os.hostname() && existing.pid !== process.pid;
    return {
      ok: false,
      reason: sameMachine ? 'in-use-same-machine' : 'in-use-other-machine',
      activeBuilder: existing,
    };
  }

  const scriptsDir = pyScriptsDir();
  const buildScript = path.join(scriptsDir, 'build-portfolio.py');
  const serveScript = path.join(scriptsDir, 'serve-portfolio.py');

  if (!fs.existsSync(buildScript) || !fs.existsSync(serveScript)) {
    return { ok: false, reason: 'scripts-missing', detail: scriptsDir };
  }

  // 1) Local HTTP server on :8765 — same as watch-and-build.sh used to start.
  serverState.serveProc = spawn(getPythonCommand(), [serveScript], {
    cwd: scriptsDir,
    env: { ...process.env, ICF_BOX_ROOT: boxFolder },
    stdio: 'ignore',
  });
  serverState.serveProc.on('error', (err) => console.error('[server] serve err:', err));

  // 2) Initial build.
  runOneBuild(boxFolder, 'initial');

  // 3) Heartbeat loop — also doubles as the rebuild scheduler if fswatch
  //    is missing, by triggering a build every N heartbeats.
  let beats = 0;
  const HEARTBEAT_BUILD_EVERY = 6; // 6 * 30s = 3 min
  writeBuilderLock(boxFolder);
  serverState.heartbeatTimer = setInterval(() => {
    writeBuilderLock(boxFolder);
    beats += 1;
    if (beats % HEARTBEAT_BUILD_EVERY === 0) {
      runOneBuild(boxFolder, 'heartbeat');
    }
  }, LOCK_HEARTBEAT_MS);

  // 4) fswatch (optional — falls back to heartbeat-only rebuilds if missing).
  try {
    serverState.fswatchProc = spawn('fswatch', ['-o', '--latency', '60',
      path.join(boxFolder, 'Clients')], { stdio: ['ignore', 'pipe', 'pipe'] });
    serverState.fswatchProc.stdout.on('data', () => runOneBuild(boxFolder, 'fswatch'));
    serverState.fswatchProc.stderr.on('data', () => {}); // drain stderr
    serverState.fswatchProc.on('error', () => { /* fswatch not installed; ignore */ });
  } catch (_) { /* fswatch not on PATH; heartbeat builds will cover it */ }

  serverState.running = true;
  store.set('serverWasRunning', true);
  emitServerState();
  return { ok: true };
}

function runOneBuild(boxFolder, reason) {
  if (serverState.buildProc) return; // already building
  const scriptsDir = pyScriptsDir();
  const buildScript = path.join(scriptsDir, 'build-portfolio.py');
  serverState.lastBuildLine = `${new Date().toLocaleTimeString()} — building (${reason})…`;
  emitServerState();

  // Read custom asset keywords and pass to build script as env var.
  const kwConfig = readKeywordsConfig(boxFolder);
  const extraKeywords = kwConfig.keywords.map(k => k.keyword).join(',');

  const proc = spawn(getPythonCommand(), [buildScript, '--client', 'all'], {
    cwd: scriptsDir,
    env: { ...process.env, ICF_BOX_ROOT: boxFolder, ICF_ASSET_KEYWORDS: extraKeywords },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverState.buildProc = proc;
  let lastLine = '';
  proc.stdout.on('data', (b) => {
    const lines = b.toString().split('\n').filter(Boolean);
    if (lines.length) lastLine = lines[lines.length - 1];
  });
  proc.stderr.on('data', () => {}); // drain stderr so it doesn't block
  proc.on('close', (code) => {
    serverState.buildProc = null;
    serverState.lastBuildAt = new Date().toISOString();
    serverState.lastBuildOk = code === 0;
    serverState.lastBuildLine = code === 0
      ? `${new Date().toLocaleTimeString()} — built (${reason})`
      : `${new Date().toLocaleTimeString()} — build failed (${reason})`;
    emitServerState();
    if (code === 0) syncToS3(boxFolder);
  });
}

function syncToS3(boxFolder) {
  const syncScript = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'sync-to-s3.sh')
    : path.join(__dirname, 'scripts', 'sync-to-s3.sh');

  if (!fs.existsSync(syncScript)) {
    console.warn('[s3-sync] sync-to-s3.sh not found at', syncScript);
    return;
  }

  serverState.s3SyncLine = `${new Date().toLocaleTimeString()} — syncing to web…`;
  emitServerState();

  const proc = spawn('bash', [syncScript], {
    env: { ...process.env, ICF_BOX_ROOT: boxFolder },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lastLine = '';
  const onData = (b) => {
    const lines = b.toString().split('\n').filter(Boolean);
    if (lines.length) lastLine = lines[lines.length - 1];
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    serverState.s3SyncOk = code === 0;
    serverState.s3SyncLine = code === 0
      ? `${new Date().toLocaleTimeString()} — web synced`
      : `${new Date().toLocaleTimeString()} — web sync failed`;
    console.log('[s3-sync]', serverState.s3SyncLine, '| last:', lastLine);
    emitServerState();
  });

  proc.on('error', (err) => {
    serverState.s3SyncOk = false;
    serverState.s3SyncLine = `${new Date().toLocaleTimeString()} — web sync error: ${err.message}`;
    console.error('[s3-sync] spawn error:', err);
    emitServerState();
  });
}

function stopServer() {
  const boxFolder = store.get('boxFolder');
  if (serverState.heartbeatTimer) { clearInterval(serverState.heartbeatTimer); serverState.heartbeatTimer = null; }
  for (const k of ['buildProc', 'serveProc', 'fswatchProc']) {
    if (serverState[k]) {
      try { serverState[k].kill('SIGTERM'); } catch (_) { /* ignore */ }
      serverState[k] = null;
    }
  }
  if (boxFolder) clearBuilderLock(boxFolder);
  serverState.running = false;
  emitServerState();
}

ipcMain.handle('serverStart', (_evt, { takeover } = {}) => {
  return startServer(store.get('boxFolder'), { takeover: !!takeover });
});
ipcMain.handle('serverStop', () => {
  stopServer();
  store.set('serverWasRunning', false);
  return { ok: true };
});
ipcMain.handle('serverStatus', () => {
  const boxFolder = store.get('boxFolder');
  return {
    self: getServerStatePublic(),
    activeBuilder: boxFolder ? readBuilderLock(boxFolder) : null,
    appVersion: app.getVersion(),
    machine: os.hostname(),
  };
});

// -----------------------------------------------------------------------------
// App menu (Mac-style)
// -----------------------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Change Box Folder…',
          click: async () => {
            const picked = await pickBoxFolder();
            if (picked && isValidBoxFolder(picked)) {
              store.set('boxFolder', picked);
              if (mainWindow) {
                const indexPath = findPortfolioIndex(picked);
                if (indexPath) mainWindow.loadFile(indexPath);
              }
            }
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    // Edit menu — without this, Cmd+V/Cmd+C/Cmd+X don't reach input fields
    // because setApplicationMenu replaces the entire default menu (Mac's
    // built-in Edit submenu, including Paste, vanishes unless we add one).
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -----------------------------------------------------------------------------
// Splash screen & Pre-fetch
// -----------------------------------------------------------------------------
let splashWindow = null;
let splashSkipped = false;

ipcMain.on('splash-skip', () => { 
  splashSkipped = true; 
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
});

async function getTargetFilesToFetch(boxFolder) {
  const masterDir = path.join(boxFolder, 'Clients', 'BGE', 'portfolio-master');
  const files = [];

  const addFile = async (p) => {
    try {
      const st = await fs.promises.stat(p);
      if (st.isFile()) files.push(p);
    } catch(err) {}
  };

  // Priority 1
  await addFile(path.join(masterDir, 'index.html'));
  await addFile(path.join(masterDir, 'clients.js'));
  try {
    const mans = await fs.promises.readdir(masterDir);
    for (const m of mans.filter(f => f.startsWith('manifest-') && f.endsWith('.js'))) {
      await addFile(path.join(masterDir, m));
    }
  } catch (err) {}

  // Priority 2
  const scanDir = async (dir) => {
    if (splashSkipped) return;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (splashSkipped) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await scanDir(full);
        } else if (ent.isFile() && !ent.name.startsWith('.')) {
          files.push(full);
        }
      }
    } catch (err) {}
  };

  await scanDir(path.join(masterDir, 'thumbs'));
  await scanDir(path.join(masterDir, 'logos'));
  await scanDir(path.join(masterDir, 'fonts'));

  return files;
}

async function prefetchContent(boxFolder) {
  const files = await getTargetFilesToFetch(boxFolder);
  if (!files.length) return;

  if (splashWindow) {
    splashWindow.webContents.send('splash-progress', { pct: 0, detail: `Found ${files.length.toLocaleString()} files` });
  }

  let completed = 0;
  const maxConcurrency = 16;
  const queue = [...files];

  const worker = async () => {
    while (queue.length > 0 && !splashSkipped) {
      const f = queue.pop();
      try {
        const handle = await fs.promises.open(f, 'r');
        const buf = Buffer.alloc(1);
        await handle.read(buf, 0, 1, 0);
        await handle.close();
      } catch (e) {}
      
      completed++;
      if (completed % 50 === 0 && splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send('splash-progress', {
          pct: Math.floor((completed / files.length) * 100),
          detail: `Checked ${completed.toLocaleString()} of ${files.length.toLocaleString()} files`
        });
      }
    }
  };

  const workers = [];
  for (let i = 0; i < maxConcurrency; i++) workers.push(worker());
  await Promise.all(workers);
}

async function showSplashAndWaitForPrefetch(boxFolder) {
  splashSkipped = false;
  return new Promise((resolve) => {
    splashWindow = new BrowserWindow({
      width: 400,
      height: 250,
      frame: false,
      transparent: true,
      resizable: false,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'splash-preload.js'),
      }
    });

    splashWindow.loadFile('splash.html');
    
    // Fallback: sometimes the window load takes a while, just start prefetch immediately.
    prefetchContent(boxFolder).then(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
      resolve();
    });

    splashWindow.on('closed', () => {
      splashWindow = null;
      splashSkipped = true;
      resolve();
    });
  });
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

app.whenReady().then(async () => {
  buildMenu();
  const boxFolder = await ensureBoxFolder();
  if (!boxFolder) return;
  
  await showSplashAndWaitForPrefetch(boxFolder);
  
  createWindow(boxFolder);
  scheduleStartupUpdateCheck(mainWindow);

  // Auto-restart server if it was running when the app was last closed/killed.
  if (store.get('serverWasRunning') && boxFolder) {
    startServer(boxFolder);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(boxFolder);
      scheduleStartupUpdateCheck(mainWindow);
    }
  });
});

// Make sure the server is shut down (and the Box lock cleared) before quit.
app.on('before-quit', () => {
  isAppQuitting = true;
  if (serverState.running) stopServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
