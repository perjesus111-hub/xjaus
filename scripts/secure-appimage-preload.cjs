'use strict';
// Build-time, version-pinned patch; never modifies installed dependencies.
const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');
const target = require.resolve('app-builder-lib/out/targets/appimage/appImageUtil');
const version = require('app-builder-lib/package.json').version;
const expected = '4d3b63afc9939ace718e0b3537e2b1508c15fde7fd030206cbe207bcb6a8f030';
const originalLoader = Module._extensions['.js'];
if (require.cache[target]) throw new Error('AppImage launcher was loaded before the secure patch');
let applied = false;
Module._extensions['.js'] = function (module, filename) {
  if (filename !== target) return originalLoader(module, filename);
  const source = fs.readFileSync(filename, 'utf8');
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  if (version !== '26.15.3' || digest !== expected) throw new Error('Unsupported app-builder-lib AppImage launcher; review the secure patch before building');
  const old = '  NO_SANDBOX=(--no-sandbox)';
  if (source.split(old).length !== 2) throw new Error('AppImage launcher patch did not match exactly once');
  const replacement = '  trap - EXIT\n  echo "XJAUS cannot verify Linux user namespaces for Electron sandboxing (unshare missing or failed); refusing to launch. Check your sandbox configuration." >&2\n  exit 1';
  const misleading = `#   - On minimal systems (e.g. Alpine or stripped-down containers) 'unshare' may not exist.\n#     In that case the shell will return exit code 127 ("command not found"), which will cause\n#     us to add '--no-sandbox'. This is an intentional fail-safe: we prefer the app to start\n#     without sandboxing rather than crash on startup.`;
  if (!source.includes(misleading)) throw new Error('AppImage launcher comments did not match');
  const explicit = '    HAVE_NO_SANDBOX=1\n    break';
  if (source.split(explicit).length !== 2) throw new Error('AppImage explicit sandbox patch did not match exactly once');
  applied = true;
  module._compile(source.replace(misleading, '# A missing or failing unshare probe refuses launch rather than disabling sandboxing.').replace(old, replacement).replace(explicit, '    trap - EXIT\n    echo "XJAUS refuses --no-sandbox." >&2\n    exit 1'), filename);
};

try {
  require(target);
  if (!applied) throw new Error('AppImage launcher secure patch was not applied');
} finally {
  Module._extensions['.js'] = originalLoader;
}
