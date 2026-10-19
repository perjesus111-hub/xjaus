import { expect, it, vi } from 'vitest';
import { initializeXboxChannels, createXboxDataChannels, XboxWebRtcController } from './webrtc';
import { XboxGamepadInput } from './gamepad';
function channel(state='open') {return Object.assign(new EventTarget(),{readyState:state,bufferedAmount:0,send:vi.fn(),binaryType:'blob'});}
it('removes diagnostic listeners as well as timers when the controller closes',()=>{
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection',class extends EventTarget {
    createDataChannel(){return Object.assign(channel(),{close:()=>{}});}
    close(){} async getStats(){return new Map();}
  });
  const controller=new XboxWebRtcController();
  const diagnostics=vi.spyOn(controller,'diagnostics');
  controller.close();
  controller.peer.dispatchEvent(new Event('connectionstatechange'));
  controller.channels.control.dispatchEvent(new Event('open'));
  vi.advanceTimersByTime(20000);
  expect(diagnostics).not.toHaveBeenCalled();
  vi.useRealTimers();vi.unstubAllGlobals();
});
it('sets input binaryType before offer',()=>{
  const peer={createDataChannel:()=>channel()};
  expect(createXboxDataChannels(peer as any).input.binaryType).toBe('arraybuffer');
});
it('waits for all channels after HandshakeAck, initializes only once, removes listeners on close',()=>{
  const channels={input:channel('connecting'),control:channel('connecting'),message:channel(),chat:channel()} as any;
  const ready=vi.fn();
  const cleanup=initializeXboxChannels(channels,ready);
  channels.message.dispatchEvent(new MessageEvent('message',{data:'{"type":"HandshakeAck"}'}));
  expect(ready).not.toHaveBeenCalled();
  channels.input.readyState='open';channels.input.dispatchEvent(new Event('open'));
  channels.control.readyState='open';channels.control.dispatchEvent(new Event('open'));
  expect(ready).toHaveBeenCalledOnce();
  expect(JSON.parse(channels.control.send.mock.calls[1][0])).toEqual({message:'gamepadChanged',gamepadIndex:0,wasAdded:true});
  channels.message.dispatchEvent(new MessageEvent('message',{data:'{"type":"HandshakeAck"}'}));
  expect(ready).toHaveBeenCalledOnce();
  cleanup(); channels.message.dispatchEvent(new Event('open'));
  expect(channels.message.send.mock.calls.length).toBe(5);
});
it('cancels slot-zero rumble repeats when the physical controller disconnects',()=>{
  vi.useFakeTimers(); const input=channel(),control=channel();
  const reset=vi.fn(async()=>{}),playEffect=vi.fn(async()=>{});
  let pads:any[]=[{index:0,connected:true,mapping:'standard',buttons:[],axes:[],vibrationActuator:{reset,playEffect}}];
  const driver=new XboxGamepadInput(input as any,control as any,()=>pads);driver.start();
  input.dispatchEvent(new MessageEvent('message',{data:new Uint8Array([128,0,0,0,100,50,0,0,10,0,10,0,2]).buffer}));
  pads=[];driver.poll();vi.advanceTimersByTime(100);
  expect(playEffect).toHaveBeenCalledOnce();expect(reset).toHaveBeenCalledOnce();
  driver.stop();vi.useRealTimers();
});
it('polls actual standard controller, registers index and stops poll and rumble on teardown',()=>{
  vi.useFakeTimers();
  const input=channel(),control=channel();
  const reset=vi.fn(async()=>{}),playEffect=vi.fn(async()=>{});
  let pads: any[]=[{index:1,connected:true,mapping:'standard',buttons:[{value:1}],axes:[],vibrationActuator:{reset,playEffect}}];
  const driver=new XboxGamepadInput(input as any,control as any,()=>pads);
  driver.start(); driver.start();
  vi.advanceTimersByTime(1000);
  expect(driver.stats.packets).toBeGreaterThanOrEqual(60);
  expect(driver.stats.aPressedPackets).toBe(driver.stats.packets);
  expect(control.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({message:'gamepadChanged',gamepadIndex:1,wasAdded:true}));
  input.dispatchEvent(new MessageEvent('message',{data:new Uint8Array([128,0,0,1,100,50,0,0,10,0,10,0,2]).buffer}));
  expect(playEffect).toHaveBeenCalledOnce();
  driver.stop(); const count=input.send.mock.calls.length;
  vi.advanceTimersByTime(1000); expect(input.send.mock.calls.length).toBe(count);
  expect(playEffect).toHaveBeenCalledOnce(); expect(reset).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
