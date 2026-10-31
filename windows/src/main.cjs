'use strict';
const { app, BrowserWindow, Menu, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_ORIGIN = 'app://local';
const SUPABASE_HOST = 'pkzzktnxiboottirasvc.supabase.co';
const EDGE_FUNCTIONS = new Set(['register-hospital', 'login-with-id', 'request-password-reset']);
const WEB_ROOT = path.join(__dirname, '..', 'app-web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

// app:// is a standard + secure scheme so the page is a secure context (required by Web Serial) with a real origin.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) { app.quit(); }          // one window => one owner of the COM port
let mainWindow = null;
const dialogs = new Map();                                      // webContents.id -> { cfg, value, resolve }

const isTrustedUrl = (u) => typeof u === 'string' && u.startsWith(APP_ORIGIN + '/');
const isTrustedFrame = (frame) => !!frame && frame === mainWindow?.webContents.mainFrame && isTrustedUrl(frame.url);

function openExternalIfHttps(url) {
  try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* ignore malformed */ }
}

function showDialog(parent, cfg) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      parent, modal: true, width: 520, height: cfg.mode === 'ports' ? 440 : 280, resizable: false,
      minimizable: false, maximizable: false, show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'dialog-preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, spellcheck: false, devTools: !app.isPackaged },
    });
    w.removeMenu();
    const id = w.webContents.id;
    dialogs.set(id, { cfg, value: null });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.once('ready-to-show', () => w.show());
    w.on('closed', () => { const d = dialogs.get(id); dialogs.delete(id); resolve(d ? d.value : null); });
    w.loadFile(path.join(__dirname, 'dialog.html'));
  });
}
ipcMain.handle('dialog:init', (e) => dialogs.get(e.sender.id)?.cfg ?? null);
ipcMain.on('dialog:done', (e, value) => {
  const d = dialogs.get(e.sender.id); if (!d) return;
  d.value = (typeof value === 'string') ? value.slice(0, 2000) : null;
  BrowserWindow.fromWebContents(e.sender)?.close();
});

// Synchronous prompt() replacement (see native/shim-windows.js). Only the app's own main frame may ask.
ipcMain.on('mc:prompt', async (event, message, defaultValue) => {
  if (!isTrustedFrame(event.senderFrame) || typeof message !== 'string' || typeof defaultValue !== 'string') { event.returnValue = null; return; }
  const v = await showDialog(mainWindow, { mode: 'prompt', message, value: defaultValue });
  event.returnValue = v;                                         // string, or null when cancelled
});

// Edge Functions (Login ID sign-in, hospital registration, password reset) through Chromium's network stack in the
// MAIN process: no renderer Origin, so no browser CORS allow-list can reject the request. Only our own project and
// the three known functions are reachable; bodies/responses are size-capped and never logged.
ipcMain.handle('mc:edge', async (event, fn, body, apikey, timeoutMs) => {
  if (!isTrustedFrame(event.senderFrame)) throw new Error('forbidden');
  if (!EDGE_FUNCTIONS.has(fn) || typeof body !== 'string' || body.length > 16384 ||
      typeof apikey !== 'string' || apikey.length < 20 || apikey.length > 600 || apikey.split('.').length !== 3) throw new Error('bad_request');
  const t = Math.min(Math.max(Number(timeoutMs) || 25000, 5000), 60000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), t);
  try {
    const res = await net.fetch(`https://${SUPABASE_HOST}/functions/v1/${fn}`, {
      method: 'POST', body, signal: ac.signal, redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json', apikey, authorization: 'Bearer ' + apikey },
    });
    const text = await res.text();
    if (text.length > 262144) throw new Error('too large');
    return { status: res.status, text };
  } catch (e) {
    const err = new Error(ac.signal.aborted ? 'timed out' : 'network'); err.name = ac.signal.aborted ? 'TimeoutError' : 'NetworkError'; throw err;
  } finally { clearTimeout(timer); }
});

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mc:window-state', { maximized: mainWindow.isMaximized(), fullscreen: mainWindow.isFullScreen() });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 360, minHeight: 520, show: false, autoHideMenuBar: true,
    title: 'Emergency Medical Records — Medical Card', backgroundColor: '#0a1628',   // navy, never a white flash
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',                                                          // custom title bar + native window controls
    titleBarOverlay: { color: '#060d1a', symbolColor: '#c9d8f5', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, spellcheck: false, webviewTag: false, devTools: !app.isPackaged,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'].forEach((ev) => mainWindow.on(ev, sendWindowState));
  mainWindow.webContents.on('did-finish-load', sendWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });
  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(({ url }) => { openExternalIfHttps(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!isTrustedUrl(url)) { e.preventDefault(); openExternalIfHttps(url); } });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  mainWindow.loadURL(APP_ORIGIN + '/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom', accelerator: 'Ctrl+0' }, { role: 'zoomIn', accelerator: 'Ctrl+Plus' }, { role: 'zoomOut', accelerator: 'Ctrl+-' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));

  // Serve the bundled web app from app://local/. Path traversal is rejected; responses are never cached.
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'local') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(WEB_ROOT, '.' + rel);
    if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });

  const ses = session.defaultSession;
  // Defence in depth on top of the page CSP: the renderer may only talk to this app and the one Supabase project.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    let host = ''; try { host = new URL(details.url).hostname; } catch { /* cancel below */ }
    cb({ cancel: host !== SUPABASE_HOST });
  });

  // Permissions: deny everything except Web Serial for the app's own origin.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'serial' && String(origin).startsWith(APP_ORIGIN));
  ses.setDevicePermissionHandler((d) => d.deviceType === 'serial' && String(d.origin).startsWith(APP_ORIGIN));

  // Port chooser for navigator.serial.requestPort() (this is Chrome's chooser equivalent).
  ses.on('select-serial-port', async (event, portList, webContents, callback) => {
    event.preventDefault();
    if (!mainWindow || webContents !== mainWindow.webContents || !isTrustedUrl(webContents.getURL())) { callback(''); return; }
    const ports = portList.map((p) => ({ id: p.portId, label: p.portName + (p.displayName ? ' — ' + p.displayName : '') }));
    const chosen = await showDialog(mainWindow, { mode: 'ports', title: 'Select the RFID reader port',
      message: 'Select the COM port of the RFID reader (USB Arduino, or the HC-05 Bluetooth COM port).', ports });
    callback(chosen || '');                                      // '' = cancelled
  });

  createWindow();
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
