import {it,expect,vi} from 'vitest';
import {XboxGamepadInput} from './gamepad';
it('Guide rising edge observes without consuming transmitted button16; Menu does not reveal',()=>{
 const channel=()=>Object.assign(new EventTarget(),{readyState:'open',bufferedAmount:0,send:vi.fn()});const input=channel(),control=channel();
 const pad={connected:true,mapping:'standard',index:0,axes:[],buttons:Array.from({length:17},()=>({value:0,pressed:false}))};
 const gamepad=new XboxGamepadInput(input as unknown as RTCDataChannel,control as unknown as RTCDataChannel,()=>[pad as unknown as Gamepad]);const reveal=vi.fn();
 gamepad.onGuidePress=reveal;gamepad.poll();pad.buttons[16]={value:1,pressed:true};gamepad.poll();gamepad.poll();expect(reveal).toHaveBeenCalledTimes(1);
 const packet=new DataView(input.send.mock.calls[input.send.mock.calls.length-1][0]);expect(packet.getUint16(16,true)&2).toBe(2);
 pad.buttons[16]={value:0,pressed:false};pad.buttons[9]={value:1,pressed:true};gamepad.poll();expect(reveal).toHaveBeenCalledTimes(1);
 gamepad.stop();
});
