'use strict';
// Local consistency check only: policy must be independently supplied by the
// operator. Neither record authenticates a human, provenance, or CI permissions.
// NONAUTHENTICATED, local preflight only. Use a trusted, quiescent tree and host.
// Path checks are not race-proof; no guarantee binds these bytes to later consumers.
// Claimed ref and permissions are not effective CI ref or permissions. No publication.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function namesFor(version) {
  assert.ok(typeof version === 'string' && version.length <= 64, 'Invalid version');
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Invalid version');
  return [`XJAUS-${version}-x86_64.AppImage`, `XJAUS-${version}-linux-x86_64.rpm`, `XJAUS-${version}-linux-amd64.deb`, `XJAUS-${version}-win-x64-setup.exe`, `XJAUS-${version}-win-x64-setup.msi`];
}
function entries(record, names) {
  assert.ok(Array.isArray(record.artifacts) && record.artifacts.length === 5, 'Expected five artifacts');
  const map = new Map();
  for (const a of record.artifacts) {
    assert.ok(a && names.includes(a.name) && !map.has(a.name), 'Unexpected or duplicate artifact');
    assert.ok(Number.isSafeInteger(a.size) && a.size > 0 && a.size <= 4 * 1024 ** 3, 'Invalid artifact size');
    assert.ok(typeof a.sha256 === 'string', 'Invalid SHA-256');
    assert.match(a.sha256, /^[0-9a-f]{64}$/, 'Invalid SHA-256');
    map.set(a.name, a);
  }
  return map;
}
function validate({dir, manifest, review, policy}) {
  assert.ok(manifest && review && policy, 'Manifest, review and independent policy required');
  assert.equal(manifest.schema, 1, 'Invalid manifest schema');
  assert.equal(review.schema, 1, 'Invalid review schema');
  assert.equal(review.status, 'recorded-nonauthenticated-nonpublishing', 'Invalid record status');
  const names = namesFor(policy.version);
  assert.ok(typeof policy.commit === 'string', 'Expected full commit');
  assert.match(policy.commit, /^[0-9a-f]{40}$/, 'Expected full commit');
  assert.ok(['local','ci'].includes(policy.origin), 'Invalid origin');
  for (const key of ['version','commit','origin']) {
    assert.equal(manifest[key], policy[key], `Manifest ${key} conflicts with policy`);
    assert.equal(review[key], policy[key], `Review ${key} conflicts with policy`);
  }
  assert.ok(Array.isArray(policy.allowedRefs) && policy.allowedRefs.length > 0 && policy.allowedRefs.length <= 64 && policy.allowedRefs.every(x => typeof x === 'string' && x.length <= 256 && /^refs\/[A-Za-z0-9._\/-]+$/.test(x)), 'Independent allowed refs required');
  assert.ok(policy.allowedRefs.includes(review.ref), 'Ref not allowed');
  assert.ok(policy.permissions && typeof policy.permissions === 'object' && !Array.isArray(policy.permissions), 'Independent permissions policy required');
  assert.ok(review.permissions && typeof review.permissions === 'object' && !Array.isArray(review.permissions), 'Review permissions required');
  const rank = {none:0, read:1};
  const permissionEntries = Object.entries(policy.permissions);
  assert.ok(permissionEntries.length > 0 && permissionEntries.length <= 64, 'Independent permissions policy required');
  for (const [key, value] of permissionEntries) assert.ok(/^[a-z][a-z0-9-]{0,63}$/.test(key) && Object.hasOwn(rank,value), `Invalid permission policy: ${key}`);
  for (const key of Object.keys(policy.permissions)) assert.ok(Object.hasOwn(review.permissions,key), `Missing permission: ${key}`);
  for (const [key, value] of Object.entries(review.permissions)) {
    assert.ok(Object.hasOwn(rank,value) && Object.hasOwn(policy.permissions,key) && value === policy.permissions[key], `Excessive permission: ${key}`);
  }
  // This detects symlinks in the observed path only; concurrent replacement is out of scope.
  assert.ok(typeof dir === 'string' && dir.length > 0 && dir.length <= 4096, 'Invalid directory');
  const absolute = path.resolve(dir);
  let component = path.parse(absolute).root;
  for (const part of absolute.slice(component.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    const st = fs.lstatSync(component);
    assert.ok(!st.isSymbolicLink() && st.isDirectory(), 'Symlink or non-directory ancestor');
  }
  const expected = entries(manifest,names), checked = entries(review,names);
  for (const name of names) {
    const a = expected.get(name), b = checked.get(name);
    assert.ok(a.size === b.size && a.sha256 === b.sha256, `Conflicting review record: ${name}`);
    const fd = fs.openSync(path.join(dir,name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd, {bigint:true});
      assert.ok(before.isFile() && before.nlink === 1n && before.size === BigInt(a.size), `Invalid artifact: ${name}`);
      const hash = crypto.createHash('sha256'), buf = Buffer.alloc(1024 * 1024); let pos = 0, n;
      while (pos < a.size && (n = fs.readSync(fd,buf,0,Math.min(buf.length,a.size-pos),pos)) > 0) { hash.update(buf.subarray(0,n)); pos += n; }
      assert.equal(pos, a.size, `Artifact changed while reading: ${name}`);
      assert.equal(hash.digest('hex'),a.sha256, `SHA-256 mismatch: ${name}`);
      const after = fs.fstatSync(fd, {bigint:true});
      assert.ok(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k => before[k] === after[k]), `Artifact changed while reading: ${name}`);
    } finally { fs.closeSync(fd); }
  }
  return {status:'consistent-nonauthenticated-nonpublishing'};
}
module.exports = {validate, namesFor};
