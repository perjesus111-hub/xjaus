// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import html from '../index.html?raw';
const f=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('./backend',()=>({invokeBackend:f.invoke,openExternalUrl:vi.fn()}));
it('polls visible consoles every 7s without overlap, stale writes, card replacement or focus loss',async()=>{
 document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 const pending:((value:unknown)=>void)[]=[];
 f.invoke.mockImplementation(async(cmd:string)=>{
  if(cmd==='auth_status')return {authenticated:true,account:'fixture',storage:''};
  if(cmd==='load_settings')return {resolution:'1920x1080',bitrate:30000,codec:'auto',audio:'opus'};
  if(cmd==='list_consoles_smartglass')return new Promise(r=>pending.push(r));
  if(cmd==='list_streaming_servers')return [{serverId:'v6',name:'Fixture'}];
  if(cmd==='wake_console')return new Promise(()=>{});
  if(cmd==='list_cloud_titles')return [];
  return {};
 });
 const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
 const tab=(name:string)=>document.querySelector<HTMLButtonElement>(`[data-action=${name}]`)!.click();
 const consoleData=(name:string,powerState='On')=>[{id:'sg',serverId:'v6',name,powerState}];
 vi.useFakeTimers();
 try {
  await import('./main');await flush();expect(pending).toHaveLength(1);
  const refresh=document.querySelector<HTMLButtonElement>('#refresh-consoles');expect(!refresh || refresh.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(21000);expect(pending).toHaveLength(1);
  pending[0](consoleData('Fresh fixture'));await flush();
  const button=document.querySelector<HTMLButtonElement>('.console-card button')!;button.focus();
  const card=button.closest('.console-card');
  await vi.advanceTimersByTimeAsync(7000);expect(pending).toHaveLength(2);
  expect(document.activeElement).toBe(button);expect(document.querySelector('.console-card')).toBe(card);
  pending[1](consoleData('Renamed','ConnectedStandby'));await flush();
  expect(document.activeElement).toBe(button);expect(document.querySelector('.console-card')).toBe(card);
  expect(card?.querySelector('h3')?.textContent).toBe('Renamed');expect(card?.querySelector('.console-badge')?.textContent).toMatch(/espera|standby/i);
  window.dispatchEvent(new Event('focus'));await flush();expect(pending).toHaveLength(3);
  tab('settings');await vi.advanceTimersByTimeAsync(21000);expect(pending).toHaveLength(3);
  pending[2](consoleData('STALE'));await flush();expect(card?.querySelector('h3')?.textContent).toBe('Renamed');
  tab('consoles');await flush();expect(pending).toHaveLength(4);
  Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
  tab('cloud');tab('consoles');await vi.advanceTimersByTimeAsync(21000);expect(pending).toHaveLength(4);
  Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));await flush();expect(pending).toHaveLength(4);
  pending[3](consoleData('STALE HIDDEN'));await flush();expect(pending).toHaveLength(5);expect(card?.querySelector('h3')?.textContent).toBe('Renamed');
  pending[4](consoleData('Visible'));await flush();expect(document.querySelector('.console-card h3')?.textContent).toBe('Visible');
  tab('cloud');await vi.advanceTimersByTimeAsync(21000);expect(pending).toHaveLength(5);
  tab('consoles');await flush();expect(pending).toHaveLength(6);pending[5](consoleData('Visible'));await flush();
  document.querySelector<HTMLButtonElement>('.console-card button')!.click();await flush();
  await vi.advanceTimersByTimeAsync(21000);expect(pending).toHaveLength(6);
 } finally {window.dispatchEvent(new Event('pagehide'));vi.useRealTimers();}
});
