// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import html from '../index.html?raw';

const fixture = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./backend', () => ({
  invokeBackend: fixture.invoke,
  openExternalUrl: vi.fn(async () => {}),
  openMicrosoftVerificationUrl: vi.fn(async () => {}),
  copyToClipboard: vi.fn(async () => {}),
}));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('does not let a stale startup auth_status hide a completed interactive login', async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  vi.stubGlobal('localStorage', storage);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));

  let resolveStartupStatus!: (value: { authenticated: boolean; account: string; storage: string }) => void;
  const startupStatus = new Promise<{ authenticated: boolean; account: string; storage: string }>(resolve => { resolveStartupStatus = resolve; });
  fixture.invoke.mockImplementation((command: string) => {
    if (command === 'load_settings') return Promise.resolve({ resolution: '1920x1080', bitrate: 15000, codec: 'h264', audio: 'opus' });
    if (command === 'auth_status') return startupStatus;
    if (command === 'begin_login_window') return Promise.resolve({ user_code: 'SYNTHETIC-CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 60, interval: 1 });
    if (command === 'poll_login') return Promise.resolve({ authenticated: true, account: 'synthetic-account', storage: 'test' });
    if (command === 'cancel_login') return Promise.resolve();
    return Promise.resolve({});
  });

  const { i18n } = await import('./i18n');
  i18n.setPreference('es');
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
  document.querySelector<HTMLButtonElement>('#btn-login')!.click();
  await vi.advanceTimersByTimeAsync(5_250);
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);

  resolveStartupStatus({ authenticated: false, account: '', storage: '' });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);
  expect(document.querySelector<HTMLElement>('#login-screen')!.hidden).toBe(true);
});

it('does not load a saved session after backend cancellation fails', async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  vi.stubGlobal('localStorage', storage);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  fixture.invoke.mockImplementation((command: string) => {
    if (command === 'load_settings') return Promise.resolve({ resolution: '1920x1080', bitrate: 15000, codec: 'h264', audio: 'opus' });
    if (command === 'auth_status') return Promise.resolve({ authenticated: false, account: '', storage: '' });
    if (command === 'begin_login_window') return Promise.resolve({ user_code: 'SYNTHETIC-CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 60, interval: 1 });
    if (command === 'cancel_login') return Promise.reject(new Error('cancel unavailable'));
    if (command === 'load_session') return Promise.resolve({ authenticated: true, account: 'synthetic-account', storage: 'test' });
    return Promise.resolve({});
  });

  const { i18n } = await import('./i18n');
  i18n.setPreference('es');
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
  document.querySelector<HTMLButtonElement>('#btn-login')!.click();
  await vi.advanceTimersByTimeAsync(0);
  document.querySelector<HTMLButtonElement>('#manual-login')!.click();
  await vi.advanceTimersByTimeAsync(0);

  expect(fixture.invoke.mock.calls.some(([command]) => command === 'load_session')).toBe(false);
  expect(document.querySelector<HTMLElement>('#login-screen')!.hidden).toBe(false);
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(true);
});
