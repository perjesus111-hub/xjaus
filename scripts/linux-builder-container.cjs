'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASE_IMAGE = 'node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0';
const RUST_VERSION = '1.96.0';
const BUILDER_IMAGE = `xjaus-linux-builder:node24-trixie-rust${RUST_VERSION}`;

function dockerBuildArgs(projectRoot) {
  const scripts = path.join(projectRoot, 'scripts');
  return ['build', '--pull', '--build-arg', `BASE_IMAGE=${BASE_IMAGE}`, '--build-arg', `RUST_VERSION=${RUST_VERSION}`,
    '--tag', BUILDER_IMAGE, '--file', path.join(scripts, 'linux-builder.Dockerfile'), scripts];
}
function dockerRunArgs(projectRoot, uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000) {
  return ['run', '--rm', '--user', `${uid}:${gid}`,
    '--env', 'XJAUS_IN_LINUX_BUILDER=1', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
    '--env', 'CARGO_HOME=/tmp/.cargo', '--env', 'RUSTUP_HOME=/opt/rustup',
    '--mount', `type=bind,src=${projectRoot},dst=/workspace`, '--workdir', '/workspace',
    BUILDER_IMAGE, 'node', 'scripts/packaging.cjs'];
}
function runDocker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed with status ${result.status}`);
}
function runBaselineBuild(projectRoot) {
  runDocker(dockerBuildArgs(projectRoot));
  runDocker(dockerRunArgs(projectRoot));
}

module.exports = { BASE_IMAGE, BUILDER_IMAGE, RUST_VERSION, dockerBuildArgs, dockerRunArgs, runBaselineBuild };
