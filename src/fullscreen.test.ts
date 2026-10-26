import {it,expect,vi} from 'vitest';
import {bindPlayerFullscreen} from './fullscreen';
import {StreamPadGestures, serializeGamepads} from './gamepad';
it('enters once on playing; handles keys; disposes listeners and restores',()=>{
 const video=new EventTarget(); const keys=new EventTarget(); const send=vi.fn();
 const close=bindPlayerFullscreen(video as HTMLVideoElement,keys,send);
 video.dispatchEvent(new Event('playing')); video.dispatchEvent(new Event('playing'));
 expect(send.mock.calls).toEqual([['session-enter']]);
 const key=(name:string)=>{const e=new Event('keydown',{cancelable:true});Object.assign(e,{key:name,repeat:false});keys.dispatchEvent(e);};
 key('F11');key('Escape');expect(send.mock.calls.slice(1)).toEqual([['toggle'],['exit']]);
 close();close();video.dispatchEvent(new Event('playing'));key('F11');expect(send.mock.calls[send.mock.calls.length-1]).toEqual(['session-restore']);expect(send).toHaveBeenCalledTimes(4);
});
it('Guide menu hold is local, requires 1200ms and does not change wire serialization',()=>{
 const toggle=vi.fn();const hold=new StreamPadGestures(toggle,()=>{});
 const pad=(index:number,button:number)=>({index,axes:[],buttons:Array.from({length:17},(_,i)=>({value:i===button?1:0}))}) as unknown as Gamepad;
 const guide = pad(0,16); const original = serializeGamepads([guide],1,0);
 hold.poll([guide],0);hold.poll([pad(0,16)],1199);expect(toggle).not.toHaveBeenCalled();
 hold.poll([pad(0,16)],1200);hold.poll([pad(0,16)],2000);expect(toggle).toHaveBeenCalledTimes(1);expect(serializeGamepads([guide],1,0)).toEqual(original);
 hold.poll([],2100);hold.poll([pad(0,9)],2200);hold.poll([pad(0,9)],4000);expect(toggle).toHaveBeenCalledTimes(1);
 hold.reset();hold.poll([pad(0,9)],4000);expect(toggle).toHaveBeenCalledTimes(1);
});
