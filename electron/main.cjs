const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { allowedCommand, trustedFrame, externalUrl } = require('./security.cjs');

const { iconPath } = require('./icons.cjs');
app.setName('XJAUS');
app.setAppUserModelId('io.github.xjaus.xjaus');
// Isolated namespace: no automatic import or removal of previous app data.
app.setPath('userData', path.join(app.getPath('appData'), 'io.github.xjaus.xjaus'));
const systemLang = [process.env.LANG, process.env.LC_ALL, process.env.LC_MESSAGES].filter(Boolean).join(':') || 'es_MX';
const localeArg = systemLang.toLowerCase().includes('es') ? 'es-MX' : 'en-US';
app.commandLine.appendSwitch('lang', localeArg);
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
let fullscreen;
let backend;
let window;
let sequence = 0;
let stdoutBuffer = '';
const pending = new Map();
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
  backend.on('error', (error) => stopPending(`No se pudo iniciar el backend Rust: ${error.message}`));
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
      pending.delete(reply.id);
      if (typeof reply.error === 'string') item.reject(new Error(reply.error));
      else item.resolve(reply.result);
    }
  });
  backend.stderr.on('data', () => { /* Never forward diagnostics or credentials to renderer. */ });
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
  const message = JSON.stringify({ id, cmd: command, args: args ?? {} });
  if (message.length > 2_000_000) throw new Error('Petición IPC demasiado grande');
  if (!backend || backend.exitCode !== null || !backend.stdin.writable) throw new Error('Backend Rust no disponible');
  if (command === 'start_stream') {
    window.show();
    window.focus();
    window.webContents.focus();
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    backend.stdin.write(`${message}\n`, (error) => {
      if (error) { const item = pending.get(id); pending.delete(id); item?.reject(error); }
    });
  });
});
ipcMain.handle('xjaus:fullscreen', (event, action) => {
  if (!authorize(event) || !['enter', 'exit', 'toggle', 'restore'].includes(action)) throw new Error('Fullscreen IPC no permitido');
  fullscreen(action);
});
ipcMain.handle('xjaus:open-external', async (event, url) => {
  if (!authorize(event) || !externalUrl(url)) throw new Error('Enlace externo no permitido');
  await shell.openExternal(url);
});
app.whenReady().then(() => {
  console.info('[XJAUS locale]', JSON.stringify({locale: app.getLocale?.(), requested: localeArg, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES}));
  startBackend();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window = new BrowserWindow({
    width: 1240, height: 800, minWidth: 860, minHeight: 600, title: 'XJAUS',
    backgroundColor: '#0a0a0a', autoHideMenuBar: true, icon: iconPath(app),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false,
    },
  });
  fullscreen = createFullscreenController(window);
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
