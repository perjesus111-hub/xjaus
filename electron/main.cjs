const { app, BrowserWindow, ipcMain, shell, session, clipboard, screen, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { allowedCommand, trustedFrame, externalUrl, externalLoginUrl, allowedClipboardText } = require('./security.cjs');
const { systemLocaleFromEnvironment } = require('./locale.cjs');
const { bindNativeTheme, windowBackgroundColor } = require('./system-theme.cjs');

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
const disposeNativeTheme = bindNativeTheme(nativeTheme, () => window);
let stdoutBuffer = '';
let stderrBuffer = '';
let sidecarShutdownResult = null;
let sidecarClosed = false;
// Settling a local promise does not establish delivery. Keep this evidence
// for the lifetime of the sidecar, even if pending empties or a reply arrives late.
let sidecarIpcIncomplete = false;
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
  backend = spawn(backendPath, ['--shutdown-report'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  backend.on('error', () => {
    sidecarIpcIncomplete = true;
    stopPending('Rust backend failed to start');
  });
  backend.stdin?.on?.('error', () => {
    sidecarIpcIncomplete = true;
    stopPending('Backend IPC write failed');
  });
  backend.on('close', () => {
    sidecarClosed = true;
    if (!quitting) stopPending('El backend Rust se cerró');
  });
  backend.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    if (stdoutBuffer.length > 4_000_000) { backend.kill(); return; }
    for (let index; (index = stdoutBuffer.indexOf('\n')) !== -1;) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      if (reply?.id === undefined && ['drained', 'cleanup_uncertain', 'cleanup_timeout', 'ipc_incomplete'].includes(reply?.shutdown)) {
        sidecarShutdownResult = reply.shutdown;
        continue;
      }
      if (!reply) continue;
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
// IPC admission control: no ordinary write queue, one reserved logout slot.
let quitting = false;
let quitComplete = false;
const IPC_MAX_PENDING = 64;
const IPC_MAX_PENDING_BYTES = 4_000_000;
let ipcPendingBytes = 0;
let ipcBlocked = false;
let ipcLogout = null;
let ipcLogoutPending = false;
function writeIpc(item) {
  const deliveryFailed = () => {
    sidecarIpcIncomplete = true;
    item.reject(new Error('Backend IPC write failed'));
  };
  try {
    if (!backend.stdin.write(item.message + '\n', error => {
      if (error) deliveryFailed();
    })) {
      ipcBlocked = true;
      backend.stdin.once('drain', () => {
        ipcBlocked = false;
        const next = ipcLogout;
        ipcLogout = null;
        if (next) writeIpc(next);
      });
    }
  } catch {
    deliveryFailed();
  }
}
ipcMain.handle('xjaus:invoke', (event, command, args) => {
  if (!authorize(event) || !allowedCommand(command)) throw new Error('Comando IPC no permitido');
  if (command === 'app_exit') {
    if (args != null && (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) throw new Error('Argumentos IPC no permitidos');
    app.quit();
    return null;
  }
  if (quitting) throw new Error('El backend Rust se está cerrando');
  const id = ++sequence;
  const startedAt = Date.now();
  const message = JSON.stringify({ id, cmd: command, args: args ?? {} });
  const bytes = Buffer.byteLength(message, 'utf8');
  if (bytes > 2_000_000) throw new Error('Petición IPC demasiado grande');
  if (!backend || backend.exitCode !== null || !backend.stdin.writable) throw new Error('Backend Rust no disponible');
  const isLogout = command === 'logout';
  if (isLogout ? ipcLogoutPending : (ipcBlocked || pending.size - Number(ipcLogoutPending) >= IPC_MAX_PENDING || ipcPendingBytes + bytes > IPC_MAX_PENDING_BYTES)) {
    throw new Error('Backend IPC saturado');
  }
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
      if (isLogout) { ipcLogoutPending = false; if (ipcLogout === item) ipcLogout = null; }
      else ipcPendingBytes -= bytes;
      if (isAuth) logAuthIpc(command, fn === resolve ? 'response_received' : 'request_failed', id, startedAt, category);
      fn(value);
    };
    const item = {
      resolve: value => finish(resolve, value),
      reject: error => finish(reject, error, error?.name === 'TimeoutError' ? 'timeout' : 'backend_error'),
    };
    pending.set(id, item);
    if (isLogout) ipcLogoutPending = true;
    else ipcPendingBytes += bytes;
    item.message = message;
    const timeoutMs = authIpcTimeouts.get(command) ?? (isLogout ? 20_000 : undefined);
    if (timeoutMs) {
      if (isAuth) logAuthIpc(command, 'request_sent', id, startedAt);
      timer = setTimeout(() => {
        sidecarIpcIncomplete = true;
        const error = new Error(isLogout
          ? (ipcLogout === item ? 'Logout timed out before being sent' : 'Logout timed out; backend outcome is unknown')
          : 'Microsoft sign-in request timed out');
        error.name = 'TimeoutError';
        item.reject(error);
      }, timeoutMs);
    }
    if (ipcBlocked) ipcLogout = item;
    else writeIpc(item);
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
    backgroundColor: windowBackgroundColor(nativeTheme.shouldUseDarkColors), autoHideMenuBar: true, icon: iconPath(app),
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
app.on('before-quit', event => {
  if (quitComplete) return;
  if (quitting) { event.preventDefault(); return; }
  quitting = true;
  disposeNativeTheme();
  if (!backend) { quitComplete = true; return; }
  const child = backend;
  const report = status => console[status === 'drained' ? 'info' : 'warn']('[XJAUS shutdown]', { status });
  if (sidecarClosed) {
    quitComplete = true;
    report('child_closed_unknown');
    return;
  }
  event.preventDefault();
  const finish = status => {
    if (quitComplete) return;
    clearTimeout(deadline);
    child.removeListener('close', onClose);
    child.stdin.removeListener('drain', endInput);
    quitComplete = true;
    stopPending('El backend Rust se cerró; resultado de peticiones pendientes desconocido');
    report(status);
    app.quit();
  };
  const endInput = () => {
    try {
      if (child.stdin.writable) child.stdin.end();
      else sidecarIpcIncomplete = true;
    } catch {
      sidecarIpcIncomplete = true;
    }
  };
  const onClose = (code, signal) => {
    if (code !== 0 || signal || !sidecarShutdownResult) finish('child_closed_unknown');
    else if (sidecarShutdownResult === 'drained' && (pending.size || sidecarIpcIncomplete)) finish('ipc_incomplete');
    else finish(sidecarShutdownResult);
  };
  const deadline = setTimeout(() => {
    try { child.kill('SIGKILL'); } finally { finish('timeout_unknown'); }
  }, 9_000);
  child.once('close', onClose);
  // writeIpc registered first: on drain it writes the reserved logout before EOF.
  if (ipcLogout) child.stdin.once('drain', endInput);
  else endInput();
});
