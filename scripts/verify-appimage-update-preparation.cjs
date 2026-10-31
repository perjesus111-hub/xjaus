'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateUpdateUrl, validateArtifactName, verifyZsync } = require('./appimage-update-preparation.cjs');
test('rejects mismatched zsync integrity metadata', () => {
  const data = Buffer.from('payload');
  const crypto = require('node:crypto');
  const digest = crypto.createHash('sha1').update(data).digest('hex');
  const header = Buffer.from(`zsync: 0.6.2\nFilename: XJAUS.AppImage\nLength: 7\nURL: XJAUS.AppImage\nSHA-1: ${digest}\n\n`);
  assert.doesNotThrow(() => verifyZsync(header, data, 'XJAUS.AppImage'));
  assert.throws(() => verifyZsync(header, Buffer.from('corrupt'), 'XJAUS.AppImage'));
  assert.throws(() => verifyZsync(header, data, 'other.AppImage'));
});
test('artifact name is safe and matches the update URL', () => {
  assert.equal(validateArtifactName('XJAUS.AppImage', 'https://example.org/XJAUS.AppImage.zsync'), 'XJAUS.AppImage');
  for (const name of ['../XJAUS.AppImage', 'other.AppImage', 'a'.repeat(255) + '.AppImage']) assert.throws(() => validateArtifactName(name, 'https://example.org/XJAUS.AppImage.zsync'));
});
test('validates direct zsync URL and embedded section limit', () => {
  assert.equal(validateUpdateUrl('https://example.org/XJAUS.AppImage.zsync', 1024), 'zsync|https://example.org/XJAUS.AppImage.zsync');
  assert.throws(() => validateUpdateUrl('https://example.org/x.AppImage', 1024));
  assert.throws(() => validateUpdateUrl('https://example.org/' + 'a'.repeat(1024) + '.AppImage.zsync', 1024));
  assert.throws(() => validateUpdateUrl('https://user:secret@example.org/x.AppImage.zsync', 1024));
  assert.throws(() => validateUpdateUrl('file:///tmp/x.AppImage.zsync', 1024));
});

test("validates GitHub release update information", () => {
  const { validateGithubUpdateInfo } = require("./appimage-update-preparation.cjs");
  assert.equal(validateGithubUpdateInfo("perjesus111-hub", "xjaus", "latest", "XJAUS-*-x86_64.AppImage.zsync", 1024), "gh-releases-zsync|perjesus111-hub|xjaus|latest|XJAUS-*-x86_64.AppImage.zsync");
  assert.throws(() => validateGithubUpdateInfo("evil|x", "repo", "latest", "x.AppImage.zsync", 1024));
});

test("preparer rejects an unverified tool before creating output", () => {
 const { spawnSync } = require("node:child_process"); const os = require("node:os"); const fs = require("node:fs"); const path = require("node:path"); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-test-"));
 try { const r = spawnSync(process.execPath, [path.join(__dirname, "prepare-appimage-update.cjs"), "input", __filename, path.join(dir, "out"), "0".repeat(64)], {encoding:"utf8"}); assert.match(r.stderr, /tool SHA256 mismatch/); assert.equal(fs.existsSync(path.join(dir,"out")), false); } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('requires explicit expected input SHA256', () => {
 const {spawnSync} = require('node:child_process');
 const r = spawnSync(process.execPath, [require('node:path').join(__dirname,'prepare-appimage-update.cjs'), 'input', 'tool', 'output'], {encoding:'utf8'});
 assert.match(r.stderr, /expected.*SHA256/i);
});


test('preparer returns a private staging directory under explicit output parent', {skip: !process.env.XJAUS_TEST_IMAGE || !process.env.XJAUS_TEST_TOOL}, () => {
 const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
 const {spawnSync} = require('node:child_process');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-test-'));
 try {
  const image = process.env.XJAUS_TEST_IMAGE, tool = process.env.XJAUS_TEST_TOOL;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'prepare-appimage-update.cjs'), image, tool, dir, digest], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(path.dirname(path.dirname(result.candidate)), dir);
  assert.equal(fs.statSync(path.dirname(result.candidate)).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(result.zsync));
 } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});


test('rejects nonzero signature and digest sections, wrong hash, and unsafe output parent', {skip: !process.env.XJAUS_TEST_IMAGE || !process.env.XJAUS_TEST_TOOL}, () => {
 const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-test-'));
 const run = (image, output, digest) => cp.spawnSync(process.execPath, [path.join(__dirname, 'prepare-appimage-update.cjs'), image, process.env.XJAUS_TEST_TOOL, output, digest], {encoding:'utf8'});
 const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
 try {
  const bytes = fs.readFileSync(process.env.XJAUS_TEST_IMAGE), image = path.join(dir, path.basename(process.env.XJAUS_TEST_IMAGE));
  fs.writeFileSync(image, bytes);
  assert.match(run(image, dir, '0'.repeat(64)).stderr, /input SHA256 mismatch/);
  const unsafe = path.join(dir, 'unsafe'); fs.mkdirSync(unsafe, {mode:0o755});
  assert.match(run(image, unsafe, digest(bytes)).stderr, /private directory/);
  const sections = cp.execFileSync('readelf', ['-SW', image], {encoding:'utf8'});
  for (const name of ['.digest_md5', '.sha256_sig']) {
   const line = sections.split('\n').find(l => l.includes(name));
   const match = line.match(/\]\s+\S+\s+\S+\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)/);
   const modified = Buffer.from(bytes); modified[parseInt(match[1], 16)] = 1; fs.writeFileSync(image, modified);
   assert.match(run(image, dir, digest(modified)).stderr, /Signed or digested/);
  }
 } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('readelf uses verified snapshot when input pathname is replaced', {skip: !process.env.XJAUS_TEST_IMAGE || !process.env.XJAUS_TEST_TOOL}, () => {
 const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-test-'));
 try {
  const image = path.join(dir, path.basename(process.env.XJAUS_TEST_IMAGE)); fs.copyFileSync(process.env.XJAUS_TEST_IMAGE, image);
  const bytes = fs.readFileSync(image), digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); const script = path.join(bin, 'readelf');
  fs.writeFileSync(script, '#!/bin/sh\nprintf replacement > "$TEST_INPUT"\nexec /usr/bin/readelf "$@"\n', {mode:0o700});
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'prepare-appimage-update.cjs'), image, process.env.XJAUS_TEST_TOOL, dir, digest], {encoding:'utf8', env:{...process.env, PATH:bin+':'+process.env.PATH, TEST_INPUT:image}});
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(image,'utf8'), 'replacement');
  assert.equal(fs.statSync(JSON.parse(r.stdout).candidate).size, bytes.length);
 } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
