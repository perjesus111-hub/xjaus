'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {validate, namesFor} = require('./ci-candidate-manifest.cjs');

test('accepts five independently pinned synthetic candidates', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const names = namesFor('1.2.3');
  const artifacts = names.map((name, i) => {
    const bytes = Buffer.from(`synthetic ${i}`); fs.writeFileSync(path.join(dir,name),bytes);
    return {name, size:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  });
  const manifest = {schema:1, version:'1.2.3', commit:'a'.repeat(40), origin:'local', artifacts};
  const review = {schema:1, status:'recorded-nonauthenticated-nonpublishing', version:manifest.version, commit:manifest.commit, origin:manifest.origin, artifacts:structuredClone(artifacts), ref:'refs/heads/main', permissions:{contents:'read'}};
  const policy = {version:manifest.version, commit:manifest.commit, origin:'local', allowedRefs:['refs/heads/main'], permissions:{contents:'read'}};
  assert.equal(validate({dir, manifest, review, policy}).status,'consistent-nonauthenticated-nonpublishing');
});


test('rejects tampering and invalid policy or records', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-negative-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const artifacts = namesFor('1.2.3').map(name => {
    const bytes = Buffer.from(name); fs.writeFileSync(path.join(dir,name),bytes);
    return {name, size:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  });
  const manifest = {schema:1, version:'1.2.3', commit:'a'.repeat(40), origin:'ci', artifacts};
  const review = {schema:1, status:'recorded-nonauthenticated-nonpublishing', version:manifest.version, commit:manifest.commit, origin:manifest.origin, artifacts:structuredClone(artifacts), ref:'refs/heads/main', permissions:{contents:'read'}};
  const policy = {version:manifest.version, commit:manifest.commit, origin:'ci', allowedRefs:['refs/heads/main'], permissions:{contents:'read'}};
  const run = (m=manifest,r=review,p=policy) => validate({dir,manifest:m,review:r,policy:p});
  assert.throws(() => run(manifest,{...review,status:'pending'}), /Invalid record status/);
  assert.throws(() => run(manifest,{...review,ref:'refs/heads/evil'}), /Ref not allowed/);
  assert.throws(() => run(manifest,{...review,permissions:{contents:'write'}}), /Excessive permission/);
  assert.throws(() => run(manifest,{...review,permissions:{contents:'read',actions:'read'}}), /Excessive permission/);
  assert.throws(() => run(manifest,{...review,permissions:{}}), /Missing permission/);
  assert.throws(() => run(manifest,{...review,commit:'b'.repeat(40)}), /conflicts/);
  const conflict = structuredClone(review); conflict.artifacts[0].sha256 = 'f'.repeat(64);
  assert.throws(() => run(manifest,conflict), /Conflicting review/);
  assert.throws(() => run({...manifest,artifacts:manifest.artifacts.slice(1)}), /five artifacts/);
  assert.throws(() => run(manifest,review,{...policy,commit:'abc'}), /full commit/);
  const file = path.join(dir,artifacts[0].name);
  const original = fs.readFileSync(file); fs.writeFileSync(file,Buffer.alloc(original.length,1));
  assert.throws(() => run(), /SHA-256 mismatch/);
  fs.unlinkSync(file);
  assert.throws(() => run(), /ENOENT/);
  fs.symlinkSync(path.join(dir,artifacts[1].name),file);
  assert.throws(() => run(), /ELOOP/);
});

 test('rejects an empty permission policy', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-empty-policy-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const artifacts = namesFor('1.2.3').map(name => { const data = Buffer.from(name); fs.writeFileSync(path.join(dir,name),data); return {name,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')}; });
  const common = {schema:1,version:'1.2.3',commit:'a'.repeat(40),origin:'local',artifacts};
  assert.throws(() => validate({dir,manifest:common,review:{...common,status:'recorded-nonauthenticated-nonpublishing',ref:'refs/heads/main',permissions:{}},policy:{version:common.version,commit:common.commit,origin:common.origin,allowedRefs:['refs/heads/main'],permissions:{}}}), /permissions policy/);
});


test('rejects malformed metadata, non-exact claims, and unsafe filesystem entries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-boundary-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const dir = path.join(root,'files'); fs.mkdirSync(dir);
  const artifacts = namesFor('1.2.3').map(name => { const data = Buffer.from(name); fs.writeFileSync(path.join(dir,name),data); return {name,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')}; });
  const manifest = {schema:1,version:'1.2.3',commit:'a'.repeat(40),origin:'local',artifacts};
  const review = {...manifest,artifacts:structuredClone(artifacts),status:'recorded-nonauthenticated-nonpublishing',ref:'refs/heads/main',permissions:{contents:'read'}};
  const policy = {version:manifest.version,commit:manifest.commit,origin:'local',allowedRefs:['refs/heads/main'],permissions:{contents:'read'}};
  const run = (m=manifest,r=review,p=policy,d=dir) => validate({dir:d,manifest:m,review:r,policy:p});
  assert.throws(() => run(manifest,null), /required/);
  assert.throws(() => run(manifest,{...review,permissions:{contents:'none'}}), /permission/);
  assert.throws(() => run(manifest,review,{...policy,allowedRefs:[]}), /refs/);
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, '1']) {
    const m = structuredClone(manifest); m.artifacts[0].size = size; assert.throws(() => run(m), /size/);
  }
  for (const hash of [null, 'A'.repeat(64), 'a'.repeat(63)]) {
    const m = structuredClone(manifest); m.artifacts[0].sha256 = hash; assert.throws(() => run(m), /SHA-256/);
  }
  for (const name of [artifacts[1].name, '../unexpected']) {
    const m = structuredClone(manifest); m.artifacts[0].name = name; assert.throws(() => run(m), /duplicate artifact/);
  }
  const link = path.join(root,'link'); fs.symlinkSync(dir,link);
  assert.throws(() => run(manifest,review,policy,link), /Symlink/);
  const file = path.join(dir,artifacts[0].name), backup = path.join(root,'backup');
  fs.linkSync(file,backup); assert.throws(() => run(), /Invalid artifact/); fs.unlinkSync(backup);
  fs.unlinkSync(file); fs.mkdirSync(file); assert.throws(() => run(), /Invalid artifact/);
});
