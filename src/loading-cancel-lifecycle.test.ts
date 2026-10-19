import {i18n} from './i18n';
i18n.setPreference('es');
// @vitest-environment happy-dom
/// <reference types="vite/client" />
import html from '../index.html?raw';
import {it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({invoke:vi.fn(),peers:0,offers:vi.fn(),closes:vi.fn(),disposes:vi.fn()}));
vi.mock('./backend',()=>({invokeBackend:f.invoke,openExternalUrl:vi.fn()}));
vi.mock('./fullscreen',()=>({bindPlayerFullscreen:()=>()=>{},requestPlayerFullscreen:vi.fn()}));
vi.mock('./hud',()=>({createPlayerHudController:()=>({dispose:f.disposes})}));
vi.mock('./webrtc',async original=>({...await original<any>(),XboxWebRtcController:class {
 peer=Object.assign(new EventTarget(),{onicecandidate:null});gamepad={};constructor(){f.peers++;}
 attachVideoElement(){} createOffer=f.offers; close=f.closes;
}}));
it('real main/coordinator: Escape cancels WNS, late wake never creates peer; click cancels cloud provisioning and returns original tab without resurrection',async()=>{
 document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 const local=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>local.get(k)??null,setItem:(k:string,v:string)=>local.set(k,v)});
 let wakeReady!:()=>void,provisionReady!:(value:any)=>void;
 const wake=new Promise<void>(r=>{wakeReady=r;}),provision=new Promise(r=>{provisionReady=r;});
 let deferCleanup=false,cleanupReady:(()=>void)|undefined;
 const raw={results:[{titleId:'FIXTUREGAME',details:{productId:'ABCDEFGHIJKL',hasEntitlement:true}}]};
 f.invoke.mockImplementation(async(cmd:string)=>{
  if(cmd==='load_settings')return {resolution:'1920x1080',bitrate:20000,codec:'h264',audio:'opus'};
  if(cmd==='auth_status')return {authenticated:true,account:'fixture',storage:''};
  if(cmd==='xbox_profile')return {gamertag:'Live fixture',gamerscore:'37',gameDisplayPicRaw:'https://images-eds.xboxlive.com/avatar',accountTier:''};
  if(cmd==='list_consoles_smartglass')return [{id:'sg',name:'Fixture Xbox',serverId:'server',powerState:'Standby'}];
  if(cmd==='list_streaming_servers')return [{serverId:'server',name:'Fixture Xbox'}];
  if(cmd==='wake_console')return wake;
  if(cmd==='list_cloud_titles')return raw;
  if(cmd==='catalog_products')return {Products:[{ProductId:'ABCDEFGHIJKL',LocalizedProperties:[{ProductTitle:'Fixture Game'}]}]};
  if(cmd==='provision_stream')return provision;
  if(cmd==='cancel_connection' && deferCleanup){deferCleanup=false;return new Promise<void>(r=>{cleanupReady=r;});}
  return undefined;
 });
 await import('./main');
 await vi.waitFor(()=>expect(document.querySelector('.console-card button')).not.toBeNull());
 document.querySelector<HTMLButtonElement>('.console-card button')!.click();
 expect(document.querySelector<HTMLElement>('#player-screen')!.hidden).toBe(false);
 expect(document.querySelector('#stream-message')!.textContent).toContain('Encendiendo');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
 expect(document.querySelector<HTMLElement>('#player-screen')!.hidden).toBe(true);
 expect(f.invoke).toHaveBeenCalledWith('cancel_connection',{attemptId:expect.any(String)});
 wakeReady();await new Promise(r=>setTimeout(r,10));expect(f.peers).toBe(0);
 document.querySelector<HTMLButtonElement>('[data-action=cloud]')!.click();
 await vi.waitFor(()=>expect(document.querySelector('.game-card button')).not.toBeNull());
 document.querySelector<HTMLButtonElement>('.game-card button')!.click();
 await vi.waitFor(()=>expect(f.invoke.mock.calls.some(([cmd])=>cmd==='provision_stream')).toBe(true));
 expect(document.querySelector('.loading-profile')!.textContent).toContain('Live fixture');
 document.querySelector<HTMLButtonElement>('.loading-exit-btn')!.click();
 expect(f.closes).toHaveBeenCalledTimes(1);
 provisionReady({state:'Provisioned'});await new Promise(r=>setTimeout(r,25));
 expect(f.offers).not.toHaveBeenCalled();
 expect(document.querySelector<HTMLElement>('#player-screen')!.hidden).toBe(true);
 expect(document.querySelector<HTMLElement>('#panel-cloud')!.hidden).toBe(false);
 expect(document.querySelector<HTMLElement>('#toast')!.hidden).toBe(true);
 expect(document.querySelector('#toast')!.textContent).toBe('');
 expect(document.querySelector<HTMLVideoElement>('#stream-video')!.srcObject).toBeNull();
 expect(document.querySelectorAll('.loading-header-actions').length).toBe(0);
 // A previous failure's cleanup must not post a toast after a newer attempt
 // has started AND been cancelled (both attempts now look like idle menus).
 f.offers.mockRejectedValueOnce(new Error('old attempt failure'));
 deferCleanup=true;
 document.querySelector<HTMLButtonElement>('.game-card button')!.click();
 await vi.waitFor(()=>expect(cleanupReady).toBeTypeOf('function'));
 document.querySelector<HTMLButtonElement>('[data-action=consoles]')!.click();
 await vi.waitFor(()=>expect(document.querySelector('.console-card button')).not.toBeNull());
 document.querySelector<HTMLButtonElement>('.console-card button')!.click();
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
 cleanupReady!();await new Promise(r=>setTimeout(r,25));
 expect(document.querySelector<HTMLElement>('#toast')!.hidden).toBe(true);
 expect(document.querySelector('#toast')!.textContent).toBe('');
 // Even a local peer teardown failure must not strand the connecting screen.
 f.disposes.mockImplementationOnce(()=>{throw new Error('HUD dispose failure');});
 f.closes.mockImplementationOnce(()=>{throw new Error('peer close failure');});
 const previousInvoke=f.invoke.getMockImplementation()!;
 f.invoke.mockImplementation(async(cmd:string,...args:unknown[])=>{if(cmd==='provision_stream')throw new Error('Xbox session provisioning timed out');return previousInvoke(cmd,...args);});
 document.querySelector<HTMLButtonElement>('[data-action=cloud]')!.click();
 await vi.waitFor(()=>expect(document.querySelector('.game-card button')).not.toBeNull());
 const origin=document.querySelector<HTMLButtonElement>('.game-card button')!;
 const cancelsBefore=f.invoke.mock.calls.filter(([cmd])=>cmd==='cancel_connection').length;
 const provisionsBefore=f.invoke.mock.calls.filter(([cmd])=>cmd==='provision_stream').length;
 origin.focus();origin.click();
 await vi.waitFor(()=>expect(f.invoke.mock.calls.filter(([cmd])=>cmd==='provision_stream').length).toBeGreaterThan(provisionsBefore));
 await vi.waitFor(()=>expect(document.querySelector<HTMLElement>('#player-screen')!.hidden).toBe(true));
 expect(document.querySelector<HTMLElement>('#panel-cloud')!.hidden).toBe(false);
 expect(document.activeElement).toBe(origin);
 expect(document.querySelector('#toast')!.textContent).toContain('Xbox session provisioning timed out');
 expect(f.invoke.mock.calls.filter(([cmd])=>cmd==='cancel_connection')).toHaveLength(cancelsBefore+1);
 window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();
});
