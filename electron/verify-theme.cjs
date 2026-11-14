'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { bindNativeTheme } = require('./system-theme.cjs');
const fs = require('node:fs');

test('Electron main binds the native system theme and initializes its window background accordingly', () => {
  const main = fs.readFileSync(require.resolve('./main.cjs'), 'utf8');
  assert.match(main, /bindNativeTheme\(nativeTheme/);
  assert.match(main, /windowBackgroundColor\(nativeTheme\.shouldUseDarkColors\)/);
});

test('Electron window background follows the operating-system color scheme', () => {
  const theme = Object.assign(new EventEmitter(), { themeSource: 'dark', shouldUseDarkColors: true });
  const colors = [];
  const window = { setBackgroundColor: color => colors.push(color) };
  const dispose = bindNativeTheme(theme, () => window);

  assert.equal(theme.themeSource, 'system');
  assert.equal(colors.at(-1), '#090a0b');
  theme.shouldUseDarkColors = false;
  theme.emit('updated');
  assert.equal(colors.at(-1), '#f4f2ec');
  dispose();
  theme.shouldUseDarkColors = true;
  theme.emit('updated');
  assert.equal(colors.at(-1), '#f4f2ec');
});
