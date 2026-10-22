// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import html from '../index.html?raw';

const fixture = vi.hoisted(() => ({
  invoke: vi.fn((command: string) => {
    if (command === 'begin_login_window') return new Promise<never>(() => {});
    if (command === 'load_settings') return Promise.resolve({ resolution: '1920x1080', bitrate: 15000, codec: 'h264', audio: 'opus' });
    if (command === 'auth_status') return Promise.resolve({ authenticated: false, account: '', storage: '' });
    return Promise.resolve({});
  }),
}));
vi.mock('./backend', () => ({ invokeBackend: fixture.invoke, openExternalUrl: vi.fn(async () => {}), openMicrosoftVerificationUrl: vi.fn(async () => {}), copyToClipboard: vi.fn(async () => {}) }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('turns a stalled device-code request into a retryable error instead of spinning forever', async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  vi.stubGlobal('localStorage', storage);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));

  const { i18n } = await import('./i18n');
  i18n.setPreference('es');
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
  document.querySelector<HTMLButtonElement>('#btn-login')!.click();
  expect(document.querySelector<HTMLElement>('#login-feedback')!.textContent).toContain('Solicitando');

  await vi.advanceTimersByTimeAsync(25_000);

  const feedback = document.querySelector<HTMLElement>('#login-feedback')!;
  expect(feedback.textContent).not.toContain('Solicitando');
  expect(feedback.textContent).toContain('Microsoft');
  expect(feedback.querySelector('[data-login-action="retry"]')).not.toBeNull();
});
