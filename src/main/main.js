'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell, clipboard, nativeTheme, session, nativeImage, screen, Notification } = require('electron');
const { Store, deepMerge } = require('./store');
const { NetContext } = require('./engine/net');
const { DownloadManager } = require('./manager');
const { QueueManager } = require('./queues');
const { GrabberRun, newProject, FILE_PRESETS } = require('./grabber');
const { LinkGrabber } = require('./linkgrabber');
const { IntegrationServer } = require('./integration');
const { parseArgs } = require('./cli');
const { powerAction, cancelShutdown } = require('./power');
const { defaultCategories } = require('./defaults');
const u = require('./util');

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// Portable/test mode: keep settings and the download list in a custom folder.
if (process.env.OPENDM_DATA_DIR) app.setPath('userData', path.resolve(process.env.OPENDM_DATA_DIR));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId('com.opendm.app');

let store, net, manager, queues, linkGrabber, server, tray, mainWin, dropWin;
const views = new Map(); // key -> BrowserWindow
const pending = new Map(); // token -> payload for dialog windows
const grabRuns = new Map(); // projectId -> GrabberRun
const interactive = new Set(); // item ids started by the user (show progress window)
const cliQuitAfter = new Set();
let quitting = false;

// ---- windows -----------------------------------------------------------------------------------

// The installer copies the extension next to the app (resources/extension).
function extensionDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(ROOT, 'extension');
}

function iconPath(size = 256) {
  return path.join(ASSETS, `icon${size}.png`);
}

function baseWebPrefs() {
  return { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false };
}

function createMainWindow(show = true) {
  const b = store.settings.appearance.window || {};
  mainWin = new BrowserWindow({
    width: b.width || 1100, height: b.height || 680, x: b.x, y: b.y, minWidth: 720, minHeight: 420,
    title: 'OpenDM', icon: iconPath(), show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d21' : '#f6f7f9',
    webPreferences: baseWebPrefs(),
  });
  if (b.maximized) mainWin.maximize();
  mainWin.loadFile(RENDERER, { query: { view: 'main' } });
  mainWin.once('ready-to-show', () => show && mainWin.show());
  mainWin.on('close', (e) => {
    saveWindowBounds();
    if (!quitting && store.settings.general.minimizeToTray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => {
    mainWin = null;
  });
  guardNavigation(mainWin);
}

function saveWindowBounds() {
  if (!mainWin || mainWin.isDestroyed()) return;
  store.settings.appearance.window = { ...mainWin.getNormalBounds(), maximized: mainWin.isMaximized() };
  store.save('settings');
}

function showMain() {
  if (!mainWin) createMainWindow(true);
  else {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
}

function guardNavigation(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Opens (or focuses) a secondary view. key de-duplicates windows (e.g. one progress window per download). */
function openView(view, params = {}, opts = {}) {
  const key = opts.key || view;
  const existing = views.get(key);
  if (existing && !existing.isDestroyed()) {
    if (opts.payload) existing.webContents.send('payload', opts.payload);
    if (!opts.background) {
      existing.show();
      existing.focus();
    }
    return existing;
  }
  let token = null;
  if (opts.payload) {
    token = u.id();
    pending.set(token, opts.payload);
  }
  const win = new BrowserWindow({
    width: opts.width || 520, height: opts.height || 420, minWidth: opts.minWidth || 360, minHeight: opts.minHeight || 200,
    title: opts.title || 'OpenDM', icon: iconPath(), show: false, resizable: opts.resizable !== false,
    alwaysOnTop: !!opts.alwaysOnTop, frame: opts.frame !== false, transparent: !!opts.transparent, skipTaskbar: !!opts.skipTaskbar,
    minimizable: opts.minimizable !== false, maximizable: !!opts.maximizable, autoHideMenuBar: true,
    backgroundColor: opts.transparent ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1b1d21' : '#f6f7f9',
    x: opts.x, y: opts.y, webPreferences: baseWebPrefs(),
  });
  win.setMenu(null);
  win.loadFile(RENDERER, { query: { view, ...params, ...(token ? { token } : {}) } });
  win.once('ready-to-show', () => {
    if (opts.minimized) win.showInactive(), win.minimize();
    else if (opts.inactive) win.showInactive();
    else win.show();
  });
  win.on('closed', () => {
    views.delete(key);
    if (token) pending.delete(token);
  });
  guardNavigation(win);
  views.set(key, win);
  return win;
}

function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: iconPath(64), silent: true }).show();
}

// ---- download flows ----------------------------------------------------------------------------

/** Entry for every new URL (browser, clipboard, CLI, drop target). Shows "Download File Info" unless silent. */
async function newDownload(payload, { silent = false, startNow, queueOnly = false } = {}) {
  const s = store.settings.downloads;
  if (!silent && s.showStartDialog) {
    openView('newdl', {}, { key: 'newdl:' + u.id(), payload, width: 620, height: 430, title: 'Download File Info', alwaysOnTop: true, resizable: true });
    return null;
  }
  const start = queueOnly ? false : startNow ?? !s.addOnlyNoStart;
  const res = await manager.add({ ...payload, start: false });
  if (queueOnly) queues.addItems('main', [res.item.id]);
  if (start) startInteractive(res.item.id, !silent);
  return res.item;
}

function startInteractive(id, showProgress = true) {
  if (showProgress) interactive.add(id);
  manager.start(id);
}

function openProgress(id) {
  const mode = store.settings.downloads.progressDialog;
  const item = manager.get(id);
  if (!item) return;
  openView('progress', { id }, { key: 'progress:' + id, width: 580, height: 560, minWidth: 460, minHeight: 300, title: item.fileName, minimized: mode === 'minimized', inactive: false });
}

function onComplete(item) {
  const full = manager.get(item.id);
  const wantDialog = full?.onComplete?.showDialog ?? store.settings.downloads.showCompleteDialog;
  const pw = views.get('progress:' + item.id);
  if (pw && !pw.isDestroyed()) pw.close();
  if (wantDialog && interactive.has(item.id)) {
    openView('complete', { id: item.id }, { key: 'complete:' + item.id, width: 540, height: 300, title: 'Download complete', resizable: false, alwaysOnTop: true });
  } else if (!mainWin?.isVisible()) notify('Download complete', item.fileName);
  interactive.delete(item.id);
  broadcast('sound', 'complete');
  const oc = full?.onComplete || {};
  if (oc.power && oc.power !== 'none') scheduleShutdown(oc.power, oc.forceTerminate, `"${item.fileName}" finished downloading.`);
  else if (oc.exitApp) quitApp();
  if (cliQuitAfter.has(item.id)) {
    cliQuitAfter.delete(item.id);
    if (!cliQuitAfter.size) quitApp();
  }
}

function scheduleShutdown(kind, force, reason) {
  openView('countdown', { kind, force: force ? 1 : 0, reason }, { width: 420, height: 220, title: 'OpenDM', alwaysOnTop: true, resizable: false });
}

function onQueueFinished(q) {
  broadcast('sound', 'queueDone');
  const oc = q.onComplete || {};
  if (oc.runFile) shell.openPath(oc.runFile);
  if (oc.power && oc.power !== 'none') scheduleShutdown(oc.power, oc.forceTerminate, `Queue "${q.name}" has finished.`);
  else if (oc.exitApp) setTimeout(quitApp, 10000);
  else if (!mainWin?.isVisible()) notify('Queue finished', q.name);
}

// ---- grabber -----------------------------------------------------------------------------------

function grabberProject(id) {
  return store.grabberProjects.find((p) => p.id === id);
}

function runGrabber(id, mode = 'explore') {
  const p = grabberProject(id);
  if (!p) throw new Error('No such project');
  grabRuns.get(id)?.stop();
  const run = new GrabberRun(p, { net, manager, getSettings: () => store.settings });
  grabRuns.set(id, run);
  let t = null;
  run.on('update', () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      broadcast('grabber:update', id, p);
    }, 250);
  });
  run.on('done', () => {
    store.save('grabber');
    broadcast('grabber:update', id, p);
    broadcast('grabber:done', id);
  });
  if (mode === 'download') {
    run.downloadChecked().then(() => {
      run.running = false;
      run.emit('done', id);
    });
  } else {
    if (mode === 'explore-download') p.startDownloadAll = true;
    run.start().catch((e) => broadcast('grabber:error', id, e.message));
  }
  return true;
}

function checkGrabberSchedules() {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  for (const p of store.grabberProjects) {
    const s = p.schedule;
    if (!s?.enabled) continue;
    const key = `${p.id}|${now.toDateString()}|${t}`;
    if (checkGrabberSchedules.fired.has(key)) continue;
    const dayOk = (s.days || []).includes(now.getDay());
    const startMin = Number(s.startTime.slice(0, 2)) * 60 + Number(s.startTime.slice(3));
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const inWindow = !s.stopEnabled || t < s.stopTime;
    const due = t === s.startTime || (s.periodicMinutes > 0 && nowMin > startMin && inWindow && (nowMin - startMin) % s.periodicMinutes === 0);
    if (dayOk && due && !grabRuns.get(p.id)?.running) {
      checkGrabberSchedules.fired.add(key);
      if (s.periodicMinutes > 0) p.overwrite = true; // synchronization replaces changed files
      runGrabber(p.id, s.action === 'explore' ? 'explore' : s.action === 'download' ? 'download' : 'explore-download');
    }
    if (s.stopEnabled && t === s.stopTime) grabRuns.get(p.id)?.stop();
  }
}
checkGrabberSchedules.fired = new Set();

// ---- clipboard ---------------------------------------------------------------------------------

let lastClip = '';
function pollClipboard() {
  if (!store.settings.general.monitorClipboard) return;
  let text;
  try {
    text = clipboard.readText().trim();
  } catch {
    return;
  }
  if (!text || text === lastClip) return;
  const first = lastClip === '';
  lastClip = text;
  if (first) return;
  if (store.settings.linkGrabber.clipboard) {
    const links = u.extractUrls(text.slice(0, 1024 * 1024)).filter((url) => !manager.findDuplicate(url)).map((url) => ({ url }));
    if (links.length && linkGrabber.add({ links, source: 'clipboard' })) openLinkGrabber(true);
    return;
  }
  if (text.length > 2048 || /\s/.test(text)) return;
  if (!/^(https?|ftp):\/\//i.test(text)) return;
  const ext = u.extOf(new URL(text).pathname);
  if (!ext || !u.splitList(store.settings.fileTypes.capture).some((p) => u.wildcardMatch(p, ext))) return;
  if (manager.findDuplicate(text)) return;
  newDownload({ url: text, source: 'clipboard' });
}

// ---- CLI ---------------------------------------------------------------------------------------

async function handleArgs(argv, first) {
  const a = parseArgs(argv);
  if (a.startQueue) queues.start('main');
  if (!a.url) {
    if (!first && !a.startQueue) showMain();
    return;
  }
  const payload = { url: a.url, saveDir: a.path || undefined, fileName: a.file || undefined, source: 'cli' };
  const item = await newDownload(payload, { silent: a.silent || a.add, queueOnly: a.add, startNow: !a.add });
  if (item && a.quit && first) cliQuitAfter.add(item.id);
}

// ---- menu / tray -------------------------------------------------------------------------------

function cmd(name, ...args) {
  return () => {
    showMain();
    mainWin.webContents.send('menu', name, ...args);
  };
}

function buildMenu() {
  const s = store.settings;
  const queueItems = (action) => queues.queues.map((q) => ({ label: q.name, click: () => (action === 'start' ? queues.start(q.id) : queues.stop(q.id)) }));
  const template = [
    {
      label: '&Tasks',
      submenu: [
        { label: '&Add new download...', accelerator: 'CmdOrCtrl+N', click: cmd('addUrl') },
        { label: 'Add &batch download...', accelerator: 'CmdOrCtrl+B', click: cmd('batch') },
        { label: 'Add batch download from &clipboard', click: () => batchFromClipboard() },
        { type: 'separator' },
        { label: '&LinkGrabber...', accelerator: 'CmdOrCtrl+L', click: () => openLinkGrabber() },
        { label: 'Run site &grabber', accelerator: 'CmdOrCtrl+G', click: () => openGrabber() },
        { label: 'Show &drop target', type: 'checkbox', checked: !!(dropWin && !dropWin.isDestroyed()), click: () => toggleDropTarget() },
        { type: 'separator' },
        { label: 'E&xport', submenu: [{ label: 'To OpenDM export &file...', click: () => exportList('json') }, { label: 'To &text file...', click: () => exportList('txt') }] },
        { label: '&Import', submenu: [{ label: 'From OpenDM export &file...', click: () => importList('json') }, { label: 'From &text file...', click: () => importList('txt') }] },
        { type: 'separator' },
        { label: 'E&xit', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() },
      ],
    },
    {
      label: '&File',
      submenu: [
        { label: '&Download Now', click: cmd('resume') },
        { label: '&Stop Download', click: cmd('stop') },
        { label: '&Remove', click: cmd('delete') },
        { label: 'R&edownload', click: cmd('redownload') },
        { type: 'separator' },
        { label: '&Open', click: cmd('open') },
        { label: 'Open &folder', click: cmd('openFolder') },
        { label: '&Properties', accelerator: 'Alt+Enter', click: cmd('properties') },
      ],
    },
    {
      label: '&Downloads',
      submenu: [
        { label: '&Pause All', click: () => manager.stopAll() },
        { label: '&Stop All', click: () => { queues.stopAll(); manager.stopAll(); } },
        { type: 'separator' },
        { label: '&Delete All Completed', click: cmd('deleteCompleted') },
        { type: 'separator' },
        { label: 'Find...', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
        { label: 'Find Next', accelerator: 'F3', click: cmd('findNext') },
        { type: 'separator' },
        { label: 'S&cheduler...', click: cmd('scheduler') },
        { label: 'Start &queue', submenu: queueItems('start') },
        { label: 'S&top queue', submenu: queueItems('stop') },
        { type: 'separator' },
        {
          label: 'Speed &Limiter',
          submenu: [
            { label: 'Turn o&n', type: 'radio', checked: s.speedLimiter.enabled, click: () => setLimiter(true) },
            { label: 'Turn of&f', type: 'radio', checked: !s.speedLimiter.enabled, click: () => setLimiter(false) },
            { type: 'separator' },
            { label: 'S&ettings...', click: cmd('limiter') },
          ],
        },
        { type: 'separator' },
        { label: '&Options...', accelerator: 'CmdOrCtrl+,', click: cmd('options') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Hide &categories', type: 'checkbox', checked: !s.appearance.showCategories, click: (mi) => saveSettings({ appearance: { showCategories: !mi.checked } }) },
        {
          label: '&Arrange files',
          submenu: [
            ['added', 'By &Order Of Addition'], ['name', 'By &File Name'], ['size', 'By &Size'], ['status', 'By St&atus'], ['timeLeft', 'By &Time Left'],
            ['rate', 'By Transfer &Rate'], ['lastTry', 'By &Last Try Date'], ['description', 'By &Description'], ['saveDir', 'By Save &Path'], ['referer', 'By R&eferer'], ['parentPage', 'By Parent &Web Page'],
          ].map(([k, label]) => ({ label, type: 'radio', checked: s.appearance.sort.key === k, click: () => saveSettings({ appearance: { sort: { key: k, dir: 'asc' } } }) })),
        },
        {
          label: '&Toolbar',
          submenu: [
            { label: '&Large Buttons', type: 'radio', checked: s.appearance.toolbar === 'large', click: () => saveSettings({ appearance: { toolbar: 'large' } }) },
            { label: '&Small Buttons', type: 'radio', checked: s.appearance.toolbar === 'small', click: () => saveSettings({ appearance: { toolbar: 'small' } }) },
            { label: '&Icons only', type: 'radio', checked: s.appearance.toolbar === 'icons', click: () => saveSettings({ appearance: { toolbar: 'icons' } }) },
          ],
        },
        { label: 'C&ustomize columns...', click: cmd('columns') },
        {
          label: '&Theme',
          submenu: ['system', 'light', 'dark'].map((t) => ({ label: t[0].toUpperCase() + t.slice(1), type: 'radio', checked: s.appearance.theme === t, click: () => saveSettings({ appearance: { theme: t } }) })),
        },
        {
          label: 'Font',
          submenu: [
            { label: 'Larger', accelerator: 'CmdOrCtrl+=', click: () => saveSettings({ appearance: { fontSize: Math.min(20, s.appearance.fontSize + 1) } }) },
            { label: 'Smaller', accelerator: 'CmdOrCtrl+-', click: () => saveSettings({ appearance: { fontSize: Math.max(10, s.appearance.fontSize - 1) } }) },
            { label: 'Reset to default font', click: () => saveSettings({ appearance: { fontSize: 13 } }) },
          ],
        },
        { label: '&Language', submenu: [{ label: '&English', type: 'radio', checked: true }] },
        { type: 'separator' },
        { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'H&elp contents', accelerator: 'F1', click: cmd('help') },
        { label: 'Browser &extension setup...', click: cmd('help', 'extension') },
        { label: 'Open browser extension folder', click: () => shell.openPath(extensionDir()) },
        { label: '&Scheduler and queues', click: cmd('help', 'queues') },
        { label: '&LinkGrabber help', click: cmd('help', 'linkgrabber') },
        { label: '&Grabber help', click: cmd('help', 'grabber') },
        { label: 'Tip of the &Day...', click: cmd('tip') },
        { type: 'separator' },
        { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
        { label: '&About OpenDM', click: cmd('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  updateTray();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath(16)));
  tray.setToolTip('OpenDM');
  tray.on('click', showMain);
  tray.on('double-click', showMain);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const s = store.settings;
  const active = manager.activeCount();
  tray.setToolTip(active ? `OpenDM — ${active} active download${active > 1 ? 's' : ''}` : 'OpenDM');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open OpenDM', click: showMain },
    { label: 'Add new download...', click: cmd('addUrl') },
    { label: 'LinkGrabber', click: () => openLinkGrabber() },
    { label: 'Run site grabber', click: () => openGrabber() },
    { label: 'Show drop target', type: 'checkbox', checked: !!(dropWin && !dropWin.isDestroyed()), click: () => toggleDropTarget() },
    { type: 'separator' },
    { label: 'Start main queue', click: () => queues.start('main') },
    { label: 'Stop all downloads', click: () => { queues.stopAll(); manager.stopAll(); } },
    { label: 'Speed limiter', type: 'checkbox', checked: s.speedLimiter.enabled, click: (mi) => setLimiter(mi.checked) },
    { label: 'Browser integration', type: 'checkbox', checked: s.general.browserIntegration, click: (mi) => saveSettings({ general: { browserIntegration: mi.checked } }) },
    { label: 'Monitor clipboard', type: 'checkbox', checked: s.general.monitorClipboard, click: (mi) => saveSettings({ general: { monitorClipboard: mi.checked } }) },
    { type: 'separator' },
    { label: 'Exit', click: () => quitApp() },
  ]));
}

function setLimiter(on) {
  saveSettings({ speedLimiter: { enabled: on } });
}

function toggleDropTarget() {
  if (dropWin && !dropWin.isDestroyed()) {
    dropWin.close();
    dropWin = null;
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    const pos = store.settings.appearance.dropPos || { x: wa.x + wa.width - 110, y: wa.y + wa.height - 110 };
    dropWin = openView('drop', {}, { width: 72, height: 72, minWidth: 48, minHeight: 48, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, x: pos.x, y: pos.y, inactive: true, title: 'Drop target' });
    dropWin.on('moved', () => {
      const [x, y] = dropWin.getPosition();
      store.settings.appearance.dropPos = { x, y };
      store.save('settings');
    });
    dropWin.on('closed', () => {
      dropWin = null;
      buildMenu();
    });
  }
  buildMenu();
}

function openGrabber(projectId) {
  openView('grabber', projectId ? { project: projectId } : {}, { key: 'grabber:' + (projectId || 'new'), width: 980, height: 680, minWidth: 760, minHeight: 480, title: 'Site Grabber', maximizable: true });
}

function openLinkGrabber(background = false) {
  openView('linkgrabber', {}, { key: 'linkgrabber', width: 1080, height: 660, minWidth: 760, minHeight: 420, title: 'LinkGrabber', maximizable: true, inactive: background, background });
}

function batchFromClipboard() {
  const urls = u.extractUrls(clipboard.readText());
  if (!urls.length) {
    dialog.showMessageBox({ type: 'info', message: 'The clipboard does not contain any web addresses.' });
    return;
  }
  collectLinks({ links: urls.map((url) => ({ url })), title: 'Batch download from clipboard', source: 'clipboard' });
}

/** A list of links to choose from: goes to the LinkGrabber, or the "Download all links" dialog. */
function collectLinks(payload) {
  if (!store.settings.linkGrabber.useForLinkLists) return openLinks(payload);
  linkGrabber.add({ links: payload.links, referer: payload.referer, cookies: payload.cookies, userAgent: payload.userAgent, source: payload.source });
  openLinkGrabber();
}

function openLinks(payload) {
  openView('links', {}, { key: 'links:' + u.id(), payload, width: 860, height: 560, minWidth: 600, minHeight: 360, title: payload.title || 'Download all links', maximizable: true });
}

async function exportList(kind) {
  const r = await dialog.showSaveDialog(mainWin, { defaultPath: kind === 'json' ? 'opendm-export.json' : 'opendm-links.txt', filters: kind === 'json' ? [{ name: 'OpenDM export', extensions: ['json'] }] : [{ name: 'Text', extensions: ['txt'] }] });
  if (r.canceled) return;
  const list = manager.exportList();
  await fs.promises.writeFile(r.filePath, kind === 'json' ? JSON.stringify({ app: 'OpenDM', version: 1, downloads: list }, null, 2) : list.map((d) => d.url).join('\r\n'));
}

async function importList(kind) {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: kind === 'json' ? [{ name: 'OpenDM export', extensions: ['json'] }] : [{ name: 'Text / HTML', extensions: ['txt', 'htm', 'html', 'csv', 'lst'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled) return;
  const text = await fs.promises.readFile(r.filePaths[0], 'utf8');
  if (kind === 'json') {
    let n = 0;
    for (const d of JSON.parse(text).downloads || []) {
      await manager.add({ url: d.url, fileName: d.fileName, saveDir: d.saveDir, category: d.category, description: d.description, referer: d.referer, duplicateAction: 'resume' });
      n++;
    }
    dialog.showMessageBox(mainWin, { type: 'info', message: `Imported ${n} downloads.` });
  } else {
    const urls = u.extractUrls(text);
    if (!urls.length) return dialog.showMessageBox(mainWin, { type: 'info', message: 'No web addresses were found in this file.' });
    collectLinks({ links: urls.map((url) => ({ url })), title: 'Import downloads from text file', source: 'import' });
  }
}

// ---- settings ----------------------------------------------------------------------------------

function applyTheme() {
  nativeTheme.themeSource = store.settings.appearance.theme;
}

async function applyProxy() {
  const p = store.settings.proxy;
  const ses = session.fromPartition('opendm-proxy-resolver');
  if (p.mode === 'pac' && p.pacUrl) await ses.setProxy({ mode: 'pac_script', pacScript: p.pacUrl });
  else await ses.setProxy({ mode: 'system' });
  net.resetAgents();
}

function applyStartup() {
  if (process.platform === 'linux' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: store.settings.general.launchOnStartup, args: ['/tray'] });
}

function saveSettings(patch) {
  const before = store.settings;
  store.settings = deepMerge(before, patch);
  // Arrays/lists replace wholesale.
  for (const [k, v] of Object.entries(patch || {})) if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) if (Array.isArray(v2)) store.settings[k][k2] = v2;
  store.save('settings');
  manager.applySpeedLimiter();
  applyTheme();
  if (patch.proxy || patch.connection) applyProxy();
  if (patch.general && 'integrationPort' in patch.general && patch.general.integrationPort !== before.general.integrationPort) server.start();
  if (patch.general && 'launchOnStartup' in patch.general) applyStartup();
  buildMenu();
  broadcast('settings', store.settings);
  return store.settings;
}

// ---- IPC ---------------------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => fn(...args, e));
}

function registerIpc() {
  handle('state', () => ({
    version: VERSION,
    platform: process.platform,
    settings: store.settings,
    categories: store.categories,
    queues: queues.list(),
    items: manager.list(),
    grabberPresets: FILE_PRESETS,
  }));
  handle('pending', (token) => pending.get(token) || null);

  handle('dl:describe', (url, opts) => manager.describe(url, opts));
  handle('dl:add', async (opts) => {
    const { start, queueId, showProgress = true, ...rest } = opts;
    const res = await manager.add({ ...rest, start: false });
    if (queueId) queues.addItems(queueId, [res.item.id]);
    if (start) startInteractive(res.item.id, showProgress);
    return res;
  });
  handle('dl:addMany', async (list, { queueId, start, top } = {}) => {
    const ids = [];
    for (const o of list) ids.push((await manager.add({ ...o, start: false, duplicateAction: o.duplicateAction || 'number' })).item.id);
    if (queueId) queues.addItems(queueId, ids, { top });
    if (start) for (const id of ids) manager.start(id);
    return ids;
  });
  handle('dl:start', (ids, showProgress = true) => ids.forEach((id) => startInteractive(id, showProgress)));
  handle('dl:stop', (ids) => ids.forEach((id) => manager.stop(id)));
  handle('dl:stopAll', () => {
    queues.stopAll();
    manager.stopAll();
  });
  handle('dl:remove', (ids, deleteFiles) => manager.remove(ids, deleteFiles));
  handle('dl:removeCompleted', () => manager.removeCompleted());
  handle('dl:redownload', (id) => {
    interactive.add(id);
    return manager.redownload(id, true);
  });
  handle('dl:update', (id, patch) => manager.update(id, patch));
  handle('dl:stats', (id) => manager.stats(id));
  handle('dl:item', (id) => {
    const it = manager.get(id);
    return it ? { ...manager.publicItem(it), auth: it.auth, cookies: it.cookies } : null;
  });
  handle('dl:open', async (id) => {
    const it = manager.get(id);
    if (it?.savedPath) return shell.openPath(it.savedPath);
  });
  handle('dl:openFolder', (id) => {
    const it = manager.get(id);
    if (it?.savedPath) shell.showItemInFolder(it.savedPath);
    else if (it) shell.openPath(it.saveDir);
  });
  handle('dl:progressWindow', (id) => openProgress(id));
  handle('dl:refreshAddress', (id, url) => manager.update(id, { url }));
  ipcMain.on('dl:drag', (e, id) => {
    const it = manager.get(id);
    if (it?.savedPath && fs.existsSync(it.savedPath)) e.sender.startDrag({ file: it.savedPath, icon: nativeImage.createFromPath(iconPath(32)) });
  });

  handle('q:list', () => queues.list());
  handle('q:create', (name, type) => queues.create(name, type));
  handle('q:update', (id, patch) => queues.update(id, patch));
  handle('q:remove', (id) => queues.remove(id));
  handle('q:start', (id) => queues.start(id));
  handle('q:stop', (id) => queues.stop(id));
  handle('q:addItems', (id, ids, opts) => queues.addItems(id, ids, opts));
  handle('q:removeItems', (id, ids) => queues.removeItems(id, ids));
  handle('q:move', (id, ids, dir) => queues.move(id, ids, dir));

  handle('cats:save', (cats) => {
    store.categories = cats.map((c) => ({ ...c, id: c.id || u.id() }));
    store.save('categories');
    broadcast('categories', store.categories);
    return store.categories;
  });
  handle('cats:reset', () => {
    store.categories = defaultCategories();
    store.save('categories');
    broadcast('categories', store.categories);
    return store.categories;
  });

  handle('settings:save', (patch) => saveSettings(patch));
  handle('settings:replaceList', (section, key, list) => {
    store.settings[section][key] = list;
    store.save('settings');
    broadcast('settings', store.settings);
    return store.settings;
  });
  handle('settings:reset', () => {
    store.resetSettings();
    return saveSettings({});
  });

  handle('dialog:folder', async (def, e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: def, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (def, e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: def, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:confirm', async (message, detail, buttons, e) => {
    const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || ['OK', 'Cancel']).length - 1, noLink: true });
    return r.response;
  });

  handle('win:open', (view, params, opts) => {
    if (view === 'grabber') return openGrabber(params?.project);
    if (view === 'progress') return openProgress(params.id);
    if (view === 'links') return openLinks(opts?.payload || {});
    if (view === 'linkgrabber') return openLinkGrabber();
    openView(view, params, opts);
  });
  handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  handle('win:resize', (w, h, e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.setContentSize(Math.round(w), Math.round(h));
  });
  handle('win:setTitle', (t, e) => BrowserWindow.fromWebContents(e.sender)?.setTitle(t));
  handle('win:showMain', () => showMain());
  handle('win:toggleDrop', () => toggleDropTarget());

  handle('clip:urls', () => u.extractUrls(clipboard.readText()));
  handle('clip:write', (t) => clipboard.writeText(String(t)));
  handle('util:batch', (pattern, from, to, width) => u.expandBatch(pattern, from, to, width));
  handle('util:openExternal', (url) => /^https?:/.test(url) && shell.openExternal(url));
  handle('util:openPath', (p) => shell.openPath(p));
  handle('util:extensionDir', () => extensionDir());
  handle('util:ffmpeg', () => require('./engine/ffmpeg').findFfmpeg(store.settings.videoPanel.ffmpegPath));
  const ytdlp = require('./engine/ytdlp');
  const binDir = () => path.join(app.getPath('userData'), 'bin');
  handle('util:ytdlp', () => ytdlp.findYtDlp(store.settings.videoPanel.ytdlpPath, binDir()));
  handle('util:ytdlpInstall', () => ytdlp.installYtDlp(net, binDir()));
  handle('util:ytdlpInfo', async (url) => {
    const bin = ytdlp.findYtDlp(store.settings.videoPanel.ytdlpPath, binDir());
    if (!bin) return { missing: true };
    return ytdlp.videoInfo(bin, url, store.settings);
  });
  handle('util:probe', async (urls, opts = {}) => {
    const out = {};
    await Promise.all(urls.map(async (url) => {
      try {
        const p = await net.probe(url, { headers: opts.referer ? { Referer: opts.referer } : {}, timeoutSec: 15 });
        out[url] = { size: p.size, type: p.type, status: p.status };
      } catch (err) {
        out[url] = { error: err.message };
      }
    }));
    return out;
  });
  handle('util:hlsVariants', async (url, referer) => {
    const { parsePlaylist } = require('./engine/hls-download');
    const { body, url: fin } = await net.fetchBuffer(url, { headers: referer ? { Referer: referer } : {}, maxBytes: 4 * 1024 * 1024 });
    const pl = parsePlaylist(body.toString('utf8'), fin);
    return pl.variants || [];
  });
  handle('import', (kind) => importList(kind));
  handle('export', (kind) => exportList(kind));
  handle('batch:clipboard', () => batchFromClipboard());
  handle('power:run', (kind, force) => powerAction(kind, !!force));
  handle('power:cancel', () => cancelShutdown());
  handle('app:quit', () => quitApp());

  handle('grabber:list', () => store.grabberProjects.map((p) => ({ id: p.id, name: p.name, startUrl: p.startUrl, stats: p.stats, running: !!grabRuns.get(p.id)?.running })));
  handle('grabber:get', (id) => grabberProject(id) || null);
  handle('grabber:new', (patch) => {
    const p = newProject({ saveDir: manager.folderForCategory('general'), ...patch });
    store.grabberProjects.push(p);
    store.save('grabber');
    return p;
  });
  handle('grabber:save', (p) => {
    const i = store.grabberProjects.findIndex((x) => x.id === p.id);
    const merged = i >= 0 ? { ...store.grabberProjects[i], ...p } : newProject(p);
    if (i >= 0) store.grabberProjects[i] = merged;
    else store.grabberProjects.push(merged);
    // Keep the live run pointed at the same object.
    const run = grabRuns.get(p.id);
    if (run) Object.assign(run.p, merged);
    store.save('grabber');
    broadcast('grabber:list');
    return merged;
  });
  handle('grabber:delete', (id) => {
    grabRuns.get(id)?.stop();
    store.grabberProjects = store.grabberProjects.filter((p) => p.id !== id);
    store.save('grabber');
    broadcast('grabber:list');
  });
  handle('grabber:run', (id, mode) => runGrabber(id, mode));
  handle('grabber:stop', (id) => grabRuns.get(id)?.stop());
  handle('grabber:setChecked', (id, urls, checked) => {
    const p = grabberProject(id);
    if (!p) return;
    const set = new Set(urls);
    for (const f of p.results.files) if (!urls.length || set.has(f.url)) f.checked = checked;
    store.save('grabber');
    return p;
  });
  handle('grabber:addToList', async (id, queueId) => {
    const p = grabberProject(id);
    const run = grabRuns.get(id) || new GrabberRun(p, { net, manager, getSettings: () => store.settings });
    const { ids } = await run.addToList(queueId);
    if (queueId) queues.addItems(queueId, ids);
    return ids.length;
  });
  handle('grabber:open', (id) => openGrabber(id));

  handle('lg:state', () => linkGrabber.snapshot());
  handle('lg:add', (opts) => linkGrabber.add({ ...opts, source: opts?.source || 'manual' }));
  handle('lg:confirm', (ids, opts) => linkGrabber.confirm(ids, opts));
  handle('lg:remove', (ids) => linkGrabber.remove(ids));
  handle('lg:removeOffline', () => linkGrabber.removeOffline());
  handle('lg:clear', () => linkGrabber.clear());
  handle('lg:enable', (ids, on) => linkGrabber.setEnabled(ids, on));
  handle('lg:updatePackage', (id, patch) => linkGrabber.updatePackage(id, patch));
  handle('lg:renameLink', (id, name) => linkGrabber.renameLink(id, name));
  handle('lg:merge', (ids, name) => linkGrabber.merge(ids, name));
  handle('lg:splitByHost', (ids) => linkGrabber.splitByHost(ids));
  handle('lg:recheck', (ids) => linkGrabber.recheck(ids));
}

// ---- lifecycle ---------------------------------------------------------------------------------

async function quitApp() {
  if (quitting) return;
  quitting = true;
  saveWindowBounds();
  queues.dispose();
  for (const r of grabRuns.values()) r.stop();
  linkGrabber.dispose();
  manager.stopAll();
  const deadline = Date.now() + 4000;
  while (manager.activeCount() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  manager.dispose();
  server.stop();
  await store.flushAll();
  tray?.destroy();
  app.exit(0);
}

app.on('second-instance', (_e, argv) => handleArgs(argv.slice(app.isPackaged ? 1 : 2), false));
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
app.on('before-quit', (e) => {
  if (!quitting) {
    e.preventDefault();
    quitApp();
  }
});

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  applyTheme();
  const resolver = session.fromPartition('opendm-proxy-resolver');
  net = new NetContext({ getSettings: () => store.settings, resolveProxy: (url) => resolver.resolveProxy(url) });
  await applyProxy();
  manager = new DownloadManager(store, net);
  queues = new QueueManager(store, manager);
  linkGrabber = new LinkGrabber(store, net, manager);
  let lgTimer = null;
  linkGrabber.on('changed', () => {
    if (lgTimer) return;
    lgTimer = setTimeout(() => {
      lgTimer = null;
      broadcast('lg:changed', linkGrabber.snapshot());
    }, 250);
  });
  server = new IntegrationServer(() => store.settings, VERSION);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') notify('Browser integration unavailable', `Port ${store.settings.general.integrationPort} is in use. Change it in Options → General.`);
  });
  server.on('download', (d) => {
    const payload = {
      url: d.url, referer: d.referrer || d.pageUrl || '', parentPage: d.pageUrl || '', cookies: d.cookies || '', userAgent: d.userAgent || '',
      fileName: d.fileName || undefined, mime: d.mime, size: d.size, kind: d.kind, description: d.title || '', source: 'browser', hls: d.hls,
      parts: Array.isArray(d.parts) ? d.parts.slice(0, 2) : undefined, ytdlp: d.ytdlp && typeof d.ytdlp === 'object' ? { quality: String(d.ytdlp.quality || 'best') } : undefined, qualities: Array.isArray(d.qualities) ? d.qualities.slice(0, 40) : undefined,
    };
    newDownload(payload).catch((e) => {
      console.error('[integration] could not add download:', e);
      notify('Could not add download', e.message);
    });
  });
  server.on('links', (d) => collectLinks({ links: d.links, referer: d.pageUrl, cookies: d.cookies, userAgent: d.userAgent, title: d.selected ? 'Download selected links' : 'Download all links', source: 'browser' }));
  server.start();

  manager.on('changed', (it) => broadcast('dl:changed', it));
  manager.on('removed', (ids) => broadcast('dl:removed', ids));
  manager.on('started', (id) => {
    if (interactive.has(id) && store.settings.downloads.progressDialog !== 'none') openProgress(id);
    updateTray();
  });
  manager.on('stopped', () => updateTray());
  let progressBuf = new Map();
  manager.on('progress', (id, stats) => progressBuf.set(id, stats));
  setInterval(() => {
    if (!progressBuf.size) return;
    // Snapshot items now, not when progress fired, so a finished download is never reported as running.
    const batch = [...progressBuf.entries()].filter(([id]) => manager.get(id)).map(([id, stats]) => ({ id, item: manager.publicItem(manager.get(id)), stats }));
    progressBuf = new Map();
    broadcast('dl:progress', batch);
  }, 500);
  manager.on('complete', (it) => {
    onComplete(it);
    updateTray();
  });
  manager.on('failed', (it) => {
    broadcast('sound', 'failed');
    interactive.delete(it.id);
    updateTray();
  });
  manager.on('quota', (q) => q.exceeded && store.settings.connection.quota.warn && notify('Download limit reached', 'Downloads will resume automatically when the quota allows.'));
  queues.on('changed', (list) => {
    broadcast('q:changed', list);
    buildMenu();
  });
  queues.on('finished', onQueueFinished);
  setInterval(checkGrabberSchedules, 20000);
  setInterval(pollClipboard, 1000);

  registerIpc();
  const args = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));
  createMainWindow(!args.hidden);
  createTray();
  buildMenu();
  applyStartup();
  handleArgs(process.argv.slice(app.isPackaged ? 1 : 2), true);
});
