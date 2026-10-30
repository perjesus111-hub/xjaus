'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { artifactName, linuxBuilderArgs } = require('./packaging.cjs');

test('AppImage has no redundant linux segment, while distro names stay unchanged', () => {
  assert.equal(artifactName('1.2.3', 'AppImage'), 'XJAUS-1.2.3-x86_64.AppImage');
  assert.equal(artifactName('1.2.3', 'rpm'), 'XJAUS-1.2.3-linux-x86_64.rpm');
  assert.equal(artifactName('1.2.3', 'deb'), 'XJAUS-1.2.3-linux-amd64.deb');
});

test('builder gets AppImage-specific naming override and publishing stays disabled', () => {
  const args = linuxBuilderArgs();
  assert.ok(args.includes('--publish') && args[args.indexOf('--publish') + 1] === 'never');
  assert.ok(args.includes('-c.appImage.artifactName=XJAUS-${version}-${arch}.${ext}'));
});


test('AppRun fails closed when namespace probe fails', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(process.execPath, ['-r', path.join(__dirname, 'secure-appimage-preload.cjs'), '-e', `
    const { generateAppRunScript } = require('app-builder-lib/out/targets/appimage/appImageUtil');
    process.stdout.write(generateAppRunScript({ExecutableName:'xjaus',ProductFilename:'XJAUS',ProductName:'XJAUS'}));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /NO_SANDBOX=\(--no-sandbox\)/);
  assert.match(result.stdout, /sandbox/i);
});

 test('launcher rejects explicit no-sandbox without executing application', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-launcher-'));
  try {
    const generated = spawnSync(process.execPath, ['-r', path.join(__dirname, 'secure-appimage-preload.cjs'), '-e', "process.stdout.write(require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript({ExecutableName:'xjaus'}))"], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    fs.writeFileSync(path.join(dir, 'AppRun'), generated.stdout);
    fs.writeFileSync(path.join(dir, 'xjaus'), '#!/bin/sh\nexit 42\n', {mode: 0o755});
    const result = spawnSync('/bin/bash', [path.join(dir, 'AppRun'), '--no-sandbox'], {env: {...process.env, APPDIR: dir}, encoding:'utf8'});
    assert.notEqual(result.status, 0); assert.notEqual(result.status, 42);
    assert.match(result.stderr, /sandbox/i);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('artifact launcher verification rejects an unpatched launcher', () => {
  const { verifyLauncher } = require('./linux-verify.cjs');
  assert.equal(typeof verifyLauncher, 'function');
  const original = require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript({ExecutableName:'xjaus'});
  assert.throws(() => verifyLauncher(original), /launcher/i);
});

test('artifact launcher verification rejects sandbox bypass inside atexit', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const { verifyLauncher } = require('./linux-verify.cjs');
  const generated = spawnSync(process.execPath, ['-r', path.join(__dirname, 'secure-appimage-preload.cjs'), '-e',
    "process.stdout.write(require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript({DesktopFileName:'io.github.xjaus.xjaus.desktop',ExecutableName:'xjaus',ProductName:'XJAUS',ProductFilename:'XJAUS',ResourceName:'appimagekit-xjaus'}))"], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  verifyLauncher(generated.stdout);
  const mutated = generated.stdout.replace('atexit()\n{\n', 'atexit()\n{\n  NO_SANDBOX=(--no-sandbox)\n');
  assert.notEqual(mutated, generated.stdout);
  assert.throws(() => verifyLauncher(mutated), /launcher/i);
});

test('launcher rejects missing and failed unshare, and executes on success', () => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const {spawnSync} = require('node:child_process');
 const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-launch-'));
 try {
  const generated = spawnSync(process.execPath, ['-r',path.join(__dirname,'secure-appimage-preload.cjs'),'-e',"process.stdout.write(require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript({ExecutableName:'xjaus'}))"],{encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr); fs.writeFileSync(path.join(d,'AppRun'),generated.stdout);
  fs.writeFileSync(path.join(d,'xjaus'),'#!/bin/bash\nprintf "%s\\n" "$@"\nexit 42\n',{mode:0o755});
  for (const mode of ['missing','fail','success']) {
   if(mode !== 'missing') fs.writeFileSync(path.join(d,'unshare'), `#!/bin/bash\nexit ${mode === 'fail' ? 1 : 0}\n`, {mode:0o755});
   const r=spawnSync('/bin/bash',[path.join(d,'AppRun'),'hello world'],{encoding:'utf8',env:{APPDIR:d,PATH:d}});
   if(mode === 'success') { assert.equal(r.status,42,r.stderr); assert.equal(r.stdout,'hello world\n'); }
   else { assert.equal(r.status,1,r.stderr); assert.match(r.stderr,/refusing to launch/); assert.equal(r.stdout,''); }
  }
 } finally {fs.rmSync(d,{recursive:true,force:true});}
});

test('preload restores the JavaScript module loader after patch installation', () => {
 const {spawnSync} = require('node:child_process');
 const r = spawnSync(process.execPath,['-e', `const M=require('node:module'); const before=M._extensions['.js']; require('./scripts/secure-appimage-preload.cjs'); if(M._extensions['.js'] !== before) process.exit(7);`],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});


test('external extractor verifies launcher without executing AppImage runtime', () => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const { extractAndVerifyLauncher } = require('./linux-verify.cjs');
 const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-extract-test-'));
 try {
  const marker = path.join(d, 'executed'), artifact = path.join(d, 'unsafe.AppImage');
  fs.writeFileSync(artifact, `#!/bin/sh\ntouch "${marker}"\nexit 99\n`, {mode:0o755});
  const generated = require('node:child_process').spawnSync(process.execPath, ['-r', path.join(__dirname, 'secure-appimage-preload.cjs'), '-e', "process.stdout.write(require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript({DesktopFileName:'io.github.xjaus.xjaus.desktop',ExecutableName:'xjaus',ProductName:'XJAUS',ProductFilename:'XJAUS',ResourceName:'appimagekit-xjaus'}))"]);
  assert.equal(generated.status,0); const launcher = path.join(d, 'launcher'); fs.writeFileSync(launcher,generated.stdout);
  const extractor = path.join(d,'extractor');
  fs.writeFileSync(extractor, `#!/bin/sh\nif [ "$1" = l ]; then printf 'Path = AppRun\nFolder = -\nSize = ${generated.stdout.length}\nMode = -rwxr-xr-x\n\n'; else cat '${launcher}'; fi\n`, {mode:0o755});
  extractAndVerifyLauncher(artifact, extractor);
  assert.equal(fs.existsSync(marker),false);
 } finally {fs.rmSync(d,{recursive:true,force:true});}
});


test('extractor errors, ambiguous entries, unsafe sizes and tampered launcher fail closed', () => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const { spawnSync } = require('node:child_process');
 const { extractAndVerifyLauncher } = require('./linux-verify.cjs');
 const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-extract-errors-'));
 try {
  const artifact = path.join(d,'artifact'), extractor = path.join(d,'7z');
  fs.writeFileSync(artifact,'not executable');
  const generated = spawnSync(process.execPath,['-r',path.join(__dirname,'secure-appimage-preload.cjs'),'-e',"process.stdout.write(require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript({DesktopFileName:'io.github.xjaus.xjaus.desktop',ExecutableName:'xjaus',ProductName:'XJAUS',ProductFilename:'XJAUS',ResourceName:'appimagekit-xjaus'}))"]);
  assert.equal(generated.status,0); const data = path.join(d,'data'); fs.writeFileSync(data,generated.stdout);
  const record = `Path = AppRun\nFolder = -\nSize = ${generated.stdout.length}\nMode = -rwxr-xr-x\n\n`;
  function install(listing, extraction = `cat '${data}'`) {
   fs.writeFileSync(extractor, `#!/bin/sh\nif [ "$1" = l ]; then printf '%s' '${listing}'; else ${extraction}; fi\n`, {mode:0o755});
  }
  fs.writeFileSync(extractor,'#!/bin/sh\nexit 2\n',{mode:0o755});
  assert.throws(() => extractAndVerifyLauncher(artifact,extractor), /listing failed/);
  install(record,'exit 3'); assert.throws(() => extractAndVerifyLauncher(artifact,extractor), /extraction failed/);
  install(record + record); assert.throws(() => extractAndVerifyLauncher(artifact,extractor), /exactly one/);
  install(record.replace(`Size = ${generated.stdout.length}`, 'Size = 65537')); assert.throws(() => extractAndVerifyLauncher(artifact,extractor), /size outside/);
  install(record, 'printf short'); assert.throws(() => extractAndVerifyLauncher(artifact,extractor), /size mismatch/);
  const modified = Buffer.from(generated.stdout); modified[0] ^= 1; fs.writeFileSync(data, modified);
  install(record); assert.throws(() => extractAndVerifyLauncher(artifact,extractor), /launcher/);
  assert.throws(() => extractAndVerifyLauncher(artifact,path.join(d,'missing')), /listing failed/);
 } finally {fs.rmSync(d,{recursive:true,force:true});}
});

test('legacy AppImage flag is explicitly rejected', () => {
 const {spawnSync} = require('node:child_process');
 const result = spawnSync(process.execPath,[require('node:path').join(__dirname,'linux-verify.cjs'),'--legacy-appimage-name'],{encoding:'utf8'});
 assert.notEqual(result.status,0); assert.match(result.stderr,/no longer supported/);
});


test('artifact replacement during verification rejects and removes stale gate', () => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const { verifyArtifacts } = require('./linux-verify.cjs');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-race-'));
 try {
  const file = path.join(dir,'app.AppImage'), gate = path.join(dir,'SHA256SUMS');
  fs.writeFileSync(file, 'original'); fs.writeFileSync(gate, 'stale');
  assert.throws(() => verifyArtifacts([file], gate, snapshot => {
   assert.notEqual(snapshot, file); assert.equal(fs.readFileSync(snapshot,'utf8'), 'original');
   const replacement = path.join(dir,'replacement'); fs.writeFileSync(replacement, 'original'); fs.renameSync(replacement,file);
  }), /changed/i);
  assert.equal(fs.existsSync(gate), false);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('verification failure removes stale gate', () => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const { verifyArtifacts } = require('./linux-verify.cjs');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-fail-'));
 try {
  const file = path.join(dir,'app.AppImage'), gate = path.join(dir,'SHA256SUMS');
  fs.writeFileSync(file,'original'); fs.writeFileSync(gate,'stale');
  assert.throws(() => verifyArtifacts([file],gate,() => { throw Error('verification failed'); }), /verification failed/);
  assert.equal(fs.existsSync(gate),false);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});


test('in-place artifact mutation fails and leaves no gate', () => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const {verifyArtifacts} = require('./linux-verify.cjs');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-change-'));
 try {
  const file = path.join(dir,'app.AppImage'), gate = path.join(dir,'SHA256SUMS');
  fs.writeFileSync(file,'original');
  assert.throws(() => verifyArtifacts([file],gate,() => fs.writeFileSync(file,'modified')), /changed/i);
  assert.equal(fs.existsSync(gate),false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('successful verification writes snapshot checksum', () => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
 const {verifyArtifacts} = require('./linux-verify.cjs');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-success-'));
 try {
  const file = path.join(dir,'app.AppImage'), gate = path.join(dir,'SHA256SUMS');
  fs.writeFileSync(file,'original'); verifyArtifacts([file],gate,snapshot => assert.equal(fs.readFileSync(snapshot,'utf8'),'original'));
  assert.equal(fs.readFileSync(gate,'utf8'), `${crypto.createHash('sha256').update('original').digest('hex')}  app.AppImage\n`);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
