// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import html from '../index.html?raw';
import {resolveLocale} from './i18n';
const backend=vi.hoisted(()=>vi.fn());
vi.mock('./backend',()=>({invokeBackend:backend,openExternalUrl:vi.fn()}));
it('respects the first supported OS language',()=>{
 expect(resolveLocale('auto',['en-US','es-MX'],'en-US')).toBe('en');
 expect(resolveLocale('auto',['fr','es-MX','en'],'fr')).toBe('es');
});
it('reports discovery failure and recovers on retry; exposes bitrate and navigation state',async()=>{
 document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 let failing=true;
 backend.mockImplementation(async(cmd:string)=>{
  if(cmd==='auth_status')return {authenticated:true,account:'fixture',storage:''};
  if(cmd==='load_settings')return {resolution:'1920x1080',bitrate:30000,codec:'auto',audio:'opus'};
  if(cmd==='list_consoles_smartglass'||cmd==='list_streaming_servers'){if(failing)throw Error('secret');return [];}
  return {};
 });
 await import('./main');
 await vi.waitFor(()=>expect(document.querySelector('#remote-status')!.textContent).toMatch(/could not|no se pudo/i));
 expect(document.querySelector('#remote-status')!.textContent).not.toContain('secret');
 failing=false;document.querySelector<HTMLButtonElement>('#refresh-consoles-context')!.click();
 await vi.waitFor(()=>expect(document.querySelector('#remote-status')!.textContent).toMatch(/no consoles|no hay consolas/i));
 const bitrate=document.querySelector<HTMLInputElement>('#stream-bitrate')!;
 expect(bitrate.getAttribute('aria-valuetext')).toBe('30 Mbps');
 bitrate.value='45000';bitrate.dispatchEvent(new Event('input'));
 expect(bitrate.getAttribute('aria-valuetext')).toBe('45 Mbps');
 const consoles=document.querySelector<HTMLButtonElement>('[data-action=consoles]')!;
 const settings=document.querySelector<HTMLButtonElement>('[data-action=settings]')!;
 expect(consoles.getAttribute('aria-current')).toBe('page');
 settings.click();expect(settings.getAttribute('aria-current')).toBe('page');expect(consoles.hasAttribute('aria-current')).toBe(false);
 window.dispatchEvent(new Event('pagehide'));
});
