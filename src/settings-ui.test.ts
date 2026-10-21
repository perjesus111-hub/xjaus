// @vitest-environment happy-dom
/// <reference types="vite/client" />
import html from '../index.html?raw';
import { describe,it,expect,vi } from 'vitest';
const backend=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn()}));
vi.mock('./backend',()=>({invokeBackend:backend.invoke,openExternalUrl:backend.open}));
describe('real settings UI startup',()=>{
 it('awaits disk before auth/dashboard, hydrates controls, and prepares exact engine payload without starting a game',async()=>{
  document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  const local=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(k:string)=>local.get(k)??null,setItem:(k:string,v:string)=>local.set(k,v)});
  let rafId=0;const frames=new Map<number,FrameRequestCallback>();const frame=(now:number)=>{const batch=[...frames.values()];frames.clear();for(const cb of batch)cb(now);};
  const pad={connected:true,mapping:'standard',index:0,buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]};
  vi.stubGlobal('navigator',{getGamepads:()=>[pad]});
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.set(++rafId,cb);return rafId;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  let release!:(v:unknown)=>void;
  backend.invoke.mockImplementation(async(command:string)=>{
   if(command==='load_settings')return new Promise(r=>{release=r;});
   if(command==='auth_status')return {authenticated:false,account:'',storage:''};
   if(command==='save_settings')return null;
   throw new Error(`unexpected command: ${command}`);
  });
  await import('./main');
  const control=(key:string)=>document.getElementById(`stream-${key}`) as HTMLInputElement;
  expect(control('resolution').disabled).toBe(true);
  expect(backend.invoke.mock.calls.map(c=>c[0])).toEqual(['load_settings']);
  release({resolution:'2560x1440',bitrate:30000,codec:'h264',audio:'opus'});
  await vi.waitFor(()=>expect(control('resolution').disabled).toBe(false));
  expect(control('resolution').value).toBe('2560x1440');expect(control('bitrate').value).toBe('30000');expect(control('codec').value).toBe('h264');
  const grid=document.querySelector<HTMLElement>('#panel-settings .settings-grid')!;
  expect(JSON.parse(grid.dataset.selectedStreamConfig!)).toEqual({profile:{width:2560,height:1440},options:{bitrateKbps:30000,codec:'h264',audio:'opus'}});
  expect(backend.invoke.mock.calls.some(c=>c[0]==='save_settings')).toBe(false);
  control('audio').value='default';control('audio').dispatchEvent(new Event('change'));
  await vi.waitFor(()=>expect(backend.invoke).toHaveBeenCalledWith('save_settings',{settings:{resolution:'2560x1440',bitrate:30000,codec:'h264',audio:'default',audioGain:1}}));
  // Synthetic Gamepad API fixture, not physical input: exercise the actual main RAF owner.
  document.querySelector<HTMLElement>('#login-screen')!.hidden=true;
  document.querySelector<HTMLElement>('#dashboard')!.hidden=false;
  document.querySelector<HTMLElement>('#panel-consoles')!.hidden=true;
  document.querySelector<HTMLElement>('#panel-settings')!.hidden=false;
  // Real user flow: audio lives in the "Video y audio" settings sub-section.
  document.querySelector<HTMLButtonElement>('[data-settings-section="video"]')!.click();
  control('audio').focus();frame(0);pad.buttons[14].pressed=true;frame(16);
  await vi.waitFor(()=>expect(backend.invoke).toHaveBeenLastCalledWith('save_settings',{settings:{resolution:'2560x1440',bitrate:30000,codec:'h264',audio:'opus',audioGain:1}}));
  expect(control('audio').value).toBe('opus');
  expect(backend.invoke.mock.calls.some(c=>c[0]==='start_stream')).toBe(false);
  window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();
 });
});
