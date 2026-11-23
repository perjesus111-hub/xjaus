'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function artifactName(version, ext) {
  if (!['AppImage', 'rpm', 'deb'].includes(ext)) throw new Error(`Unsupported artifact: ${ext}`);
  const arch = ext === 'deb' ? 'amd64' : 'x86_64';
  return `XJAUS-${version}-${ext === 'AppImage' ? '' : 'linux-'}${arch}.${ext}`;
}
function linuxBuilderArgs() {
  return ['--linux', 'AppImage', 'rpm', 'deb', '--x64', '--publish', 'never',
    '-c.directories.output=release/linux', '-c.appImage.artifactName=XJAUS-${version}-${arch}.${ext}',
    '-c.toolsets.appimage=1.0.3'];
}
exports.artifactName = artifactName;
exports.linuxBuilderArgs = linuxBuilderArgs;

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
  if (process.env.XJAUS_IN_LINUX_BUILDER !== '1') {
    require('./linux-builder-container.cjs').runBaselineBuild(root);
  } else {
    fs.rmSync(path.join(root, 'release/linux/SHA256SUMS'), {force:true});
    run('npm', ['ci']);
    run('npm', ['test']);
    run('npm', ['run', 'build']);
    run('npm', ['run', 'electron:build-backend:linux']);
    run(process.execPath, ['-r', path.join(root, 'scripts/secure-appimage-preload.cjs'),
      '-r', path.join(root, 'scripts/fpm-desktop-mode-preload.cjs'),
      path.join(root, 'node_modules/electron-builder/cli.js'), ...linuxBuilderArgs()]);
    run(process.execPath, [path.join(root, 'scripts/linux-verify.cjs')]);
  }
}
