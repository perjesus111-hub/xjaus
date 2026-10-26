const { contextBridge, ipcRenderer } = require('electron');
const commands = new Set([
  'app_exit', 'auth_status', 'begin_login_window', 'poll_login', 'cancel_login', 'load_session', 'persist_session',
  'refresh_session', 'logout', 'xbox_profile', 'load_settings', 'save_settings', 'wake_console', 'list_consoles_smartglass', 'list_streaming_servers',
  'list_cloud_titles', 'catalog_products', 'start_stream', 'provision_stream',
  'submit_stream_offer', 'poll_stream_answer', 'exchange_stream_ice', 'stream_keepalive', 'stop_stream', 'cancel_connection',
]);
contextBridge.exposeInMainWorld('xjaus', Object.freeze({
  invoke(command, args) {
    if (!commands.has(command)) return Promise.reject(new Error('Comando IPC no permitido'));
    return ipcRenderer.invoke('xjaus:invoke', command, args);
  },
  fullscreen(action) {
    if (!['enter', 'exit', 'toggle', 'restore', 'session-enter', 'session-restore'].includes(action)) return Promise.reject(new Error('Acción fullscreen no permitida'));
    return ipcRenderer.invoke('xjaus:fullscreen', action);
  },
  openExternal(url) { return ipcRenderer.invoke('xjaus:open-external', url); },
  openMicrosoftVerification(url) {
    if (typeof url !== 'string' || url.length > 512) return Promise.reject(new Error('Enlace de verificación no permitido'));
    return ipcRenderer.invoke('xjaus:open-microsoft-verification', url);
  },
  copyText(text) {
    if (typeof text !== 'string' || text.length > 512) return Promise.reject(new Error('Texto para copiar no permitido'));
    return ipcRenderer.invoke('xjaus:clipboard', text);
  },
}));
