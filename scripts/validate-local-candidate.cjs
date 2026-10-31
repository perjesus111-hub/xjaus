'use strict';
// Explicit local invocation only. Reads files; never publishes or modifies them.
const fs=require('node:fs'), crypto=require('node:crypto');
// Exact local candidate byte consistency only; this digest is not a trust root.
const EXPECTED_MANIFEST_SHA256='f58841e742f1cb78bb869b1498903339907f757f75b0fe6ec77b0dd432bdf724';
const MAX_MANIFEST_BYTES=64*1024;
function readManifest(file) {
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try {
  const before=fs.fstatSync(fd,{bigint:true});
  if (!before.isFile() || before.size>BigInt(MAX_MANIFEST_BYTES)) throw new Error('manifest must be a bounded regular file');
  const buf=Buffer.alloc(MAX_MANIFEST_BYTES+1); let total=0,n;
  while (total<buf.length && (n=fs.readSync(fd,buf,total,buf.length-total,total))>0) total+=n;
  const after=fs.fstatSync(fd,{bigint:true});
  if(total>MAX_MANIFEST_BYTES || BigInt(total)!==before.size || !['dev','ino','size','mtimeNs','ctimeNs'].every(k=>before[k]===after[k])) throw new Error('manifest changed or oversized');
  const bytes=buf.subarray(0,total);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==EXPECTED_MANIFEST_SHA256) throw new Error('manifest SHA256 mismatch');
  return JSON.parse(bytes.toString('utf8'));
 } finally { fs.closeSync(fd); }
}
const {validate}=require('./release-simulation.cjs');
try {
 if(process.argv.length!==4) throw new Error('Usage: node scripts/validate-local-candidate.cjs MANIFEST ARTIFACT_DIRECTORY');
 const manifest=readManifest(process.argv[2]);
 const result=validate(manifest,process.argv[3]);
 console.log(`Local file consistency verified; release_commit ${result.releaseCommit}. No provenance, signature, or approval verified.`);
} catch(e) { console.error(`Local validation failed: ${e.message}`); process.exitCode=1; }
