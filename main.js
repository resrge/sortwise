const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const organizer = require('./src/organizer');
const { FolderWatcher } = require('./src/watcher');
const { Updater } = require('./src/updater');
const pkg = require('./package.json');

const APP_ID = 'com.resrge.sortwise';
const APP_VERSION = pkg.version;
const BUILD = pkg.buildStamp || '';
const ICON = path.join(__dirname, 'assets', 'icon.png');
const START_HIDDEN = process.argv.includes('--hidden');
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY = 25;

// One copy at a time; a second launch just shows the window
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

// ---------- Settings & history ----------
const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const historyFile = () => path.join(dataDir(), 'history.json');

const DEFAULTS = {
  mode: 'category',
  groupSimilar: true,
  minGroup: 2,
  includeHidden: false,
  watch: false,         // watch the source folder for new files
  autoClean: false,     // move new files automatically
  openAfter: false,     // open the destination folder after a manual run
  startWithWindows: false,
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getSettings() {
  const s = { ...DEFAULTS, ...readJSON(settingsFile(), {}) };
  if (!s.source) s.source = app.getPath('downloads');
  if (!s.dest) s.dest = path.join(s.source, 'Organized');
  if (s.autoClean) s.watch = true;
  return s;
}
function saveSettings(next) {
  const prev = getSettings();
  const merged = { ...prev, ...next };
  if (merged.autoClean) merged.watch = true;
  writeJSON(settingsFile(), merged);
  applySettings(prev, merged);
  send('settings:changed', merged);
  return merged;
}

function recordHistory(s, log, extra = {}) {
  if (!log.length) return null;
  const history = readJSON(historyFile(), []);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    date: new Date().toISOString(),
    source: s.source, dest: s.dest,
    count: log.length, log, undone: false, ...extra,
  };
  history.unshift(entry);
  writeJSON(historyFile(), history.slice(0, MAX_HISTORY));
  send('history:changed');
  return entry;
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// Moves and undos never overlap (auto-organize can fire while you click Organize)
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- Window ----------
function createWindow({ show = true } = {}) {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1115',
    title: 'SortWise',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32'
      ? { color: '#0f1115', symbolColor: '#9aa3b2', height: 38 }
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });

  // While watching, closing the window keeps SortWise running in the tray
  win.on('close', (e) => {
    if (quitting || !getSettings().watch) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: 'SortWise is still watching',
        body: 'It keeps running in the tray. Right-click the tray icon to quit.',
        icon: ICON, silent: true,
      }).show();
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- Tray ----------
function refreshTray() {
  const s = getSettings();
  if (!s.watch) {
    if (tray) { tray.destroy(); tray = null; }
    return;
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('click', showWindow);
  }
  const folder = path.basename(s.source) || s.source;
  tray.setToolTip(`SortWise — ${s.autoClean ? 'auto-organizing' : 'watching'} ${folder}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open SortWise', click: showWindow },
    { type: 'separator' },
    { label: `Watching ${folder}`, enabled: false },
    { label: 'Auto-organize new files', type: 'checkbox', checked: s.autoClean,
      click: (item) => saveSettings({ autoClean: item.checked }) },
    { label: 'Stop watching', click: () => saveSettings({ watch: false, autoClean: false }) },
    { type: 'separator' },
    { label: 'Open organized folder', click: () => openFolder(s.dest) },
    { type: 'separator' },
    { label: 'Quit SortWise', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- Watching & auto-organize ----------
const watcher = new FolderWatcher();
watcher.on('error', (err) => console.error('[watch]', err.message));
watcher.on('new-files', (paths) => {
  const s = getSettings();
  if (s.autoClean) exclusive(() => autoOrganize(paths, s));
  else send('watch:new-files', { count: paths.length, names: paths.map(p => path.basename(p)) });
});

async function applyWatch(s) {
  if (s.watch && fs.existsSync(s.source)) {
    try { await watcher.start(s.source, { includeHidden: s.includeHidden }); }
    catch (err) { console.error('[watch]', err.message); }
  } else {
    watcher.stop();
  }
  send('watch:state', { watching: watcher.active, autoClean: s.autoClean, source: s.source });
}

async function autoOrganize(paths, s) {
  const { files } = await organizer.scanFolder(s.source, { includeHidden: s.includeHidden });
  const existing = await organizer.loadExistingFamilies(s.dest);
  const groups = organizer.buildPlan(files, {
    mode: s.mode, groupSimilar: s.groupSimilar, minGroup: s.minGroup, destDir: s.dest, existing,
  });
  const wanted = new Set(paths);
  const moves = [];
  for (const g of groups) for (const f of g.files) if (wanted.has(f.path)) moves.push({ from: f.path, toDir: g.target });
  if (!moves.length) return;

  const { log, errors } = await organizer.executeMoves(moves);
  const entry = recordHistory(s, log, { auto: true });
  send('organizer:changed', { auto: true, moved: log.length, errors: errors.length, id: entry?.id });

  if (log.length && Notification.isSupported()) {
    const names = log.map(l => path.basename(l.to));
    const where = path.relative(s.dest, path.dirname(log[0].to)) || path.basename(s.dest);
    const n = new Notification({
      title: log.length === 1 ? `Moved ${names[0]}` : `Moved ${log.length} new files`,
      body: log.length === 1 ? `into ${where}` : names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : ''),
      icon: ICON, silent: true,
    });
    // Clicking opens the folder the file went to (or the whole organized folder for several)
    n.on('click', () => openFolder(log.length === 1 ? path.dirname(log[0].to) : s.dest));
    n.show();
  }
}

function openFolder(p) {
  if (!p) return;
  fs.mkdirSync(p, { recursive: true });
  return shell.openPath(p);
}

// ---------- Start with Windows ----------
function applyLoginItem(s) {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: !!s.startWithWindows,
    path: process.execPath,
    args: ['--hidden'],
    name: 'SortWise',
  });
}

function applySettings(prev, next) {
  if (!prev || prev.watch !== next.watch || prev.source !== next.source ||
      prev.includeHidden !== next.includeHidden || prev.autoClean !== next.autoClean) {
    applyWatch(next);
  }
  if (!prev || prev.startWithWindows !== next.startWithWindows) applyLoginItem(next);
  refreshTray();
}

// ---------- Updates ----------
const updater = new Updater({
  owner: pkg.updates?.owner,
  repo: pkg.updates?.repo,
  mirror: pkg.updates?.mirror,
  version: APP_VERSION,
  build: BUILD,
});
updater.on('state', (st) => {
  send('update:state', st);
  if (st.status === 'ready' && tray) tray.setToolTip(`SortWise — update v${st.update?.version} ready`);
});
function scheduleUpdateChecks() {
  if (!app.isPackaged) return; // no auto checks when running from source
  setTimeout(() => updater.check().catch(() => {}), 8000);
  setInterval(() => updater.check().catch(() => {}), UPDATE_EVERY_MS);
}

// ---------- App lifecycle ----------
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  const s = getSettings();
  // Launched at login with --hidden: stay in the tray if watching
  createWindow({ show: !(START_HIDDEN && s.watch) });
  applySettings(null, s);
  scheduleUpdateChecks();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (!getSettings().watch && process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (!win) createWindow(); });

// ---------- IPC ----------
ipcMain.handle('app:info', () => ({
  version: APP_VERSION,
  build: BUILD,
  platform: process.platform,
  packaged: app.isPackaged,
  downloads: app.getPath('downloads'),
}));

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, s) => saveSettings(s));

ipcMain.handle('dialog:pickFolder', async (_e, { title, defaultPath }) => {
  const res = await dialog.showOpenDialog(win, {
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('organizer:scan', async (_e, opts) => {
  const { source, dest, mode, groupSimilar, minGroup, includeHidden } = opts;
  if (!source || !fs.existsSync(source)) throw new Error('That source folder no longer exists.');
  const { files, skipped } = await organizer.scanFolder(source, { includeHidden });
  const existing = await organizer.loadExistingFamilies(dest);
  const groups = organizer.buildPlan(files, { mode, groupSimilar, minGroup, destDir: dest, existing });
  return { groups, skipped, total: files.length };
});

ipcMain.handle('organizer:execute', (_e, { source, dest, moves }) => exclusive(async () => {
  const result = await organizer.executeMoves(moves, (done, total) => {
    send('organizer:progress', { done, total, phase: 'move' });
  });
  const entry = recordHistory({ source, dest }, result.log);
  if (result.log.length && getSettings().openAfter) openFolder(dest);
  return { moved: result.log.length, errors: result.errors, id: entry?.id };
}));

ipcMain.handle('history:list', () =>
  readJSON(historyFile(), []).map(({ log, ...rest }) => rest)
);

ipcMain.handle('history:undo', (_e, id) => exclusive(async () => {
  const history = readJSON(historyFile(), []);
  const run = history.find(h => h.id === id);
  if (!run) throw new Error('That run was not found.');
  if (run.undone) throw new Error('That run was already undone.');
  // Files put back into a watched folder shouldn't be instantly auto-organized again
  const wasAuto = getSettings().autoClean;
  if (wasAuto) watcher.stop();
  const { errors } = await organizer.undoMoves(run.log, (done, total) => {
    send('organizer:progress', { done, total, phase: 'undo' });
  });
  run.undone = true;
  writeJSON(historyFile(), history);
  if (wasAuto) await applyWatch(getSettings());
  send('history:changed');
  return { restored: run.log.length - errors.length, errors };
}));

ipcMain.handle('history:clear', () => { writeJSON(historyFile(), []); return true; });

ipcMain.handle('watch:state', () => ({ watching: watcher.active, autoClean: getSettings().autoClean, source: getSettings().source }));

ipcMain.handle('update:state', () => updater.state);
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:install', () => {
  if (!updater.installAndRestart()) return false;
  quitting = true;
  setTimeout(() => app.quit(), 600);
  return true;
});

ipcMain.handle('shell:open', (_e, p) => openFolder(p));
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
