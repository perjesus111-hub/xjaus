const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
function harness(timers = { setTimeout, clearTimeout }) {
  const source = fs.readFileSync(require.resolve('./main.cjs'), 'utf8');
  const handlers = {};
  const stdin = new EventEmitter();
  stdin.writable = true; stdin.writes = []; stdin.block = false;
  stdin.write = function (s, cb) { this.writes.push(s); this.callbacks.push(cb); return !this.block; };
  stdin.callbacks = [];
  stdin.end = () => { stdin.ended = true; };
  const backend = Object.assign(new EventEmitter(), { stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kill(signal) { this.signal = signal; } });
  const events = new EventEmitter();
  const outcomes = [];
  const context = { Buffer, Map, Date, Error, JSON, Object, Array, String, ...timers,
    console: { info: (...args) => outcomes.push(args), warn: (...args) => outcomes.push(args) },
    app: { on: events.on.bind(events), quit: () => events.emit('before-quit', { preventDefault() {} }) },
    disposeNativeTheme() {}, backendPath: 'mock-sidecar', spawn: () => backend,
    window: {}, sequence: 0, pending: new Map(), authIpcTimeouts: new Map([['poll_login', 90_000]]),
    logAuthIpc() {}, authorize: () => true, allowedCommand: () => true,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
  const start = source.indexOf('// IPC admission control');
  const actualStart = start < 0 ? source.indexOf("ipcMain.handle('xjaus:invoke'") : start;
  const end = source.indexOf("ipcMain.handle('xjaus:fullscreen'", actualStart);
  vm.runInNewContext(source.slice(source.indexOf('let stdoutBuffer'), source.indexOf('const pending =')) +
    source.slice(source.indexOf('function stopPending'), source.indexOf('function authorize')) +
    source.slice(actualStart, end) + '\nstartBackend();', context);
  vm.runInNewContext(source.slice(source.indexOf("app.on('before-quit'")), context);
  return { invoke: (cmd, args) => handlers['xjaus:invoke']({}, cmd, args), stdin, context, backend, outcomes,
    quit: () => { let prevented = false; events.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; } };
}
test('rejects UTF-8 request above backend byte limit', () => {
  const h = harness();
  assert.throws(() => h.invoke('save_settings', { text: 'é'.repeat(1_000_000) }), /demasiado grande/);
  assert.equal(h.stdin.writes.length, 0);
});

test('backpressure rejects ordinary requests and reserves logout until drain', async () => {
  const h = harness(); h.stdin.block = true;
  const first = h.invoke('load_settings'); first.catch(() => {});
  assert.throws(() => h.invoke('load_settings'), /saturad/i);
  const logout = h.invoke('logout'); logout.catch(() => {});
  assert.equal(h.stdin.writes.length, 1);
  assert.throws(() => h.invoke('logout'), /saturad/i);
  h.stdin.block = false; h.stdin.emit('drain');
  assert.equal(JSON.parse(h.stdin.writes[1]).cmd, 'logout');
  for (const item of h.context.pending.values()) item.reject(new Error('cleanup'));
  await Promise.allSettled([first, logout]);
});

test('pending count is bounded and logout has a reserved slot', async () => {
  const h = harness(); const calls = [];
  for (let i = 0; i < 64; i++) calls.push(h.invoke('load_settings'));
  assert.throws(() => h.invoke('load_settings'), /saturad/i);
  calls.push(h.invoke('logout'));
  assert.equal(h.stdin.writes.length, 65);
  for (const item of h.context.pending.values()) item.resolve(null);
  await Promise.all(calls);
  const again = h.invoke('load_settings');
  h.context.pending.values().next().value.resolve(null); await again;
});
test('pending byte budget is released on completion', async () => {
  const h = harness(); const payload = { text: 'x'.repeat(1_400_000) };
  const a = h.invoke('save_settings', payload); const b = h.invoke('save_settings', payload);
  assert.throws(() => h.invoke('save_settings', payload), /saturad/i);
  h.context.pending.values().next().value.resolve(null); await a;
  const c = h.invoke('save_settings', payload);
  for (const item of h.context.pending.values()) item.resolve(null);
  await Promise.all([b, c]);
});
test('logout waiting for drain times out and is never written later', async () => {
  const timers = [];
  const h = harness({ setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.cleared = true; } });
  h.stdin.block = true;
  const first = h.invoke('load_settings');
  const logout = h.invoke('logout');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 20000);
  timers[0].fn();
  await assert.rejects(logout, /timed out before being sent/i);
  assert.equal(h.context.pending.size, 1);
  h.stdin.block = false; h.stdin.emit('drain');
  assert.equal(h.stdin.writes.length, 1);
  h.context.pending.values().next().value.resolve(null); await first;
});
test('logout timeout after write reports unknown backend outcome', async () => {
  let timer;
  const h = harness({ setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => {} });
  const logout = h.invoke('logout');
  assert.equal(h.stdin.writes.length, 1);
  timer();
  await assert.rejects(logout, /outcome is unknown/i);
  assert.equal(h.context.pending.size, 0);
});
test('write callback failure releases admission capacity', async () => {
  const h = harness(); const promise = h.invoke('load_settings');
  h.stdin.callbacks[0](new Error('broken'));
  await assert.rejects(promise, /write failed/);
  assert.equal(h.context.pending.size, 0);
});

test('quit drains reserved logout before EOF and refuses new IPC', async () => {
  const h = harness(); h.stdin.block = true;
  const stop = h.invoke('stop_stream');
  const logout = h.invoke('logout');
  assert.equal(h.quit(), true);
  assert.equal(h.quit(), true);
  assert.equal(h.stdin.ended, undefined);
  assert.throws(() => h.invoke('load_settings'), /cerrando/);
  h.stdin.block = false; h.stdin.emit('drain');
  assert.equal(JSON.parse(h.stdin.writes[1]).cmd, 'logout');
  assert.equal(h.stdin.ended, true);
  for (const line of h.stdin.writes) {
    h.backend.stdout.emit('data', Buffer.from(JSON.stringify({ id: JSON.parse(line).id, result: null }) + '\n'));
  }
  await Promise.all([stop, logout]);
  h.backend.stdout.emit('data', Buffer.from('{"shutdown":"drained"}\n'));
  h.backend.emit('close', 0, null);
  assert.equal(h.backend.signal, undefined);
  assert.equal(h.outcomes[0][1].status, 'drained');
  assert.equal(h.quit(), false);
});

test('quit deadline forces termination and reports unknown outcome once', () => {
  const timers = [];
  const h = harness({ setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; }, clearTimeout() {} });
  assert.equal(h.quit(), true);
  assert.equal(h.stdin.ended, true);
  assert.equal(h.backend.signal, undefined);
  assert.equal(timers[0].ms, 9_000);
  timers[0].fn();
  h.backend.emit('close', null, 'SIGKILL');
  assert.equal(h.backend.signal, 'SIGKILL');
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.outcomes[0][1].status, 'timeout_unknown');
});

test('clean exit without a shutdown result is not evidence of cleanup', () => {
  const h = harness();
  assert.equal(h.quit(), true);
  h.backend.emit('close', 0, null);
  assert.equal(h.outcomes[0][1].status, 'child_closed_unknown');
});

for (const [label, fail] of [
  ['stdin error during quit', h => { h.quit(); h.stdin.emit('error', new Error('mock failure')); }],
  ['child error', h => h.backend.emit('error', new Error('mock failure'))],
  ['write callback failure', h => h.stdin.callbacks[0](new Error('mock failure'))],
  ['synchronous write failure', h => { h.stdin.write = () => { throw new Error('mock failure'); }; }],
  ['request timeout', (_h, timers) => timers.find(t => t.ms === 90_000).fn()],
]) {
  test(`clean close plus drained cannot hide ${label}`, async () => {
    const timers = [];
    const h = harness({ setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout() {} });
    if (label === 'synchronous write failure') fail(h);
    const request = h.invoke('poll_login');
    if (label !== 'synchronous write failure') fail(h, timers);
    await assert.rejects(request, /write failed|failed to start|timed out/);
    assert.equal(h.context.pending.size, 0);
    assert.equal(h.quit(), true);
    h.backend.stdout.emit('data', Buffer.from('{"id":1,"result":null}\n{"shutdown":"drained"}\n'));
    h.backend.emit('close', 0, null);
    assert.deepEqual(h.outcomes.map(([, result]) => result.status), ['ipc_incomplete']);
  });
}

test('logout that expires without being written prevents drained', async () => {
  const timers = [];
  const h = harness({ setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; }, clearTimeout() {} });
  h.stdin.block = true;
  const first = h.invoke('load_settings');
  const logout = h.invoke('logout');
  timers.find(t => t.ms === 20_000).fn();
  await assert.rejects(logout, /before being sent/);
  assert.equal(h.quit(), true);
  h.backend.stdout.emit('data', Buffer.from('{"id":1,"result":true}\n{"shutdown":"drained"}\n'));
  assert.equal(await first, true);
  assert.equal(h.stdin.writes.length, 1);
  h.backend.emit('close', 0, null);
  assert.deepEqual(h.outcomes.map(([, result]) => result.status), ['ipc_incomplete']);
});

test('synchronous EOF delivery failure prevents drained without throwing from quit', () => {
  const h = harness();
  h.stdin.end = () => { throw new Error('mock EOF failure'); };
  assert.equal(h.quit(), true);
  h.backend.stdout.emit('data', Buffer.from('{"shutdown":"drained"}\n'));
  h.backend.emit('close', 0, null);
  assert.deepEqual(h.outcomes.map(([, result]) => result.status), ['ipc_incomplete']);
});
