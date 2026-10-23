export const DEFAULT_VERIFICATION_URI = 'https://microsoft.com/devicelogin';

export type DeviceLoginStart = {
  user_code: string;
  verification_uri?: string | null;
  expires_in: number;
  interval?: number;
};

export type DeviceLoginStatus = {
  authenticated: boolean;
  account: string;
  storage: string;
  catalogAccountScope?: string;
};

export type DeviceLoginState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'code-available'; userCode: string; verificationUri: string }
  | { kind: 'waiting'; userCode: string; verificationUri: string }
  | { kind: 'authorized'; status: DeviceLoginStatus }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'error'; stage: 'begin' | 'poll' | 'cancel'; reason: 'timeout' | 'invalid-response' | 'recoverable' };

export type DeviceLoginApi = {
  begin(attemptId: string): Promise<DeviceLoginStart>;
  poll(attemptId: string): Promise<DeviceLoginStatus>;
  cancel(attemptId: string): Promise<void>;
};

export type DeviceLoginOptions = {
  beginTimeoutMs?: number;
  pollTimeoutMs?: number;
  cancelTimeoutMs?: number;
  minPollIntervalMs?: number;
  maxPollIntervalMs?: number;
  slowDownIncrementMs?: number;
  now?: () => number;
};

export function isAllowedMicrosoftVerificationUri(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return value === url.href
      && url.protocol === 'https:'
      && ['microsoft.com', 'www.microsoft.com'].includes(url.hostname.toLowerCase())
      && !url.username && !url.password && !url.port
      && ['/devicelogin', '/link'].includes(url.pathname.toLowerCase())
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export class DeviceLoginTimeout extends Error {
  constructor() {
    super('Device login request timed out');
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeviceLoginTimeout()), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateStart(value: unknown): Required<Pick<DeviceLoginStart, 'user_code' | 'expires_in' | 'interval'>> & { verification_uri: string } {
  if (!value || typeof value !== 'object') throw new TypeError('invalid device-code response');
  const candidate = value as Partial<DeviceLoginStart>;
  const userCode = typeof candidate.user_code === 'string' ? candidate.user_code : '';
  if (!userCode || userCode.trim() !== userCode || userCode.length > 64) throw new TypeError('invalid device-code response');
  if (!Number.isSafeInteger(candidate.expires_in) || (candidate.expires_in ?? 0) <= 0 || (candidate.expires_in ?? 0) > 3600) {
    throw new TypeError('invalid device-code response');
  }
  const interval = candidate.interval === undefined ? 5 : candidate.interval;
  if (!Number.isSafeInteger(interval) || interval <= 0 || interval > 3600) throw new TypeError('invalid device-code response');
  const verificationUri = candidate.verification_uri == null || candidate.verification_uri === ''
    ? DEFAULT_VERIFICATION_URI
    : candidate.verification_uri;
  if (!isAllowedMicrosoftVerificationUri(verificationUri)) throw new TypeError('invalid device-code response');
  return { user_code: userCode, verification_uri: verificationUri, expires_in: candidate.expires_in!, interval };
}

function classifyError(error: unknown): 'expired' | 'denied' | 'waiting' | 'slow-down' | 'timeout' | 'invalid-response' | 'recoverable' {
  const message = errorMessage(error);
  if (error instanceof DeviceLoginTimeout || (error instanceof Error && error.name === 'TimeoutError') || /device_code_timeout|timed out|timeout/i.test(message)) return 'timeout';
  if (/invalid.*response|invalid_device_code_response|invalid_verification_uri/i.test(message)) return 'invalid-response';
  if (/expired_token|authorization_expired|device code expired/i.test(message)) return 'expired';
  if (/access_denied|authorization_declined|authorization_denied/i.test(message)) return 'denied';
  if (/authorization_pending|waiting for user/i.test(message)) return 'waiting';
  if (/slow_down/i.test(message)) return 'slow-down';
  return 'recoverable';
}

export function createDeviceLoginFlow(
  api: DeviceLoginApi,
  onState: (state: DeviceLoginState) => void,
  options: DeviceLoginOptions = {},
) {
  const beginTimeoutMs = options.beginTimeoutMs ?? 25_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 100_000;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 10_000;
  const minPollIntervalMs = options.minPollIntervalMs ?? 5_000;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 3_600_000;
  const slowDownIncrementMs = options.slowDownIncrementMs ?? 5_000;
  const now = options.now ?? Date.now;
  let state: DeviceLoginState = { kind: 'idle' };
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let current: ReturnType<typeof validateStart> | undefined;
  let currentAttemptId: string | undefined;
  let expiresAt = 0;
  let intervalMs = minPollIntervalMs;

  const emit = (next: DeviceLoginState) => { state = next; onState(next); };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const safeCancel = async (attemptId: string) => {
    await withTimeout(api.cancel(attemptId), cancelTimeoutMs);
    if (currentAttemptId === attemptId) currentAttemptId = undefined;
  };
  const cancelQuietly = (attempt: number, attemptId: string) => {
    void safeCancel(attemptId).catch(() => {
      if (!disposed && attempt === generation && currentAttemptId === attemptId) {
        emit({ kind: 'error', stage: 'cancel', reason: 'recoverable' });
      }
    });
  };

  const schedulePoll = (attempt: number, attemptId: string) => {
    if (!current || currentAttemptId !== attemptId || disposed || attempt !== generation) return;
    const remaining = expiresAt - now();
    if (remaining <= 0) {
      current = undefined;
      emit({ kind: 'expired' });
      cancelQuietly(attempt, attemptId);
      return;
    }
    timer = setTimeout(() => { void poll(attempt, attemptId); }, Math.min(intervalMs, remaining));
  };

  const poll = async (attempt: number, attemptId: string): Promise<void> => {
    if (!current || currentAttemptId !== attemptId || disposed || attempt !== generation) return;
    if (now() >= expiresAt) {
      current = undefined;
      emit({ kind: 'expired' });
      cancelQuietly(attempt, attemptId);
      return;
    }
    emit({ kind: 'waiting', userCode: current.user_code, verificationUri: current.verification_uri });
    try {
      const status = await withTimeout(api.poll(attemptId), pollTimeoutMs);
      if (disposed || attempt !== generation || currentAttemptId !== attemptId) return;
      if (now() >= expiresAt) {
        current = undefined;
        emit({ kind: 'expired' });
        cancelQuietly(attempt, attemptId);
      } else if (status?.authenticated === true) {
        current = undefined;
        currentAttemptId = undefined;
        emit({ kind: 'authorized', status });
      } else {
        current = undefined;
        emit({ kind: 'error', stage: 'poll', reason: 'recoverable' });
        cancelQuietly(attempt, attemptId);
      }
    } catch (error) {
      if (disposed || attempt !== generation || currentAttemptId !== attemptId) return;
      const classification = classifyError(error);
      if (classification === 'waiting') {
        schedulePoll(attempt, attemptId);
      } else if (classification === 'slow-down') {
        intervalMs = Math.min(maxPollIntervalMs, intervalMs + slowDownIncrementMs);
        schedulePoll(attempt, attemptId);
      } else if (classification === 'expired') {
        current = undefined;
        emit({ kind: 'expired' });
        cancelQuietly(attempt, attemptId);
      } else if (classification === 'denied') {
        current = undefined;
        emit({ kind: 'denied' });
        cancelQuietly(attempt, attemptId);
      } else {
        current = undefined;
        emit({ kind: 'error', stage: 'poll', reason: classification === 'timeout' ? 'timeout' : classification === 'invalid-response' ? 'invalid-response' : 'recoverable' });
        cancelQuietly(attempt, attemptId);
      }
    }
  };

  const start = async (): Promise<void> => {
    if (disposed || currentAttemptId !== undefined || ['requesting', 'code-available', 'waiting', 'authorized'].includes(state.kind)) return;
    const attempt = ++generation;
    const attemptId = crypto.randomUUID();
    currentAttemptId = attemptId;
    clearTimer();
    current = undefined;
    emit({ kind: 'requesting' });
    try {
      const result = validateStart(await withTimeout(api.begin(attemptId), beginTimeoutMs));
      if (disposed || attempt !== generation || currentAttemptId !== attemptId) return;
      current = result;
      expiresAt = now() + result.expires_in * 1000;
      intervalMs = Math.max(minPollIntervalMs, result.interval * 1000);
      emit({ kind: 'code-available', userCode: result.user_code, verificationUri: result.verification_uri });
      schedulePoll(attempt, attemptId);
    } catch (error) {
      if (disposed || attempt !== generation || currentAttemptId !== attemptId) return;
      const classification = classifyError(error);
      emit({ kind: 'error', stage: 'begin', reason: error instanceof TypeError || classification === 'invalid-response' ? 'invalid-response' : classification === 'timeout' ? 'timeout' : 'recoverable' });
      cancelQuietly(attempt, attemptId);
    }
  };

  const retry = async (): Promise<void> => {
    if (disposed || state.kind !== 'error' && state.kind !== 'expired' && state.kind !== 'denied' && state.kind !== 'cancelled') return;
    const attempt = ++generation;
    const previousAttemptId = currentAttemptId;
    clearTimer();
    current = undefined;
    if (previousAttemptId) {
      try {
        await safeCancel(previousAttemptId);
      } catch {
        if (!disposed && attempt === generation) emit({ kind: 'error', stage: 'cancel', reason: 'recoverable' });
        return;
      }
    }
    if (!disposed && attempt === generation) await start();
  };

  const cancel = async (): Promise<boolean> => {
    if (disposed) return false;
    if (state.kind === 'cancelled') return true;
    const attemptId = currentAttemptId;
    generation++;
    clearTimer();
    current = undefined;
    emit({ kind: 'cancelled' });
    if (!attemptId) return true;
    try {
      await safeCancel(attemptId);
      return true;
    } catch {
      if (!disposed) emit({ kind: 'error', stage: 'cancel', reason: 'recoverable' });
      return false;
    }
  };

  const dispose = (): void => {
    const attemptId = currentAttemptId;
    disposed = true;
    generation++;
    clearTimer();
    current = undefined;
    currentAttemptId = undefined;
    if (attemptId) void safeCancel(attemptId).catch(() => {});
  };

  return { start, retry, cancel, dispose, get state() { return state; } };
}
