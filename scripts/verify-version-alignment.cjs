const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('application manifests and lockfile root packages target 1.2.4', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  const cargo = read('src-tauri/Cargo.toml');
  const cargoLock = read('src-tauri/Cargo.lock');
  const packageSection = cargo.match(/^\[package\]\s*([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  assert.ok(packageSection, 'Cargo package section');
  const cargoVersion = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoName = packageSection.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const entries = cargoLock.split('[[package]]').slice(1);
  const ownEntry = entries.find(entry => entry.match(/^name\s*=\s*"([^"]+)"/m)?.[1] === cargoName);
  assert.ok(ownEntry, 'Cargo lock root package');
  const versions = { package: pkg.version, npmLock: lock.version, npmRoot: lock.packages[''].version, tauri: tauri.version, cargo: cargoVersion, cargoLock: ownEntry.match(/^version\s*=\s*"([^"]+)"/m)?.[1] };
  assert.deepEqual(versions, Object.fromEntries(Object.keys(versions).map(key => [key, '1.2.4'])));
});
