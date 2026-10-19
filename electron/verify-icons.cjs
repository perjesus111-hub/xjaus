const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
require('./verify-identity.cjs');
test('window icon resolves from development and packaged app resources', () => {
  const { iconPath } = require('./icons.cjs');
  assert.equal(iconPath({ isPackaged: false, getAppPath: () => '/project' }), '/project/resources/icons/512x512.png');
  assert.equal(iconPath({ isPackaged: true, getAppPath: () => '/bundle/resources/app.asar' }), '/bundle/resources/app.asar/resources/icons/512x512.png');
  assert.ok(fs.existsSync(iconPath({ getAppPath: () => path.resolve(__dirname, '..') })));
});
