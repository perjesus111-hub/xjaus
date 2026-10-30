'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {run, namesFor} = require('./release-gate.cjs');
const names = namesFor('1.2.3');
const {extractAndVerifyLauncher: realVerifier} = require('./linux-verify.cjs');
const realImage = path.join(__dirname,'../release/linux',names[0]);
function realFixture(f) { fs.copyFileSync(realImage,path.join(f.dir,names[0])); f.sign(f.text()); }
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
  try {
    const dir = path.join(root,'candidates'); fs.mkdirSync(dir);
    for (const n of names) fs.writeFileSync(path.join(dir,n), `test ${n}`);
    const keys = crypto.generateKeyPairSync('ed25519');
    const f = {root,dir,out:path.join(root,'snapshot'),manifest:path.join(root,'manifest'),sig:path.join(root,'sig'),key:path.join(root,'key'),keys};
    fs.writeFileSync(f.key,keys.publicKey.export({type:'spki',format:'pem'}));
    f.sign = text => { fs.writeFileSync(f.manifest,text); fs.writeFileSync(f.sig,crypto.sign(null,Buffer.from(text),keys.privateKey)); };
    f.text = () => names.map(n => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex')}  ${n}`).join('\n')+'\n';
    f.sign(f.text());
    f.run = (verify=()=>{}) => run('1.2.3',dir,f.manifest,f.sig,f.key,f.out,verify);
    fn(f);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
test('publication entry points fail before any executable, consumer or snapshot side effect',()=>fixture(f=>{
  const {runLocal}=require('./release-gate.cjs');
  const bin=path.join(f.root,'bin'); fs.mkdirSync(bin);
  const marker=path.join(f.root,'executable-marker'), consumer=path.join(f.root,'consumer-marker');
  for (const name of ['7z','python3']) fs.writeFileSync(path.join(bin,name),`#!/bin/sh\n/bin/touch '${marker}'\n`,{mode:0o755});
  const old=process.env.PATH; process.env.PATH=bin+':'+old;
  const cp=require('node:child_process'), original=cp.spawnSync; let spawned=false;
  cp.spawnSync=(...args)=>{spawned=true; return original(...args);};
  try {
    assert.throws(()=>runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,()=>fs.writeFileSync(consumer,'called')),/publication disabled/i);
    assert.equal(spawned,false); assert.equal(fs.existsSync(marker),false); assert.equal(fs.existsSync(consumer),false); assert.equal(fs.existsSync(f.out),false);
  } finally { cp.spawnSync=original; process.env.PATH=old; }
  const r=spawnSync(process.execPath,[path.join(__dirname,'release-gate.cjs'),'1.2.3',f.dir,f.manifest,f.sig,f.key,f.out],{encoding:'utf8',env:{...process.env,PATH:bin+':'+old}});
  assert.notEqual(r.status,0); assert.match(r.stderr,/publication disabled/i); assert.equal(r.stdout,'');
  assert.equal(fs.existsSync(marker),false); assert.equal(fs.existsSync(consumer),false); assert.equal(fs.existsSync(f.out),false);
}));
test('accepts real Ed25519 signature and snapshots five signed candidates',()=>fixture(f=>{
  assert.equal(f.run(),f.text()); assert.equal(fs.readdirSync(f.out).length,5);
  for (const n of names) assert.equal(fs.statSync(path.join(f.out,n)).mode & 0o777,0o400);
}));
test('rejects missing signature',()=>fixture(f=>{ fs.unlinkSync(f.sig); assert.throws(()=>f.run(),/ENOENT/); assert.ok(!fs.existsSync(f.out)); }));
test('rejects wrong trusted key',()=>fixture(f=>{ fs.writeFileSync(f.key,crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})); assert.throws(()=>f.run(),/Invalid manifest signature/); }));
test('rejects changed signed manifest',()=>fixture(f=>{ fs.appendFileSync(f.manifest,'x'); assert.throws(()=>f.run(),/Invalid manifest signature/); }));
test('rejects modified signature',()=>fixture(f=>{ const s=fs.readFileSync(f.sig); s[0]^=1; fs.writeFileSync(f.sig,s); assert.throws(()=>f.run(),/Invalid manifest signature/); }));
test('rejects malformed but validly signed manifest',()=>fixture(f=>{ f.sign(f.text()+f.text().split('\n')[0]+'\n'); assert.throws(()=>f.run(),/duplicate/); }));
test('rejects signed manifest missing entry',()=>fixture(f=>{ f.sign(f.text().split('\n').slice(0,4).join('\n')); assert.throws(()=>f.run(),/five manifest/); }));
test('rejects extra candidate',()=>fixture(f=>{ fs.writeFileSync(path.join(f.dir,'extra.zsync'),'x'); assert.throws(()=>f.run(),/exactly five/); }));
test('rejects altered candidate hash',()=>fixture(f=>{ fs.writeFileSync(path.join(f.dir,names[1]),'tampered'); assert.throws(()=>f.run(),/Checksum mismatch/); }));
test('rejects symlink candidate',()=>fixture(f=>{ fs.unlinkSync(path.join(f.dir,names[1])); fs.symlinkSync(names[0],path.join(f.dir,names[1])); assert.throws(()=>f.run(),/ELOOP/); }));
test('rejects hardlinked candidate even when hashes match',()=>fixture(f=>{ fs.unlinkSync(path.join(f.dir,names[1])); fs.linkSync(path.join(f.dir,names[0]),path.join(f.dir,names[1])); f.sign(f.text()); assert.throws(()=>f.run(),/one link/); }));
test('rejects candidate mutation during AppRun check',()=>fixture(f=>{ assert.throws(()=>f.run(()=>fs.writeFileSync(path.join(f.dir,names[0]),'changed')),/File changed/); }));
test('rejects snapshot mutation during AppRun check',()=>fixture(f=>{ assert.throws(()=>f.run(()=>{ const p=path.join(f.out,names[0]); fs.chmodSync(p,0o600); fs.writeFileSync(p,'changed'); }),/File changed/); }));
test('rejects failed AppRun check',()=>fixture(f=>{ assert.throws(()=>f.run(()=>{throw new Error('bad AppRun');}),/bad AppRun/); }));
test('rejects nested snapshot',()=>fixture(f=>{ f.out=path.join(f.dir,'snapshot'); assert.throws(()=>run('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,()=>{}),/separate/); }));
test('rejects preexisting snapshot without deleting it',()=>fixture(f=>{ fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out,'keep'),'x'); assert.throws(()=>f.run(),/EEXIST/); assert.equal(fs.readFileSync(path.join(f.out,'keep'),'utf8'),'x'); }));
test('CLI rejects unsigned manifest and missing arguments',()=>fixture(f=>{
  fs.unlinkSync(f.sig);
  const cli=path.join(__dirname,'release-gate.cjs');
  const r=spawnSync(process.execPath,[cli,'1.2.3',f.dir,f.manifest,f.sig,f.key,f.out],{encoding:'utf8'});
  assert.equal(r.status,1); assert.match(r.stderr,/Release gate failed/); assert.equal(r.stdout,'');
  assert.equal(spawnSync(process.execPath,[cli],{encoding:'utf8'}).status,1);
}));

test.skip('local chain passes retained fs-verity descriptors to consumer',{skip: !fs.existsSync(realImage)},()=>fixture(f=>{
  realFixture(f);
  const {runLocal} = require('./release-gate.cjs');
  let seen = false;
  const result = runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier, fds => {
    seen = true; assert.equal(fds.length,5);
    for (let i=0;i<5;i++) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fds[i])).digest('hex'),f.text().split('\n')[i].slice(0,64));
  });
  assert.ok(seen); assert.equal(result,f.text());
}));

test.skip('local consumer inherits pinned descriptors despite path replacement',{skip: !fs.existsSync(realImage)},()=>fixture(f=>{
  realFixture(f);
  const {runLocal} = require('./release-gate.cjs');
  runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier, fds=>{
    const target=path.join(f.out,names[0]);
    assert.throws(()=>fs.writeFileSync(target,'tampered'));
    const replacement=path.join(f.root,'replacement'); fs.writeFileSync(replacement,'replacement'); fs.renameSync(replacement,target);
    const child=spawnSync(process.execPath,['-e',`const fs=require('fs'),c=require('crypto'); process.stdout.write(c.createHash('sha256').update(fs.readFileSync(3)).digest('hex'));`],{stdio:['ignore','pipe','pipe',fds[0]],encoding:'utf8'});
    assert.equal(child.status,0,child.stderr); assert.equal(child.stdout,f.text().slice(0,64));
    assert.equal(fs.readFileSync(target,'utf8'),'replacement');
  });
}));
test.skip('local chain fails closed when fs-verity helper is unavailable',()=>fixture(f=>{
  const {runLocal} = require('./release-gate.cjs'); let called=false;
  const cp=require('node:child_process'), original=cp.spawnSync;
  cp.spawnSync=()=>({error:new Error('helper unavailable'),status:null,stdout:'',stderr:''});
  try { assert.throws(()=>runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,()=>{called=true;}),/fs-verity enable\/measure failed.*helper unavailable/); assert.equal(called,false); }
  finally { cp.spawnSync=original; }
}));
test.skip('local chain rejects asynchronous consumers',{skip: !fs.existsSync(realImage)},()=>fixture(f=>{
  realFixture(f);
  const {runLocal} = require('./release-gate.cjs');
  assert.throws(()=>runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,()=>Promise.resolve()),/synchronous/);
}));

test.skip('local chain refuses a substituted AppRun verifier',()=>fixture(f=>{
  const {runLocal} = require('./release-gate.cjs'); let consumed=false;
  assert.throws(()=>runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,()=>{},()=>{consumed=true;}),/real AppRun verifier/);
  assert.equal(consumed,false);
}));

test.skip('real 7z uses pinned inode when AppImage path is swapped before listing', {skip: !fs.existsSync(realImage)},()=>fixture(f=>{
  realFixture(f);
  const {runLocal} = require('./release-gate.cjs');
  const bin=path.join(f.root,'bin'); fs.mkdirSync(bin);
  const replacement=path.join(f.root,'replacement'); fs.writeFileSync(replacement,'not an AppImage');
  const wrapper=path.join(bin,'7z');
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ -e "$SWAP_FROM" ]; then mv "$SWAP_FROM" "$SWAP_TO"; fi\nexec /usr/sbin/7z "$@"\n`,{mode:0o755});
  const previous={PATH:process.env.PATH,SWAP_FROM:process.env.SWAP_FROM,SWAP_TO:process.env.SWAP_TO};
  process.env.PATH=bin+':'+previous.PATH; process.env.SWAP_FROM=replacement; process.env.SWAP_TO=path.join(f.out,names[0]);
  try { let called=false; runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,fds=>{
    called=true; assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fds[0])).digest('hex'),f.text().slice(0,64));
    assert.equal(fs.readFileSync(process.env.SWAP_TO,'utf8'),'not an AppImage');
  }); assert.ok(called); } finally { for(const [k,v] of Object.entries(previous)) if(v===undefined) delete process.env[k]; else process.env[k]=v; }
}));

test('CLI refuses even valid signed inputs without a same-FD consumer',()=>fixture(f=>{
  const r=spawnSync(process.execPath,[path.join(__dirname,'release-gate.cjs'),'1.2.3',f.dir,f.manifest,f.sig,f.key,f.out],{encoding:'utf8'});
  assert.equal(r.status,1); assert.equal(r.stdout,''); assert.match(r.stderr,/publication disabled/i);
  assert.equal(fs.existsSync(f.out),false);
}));

test.skip('real 7z extraction retains inode when path swaps after listing', {skip: !fs.existsSync(realImage)},()=>fixture(f=>{
  realFixture(f); const {runLocal}=require('./release-gate.cjs');
  const bin=path.join(f.root,'bin'); fs.mkdirSync(bin); const marker=path.join(f.root,'marker');
  const replacement=path.join(f.root,'replacement'); fs.writeFileSync(replacement,'replacement');
  fs.writeFileSync(path.join(bin,'7z'),`#!/bin/sh\nif [ -e "$MARKER" ]; then mv "$SWAP_FROM" "$SWAP_TO"; else touch "$MARKER"; fi\nexec /usr/sbin/7z "$@"\n`,{mode:0o755});
  const previous={PATH:process.env.PATH,SWAP_FROM:process.env.SWAP_FROM,SWAP_TO:process.env.SWAP_TO,MARKER:process.env.MARKER};
  Object.assign(process.env,{PATH:bin+':'+previous.PATH,SWAP_FROM:replacement,SWAP_TO:path.join(f.out,names[0]),MARKER:marker});
  try { let called=false; runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,fds=>{
    called=true; assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fds[0])).digest('hex'),f.text().slice(0,64));
    assert.equal(fs.readFileSync(process.env.SWAP_TO,'utf8'),'replacement');
  }); assert.ok(called); } finally { for(const [k,v] of Object.entries(previous)) if(v===undefined) delete process.env[k]; else process.env[k]=v; }
}));

test.skip('local chain never consumes when real AppRun verification fails',()=>fixture(f=>{
  const {runLocal}=require('./release-gate.cjs'); let called=false;
  assert.throws(()=>runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,()=>{called=true;}),/7z AppRun listing failed/);
  assert.equal(called,false);
}));
test.skip('local chain never executes a python3 supplied via PATH',()=>fixture(f=>{
  const {runLocal}=require('./release-gate.cjs'); const bin=path.join(f.root,'bin'); fs.mkdirSync(bin);
  const marker=path.join(f.root,'executed');
  fs.writeFileSync(path.join(bin,'python3'),`#!/bin/sh\ntouch '${marker}'\nprintf '%064d\\n' 0\n`,{mode:0o755});
  const old=process.env.PATH; process.env.PATH=bin+':'+old;
  try { try { runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,()=>{}); } catch {} assert.equal(fs.existsSync(marker),false); }
  finally { process.env.PATH=old; }
}));
test.skip('fs-verity ioctl failure never falls back to pathname verification',()=>fixture(f=>{
  const {runLocal}=require('./release-gate.cjs'); let called=false;
  const cp=require('node:child_process'), original=cp.spawnSync;
  cp.spawnSync=()=>({status:1,stdout:'',stderr:'fs-verity unsupported'});
  try { assert.throws(()=>runLocal('1.2.3',f.dir,f.manifest,f.sig,f.key,f.out,realVerifier,()=>{called=true;}),/fs-verity enable\/measure failed.*unsupported/s); assert.equal(called,false); }
  finally { cp.spawnSync=original; }
}));
