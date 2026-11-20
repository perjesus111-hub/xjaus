// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { invokeBackend } from './backend';

afterEach(() => { delete window.xjaus; });
describe('stream IPC ownership', () => {
  it.each(['wake_console', 'start_stream', 'provision_stream', 'submit_stream_offer', 'poll_stream_answer', 'exchange_stream_ice', 'stream_keepalive', 'stop_stream', 'cancel_connection'])('%s rejects absent or empty owner before IPC', async command => {
    const invoke = vi.fn(async () => undefined);
    window.xjaus = { invoke, openExternal: vi.fn(), openMicrosoftVerification: vi.fn(), copyText: vi.fn() } as any;
    await expect(invokeBackend(command)).rejects.toThrow(/attempt/i);
    await expect(invokeBackend(command, { attemptId: '' })).rejects.toThrow(/attempt/i);
    await expect(invokeBackend(command, { attemptId: 'owner' })).rejects.toThrow(/generation/i);
    await expect(invokeBackend(command, { attemptId: 'owner', generation: '' })).rejects.toThrow(/generation/i);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('requests generation from backend without providing one', async () => {
    const invoke = vi.fn(async () => 'server-generation');
    window.xjaus = { invoke, openExternal: vi.fn(), openMicrosoftVerification: vi.fn(), copyText: vi.fn() } as any;
    await expect(invokeBackend('begin_connection', {attemptId:'owner'})).resolves.toBe('server-generation');
    expect(invoke).toHaveBeenCalledWith('begin_connection', {attemptId:'owner'});
  });
  it('forwards the exact owner', async () => {
    const invoke = vi.fn(async () => undefined);
    window.xjaus = { invoke, openExternal: vi.fn(), openMicrosoftVerification: vi.fn(), copyText: vi.fn() } as any;
    await invokeBackend('stop_stream', { attemptId: 'fixture-owner', generation: 'fixture-generation' });
    expect(invoke).toHaveBeenCalledWith('stop_stream', { attemptId: 'fixture-owner', generation: 'fixture-generation' });
  });
});
