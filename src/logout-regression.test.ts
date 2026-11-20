// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from '../index.html?raw';
const backend = vi.hoisted(() => vi.fn());
vi.mock('./backend', () => ({ invokeBackend: backend, openExternalUrl: vi.fn() }));
it('reconciles a failed logout with backend state and warns about persistent cleanup', async () => {
  document.documentElement.innerHTML = html.replace(/<link\b[^>]*>/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  let authenticated = true;
  let mode: 'transport' | 'unknown' | 'cleanup' = 'transport';
  backend.mockImplementation(async (command: string) => {
    if (command === 'auth_status') {
      if (mode === 'unknown') throw new Error('status unavailable');
      return { authenticated, account: '', storage: '' };
    }
    if (command === 'logout') {
      if (mode === 'cleanup') authenticated = false;
      throw new Error(mode === 'cleanup' ? 'cleanup failed' : 'transport unavailable');
    }
    if (command === 'load_settings') return { resolution: '1920x1080', bitrate: 30000, codec: 'auto', audio: 'opus' };
    if (command === 'list_consoles_smartglass' || command === 'list_streaming_servers') return [];
    return {};
  });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#dashboard')?.hidden).toBe(false));
  document.querySelector<HTMLButtonElement>('[data-action=settings]')!.click();
  const logout = document.querySelector<HTMLButtonElement>('.profile-logout')!;
  logout.click();
  await vi.waitFor(() => expect(document.querySelector('#toast')!.textContent).toMatch(/could not confirm|no se pudo confirmar/i));
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);
  mode = 'unknown';
  logout.click();
  await vi.waitFor(() => expect(backend.mock.calls.filter(([cmd]) => cmd === 'auth_status').length).toBe(3));
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);
  mode = 'cleanup';
  logout.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#dashboard')?.hidden).toBe(true));
  expect(document.querySelector('#toast')!.textContent).toMatch(/persist|almacen|saved|guardad/i);
  window.dispatchEvent(new Event('pagehide'));
});