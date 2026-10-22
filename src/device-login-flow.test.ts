// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeviceLoginFlow,
  DEFAULT_VERIFICATION_URI,
  isAllowedMicrosoftVerificationUri,
  type DeviceLoginApi,
  type DeviceLoginStart,
  type DeviceLoginStatus,
  type DeviceLoginState,
} from './device-login-flow';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const startResponse: DeviceLoginStart = {
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://microsoft.com/devicelogin',
  expires_in: 60,
  interval: 1,
};
const authenticated: DeviceLoginStatus = { authenticated: true, account: 'account', storage: 'vault' };
const options = { beginTimeoutMs: 1000, pollTimeoutMs: 500, cancelTimeoutMs: 100, minPollIntervalMs: 50, maxPollIntervalMs: 5000, slowDownIncrementMs: 50 };

function makeFlow(overrides: Partial<DeviceLoginApi> = {}, config = options) {
  const states: DeviceLoginState[] = [];
  const api: DeviceLoginApi = {
    begin: vi.fn(async () => startResponse),
    poll: vi.fn(async () => authenticated),
    cancel: vi.fn(async () => {}),
    ...overrides,
  };
  const flow = createDeviceLoginFlow(api, state => states.push(state), config);
  return { api, flow, states };
}

describe('device-code login state machine', () => {
  it('shows a valid code and reaches authorized after one successful poll', async () => {
    vi.useFakeTimers();
    const { api, flow, states } = makeFlow();
    await flow.start();
    expect(states[states.length - 1]).toMatchObject({ kind: 'code-available', userCode: 'ABCD-EFGH' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.poll).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toMatchObject({ kind: 'authorized', status: authenticated });
  });

  it('binds every login request to one unique attempt id', async () => {
    vi.useFakeTimers();
    const ids = ['attempt-fixture-1', 'attempt-fixture-2'];
    vi.stubGlobal('crypto', { randomUUID: () => ids.shift()! });
    let resolvePoll!: (value: DeviceLoginStatus) => void;
    const { api, flow } = makeFlow({ poll: vi.fn(() => new Promise<DeviceLoginStatus>(resolve => { resolvePoll = resolve; })) });
    await flow.start();
    expect(api.begin).toHaveBeenCalledWith('attempt-fixture-1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.poll).toHaveBeenCalledWith('attempt-fixture-1');
    await flow.cancel();
    expect(api.cancel).toHaveBeenCalledWith('attempt-fixture-1');
    resolvePoll(authenticated);
    await vi.advanceTimersByTimeAsync(0);
    await flow.retry();
    expect(api.begin).toHaveBeenNthCalledWith(2, 'attempt-fixture-2');
    flow.dispose();
  });

  it('recovers from a slow but finite device-code response', async () => {
    vi.useFakeTimers();
    let resolveStart!: (value: DeviceLoginStart) => void;
    const { flow, states } = makeFlow({ begin: () => new Promise(resolve => { resolveStart = resolve; }) });
    const request = flow.start();
    expect(states[states.length - 1]?.kind).toBe('requesting');
    resolveStart(startResponse);
    await request;
    expect(states[states.length - 1]?.kind).toBe('code-available');
  });

  it('turns a disconnected/hung start request into a retryable timeout', async () => {
    vi.useFakeTimers();
    const { flow, states } = makeFlow({ begin: () => new Promise<never>(() => {}) });
    const request = flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    await request;
    expect(states[states.length - 1]).toEqual({ kind: 'error', stage: 'begin', reason: 'timeout' });
  });

  it('uses Microsoft’s documented verification URI if the response omits one', async () => {
    vi.useFakeTimers();
    const { flow, states } = makeFlow({ begin: async () => ({ ...startResponse, verification_uri: undefined }) });
    await flow.start();
    expect(states[states.length - 1]).toMatchObject({ kind: 'code-available', verificationUri: DEFAULT_VERIFICATION_URI });
  });

  it('rejects an invalid payload and never exposes it as a code', async () => {
    vi.useFakeTimers();
    const { flow, states } = makeFlow({ begin: async () => ({ ...startResponse, user_code: '', verification_uri: 'https://evil.invalid/devicelogin' }) });
    await flow.start();
    expect(states[states.length - 1]).toEqual({ kind: 'error', stage: 'begin', reason: 'invalid-response' });
  });

  it('rejects a malformed code rather than silently changing the provider value', async () => {
    vi.useFakeTimers();
    const { flow, states } = makeFlow({ begin: async () => ({ ...startResponse, user_code: ' ABCD-EFGH ' }) });
    await flow.start();
    expect(states[states.length - 1]).toEqual({ kind: 'error', stage: 'begin', reason: 'invalid-response' });
  });

  it('keeps provider polling sequential and honors authorization_pending', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockRejectedValueOnce(new Error('authorization_pending')).mockResolvedValueOnce(authenticated);
    const { api, flow, states } = makeFlow({ poll });
    await flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.poll).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]?.kind).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.poll).toHaveBeenCalledTimes(2);
    expect(states[states.length - 1]?.kind).toBe('authorized');
  });

  it('honors the provider interval even when it exceeds the local slowdown cap', async () => {
    vi.useFakeTimers();
    const { api, flow } = makeFlow({ begin: async () => ({ ...startResponse, expires_in: 180, interval: 90 }) });
    await flow.start();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(api.poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.poll).toHaveBeenCalledTimes(1);
  });

  it('increases the polling interval by five seconds after slow_down', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockRejectedValueOnce(new Error('slow_down')).mockResolvedValueOnce(authenticated);
    const { api, flow } = makeFlow({ poll });
    await flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1049);
    expect(api.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.poll).toHaveBeenCalledTimes(2);
  });

  it('stops polling on denial and expiration', async () => {
    vi.useFakeTimers();
    const deniedPoll = vi.fn(async () => { throw new Error('authorization_declined'); });
    const denied = makeFlow({ poll: deniedPoll });
    await denied.flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(denied.states[denied.states.length - 1]?.kind).toBe('denied');
    expect(deniedPoll).toHaveBeenCalledTimes(1);

    const expired = makeFlow({ begin: async () => ({ ...startResponse, expires_in: 1 }) });
    await expired.flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(expired.states[expired.states.length - 1]?.kind).toBe('expired');
    expect(expired.api.poll).not.toHaveBeenCalled();
  });

  it('cancels immediately and ignores a late response', async () => {
    vi.useFakeTimers();
    let resolveStart!: (value: DeviceLoginStart) => void;
    const { api, flow, states } = makeFlow({ begin: () => new Promise(resolve => { resolveStart = resolve; }) });
    const request = flow.start();
    await flow.cancel();
    resolveStart(startResponse);
    await request;
    expect(states[states.length - 1]?.kind).toBe('cancelled');
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it('reports backend cancellation failure and keeps the attempt retryable', async () => {
    const { api, flow } = makeFlow({ cancel: vi.fn(async () => { throw new Error('cancel unavailable'); }) });
    await flow.start();
    await flow.cancel();
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual({ kind: 'error', stage: 'cancel', reason: 'recoverable' });
  });

  it('sends backend cancellation when disposed during a pending begin and ignores the late response', async () => {
    vi.useFakeTimers();
    let resolveStart!: (value: DeviceLoginStart) => void;
    const { api, flow, states } = makeFlow({ begin: () => new Promise(resolve => { resolveStart = resolve; }) });
    const request = flow.start();
    flow.dispose();
    expect(api.cancel).toHaveBeenCalledTimes(1);
    resolveStart(startResponse);
    await request;
    expect(states.some(state => state.kind === 'code-available' || state.kind === 'waiting')).toBe(false);
  });

  it('sends backend cancellation when disposed during a pending poll and ignores late authorization', async () => {
    vi.useFakeTimers();
    let resolvePoll!: (value: DeviceLoginStatus) => void;
    const poll = vi.fn(() => new Promise<DeviceLoginStatus>(resolve => { resolvePoll = resolve; }));
    const { api, flow, states } = makeFlow({ poll });
    await flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.poll).toHaveBeenCalledTimes(1);
    flow.dispose();
    expect(api.cancel).toHaveBeenCalledTimes(1);
    resolvePoll(authenticated);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.some(state => state.kind === 'authorized')).toBe(false);
  });

  it('times out a poll request without leaving the UI in a waiting state', async () => {
    vi.useFakeTimers();
    const { api, flow, states } = makeFlow({ poll: () => new Promise<never>(() => {}) });
    await flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(500);
    expect(states[states.length - 1]).toEqual({ kind: 'error', stage: 'poll', reason: 'timeout' });
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it('validates verification URLs before any external-open action can use them', () => {
    expect(isAllowedMicrosoftVerificationUri('https://microsoft.com/devicelogin')).toBe(true);
    expect(isAllowedMicrosoftVerificationUri('https://www.microsoft.com/link')).toBe(true);
    for (const value of [
      'http://microsoft.com/devicelogin',
      'https://microsoft.com.evil.invalid/devicelogin',
      'https://evil.invalid/devicelogin',
      'https://user@microsoft.com/devicelogin',
      'https://microsoft.com:443/devicelogin',
      'https://microsoft.com/devicelogin?code=secret',
      'https://microsoft.com/devicelogin#fragment',
      'https://microsoft.com/other',
    ]) expect(isAllowedMicrosoftVerificationUri(value)).toBe(false);
  });
});
