'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {build} = require('../package.json');

// Source contracts only: never run AppRun, package hooks or a release CLI.
for (const format of ['deb', 'rpm']) {
  for (const phase of ['afterInstall', 'afterRemove']) {
    test(`source-only ${format}.${phase} overrides the default with an inert script`, () => {
      const configured = build[format][phase];
      assert.ok(configured);
      const source = readFileSync(path.resolve(__dirname, '..', configured), 'utf8');
      assert.match(source, /^#!\/bin\/sh\n(?:#[\x20-\x7e]*\n)*exit 0\n(?![\s\S])/);
    });
  }
}

test('source-only AppRun contains refusal paths for explicit and unavailable sandboxing', () => {
  require('./secure-appimage-preload.cjs');
  const {generateAppRunScript} = require('app-builder-lib/out/targets/appimage/appImageUtil');
  const {verifyLauncher} = require('./linux-verify.cjs');
  const launcher = generateAppRunScript({DesktopFileName:'io.github.xjaus.xjaus.desktop', ExecutableName:'xjaus', ProductName:'XJAUS', ProductFilename:'XJAUS', ResourceName:'appimagekit-xjaus'});
  verifyLauncher(launcher);
  assert.match(launcher, /echo "XJAUS refuses --no-sandbox\." >&2\n\s+exit 1/);
  assert.match(launcher, /echo "XJAUS cannot verify Linux user namespaces[^\n]+\n\s+exit 1/);
});
