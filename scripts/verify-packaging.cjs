'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { artifactName, linuxBuilderArgs } = require('./packaging.cjs');

test('AppImage has no redundant linux segment, while distro names stay unchanged', () => {
  assert.equal(artifactName('1.2.3', 'AppImage'), 'XJAUS-1.2.3-x86_64.AppImage');
  assert.equal(artifactName('1.2.3', 'rpm'), 'XJAUS-1.2.3-linux-x86_64.rpm');
  assert.equal(artifactName('1.2.3', 'deb'), 'XJAUS-1.2.3-linux-amd64.deb');
});

test('builder gets AppImage-specific naming override and publishing stays disabled', () => {
  const args = linuxBuilderArgs();
  assert.ok(args.includes('--publish') && args[args.indexOf('--publish') + 1] === 'never');
  assert.ok(args.includes('-c.appImage.artifactName=XJAUS-${version}-${arch}.${ext}'));
});
