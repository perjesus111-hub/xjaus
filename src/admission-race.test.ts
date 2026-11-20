// @vitest-environment happy-dom
import {it, expect, vi} from 'vitest';
import html from '../index.html?raw';
const f = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./backend', () => ({ invokeBackend: f.invoke, openExternalUrl: vi.fn() }));

it('returns to the dashboard immediately and cancels only after pending admission succeeds', async () => {
  document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  let admit!: (generation: string) => void;
  const pending = new Promise<string>(resolve => { admit = resolve; });
  f.invoke.mockImplementation(async (command: string) => {
    if (command === 'auth_status') return {authenticated:true, account:'fixture', storage:''};
    if (command === 'load_settings') return {};
    if (command === 'list_consoles_smartglass') return [{id:'device',serverId:'server',name:'Fixture'}];
    if (command === 'list_streaming_servers') return [{serverId:'server',name:'Fixture'}];
    if (command === 'begin_connection') return pending;
    return undefined;
  });
  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('.console-card button')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.console-card button')!.click();
  const begin = f.invoke.mock.calls.find(([cmd]) => cmd === 'begin_connection')!;
  window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);
  expect(f.invoke.mock.calls.some(([cmd]) => cmd === 'cancel_connection' || cmd === 'wake_console')).toBe(false);
  admit('backend-generation');
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith('cancel_connection', {attemptId:begin[1].attemptId, generation:'backend-generation'}));
  expect(f.invoke.mock.calls.some(([cmd]) => cmd === 'wake_console')).toBe(false);
  window.dispatchEvent(new Event('pagehide'));
});
