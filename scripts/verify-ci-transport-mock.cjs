'use strict';

// Standalone simulation using synthetic bytes and a local mock copy only.
// This is not approval authentication, a real publisher, or an end-to-end gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function describeFile(file) {
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, sha256: digest(bytes) };
}

function simulateDelivery({ approved, source, destination, transport }) {
  if (approved !== true) throw new Error('synthetic approval required');
  // The expectation is fixed before transport, never derived from the receiver.
  const expected = describeFile(source);
  transport(source, destination);
  const received = describeFile(destination);
  if (received.size !== expected.size) throw new Error('received size mismatch');
  if (received.sha256 !== expected.sha256) throw new Error('received hash mismatch');
  return { expected, received };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-transport-simulation-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const destinationDir = path.join(root, 'destination');
  fs.mkdirSync(sourceDir, { mode: 0o700 });
  fs.mkdirSync(destinationDir, { mode: 0o700 });
  const source = path.join(sourceDir, 'synthetic.bin');
  const destination = path.join(destinationDir, 'synthetic.bin');
  fs.writeFileSync(source, Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]), { mode: 0o600 });
  return { source, destination };
}

function copy(source, destination) {
  fs.copyFileSync(source, destination);
}

test('mock copy verifies source size and hash at the receiver', (t) => {
  const { source, destination } = fixture(t);
  const before = describeFile(source);
  const result = simulateDelivery({ approved: true, source, destination, transport: copy });
  assert.deepEqual(result.expected, before);
  assert.deepEqual(result.received, before);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
});

test('same-size in-transit tampering is rejected by hash', (t) => {
  const { source, destination } = fixture(t);
  assert.throws(() => simulateDelivery({ approved: true, source, destination, transport: (src, dest) => {
    const bytes = fs.readFileSync(src);
    bytes[0] ^= 0xff;
    fs.writeFileSync(dest, bytes);
  } }), /received hash mismatch/);
});

test('replacement after copy is rejected by hash', (t) => {
  const { source, destination } = fixture(t);
  assert.throws(() => simulateDelivery({ approved: true, source, destination, transport: (src, dest) => {
    copy(src, dest);
    fs.unlinkSync(dest);
    fs.writeFileSync(dest, Buffer.alloc(8, 42));
  } }), /received hash mismatch/);
});

test('truncated transport is rejected by size', (t) => {
  const { source, destination } = fixture(t);
  assert.throws(() => simulateDelivery({ approved: true, source, destination, transport: (src, dest) => {
    fs.writeFileSync(dest, fs.readFileSync(src).subarray(0, 3));
  } }), /received size mismatch/);
});

test('missing synthetic approval fails before invoking transport', (t) => {
  const { source, destination } = fixture(t);
  let called = false;
  assert.throws(() => simulateDelivery({ source, destination, transport: () => { called = true; } }), /synthetic approval required/);
  assert.equal(called, false);
  assert.equal(fs.existsSync(destination), false);
});
