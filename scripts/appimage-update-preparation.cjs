'use strict';
function validateUpdateUrl(value, capacity) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.AppImage.zsync')) throw new Error('Expected an HTTP(S) direct AppImage.zsync URL without credentials, query or fragment');
  const info = `zsync|${value}`;
  if (Buffer.byteLength(info) >= capacity) throw new Error('Update information exceeds section capacity');
  return info;
}
function validateArtifactName(name, updateUrl) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.AppImage$/.test(name) || Buffer.byteLength(name + '.zsync') > 255 || new URL(updateUrl).pathname.split('/').pop() !== name + '.zsync') throw new Error('Unsafe artifact name or update URL mismatch');
  return name;
}
function verifyZsync(zsync, image, name) {
  const end = zsync.indexOf('\n\n');
  if (end < 0) throw new Error('Invalid zsync header');
  const fields = new Map();
  for (const line of zsync.subarray(0, end).toString('utf8').split('\n')) {
    const i = line.indexOf(': ');
    if (i < 0 || fields.has(line.slice(0, i))) throw new Error('Invalid zsync field');
    fields.set(line.slice(0, i), line.slice(i + 2));
  }
  const hash = require('node:crypto').createHash('sha1').update(image).digest('hex');
  if (fields.get('Filename') !== name || fields.get('URL') !== name || fields.get('Length') !== String(image.length) || fields.get('SHA-1') !== hash) throw new Error('zsync metadata does not match artifact');
}
function validateGithubUpdateInfo(owner, repo, tag, asset, capacity) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9_.-]+$/.test(tag) || !/^[A-Za-z0-9_.\-*]+\.AppImage\.zsync$/.test(asset)) throw new Error('Invalid GitHub release update information');
  const info = `gh-releases-zsync|${owner}|${repo}|${tag}|${asset}`;
  if (Buffer.byteLength(info) >= capacity) throw new Error('Update information exceeds section capacity');
  return info;
}
module.exports = { validateUpdateUrl, validateArtifactName, verifyZsync, validateGithubUpdateInfo };
