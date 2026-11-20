'use strict';
// Normalize just the FPM desktop input; do not relax the build's private umask.
const fs = require('node:fs');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const Module = require('node:module');
const target = require.resolve('app-builder-lib/out/targets/FpmTarget');
const source = fs.readFileSync(target, 'utf8');
const expected = 'e2dd925448d63f255bcd1d96da3a301cd73104fff4c54af8f29065e089f3076a';
const anchor = 'const desktopFilePath = await this.helper.writeDesktopEntry(this.options);';
if (require.cache[target] || require('app-builder-lib/package.json').version !== '26.15.3' ||
    crypto.createHash('sha256').update(source).digest('hex') !== expected || source.split(anchor).length !== 2) {
  throw new Error('Unsupported FPM target; review desktop mode normalization');
}
const original = Module._extensions['.js'];
Module._extensions['.js'] = (module, filename) => {
  if (filename !== target) return original(module, filename);
  module._compile(source.replace(anchor, `${anchor}\n        await (0, promises_1.chmod)(desktopFilePath, 0o644);`), filename);
};
try {
  createRequire(__filename)(target);
} finally {
  Module._extensions['.js'] = original;
}
