'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (process.platform !== 'linux') throw new Error('Linux sidecar must be built on Linux');
// Rust panic messages embed the absolute build-time path; remap the maintainer's
// home directory out of every published binary.
const remapFlags = ['--remap-path-prefix=' + os.homedir() + '=/build'];
if (process.env.RUSTFLAGS) remapFlags.unshift(process.env.RUSTFLAGS);
// Keep the frontend in dist/ and installer output in release/linux/.
const result = spawnSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'xjaus_backend', '--release', '--locked', '-j', '8'], { cwd: root, stdio: 'inherit', env: { ...process.env, RUSTFLAGS: remapFlags.join(' ') } });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const binary = path.join(root, 'src-tauri/target/release/xjaus_backend');
const header = fs.readFileSync(binary).subarray(0, 20);
if (header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 || header.readUInt16LE(18) !== 62) throw new Error('Expected a Linux x86-64 ELF sidecar');
const binaryText = fs.readFileSync(binary);
// The Xbox endpoint list contains a literal "/home" path fragment, so assert the
// maintainer's home prefix rather than a bare "/home/".
if (binaryText.includes(Buffer.from(path.join(os.homedir(), '/')))) throw new Error('Sidecar leaks a build-time home path');
fs.chmodSync(binary, 0o755);
console.log('Linux release sidecar verified: ELF x86-64, mode 0755, no home path leaks');
