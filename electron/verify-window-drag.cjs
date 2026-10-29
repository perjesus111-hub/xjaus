const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

function windowOptions(platform) {
  let options;
  const win = { webContents: { setWindowOpenHandler() {}, on() {} }, loadFile() {} };
  const app = { getPath: () => '/isolated-app-data', setPath() {}, setName() {}, setAppUserModelId() {}, setDesktopName() {}, getAppPath: () => '/app', commandLine: { appendSwitch() {} }, whenReady: () => ({ then: fn => fn() }), on() {} };
  const backend = { on() {}, stdout: { on() {} }, stderr: { on() {} } };
  runInNewContext(readFileSync(require.resolve('./main.cjs'), 'utf8'), {
    process: { ...process, platform }, __dirname: '/app/electron',
    require: name => name === 'electron' ? { app, BrowserWindow: function (value) { options = value; return win; }, ipcMain: { handle() {} }, session: { defaultSession: { setPermissionRequestHandler() {} } } } : name === 'node:child_process' ? { spawn: () => backend } : require(name),
  });
  return options;
}

test('Linux uses the native movable title bar on login and dashboard', () => {
  const options = windowOptions('linux');
  assert.notEqual(options.frame, false);
  assert.ok(options.titleBarStyle === undefined || options.titleBarStyle === 'default');
  assert.equal(options.titleBarOverlay, undefined);
});

test('Windows and macOS retain their existing native overlay controls', () => {
  assert.equal(windowOptions('win32').titleBarStyle, 'hidden');
  assert.equal(windowOptions('win32').titleBarOverlay.height, 40);
  assert.equal(windowOptions('darwin').titleBarStyle, 'hidden');
  assert.equal(windowOptions('darwin').titleBarOverlay, undefined);
});
