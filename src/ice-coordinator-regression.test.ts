import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('./backend',()=>({invokeBackend:invoke}));
import { XboxSessionCoordinator, KEYFRAME_REQUEST } from './webrtc';

function setup(sdp:string) {
  let release!: (value:any)=>void;
  const remote = new Promise(r=>{release=r});
  invoke.mockImplementation(async (command:string)=>{
    if(command==='provision_stream')return {};
    if(command==='poll_stream_answer')return {type:'answer',sdp};
    if(command==='exchange_stream_ice')return remote;
  });
  const control=Object.assign(new EventTarget(),{readyState:'connecting'});
  const controller:any={channels:{control},sendControl:vi.fn(),createOffer:async()=>({sdp:'fixture-offer'}),
    close:vi.fn(),peer:{setRemoteDescription:async()=>{},addIceCandidate:vi.fn()}};
  vi.stubGlobal('window',globalThis);
  const coordinator=new XboxSessionCoordinator(controller);
  return {controller,control,coordinator,release};
}
it('arms keyframe on control open before the pending ICE GET completes',async()=>{
  const {controller,control,coordinator,release}=setup('v=0\r\n');
  controller.createOffer=async()=>{controller.peer.onicecandidate({candidate:{toJSON:()=>({candidate:'fixture'})}});return {sdp:'fixture-offer'}};
  const negotiation=coordinator.negotiate('cloud','fixture-title');
  await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('poll_stream_answer'));
  await new Promise(r=>setTimeout(r,0));
  control.readyState='open';control.dispatchEvent(new Event('open'));
  try {expect(controller.sendControl).toHaveBeenCalledWith(JSON.stringify(KEYFRAME_REQUEST));}
  finally {release([]);await negotiation;await coordinator.stop();vi.unstubAllGlobals();}
});
it('does not block embedded answer candidates on a pending ICE GET',async()=>{
  const {controller,coordinator,release}=setup('v=0\r\na=candidate:fixture\r\n');
  controller.createOffer=async()=>{controller.peer.onicecandidate({candidate:{toJSON:()=>({candidate:'fixture'})}});return {sdp:'fixture-offer'}};
  let done=false;
  const negotiation=coordinator.negotiate('home','fixture-title').then(()=>{done=true});
  await new Promise(r=>setTimeout(r,10));
  try {expect(done).toBe(true);}
  finally {release([]);await negotiation;await coordinator.stop();vi.unstubAllGlobals();}
});
