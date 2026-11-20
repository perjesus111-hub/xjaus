const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { build } = require('../package.json');
const project = path.resolve(__dirname, '..');

// Static allowlist first: never execute an unexpected maintainer script.
function inertHook(format, phase) {
  const configured = build[format][phase];
  assert.ok(configured, `${format}.${phase} must replace the upstream default`);
  const source = fs.readFileSync(path.resolve(project, configured), 'utf8');
  assert.match(source, /^#!\/bin\/sh\n(?:#[\x20-\x7e]*\n)*exit 0\n(?![\s\S])/);
  return source;
}

for (const [format, phase, scenario, args] of [
  ['deb', 'afterInstall', 'install alongside legacy files', ['configure']],
  ['deb', 'afterInstall', 'upgrade', ['configure', '1.2.3']],
  ['deb', 'afterRemove', 'old package upgrade callback', ['upgrade', '1.2.4']],
  ['deb', 'afterRemove', 'remove', ['remove']],
  ['deb', 'afterRemove', 'purge', ['purge']],
  ['deb', 'afterRemove', 'partial failure', ['abort-install']],
  ['rpm', 'afterInstall', 'install alongside legacy files', ['1']],
  ['rpm', 'afterInstall', 'upgrade', ['2']],
  ['rpm', 'afterRemove', 'old package upgrade callback', ['1']],
  ['rpm', 'afterRemove', 'final erase', ['0']],
  ['rpm', 'afterRemove', 'unexpected transaction input', []],
]) {
  test(`${format} ${phase}: ${scenario} is inert on repeat`, () => {
    const hook = inertHook(format, phase);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-hook-fixture-'));
    try {
      const files = ['opt/XJAUS/chrome-sandbox', 'opt/Greenlight/greenlight',
        'etc/apparmor.d/xjaus', 'etc/alternatives/xjaus',
        'usr/share/applications/io.github.xjaus.xjaus.desktop',
        'usr/share/applications/mimeinfo.cache', 'usr/share/mime/mime.cache'];
      for (const name of files) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `fixture:${name}`, { mode: 0o755 });
      }
      const link = path.join(root, 'usr/bin/xjaus');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync('../../opt/Greenlight/greenlight', link);
      const snapshot = () => fs.readdirSync(root, { recursive: true }).sort().map(name => {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        return [name, stat.mode, stat.uid, stat.gid, stat.isSymbolicLink() ? fs.readlinkSync(file)
          : stat.isFile() ? fs.readFileSync(file, 'hex') : null];
      });
      const before = snapshot();
      // Run only an exact, allowlisted inert fixture copy, not a package hook.
      const fixture = path.join(root, 'hook.fixture');
      fs.writeFileSync(fixture, hook, { mode: 0o600 });
      for (let i = 0; i < 2; i++) {
        const result = spawnSync('/bin/sh', [fixture, ...args], {
          cwd: root, env: { HOME: root, PATH: '/nonexistent', LC_ALL: 'C' }, encoding: 'utf8',
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout + result.stderr, '');
      }
      fs.unlinkSync(fixture);
      assert.deepEqual(snapshot(), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const format of ['deb', 'rpm']) {
  test(`${format}: bundled AppArmor placeholder contains no policy`, () => {
    const configured = build[format].appArmorProfile;
    assert.ok(configured, `${format} must replace the upstream AppArmor template`);
    assert.match(fs.readFileSync(path.resolve(project, configured), 'utf8'), /^(?:#[^\n]*\n)+$/);
  });
}
