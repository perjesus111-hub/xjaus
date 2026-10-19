// @vitest-environment happy-dom
import { it, expect, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({invoke: vi.fn()}));
vi.mock('./backend', () => ({invokeBackend: invoke}));
import { XboxSessionCoordinator, XboxWebRtcController, requestVideoKeyframe } from './webrtc';
it('bounds remote cleanup to 2s, keeps the attempt identity and absorbs late rejection',async()=>{
 vi.useFakeTimers();invoke.mockReset();let reject!:(error:unknown)=>void;
 invoke.mockImplementation(()=>new Promise((_,r)=>{reject=r;}));
 const controller:any={peer:{},close:vi.fn()};const session=new XboxSessionCoordinator(controller,vi.fn(),undefined,'old-attempt');
 let done=false;const stopping=session.stop().then(()=>{done=true;});
 expect(controller.close).toHaveBeenCalledOnce();expect(invoke).toHaveBeenCalledWith('cancel_connection',{attemptId:'old-attempt'});
 await vi.advanceTimersByTimeAsync(1999);expect(done).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(done).toBe(true);await stopping;
 reject(new Error('late cleanup'));await Promise.resolve();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
});
it('cancel during provisioning closes immediately and delayed completion cannot create offer or timer', async () => {
 let release!: (v: unknown) => void;
 const pending = new Promise(r => {release=r;});
 invoke.mockImplementation(async (cmd: string) => cmd === 'provision_stream' ? pending : undefined);
 const controller: any = {peer: {}, close: vi.fn(), createOffer: vi.fn(async()=>({sdp:'offer'}))};
 const progress=vi.fn(), errors=vi.fn();
 const session = new XboxSessionCoordinator(controller, errors, progress);
 const negotiation=session.negotiate('home','fixture').catch(()=>{});
 await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('provision_stream'));
 await session.stop();
 release({state:'Provisioned'}); await negotiation;
 expect(controller.close).toHaveBeenCalledTimes(1);
 expect(controller.createOffer).not.toHaveBeenCalled();
 expect(progress).not.toHaveBeenCalled();
 expect(session['keepaliveTimer']).toBeUndefined();
 expect(errors).not.toHaveBeenCalled();
 await session.stop();expect(controller.close).toHaveBeenCalledTimes(1);
});
it.each(['poll_stream_answer','exchange_stream_ice'])('late %s cannot touch the closed peer or rearm keepalive',async(stage)=>{
 invoke.mockReset();
 let release!:(value:any)=>void;
 const delayed=new Promise(r=>{release=r;});
 invoke.mockImplementation(async(cmd:string)=>{
  if(cmd===stage)return delayed;
  if(cmd==='provision_stream')return {};
  if(cmd==='poll_stream_answer')return {type:'answer',sdp:'v=0\r\n'};
  if(cmd==='exchange_stream_ice')return [];
 });
 const peer:any={setRemoteDescription:vi.fn(async()=>{}),addIceCandidate:vi.fn()};
 const controller:any={peer,close:vi.fn(),createOffer:async()=>{
  peer.onicecandidate({candidate:{toJSON:()=>({candidate:'fixture'})}});return {sdp:'fixture'};
 }};
 const errors=vi.fn(),session=new XboxSessionCoordinator(controller,errors);
 const negotiation=session.negotiate('home','fixture').catch(()=>{});
 await vi.waitFor(()=>expect(invoke.mock.calls.some(([cmd])=>cmd===stage)).toBe(true));
 await session.stop();
 release(stage==='poll_stream_answer'?{type:'answer',sdp:'v=0\r\n'}:[{candidate:'fixture'}]);
 await negotiation;
 expect(peer.addIceCandidate).not.toHaveBeenCalled();
 if(stage==='poll_stream_answer')expect(peer.setRemoteDescription).not.toHaveBeenCalled();
 expect(session['keepaliveTimer']).toBeUndefined();expect(errors).not.toHaveBeenCalled();
});
it('a late browser offer cannot install a description on a closed peer', async()=>{
 let release!:(v:any)=>void;
 const peer:any={addTransceiver:vi.fn(()=>({})),createOffer:()=>new Promise(r=>{release=r;}),setLocalDescription:vi.fn()};
 const controller=Object.create(XboxWebRtcController.prototype) as XboxWebRtcController;
 Object.assign(controller,{peer,options:{codec:'auto'},closed:false});
 const pending=controller.createOffer().catch(()=>{});
 (controller as any).closed=true;
 release({type:'offer',sdp:'fixture'});await pending;
 expect(peer.setLocalDescription).not.toHaveBeenCalled();
});
it('cancellation removes a pending keyframe-open callback',async()=>{
 const abort=new AbortController(),control=Object.assign(new EventTarget(),{readyState:'connecting'});
 const controller:any={channels:{control},sendControl:vi.fn()};
 await requestVideoKeyframe(controller,abort.signal);
 abort.abort();control.readyState='open';control.dispatchEvent(new Event('open'));
 expect(controller.sendControl).not.toHaveBeenCalled();
});
