// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import html from '../index.html?raw';
const f=vi.hoisted(()=>({invoke:vi.fn(),controllers:[] as any[]}));
vi.mock('./backend',()=>({invokeBackend:f.invoke,openExternalUrl:vi.fn()}));
vi.mock('./fullscreen',()=>({bindPlayerFullscreen:()=>()=>{},requestPlayerFullscreen:vi.fn()}));
vi.mock('./webrtc',async original=>({...await original<any>(),XboxWebRtcController:class {
 peer=Object.assign(new EventTarget(),{connectionState:'connected',iceConnectionState:'connected',onicecandidate:null});
 gamepad={setModal:vi.fn()}; close=vi.fn();attachVideoElement(){}createOffer=()=>new Promise(()=>{});
 constructor(){f.controllers.push(this);}
}}));
it('intentional exit navigates and exits app before backend stop; closed remotely cancels grace and old stop cannot disturb next attempt',async()=>{
 document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 const pending:((v?:unknown)=>void)[]=[];
 f.invoke.mockImplementation(async(cmd:string)=>{
  if(cmd==='auth_status')return {authenticated:true,account:'fixture',storage:''};
  if(cmd==='load_settings')return {resolution:'1920x1080',bitrate:30000,codec:'auto',audio:'opus'};
  if(cmd==='list_consoles_smartglass')return [{id:'a',serverId:'a',name:'First'},{id:'b',serverId:'b',name:'Second'}];
  if(cmd==='list_streaming_servers')return [{serverId:'a',name:'First'},{serverId:'b',name:'Second'}];
  if(cmd==='cancel_connection')return new Promise(r=>pending.push(r));
  return {};
 });
 const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve();};
 vi.useFakeTimers();
 try{
  await import('./main');await flush();
  const origin=document.querySelectorAll<HTMLButtonElement>('.console-card button')[1];origin.focus();origin.click();await flush();
  const video=document.querySelector<HTMLVideoElement>('#stream-video')!;video.dispatchEvent(new Event('playing'));await flush();
  const peer=f.controllers[0].peer;peer.connectionState='disconnected';peer.dispatchEvent(new Event('connectionstatechange'));
  expect(document.querySelector<HTMLElement>('.stream-reconnecting')!.hidden).toBe(false);
  document.querySelector<HTMLButtonElement>('.stream-menu [data-action=exit]')!.click();await flush();
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);
  expect(f.invoke.mock.calls.some(([cmd])=>cmd==='app_exit')).toBe(true);
  expect(document.activeElement).toBe(origin);expect(f.controllers[0].close).toHaveBeenCalledTimes(1);
  expect(document.documentElement.classList.contains('cursor-none')).toBe(false);
  expect(document.querySelector('.stream-menu')).toBeNull();expect(video.srcObject).toBeNull();
  origin.click();await flush();expect(f.controllers).toHaveLength(2);
  pending[0]();await flush();await vi.advanceTimersByTimeAsync(6001);
  expect(document.querySelector<HTMLElement>('#player-screen')!.hidden).toBe(false);expect(f.controllers[1].close).not.toHaveBeenCalled();
  const second=f.controllers[1].peer;second.connectionState='closed';second.dispatchEvent(new Event('connectionstatechange'));await flush();
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);expect(f.controllers[1].close).toHaveBeenCalledTimes(1);
  expect(document.querySelector<HTMLElement>('#toast')!.hidden).toBe(true);
  const ids=f.invoke.mock.calls.filter(([cmd])=>cmd==='cancel_connection').map(([,args])=>args.attemptId);
  expect(new Set(ids).size).toBe(2);
  origin.click();await flush();const third=f.controllers[2];
  third.peer.connectionState='disconnected';third.peer.dispatchEvent(new Event('connectionstatechange'));
  expect(document.querySelector<HTMLElement>('.stream-reconnecting')!.hidden).toBe(false);
  const remoteEnd=third.onRemoteEnd;expect(remoteEnd).toBeTypeOf('function');remoteEnd();await flush();
  expect(document.querySelector<HTMLElement>('#dashboard')!.hidden).toBe(false);
  expect(third.close).toHaveBeenCalledOnce();
  // Even a captured callback from the old session cannot stop a newer one.
  origin.click();await flush();remoteEnd();expect(f.controllers[3].close).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('.loading-exit-btn')!.click();await flush();
  await vi.advanceTimersByTimeAsync(2000);window.dispatchEvent(new Event('pagehide'));
  expect(vi.getTimerCount()).toBe(0);
 }finally{window.dispatchEvent(new Event('pagehide'));vi.useRealTimers();}
});
