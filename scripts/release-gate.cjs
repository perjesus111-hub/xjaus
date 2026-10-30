'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {artifactName} = require('./packaging.cjs');
const {extractAndVerifyLauncher} = require('./linux-verify.cjs');

function namesFor(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected numeric release version');
  return ['AppImage', 'rpm', 'deb'].map(ext => artifactName(version, ext))
    .concat(['exe', 'msi'].map(ext => `XJAUS-${version}-win-x64-setup.${ext}`));
}
function outside(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}
function stat(fd) {
  const s = fs.fstatSync(fd, {bigint:true});
  assert.ok(s.isFile() && s.size > 0n && s.nlink === 1n, 'Expected non-empty regular file with one link');
  return s;
}
function same(a,b) {
  return ['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k => a[k] === b[k]);
}
function digest(fd, destination) {
  const hash = crypto.createHash('sha256'), buf = Buffer.alloc(1024 * 1024);
  let pos = 0, n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) !== 0) {
    hash.update(buf.subarray(0,n));
    if (destination !== undefined) {
      let written = 0;
      while (written < n) written += fs.writeSync(destination, buf, written, n-written);
    }
    pos += n;
  }
  return hash.digest('hex');
}
function open(file) { return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
function inspect(file, expected, previous) {
  const fd = open(file);
  try {
    const before = stat(fd);
    if (previous) assert.ok(same(previous,before), `File changed: ${file}`);
    assert.equal(digest(fd), expected, `Checksum mismatch: ${file}`);
    assert.ok(same(before,stat(fd)), `File changed while reading: ${file}`);
    return before;
  } finally { fs.closeSync(fd); }
}
function run(version, dir, manifestFile, signatureFile, trustedKeyFile, out, verify = extractAndVerifyLauncher) {
  const names = namesFor(version);
  assert.ok(dir && manifestFile && signatureFile && trustedKeyFile && out, 'Missing gate arguments');
  const candidate = fs.realpathSync(dir);
  const parent = fs.realpathSync(path.dirname(path.resolve(out)));
  const target = path.join(parent,path.basename(path.resolve(out)));
  assert.ok(outside(candidate,target) && outside(target,candidate), 'Snapshot and candidates must be separate');
  // The key is supplied independently by the operator, never by the signed manifest.
  const manifest = fs.readFileSync(manifestFile);
  assert.ok(manifest.length <= 16384, 'Manifest too large');
  const signature = fs.readFileSync(signatureFile);
  assert.equal(signature.length,64,'Invalid Ed25519 signature length');
  const keyBytes = fs.readFileSync(trustedKeyFile);
  assert.match(keyBytes.toString('ascii'), /^-----BEGIN PUBLIC KEY-----\r?\n/,'Expected PEM public key');
  const key = crypto.createPublicKey(keyBytes);
  assert.equal(key.asymmetricKeyType,'ed25519','Expected Ed25519 public key');
  assert.ok(crypto.verify(null,manifest,key,signature),'Invalid manifest signature');
  const text = manifest.toString('utf8');
  assert.ok(Buffer.from(text).equals(manifest),'Invalid manifest encoding');
  const lines = text.endsWith('\n') ? text.slice(0,-1).split('\n') : text.split('\n');
  const expected = new Map();
  for (const line of lines) {
    const m = /^([0-9a-f]{64})  ([^/\\\r\n]+)$/.exec(line);
    assert.ok(m && names.includes(m[2]) && !expected.has(m[2]), 'Malformed, unexpected or duplicate manifest entry');
    expected.set(m[2],m[1]);
  }
  assert.equal(expected.size,5,'Expected five manifest entries');
  const checkDir = d => assert.deepEqual(fs.readdirSync(d).sort(), [...names].sort(), 'Directory must contain exactly five expected files');
  checkDir(candidate);
  fs.mkdirSync(target,{mode:0o700});
  const originals = [], snapshots = [];
  for (const name of names) {
    const source = path.join(candidate,name), dest = path.join(target,name);
    const fd = open(source);
    try {
      const before = stat(fd);
      const dst = fs.openSync(dest,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,0o600);
      try {
        assert.equal(digest(fd,dst),expected.get(name),`Checksum mismatch: ${name}`);
        fs.fsyncSync(dst); fs.fchmodSync(dst,0o400);
      } finally { fs.closeSync(dst); }
      assert.ok(same(before,stat(fd)),`Candidate changed: ${name}`);
      originals.push(before);
    } finally { fs.closeSync(fd); }
    snapshots.push(inspect(dest,expected.get(name)));
  }
  verify(path.join(target,names[0]));
  for (let i=0;i<names.length;i++) {
    inspect(path.join(candidate,names[i]),expected.get(names[i]),originals[i]);
    inspect(path.join(target,names[i]),expected.get(names[i]),snapshots[i]);
  }
  checkDir(candidate); checkDir(target);
  return names.map(name => `${expected.get(name)}  ${name}`).join('\n')+'\n';
}
// Experimental Linux-only local chain. The consumer runs synchronously while the
// gate retains read-only descriptors; paths are not a consumption interface.
function runLocal(version, dir, manifestFile, signatureFile, trustedKeyFile, out, verify, consume) {
  throw new Error('Publication disabled: experimental local chain is not safe for use');
  assert.equal(process.platform, 'linux', 'fs-verity local chain requires Linux');
  assert.equal(typeof consume, 'function', 'A synchronous local consumer is required');
  assert.equal(verify, extractAndVerifyLauncher, 'The real AppRun verifier is required');
  // Preflight only: AppRun is verified later through the verity-protected FD.
  const result = run(version, dir, manifestFile, signatureFile, trustedKeyFile, out, () => {});
  const names = namesFor(version), expected = new Map(result.trimEnd().split('\n').map(line => [line.slice(66),line.slice(0,64)]));
  const fds = [];
  try {
    for (const name of names) {
      const fd = open(path.join(out,name)); fds.push(fd); stat(fd);
      const script = `import fcntl,struct,sys
fd=3
fcntl.ioctl(fd,0x40806685,struct.pack('=IIIIQIIQ11Q',1,1,4096,0,0,0,0,0,*([0]*11)))
b=bytearray(struct.pack('HH',0,64)+bytes(64))
fcntl.ioctl(fd,0xc0046686,b,True)
a,n=struct.unpack_from('HH',b)
if (a,n)!=(1,32): sys.exit(1)
print(bytes(b[4:36]).hex())`;
      fs.fchmodSync(fd,0o600);
      const child = require('node:child_process').spawnSync('/usr/bin/python3',['-I','-S','-c',script],{stdio:['ignore','pipe','pipe',fd],encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
      fs.fchmodSync(fd,0o400);
      assert.ok(!child.error && child.status === 0 && /^[0-9a-f]{64}\n$/.test(child.stdout), `fs-verity enable/measure failed: ${child.error?.message || child.stderr || child.status}`);
      assert.equal(digest(fd),expected.get(name),`Checksum mismatch: ${name}`);
    }
    extractAndVerifyLauncher(null, '7z', fds[0]);
    const value = consume(Object.freeze([...fds]));
    assert.ok(!value || typeof value.then !== 'function', 'Consumer must be synchronous');
    for (let i=0;i<fds.length;i++) assert.equal(digest(fds[i]),expected.get(names[i]),`Consumed file changed: ${names[i]}`);
    return result;
  } finally { for (const fd of fds) fs.closeSync(fd); }
}
exports.runLocal = runLocal;
exports.run = run;
exports.namesFor = namesFor;
if (require.main === module) {
  console.error('Release gate failed: publication disabled; no release approved.');
  process.exitCode = 1;
}
