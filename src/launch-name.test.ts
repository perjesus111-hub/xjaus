import {i18n} from './i18n';
i18n.setPreference('es');
// @vitest-environment happy-dom
/// <reference types="vite/client" />
import html from '../index.html?raw';
import {expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({invoke:vi.fn(),negotiate:vi.fn(()=>new Promise(()=>{}))}));
vi.mock('./backend',()=>({invokeBackend:f.invoke,openExternalUrl:vi.fn()}));
vi.mock('./fullscreen',()=>({bindPlayerFullscreen:()=>()=>{},requestPlayerFullscreen:vi.fn()}));
vi.mock('./hud',()=>({createPlayerHudController:()=>({dispose(){}})}));
vi.mock('./webrtc',()=>({XboxWebRtcController:class {peer=new EventTarget();gamepad={};attachVideoElement(){}},XboxSessionCoordinator:class {negotiate=f.negotiate;stop=vi.fn(async()=>{})}}));
it('synthetic backend: stale provisional card refreshes metadata before one launch, preserving protocol ID and commercial loading name',async()=>{
 document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 const local=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>local.get(k)??null,setItem:(k:string,v:string)=>local.set(k,v)});
 const raw={results:[{titleId:'ASSASSINSCREEDVALHALLA',details:{productId:'ABCDEFGHIJKL',hasEntitlement:true}}]};
 let metadataCalls=0;
 f.invoke.mockImplementation(async(cmd:string)=>{
  if(cmd==='load_settings')return {resolution:'2560x1440',bitrate:30000,codec:'h264',audio:'opus'};
  if(cmd==='auth_status')return {authenticated:true,account:'fixture',storage:''};
  if(cmd==='list_consoles_smartglass'||cmd==='list_streaming_servers')return [];
  if(cmd==='list_cloud_titles')return raw;
  if(cmd==='catalog_products')return ++metadataCalls===1 ? {Products:[]} : {Products:[{ProductId:'ABCDEFGHIJKL',LocalizedProperties:[{ProductTitle:'Localized Commercial Valhalla'}]}]};
  throw Error(`unexpected ${cmd}`);
 });
 await import('./main');
 await vi.waitFor(()=>expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false));
 document.querySelector<HTMLButtonElement>('[data-action=cloud]')!.click();
 await vi.waitFor(()=>expect(document.querySelector('.game-card h3')?.textContent).toBe("Assassin's Creed Valhalla"));
 await vi.waitFor(()=>expect(metadataCalls).toBe(1));
 const button=document.querySelector<HTMLButtonElement>('.game-card button')!;button.click();button.click();
 await vi.waitFor(()=>expect(f.negotiate).toHaveBeenCalledTimes(1));
 expect(f.negotiate).toHaveBeenCalledWith('cloud','ASSASSINSCREEDVALHALLA',{width:2560,height:1440});
 expect(document.querySelector('#stream-overlay h1')?.textContent).toBe('Localized Commercial Valhalla');
 expect(document.querySelector('#stream-message')?.textContent).toBe('Conectando con la nube Xbox');
 expect(metadataCalls).toBe(2);
 window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();
});
