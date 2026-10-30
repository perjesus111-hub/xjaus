#!/usr/bin/env node
'use strict';
// EXPERIMENTAL ONLY: output is unsigned and unauthenticated; do not publish or
// distribute it until a trusted publisher-signature policy is implemented.
// Pinned official AppImage/appimagetool continuous x86_64 asset, independently verified.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateGithubUpdateInfo, verifyZsync } = require('./appimage-update-preparation.cjs');
const PIN = '793fca0ce4bcc309dc65d3f66669f58e3755643e4dadbe03932e7b436128494f';
const sha = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex');
function main() {
  const [input, tool, output, expectedSha256, ...extra] = process.argv.slice(2);
  if (!input || !tool || !output || extra.length || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw new Error('Expected input SHA256 as fourth argument (64 lowercase hex characters)');
  const toolBytes = fs.readFileSync(tool);
  if (sha('sha256', toolBytes) !== PIN) throw new Error('tool SHA256 mismatch');
  const name = path.basename(input);
  if (!/^XJAUS-[A-Za-z0-9._-]+-x86_64\.AppImage$/.test(name)) throw new Error('Unexpected artifact name');
  const dest = path.resolve(output);
  const parent = fs.realpathSync(dest);
  const parentStat = fs.statSync(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077)) throw new Error('Output must be a user-owned private directory (mode 0700 or stricter)');
  for (let dir = parent;; dir = path.dirname(dir)) {
    const st = fs.statSync(dir);
    if ((st.uid !== 0 && st.uid !== process.getuid()) || ((st.mode & 0o022) && !(st.mode & 0o1000))) throw new Error('Unsafe output directory ancestor');
    if (dir === path.dirname(dir)) break;
  }
  const fd = fs.openSync(input, 'r');
  let image, inputStat;
  try { inputStat = fs.fstatSync(fd); if (!inputStat.isFile()) throw new Error('Input must be a regular file'); image = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  if (sha('sha256', image) !== expectedSha256) throw new Error('input SHA256 mismatch');
  if (image.subarray(0, 4).toString('hex') !== '7f454c46' || image.subarray(8, 11).toString('hex') !== '414902') throw new Error('Not a type 2 AppImage');
  const stage = fs.mkdtempSync(path.join(parent, '.xjaus-update-'));
  const snapshot = path.join(stage, 'input.snapshot');
  fs.writeFileSync(snapshot, image, {mode:0o600, flag:'wx'});
  const sections = execFileSync('readelf', ['-SW', snapshot], {encoding:'utf8'});
  function section(name) {
    const lines = sections.split('\n').filter(l => new RegExp('\\s' + name.replace('.', '\\.') + '\\s').test(l));
    if (lines.length !== 1) throw new Error(`Expected one ${name} section`);
    const m = lines[0].match(/\]\s+\S+\s+\S+\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)/);
    if (!m) throw new Error('Cannot parse ELF section');
    const offset = parseInt(m[1],16), size = parseInt(m[2],16);
    if (!size || offset + size > image.length) throw new Error('Invalid section bounds');
    return {offset,size};
  }
  const upd = section('.upd_info'), sig = section('.sha256_sig'), md5 = section('.digest_md5');
  for (const section of [sig, md5]) if (image.subarray(section.offset, section.offset + section.size).some(x => x !== 0)) throw new Error('Signed or digested AppImage cannot be modified safely');
  fs.unlinkSync(snapshot);
  const info = validateGithubUpdateInfo('perjesus111-hub', 'xjaus', 'latest', 'XJAUS-*-x86_64.AppImage.zsync', upd.size);
  image.fill(0, upd.offset, upd.offset + upd.size); image.write(info, upd.offset, 'utf8');
  const tmp = fs.mkdtempSync(path.join(stage, '.tool-'));
  try {
    const localTool = path.join(tmp, 'tool.AppImage');
    fs.writeFileSync(localTool, toolBytes, {mode:0o700});
    execFileSync(localTool, ['--appimage-extract'], {cwd:tmp, stdio:'ignore'});
    const zsyncmake = path.join(tmp, 'squashfs-root/usr/bin/zsyncmake');
    const candidate = path.join(stage, name);
    fs.writeFileSync(candidate, image, {mode: inputStat.mode & 0o777, flag:'wx'});
    const zfile = candidate + '.zsync';
    execFileSync(zsyncmake, ['-u', name, '-o', zfile, candidate], {cwd:stage, stdio:'pipe'});
    const z = fs.readFileSync(zfile); verifyZsync(z, image, name);
    // Recompute the entire control file, including binary block checksums.
    const check = path.join(stage, 'check.zsync');
    execFileSync(zsyncmake, ['-u', name, '-o', check, candidate], {cwd:stage, stdio:'pipe'});
    if (!z.equals(fs.readFileSync(check))) throw new Error('zsync block checksum verification failed');
    fs.unlinkSync(check);
    const digest = sha('sha256', image);
    fs.writeFileSync(candidate + '.sha256', `${digest}  ${name}\n`, {flag:'wx'});
    console.log(JSON.stringify({stage, candidate, zsync:zfile, sha256File:candidate+'.sha256', sha256:digest, updateInfo:info, section:upd, toolSha256:PIN}, null, 2));
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
