'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const sim = require('./release-simulation.cjs');
function fixture(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjaus-sim-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const artifacts = sim.names.map((name,i)=>{const data=Buffer.from(`synthetic ${i}`); fs.writeFileSync(path.join(dir,name),data); return {path:name,size_bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};});
 return {dir, manifest:{schema:'xjaus-local-candidate-v1',version:'1.2.3',build_commit:sim.commit,origin:'local',release_commit:null,signature:null,status:'unapproved',canonicalization:'UTF-8 JSON, sorted keys, compact separators, no trailing newline; ASCII escaped',artifacts}};
}
test('real schema and synthetic bytes pass; release commit is explicit',t=>{const f=fixture(t); assert.equal(sim.validate(f.manifest,f.dir).releaseCommit,'unassigned'); f.manifest.release_commit='a'.repeat(40); assert.equal(sim.validate(f.manifest,f.dir).releaseCommit,'a'.repeat(40)); delete f.manifest.release_commit; assert.throws(()=>sim.validate(f.manifest,f.dir),/release_commit/);});
test('bad or missing manifest, names, size, hash, origin and commit fail',t=>{const f=fixture(t); assert.throws(()=>sim.validate(null,f.dir),/manifest/i); for(const mutate of [m=>m.artifacts.pop(),m=>m.artifacts[0].path='../bad',m=>m.artifacts[0].size_bytes=0,m=>m.artifacts[0].sha256='0'.repeat(64),m=>m.origin='ci',m=>m.build_commit='b'.repeat(40)]) {const m=structuredClone(f.manifest); mutate(m); assert.throws(()=>sim.validate(m,f.dir));}});
test('synthetic PR claims require distinct head and merge; no event derivation',()=>{const head='a'.repeat(40),merge='b'.repeat(40); const claim={event:'pull_request',head,merge,expectedHead:head,approved:true,permissions:{contents:'read'},workflow:'validation'}; assert.equal(sim.simulate(claim).head,head); for(const change of [{expectedHead:merge},{approved:false},{permissions:{contents:'write'}},{workflow:'release'},{head:merge}]) assert.throws(()=>sim.simulate({...claim,...change}));});
test('local CLI fails on absent manifest without writing',t=>{const f=fixture(t); const p=spawnSync(process.execPath,[path.join(__dirname,'validate-local-candidate.cjs'),path.join(f.dir,'missing.json'),f.dir],{encoding:'utf8'}); assert.notEqual(p.status,0);});

test('CLI rejects a self-consistent substituted manifest',t=>{const f=fixture(t); const file=path.join(f.dir,'manifest.json'); fs.writeFileSync(file,JSON.stringify(f.manifest)); const p=spawnSync(process.execPath,[path.join(__dirname,'validate-local-candidate.cjs'),file,f.dir],{encoding:'utf8',timeout:3000}); assert.notEqual(p.status,0); assert.match(p.stderr,/manifest.*(digest|hash|sha256)/i);});
test('rejects unexpected schema fields',t=>{const f=fixture(t); f.manifest.extra=true; assert.throws(()=>sim.validate(f.manifest,f.dir),/field/i); delete f.manifest.extra; f.manifest.artifacts[0].extra=true; assert.throws(()=>sim.validate(f.manifest,f.dir),/field/i);});

test('CLI rejects oversized, symlink, and FIFO manifests without blocking',t=>{
 const f=fixture(t), cli=path.join(__dirname,'validate-local-candidate.cjs');
 const regular=path.join(f.dir,'large'); fs.writeFileSync(regular,Buffer.alloc(65537));
 const link=path.join(f.dir,'link'); fs.symlinkSync(regular,link);
 const fifo=path.join(f.dir,'fifo'); const mk=spawnSync('mkfifo',[fifo],{encoding:'utf8'}); assert.equal(mk.status,0,mk.stderr);
 for(const file of [regular,link,fifo]) {const p=spawnSync(process.execPath,[cli,file,f.dir],{encoding:'utf8',timeout:3000}); assert.ifError(p.error); assert.notEqual(p.status,0); assert.match(p.stderr,/Local validation failed/);}
});
