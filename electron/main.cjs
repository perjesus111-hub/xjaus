const { app, BrowserWindow, ipcMain, shell, session, clipboard, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { allowedCommand, trustedFrame, externalUrl, externalLoginUrl, allowedClipboardText } = require('./security.cjs');
const { systemLocaleFromEnvironment } = require('./locale.cjs');

const { iconPath } = require('./icons.cjs');
app.setName('XJAUS');
app.setAppUserModelId('io.github.xjaus.xjaus');
// Isolated namespace: no automatic import or removal of previous app data.
app.setPath('userData', path.join(app.getPath('appData'), 'io.github.xjaus.xjaus'));
// Follow the OS message locale as a language preference; preserve its exact
// locale region without using it to mutate the Xbox account or market region.
const systemLocale = systemLocaleFromEnvironment(process.env);
if (systemLocale) app.commandLine.appendSwitch('lang', systemLocale);
if (process.platform === 'linux') {
  app.setDesktopName('io.github.xjaus.xjaus.desktop');
  app.commandLine.appendSwitch('class', 'io.github.xjaus.xjaus');
}

if (process.platform === 'linux') {
  const {mergeDecoderFeatures} = require('./features.cjs');
  app.commandLine.appendSwitch('enable-features', mergeDecoderFeatures(app.commandLine.getSwitchValue?.('enable-features') ?? ''));
}
// Set before ready; preserve Chromium's existing feature switches.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { createFullscreenController } = require('./fullscreen.cjs');
const { restoreWindowState, persistWindowState } = require('./window-state.cjs');
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');
const windowStateStore = {
  get(key) {
    if (key !== 'windowState') return undefined;
    try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')).windowState; } catch { return undefined; }
  },
  set(key, value) {
    if (key !== 'windowState') return;
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(windowStatePath(), JSON.stringify({windowState:value}), { mode: 0o600 });
    } catch { /* Window state is optional; never block startup or shutdown. */ }
  },
};
let fullscreen;
let backend;
let window;
let sequence = 0;
let stdoutBuffer = '';
let stderrBuffer = '';
const pending = new Map();
const authIpcTimeouts = new Map([['begin_login_window', 20_000], ['poll_login', 90_000], ['cancel_login', 8_000]]);
function logAuthIpc(command, stage, id, startedAt, category) {
  const record = { command, stage, request_id: id, elapsed_ms: Math.max(0, Date.now() - startedAt) };
  if (category) record.category = category;
  console.info('[XJAUS auth IPC]', JSON.stringify(record));
}
const frontend = path.resolve(__dirname, '../dist/index.html');
const backendPath = require('./backend-path.cjs').backendPath({
  isPackaged: app.isPackaged, resourcesPath: process.resourcesPath,
  platform: process.platform, dirname: __dirname,
});
function stopPending(reason) {
  for (const entry of pending.values()) entry.reject(new Error(reason));
  pending.clear();
}
function startBackend() {
  backend = spawn(backendPath, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  backend.on('error', () => stopPending('Rust backend failed to start'));
  backend.on('close', () => stopPending('El backend Rust se cerró'));
  backend.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    if (stdoutBuffer.length > 4_000_000) { backend.kill(); return; }
    for (let index; (index = stdoutBuffer.indexOf('\n')) !== -1;) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      const item = pending.get(reply.id);
      if (!item) continue;
      if (typeof reply.error === 'string') item.reject(new Error(reply.error));
      else item.resolve(reply.result);
    }
  });
  backend.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
    if (stderrBuffer.length > 8_192) stderrBuffer = stderrBuffer.slice(-4_096);
    for (let index; (index = stderrBuffer.indexOf('\n')) !== -1;) {
      const line = stderrBuffer.slice(0, index).trim();
      stderrBuffer = stderrBuffer.slice(index + 1);
      if (/^\[XJAUS_AUTH\] (?:device_code_request_started|device_code_response_received status=\d{3} duration_ms=\d{1,8}|device_code_response_invalid category=(?:json|schema|url)|device_code_request_failed category=(?:timeout|network|http|oauth)|device_code_poll (?:pending|slow_down|expired|denied|authorized)(?: interval_seconds=\d{1,6})?)$/.test(line)) console.info(line);
    }
  });
}
function authorize(event) {
  return event.sender === window?.webContents && event.senderFrame === event.senderFrame?.top
    && trustedFrame(event.senderFrame.url, window.webContents.getURL(), frontend);
}
ipcMain.handle('xjaus:invoke', (event, command, args) => {
  if (!authorize(event) || !allowedCommand(command)) throw new Error('Comando IPC no permitido');
  if (command === 'app_exit') {
    if (args != null && (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) throw new Error('Argumentos IPC no permitidos');
    app.quit();
    return null;
  }
  const id = ++sequence;
  const startedAt = Date.now();
  const message = JSON.stringify({ id, cmd: command, args: args ?? {} });
  if (message.length > 2_000_000) throw new Error('Petición IPC demasiado grande');
  if (!backend || backend.exitCode !== null || !backend.stdin.writable) throw new Error('Backend Rust no disponible');
  if (command === 'start_stream') {
    window.show();
    window.focus();
    window.webContents.focus();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const isAuth = authIpcTimeouts.has(command);
    const finish = (fn, value, category) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.delete(id);
      if (isAuth) logAuthIpc(command, fn === resolve ? 'response_received' : 'request_failed', id, startedAt, category);
      fn(value);
    };
    const item = {
      resolve: value => finish(resolve, value),
      reject: error => finish(reject, error, error?.name === 'TimeoutError' ? 'timeout' : 'backend_error'),
    };
    pending.set(id, item);
    const timeoutMs = authIpcTimeouts.get(command);
    if (timeoutMs) {
      logAuthIpc(command, 'request_sent', id, startedAt);
      timer = setTimeout(() => {
        const error = new Error('Microsoft sign-in request timed out');
        error.name = 'TimeoutError';
        item.reject(error);
      }, timeoutMs);
    }
    backend.stdin.write(`${message}${String.fromCharCode(10)}`, error => {
      if (error) item.reject(new Error('Backend IPC write failed'));
    });
  });
});
ipcMain.handle('xjaus:fullscreen', (event, action) => {
  if (!authorize(event) || !['enter', 'exit', 'toggle', 'restore', 'session-enter', 'session-restore'].includes(action)) throw new Error('Fullscreen IPC no permitido');
  fullscreen(action);
});
ipcMain.handle('xjaus:open-external', async (event, url) => {
  if (!authorize(event) || !externalUrl(url)) throw new Error('Enlace externo no permitido');
  await shell.openExternal(url);
});
ipcMain.handle('xjaus:open-microsoft-verification', async (event, url) => {
  if (!authorize(event) || !externalLoginUrl(url)) throw new Error('Enlace de verificación no permitido');
  await shell.openExternal(url);
});
ipcMain.handle('xjaus:clipboard', (event, text) => {
  if (!authorize(event) || !allowedClipboardText(text)) throw new Error('Texto para copiar no permitido');
  clipboard.writeText(text);
  return true;
});
app.whenReady().then(() => {
  console.info('[XJAUS locale]', JSON.stringify({locale: app.getLocale?.(), requested: systemLocale || 'auto', LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES}));
  startBackend();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  const restoredBounds = restoreWindowState(windowStateStore.get('windowState'), screen?.getAllDisplays?.() ?? [], {width:1240,height:800});
  const restoreMaximized = Boolean(windowStateStore.get('windowState')?.maximized);
  window = new BrowserWindow({
    ...restoredBounds, minWidth: 860, minHeight: 600, title: 'XJAUS',
    backgroundColor: '#090a0b', autoHideMenuBar: true, icon: iconPath(app),
    // Linux uses the compositor's native title bar, including on the login screen.
    // Wayland does not support moving a window via programmatic positioning.
    ...(process.platform === 'linux' ? {} : { titleBarStyle: 'hidden' }),
    ...(process.platform !== 'linux' && process.platform !== 'darwin' ? { titleBarOverlay: { color: '#090a0b', symbolColor: '#f4f2ec', height: 40 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false,
    },
  });
  fullscreen = createFullscreenController(window);
  if (restoreMaximized) window.maximize();
  let stateTimer;
  const saveWindowState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => persistWindowState(windowStateStore, window), 250);
  };
  for (const event of ['resize','move','maximize','unmaximize']) window.on?.(event, saveWindowState);
  window.on?.('close', () => { clearTimeout(stateTimer); persistWindowState(windowStateStore, window); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(frontend).href) event.preventDefault();
  });
  window.loadFile(frontend);
});
app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => {
  if (backend && backend.exitCode === null) { backend.stdin.end(); backend.kill(); }
});
