const { fileURLToPath } = require('node:url');
const path = require('node:path');
const commands = new Set([
  'app_exit', 'auth_status', 'begin_login_window', 'poll_login', 'load_session', 'persist_session',
  'refresh_session', 'logout', 'xbox_profile', 'load_settings', 'save_settings', 'wake_console', 'list_consoles_smartglass', 'list_streaming_servers',
  'list_cloud_titles', 'catalog_products', 'start_stream', 'provision_stream',
  'submit_stream_offer', 'poll_stream_answer', 'exchange_stream_ice', 'stream_keepalive', 'stop_stream', 'cancel_connection',
]);
exports.allowedCommand = (name) => typeof name === 'string' && commands.has(name);
exports.trustedFrame = (frameUrl, topUrl, filePath) => {
  try {
    const frame = new URL(frameUrl);
    return frame.href === topUrl && frame.protocol === 'file:' && path.resolve(fileURLToPath(frame)) === path.resolve(filePath);
  } catch { return false; }
};
exports.externalUrl = value => exports.repositoryUrl(value) || value === 'https://paypal.me/Comicoon' || exports.externalLoginUrl(value);
exports.repositoryUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
      && url.port === '' && url.pathname === '/perjesus111-hub/xjaus' && !url.search && !url.hash;
  } catch { return false; }
};
exports.externalLoginUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['microsoft.com', 'www.microsoft.com'].includes(url.hostname)
      && ['/devicelogin', '/link'].includes(url.pathname);
  } catch { return false; }
};
