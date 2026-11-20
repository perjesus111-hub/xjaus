'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
function verifyLauncher(launcher) {
  // AppImageTarget's effective template config for this build: no EULA or MIME
  // file. Only ExecutableName affects output without an EULA in builder 26.15.3.
  const config = {DesktopFileName: 'io.github.xjaus.xjaus.desktop', ExecutableName: 'xjaus',
    ProductName: 'XJAUS', ProductFilename: 'XJAUS', ResourceName: 'appimagekit-xjaus'};
  const generated = spawnSync(process.execPath, ['-r', path.join(__dirname, 'secure-appimage-preload.cjs'), '-e',
    `process.stdout.write(require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript(${JSON.stringify(config)}))`]);
  assert.equal(generated.status, 0, `Cannot generate expected launcher: ${generated.error || generated.stderr}`);
  assert.ok(Buffer.from(launcher).equals(generated.stdout), 'AppImage launcher does not exactly match the patched builder output');
}
exports.verifyLauncher = verifyLauncher;
// Use an external parser; never execute an untrusted AppImage runtime.
function extractAndVerifyLauncher(artifact, extractor = '7z', inheritedFd) {
  const childStdio = inheritedFd === undefined ? undefined : ['ignore', 'pipe', 'pipe', inheritedFd];
  if (inheritedFd !== undefined) artifact = '/proc/self/fd/3';
  const maxLauncherSize = 64 * 1024;
  const args = ['-tSquashFS', '-spd', artifact, 'AppRun'];
  const listing = spawnSync(extractor, ['l', '-slt', '-ba', ...args], {encoding: 'utf8', maxBuffer: maxLauncherSize, stdio: childStdio});
  assert.equal(listing.status, 0, `7z AppRun listing failed: ${listing.error || listing.stderr}`);
  const records = listing.stdout.trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  assert.equal(records.length, 1, 'Expected exactly one AppRun entry');
  const fields = records[0].split(/\r?\n/).map(line => line.split(' = '));
  const values = key => fields.filter(parts => parts[0] === key).map(parts => parts.slice(1).join(' = '));
  assert.deepEqual(values('Path'), ['AppRun'], 'Expected exactly one root AppRun entry');
  assert.deepEqual(values('Folder'), ['-'], 'AppRun must be a file');
  assert.equal(values('Mode').length, 1, 'AppRun mode missing or duplicated');
  assert.match(values('Mode')[0], /^-/, 'AppRun must be a regular file');
  const sizes = values('Size');
  assert.equal(sizes.length, 1, 'AppRun size missing or duplicated');
  assert.match(sizes[0], /^[0-9]+$/, 'Invalid AppRun size');
  const size = Number(sizes[0]);
  assert.ok(Number.isSafeInteger(size) && size > 0 && size <= maxLauncherSize, 'AppRun size outside allowed range');
  const result = spawnSync(extractor, ['x', '-so', ...args], {maxBuffer: maxLauncherSize, stdio: childStdio});
  assert.equal(result.status, 0, `7z AppRun extraction failed: ${result.error || result.stderr}`);
  assert.equal(result.stdout.length, size, 'AppRun extracted size mismatch');
  verifyLauncher(result.stdout);
}
exports.extractAndVerifyLauncher = extractAndVerifyLauncher;

// Read only the license member; never run runtime or package hooks.
function verifyPackagedLicense(artifact, ext, expected, run = spawnSync) {
  assert.ok(Buffer.isBuffer(expected) && expected.length > 0 && expected.length <= 65536);
  const member = './opt/XJAUS/resources/LICENSE';
  const commands = {
    AppImage: ['7z', ['x', '-so', '-tSquashFS', '-spd', artifact, 'resources/LICENSE']],
    rpm: ['bash', ['-o', 'pipefail', '-c', 'rpm2archive -n - < "$1" | tar -xOf - -- "$2"', 'license', artifact, member]],
    deb: ['bash', ['-o', 'pipefail', '-c', 'dpkg-deb --fsys-tarfile "$1" | tar -xOf - -- "$2"', 'license', artifact, member]],
  };
  assert.ok(Object.hasOwn(commands, ext), `Unknown package type: ${ext}`);
  const [tool, args] = commands[ext];
  const result = run(tool, args, {maxBuffer: 65536, timeout: 120000});
  assert.equal(result.status, 0, `${ext} LICENSE extraction failed: ${result.error || result.stderr}`);
  assert.ok(expected.equals(result.stdout), `${ext} LICENSE mismatch`);
}
exports.verifyPackagedLicense = verifyPackagedLicense;

// Query archived metadata, not the mode/owner of a locally extracted copy.
function verifyDesktopEntry(artifact, ext, run = spawnSync) {
  const member = '/usr/share/applications/io.github.xjaus.xjaus.desktop';
  const rpm = ext === 'rpm';
  const [tool, args] = rpm
    ? ['rpm', ['-qp', '--qf', '[%{FILENAMES}\t%{FILEMODES:perms}\t%{FILEUSERNAME}\t%{FILEGROUPNAME}\n]', artifact]]
    : ['dpkg-deb', ['--contents', artifact]];
  const result = run(tool, args, {encoding:'utf8', timeout:120000, env:{...process.env, LC_ALL:'C'}});
  assert.equal(result.status, 0, `${ext} desktop listing failed: ${result.error || result.stderr}`);
  const lines = result.stdout.split(/\r?\n/);
  const entries = rpm ? lines.filter(line => line.startsWith(`${member}\t`))
    : lines.filter(line => line.includes(` .${member}`) && line.split(` .${member}`)[1].match(/^(?:$| -> | link to )/));
  const valid = rpm ? entries[0] === `${member}\t-rw-r--r--\troot\troot`
    : /^-rw-r--r--\s+(?:root\/root|0\/0)\s/.test(entries[0]) && entries[0].endsWith(` .${member}`);
  assert.ok(entries.length === 1 && valid, `${ext} desktop entry must be a unique root:root regular file with mode 0644`);
}
exports.verifyDesktopEntry = verifyDesktopEntry;

function verifyDebLibc(artifact, run = spawnSync) {
  const result = run('dpkg-deb', ['-f', artifact, 'Depends'], {encoding:'utf8', timeout:120000});
  assert.equal(result.status, 0, `DEB Depends query failed: ${result.error || result.stderr}`);
  assert.ok(result.stdout.split(',').some(clause => /^libc6\s*\(\s*>=\s*2\.39\s*\)$/.test(clause.trim())),
    'DEB Depends must include unconditional libc6 (>= 2.39)');
}
exports.verifyDebLibc = verifyDebLibc;

function verifyRpmGlibc(artifact) {
  const capability = 'libc.so.6(GLIBC_2.39)(64bit)';
  const result = spawnSync('rpm', ['-qp', '--requires', artifact],
    {encoding:'utf8', timeout:120000, env:{...process.env, LC_ALL:'C'}});
  assert.equal(result.status, 0, `RPM Requires query failed: ${result.error || result.stderr}`);
  assert.ok(result.stdout.split(/\r?\n/).includes(capability),
    `RPM Requires must include unconditional ${capability}`);
}

// Snapshot every input before invoking an external parser. The private directory
// prevents other users from replacing snapshots; the builder user remains trusted.
function verifyArtifacts(files, gate, verifyAppImage = extractAndVerifyLauncher, expectedLicense) {
  fs.rmSync(gate, {force: true});
  const dir = fs.mkdtempSync(path.join(path.dirname(gate), '.verify-'));
  try {
    const artifacts = files.map((file, i) => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd, {bigint:true});
        assert.ok(stat.isFile() && stat.size > 0n, `Invalid artifact: ${file}`);
        const bytes = fs.readFileSync(fd);
        const snapshot = path.join(dir, String(i));
        fs.writeFileSync(snapshot, bytes, {mode:0o400, flag:'wx'});
        return {file, snapshot, stat, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
      } finally { fs.closeSync(fd); }
    });
    verifyAppImage(artifacts[0].snapshot);
    if (expectedLicense !== undefined) {
      for (const {file, snapshot} of artifacts) {
        const ext = path.extname(file).slice(1);
        verifyPackagedLicense(snapshot, ext, expectedLicense);
        if (ext === 'rpm' || ext === 'deb') verifyDesktopEntry(snapshot, ext);
        if (ext === 'deb') verifyDebLibc(snapshot);
        if (ext === 'rpm') verifyRpmGlibc(snapshot);
      }
    }
    for (const item of artifacts) {
      const fd = fs.openSync(item.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(fd, {bigint:true});
        const hash = crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
        const after = fs.fstatSync(fd, {bigint:true});
        const current = fs.lstatSync(item.file, {bigint:true});
        for (const stat of [before, after, current])
          assert.ok(stat.isFile() && stat.dev === item.stat.dev && stat.ino === item.stat.ino &&
            stat.size === item.stat.size && stat.mtimeNs === item.stat.mtimeNs && stat.ctimeNs === item.stat.ctimeNs, `Artifact changed: ${item.file}`);
        assert.equal(hash, item.sha256, `Artifact changed: ${item.file}`);
      } finally { fs.closeSync(fd); }
    }
    const temporaryGate = path.join(dir, 'SHA256SUMS');
    fs.writeFileSync(temporaryGate, artifacts.map(({file, sha256}) => `${sha256}  ${path.basename(file)}`).join('\n') + '\n', {flag:'wx'});
    fs.renameSync(temporaryGate, gate);
    return artifacts;
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
}
exports.verifyArtifacts = verifyArtifacts;

if (require.main === module) {
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const { backendPath } = require('../electron/backend-path.cjs');
const output = path.join(root, 'release/linux');
assert.ok(!process.argv.includes('--legacy-appimage-name'), '--legacy-appimage-name is no longer supported');
fs.rmSync(path.join(output, 'SHA256SUMS'), {force:true});
const resources = path.join(output, 'linux-unpacked/resources');
const binary = backendPath({ isPackaged: true, resourcesPath: resources, platform: 'linux' });
assert.equal(fs.statSync(binary).mode & 0o777, 0o755);
const source = fs.readFileSync(path.join(root, 'src-tauri/target/release/xjaus_backend'));
assert.deepEqual(fs.readFileSync(binary), source);
const asar = require('@electron/asar');
const archive = path.join(resources, 'app.asar');
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(metadata.version, pkg.version);
assert.equal(metadata.license, 'GPL-3.0-only');
// electron-builder removes build-only configuration from packaged metadata.
assert.equal(pkg.build.appId, 'io.github.xjaus.xjaus');
assert.ok(asar.extractFile(archive, 'electron/main.cjs').toString().includes("app.setAppUserModelId('io.github.xjaus.xjaus')"));
assert.equal(metadata.description, 'High-performance Xbox Cloud Gaming & Remote Play client for Linux');
assert.equal(metadata.desktopName, 'io.github.xjaus.xjaus.desktop');
assert.equal(metadata.homepage, 'https://github.com/perjesus111-hub/xjaus');
assert.equal(metadata.repository.url, 'https://github.com/perjesus111-hub/xjaus.git');
for (const entry of ['dist/index.html', 'dist/login.html', 'electron/main.cjs', 'electron/preload.cjs', 'electron/backend-path.cjs']) assert.ok(asar.extractFile(archive, entry).length, entry);
const files = ['AppImage', 'rpm', 'deb'].map(ext => {
  const name = require('./packaging.cjs').artifactName(pkg.version, ext);
  const file = path.join(output, name);
  assert.ok(fs.statSync(file).size > 1024, name);
  return file;
});
const artifacts = verifyArtifacts(files, path.join(output, 'SHA256SUMS'), undefined,
  fs.readFileSync(path.join(root, 'LICENSE')));
console.log('Project LICENSE verified byte-for-byte inside AppImage, RPM and DEB');
console.log('Packaged backend path, byte identity, mode 0755, ASAR metadata and renderer verified');
for (const {file, sha256} of artifacts) console.log(`${sha256}  ${file}`);

}
