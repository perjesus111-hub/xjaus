const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
require('./verify-identity.cjs');
test('window icon resolves from development and packaged app resources', () => {
  const { iconPath } = require('./icons.cjs');
  const project = path.resolve('project');
  const packaged = path.resolve('bundle', 'resources', 'app.asar');
  assert.equal(iconPath({ isPackaged: false, getAppPath: () => project }), path.join(project, 'resources', 'icons', '512x512.png'));
  assert.equal(iconPath({ isPackaged: true, getAppPath: () => packaged }), path.join(packaged, 'resources', 'icons', '512x512.png'));
  assert.ok(fs.existsSync(iconPath({ getAppPath: () => path.resolve(__dirname, '..') })));
});
