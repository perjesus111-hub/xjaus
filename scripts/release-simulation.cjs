'use strict';
// Read-only consistency checks, not provenance, authorization, or a release gate.
// Run only on a trusted, quiescent local filesystem; checks are not race-proof.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const commit='80529c750da5a6bf684391333d5f4e49c574fbee';
const names=['XJAUS-1.2.3-linux-amd64.deb','XJAUS-1.2.3-linux-x86_64.rpm','XJAUS-1.2.3-win-x64-setup.exe','XJAUS-1.2.3-win-x64-setup.msi','XJAUS-1.2.3-x86_64.AppImage'];
const sha40=x=>typeof x==='string' && /^[0-9a-f]{40}$/.test(x);
function exactFields(obj, fields) { assert.ok(obj && typeof obj==='object' && !Array.isArray(obj), 'invalid object fields'); assert.deepEqual(Object.keys(obj).sort(), [...fields].sort(), 'unexpected or missing fields'); }
function validate(m,dir) {
 assert.ok(m && typeof m==='object' && !Array.isArray(m),'manifest required');
 exactFields(m,['schema','version','build_commit','origin','release_commit','status','signature','canonicalization','artifacts']);
 assert.equal(m.schema,'xjaus-local-candidate-v1'); assert.equal(m.version,'1.2.3'); assert.equal(m.build_commit,commit); assert.equal(m.origin,'local');
 assert.ok(Object.hasOwn(m,'release_commit') && (m.release_commit===null || sha40(m.release_commit)),'invalid release_commit');
 assert.equal(m.status,'unapproved'); assert.equal(m.signature,null);
 assert.equal(m.canonicalization,'UTF-8 JSON, sorted keys, compact separators, no trailing newline; ASCII escaped');
 assert.ok(Array.isArray(m.artifacts) && m.artifacts.length===5,'five artifacts required');
 const seen=new Set();
 for(const a of m.artifacts) {
  exactFields(a,['path','size_bytes','sha256']);
  assert.ok(a && names.includes(a.path) && !seen.has(a.path),'invalid artifact path'); seen.add(a.path);
  assert.ok(Number.isSafeInteger(a.size_bytes) && a.size_bytes>0,'invalid size'); assert.equal(typeof a.sha256,'string','invalid hash'); assert.match(a.sha256,/^[0-9a-f]{64}$/,'invalid hash');
  const fd=fs.openSync(path.join(dir,a.path),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {const before=fs.fstatSync(fd,{bigint:true}); assert.ok(before.isFile() && before.size===BigInt(a.size_bytes),'artifact size/type mismatch'); const h=crypto.createHash('sha256'), buf=Buffer.alloc(1024*1024); let pos=0,n; while((n=fs.readSync(fd,buf,0,buf.length,pos))>0){h.update(buf.subarray(0,n));pos+=n;} assert.equal(h.digest('hex'),a.sha256,'hash mismatch'); const after=fs.fstatSync(fd,{bigint:true}); assert.ok(['dev','ino','size','mtimeNs','ctimeNs'].every(k=>before[k]===after[k]),'file changed');} finally {fs.closeSync(fd);}
 }
 return {releaseCommit:m.release_commit===null?'unassigned':m.release_commit};
}
// All inputs below are invented claims. No GitHub token or effective permissions examined.
function simulate(c) {
 assert.equal(c.event,'pull_request','mock event'); assert.ok(sha40(c.head)&&sha40(c.merge)&&c.head!==c.merge,'mock PR head/merge'); assert.equal(c.head,c.expectedHead,'mock head mismatch'); assert.equal(c.approved,true,'mock approval'); assert.deepEqual(c.permissions,{contents:'read'},'mock permissions'); assert.equal(c.workflow,'validation','mock workflow'); return {head:c.head,merge:c.merge};
}
module.exports={validate,simulate,names,commit};
