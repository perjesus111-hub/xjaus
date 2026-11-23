// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import html from '../index.html?raw';
const backend = vi.hoisted(() => vi.fn());
vi.mock('./backend', () => ({ invokeBackend: backend, openExternalUrl: vi.fn() }));
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
});
it('bounds logout reconciliation and re-arms device login after either confirmed logout path', async () => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = html.replace(/<link\b[^>]*>/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const status = (authenticated: boolean) => ({ authenticated, account: '', storage: '' });
  let authenticated = false;
  let mode: 'transport' | 'hung' | 'cleanup' | 'success' = 'transport';
  let finishLateStatus!: (value: ReturnType<typeof status>) => void;
  backend.mockImplementation(async (command: string) => {
    if (command === 'auth_status') {
      if (mode === 'hung') return new Promise(resolve => { finishLateStatus = resolve; });
      return status(authenticated);
    }
    if (command === 'logout') {
      if (mode === 'cleanup' || mode === 'success') authenticated = false;
      if (mode !== 'success') throw new Error(mode === 'cleanup' ? 'cleanup failed' : 'logout timed out');
      return;
    }
    if (command === 'begin_login_window') return { user_code: 'ABCD-EFGH', expires_in: 60, interval: 1 };
    if (command === 'poll_login') return status(authenticated = true);
    if (command === 'load_settings') return { resolution: '1920x1080', bitrate: 30000, codec: 'auto', audio: 'opus' };
    if (command === 'list_consoles_smartglass' || command === 'list_streaming_servers') return [];
    return {};
  });
  await import('./main');
  const dashboard = document.querySelector<HTMLElement>('#dashboard')!;
  const login = document.querySelector<HTMLButtonElement>('#btn-login')!;
  const settings = document.querySelector<HTMLButtonElement>('[data-action=settings]')!;
  const logout = document.querySelector<HTMLButtonElement>('.profile-logout')!;
  const toast = document.querySelector('#toast')!;
  const calls = (command: string) => backend.mock.calls.filter(([cmd]) => cmd === command);
  const signIn = async (expectedAttempts: number) => {
    expect(dashboard.hidden).toBe(true);
    expect(login.disabled).toBe(false);
    login.click();
    await vi.advanceTimersByTimeAsync(5_250);
    expect(calls('begin_login_window')).toHaveLength(expectedAttempts);
    expect(dashboard.hidden).toBe(false);
    settings.click();
  };
  await vi.advanceTimersByTimeAsync(0);
  await signIn(1);
  logout.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(toast.textContent).toMatch(/could not confirm|no se pudo confirmar/i);
  expect(dashboard.hidden).toBe(false);

  mode = 'hung';
  toast.textContent = '';
  logout.click();
  logout.click();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(calls('logout')).toHaveLength(2);
  expect(calls('auth_status')).toHaveLength(3); // startup plus one read per failure
  expect(toast.textContent).toBe('');
  await vi.advanceTimersByTimeAsync(1);
  expect(toast.textContent).toMatch(/could not confirm|no se pudo confirmar/i);
  finishLateStatus(status(false));
  await vi.advanceTimersByTimeAsync(0);
  expect(dashboard.hidden).toBe(false);

  mode = 'cleanup';
  logout.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(toast.textContent).toMatch(/persist|almacen|saved|guardad/i);
  await signIn(2);
  mode = 'success';
  logout.click();
  await vi.advanceTimersByTimeAsync(0);
  await signIn(3);
  expect(new Set(calls('begin_login_window').map(([, args]) => args.attemptId)).size).toBe(3);
});
