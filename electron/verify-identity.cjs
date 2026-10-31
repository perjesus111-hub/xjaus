const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const id = 'io.github.xjaus.xjaus';
test('icon is absolute and uses existing official 512 PNG', () => {
  const { iconPath } = require('./icons.cjs');
  assert.ok(path.isAbsolute(iconPath({ getAppPath: () => '.' })));
  const png = fs.readFileSync(iconPath({ getAppPath: () => root }));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
});
test('Electron declares coherent identity before ready', () => {
  const main = read('electron/main.cjs');
  const identity = main.indexOf(`app.setAppUserModelId('${id}')`);
  assert.ok(identity >= 0 && identity < main.indexOf('app.whenReady()'));
  assert.ok(main.includes(`app.setDesktopName('${id}.desktop')`));
  assert.ok(main.includes(`app.commandLine.appendSwitch('class', '${id}')`));
});
test('Linux launchers and packaging share identity and official icon', () => {
  assert.ok(read('launch-xjaus.sh').includes(`--class=${id}`));
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['electron', 'electron:run']) assert.ok(pkg.scripts[name].includes(`electron . --class=${id}`));
  assert.equal(pkg.desktopName, `${id}.desktop`);
  assert.equal(pkg.build.linux.desktop.entry.StartupWMClass, id);
  assert.ok(pkg.build.linux.executableArgs.includes(`--class=${id}`));
  for (const file of [`resources/linux/${id}.desktop`, `assets/${id}.desktop`]) {
    const desktop = read(file);
    assert.ok(desktop.split(/\r?\n/).includes(`StartupWMClass=${id}`));
    assert.ok(desktop.includes(`--class=${id}`));
  }
  assert.deepEqual(fs.readFileSync(path.join(root, 'assets/icon.png')), fs.readFileSync(path.join(root, 'resources/icons/512x512.png')));
});
