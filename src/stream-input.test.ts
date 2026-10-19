import {it,expect,vi} from 'vitest';
import {StreamPadGestures, XboxGamepadInput} from './gamepad';
const pad=()=>({index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))});
it('Guide requires 1200ms, Menu alone never opens; chord and telemetry are rising edges',()=>{
 const menu=vi.fn(),stats=vi.fn();const g=new StreamPadGestures(menu,stats),p=pad();
 p.buttons[9].value=1;g.poll([p as unknown as Gamepad],0);g.poll([p as unknown as Gamepad],3000);expect(menu).not.toHaveBeenCalled();
 p.buttons[16].value=1;g.poll([p as unknown as Gamepad],4000);g.poll([p as unknown as Gamepad],5199);expect(menu).not.toHaveBeenCalled();g.poll([p as unknown as Gamepad],5200);g.poll([p as unknown as Gamepad],7000);expect(menu).toHaveBeenCalledTimes(1);
 p.buttons[16].value=0;p.buttons[8].value=1;g.poll([p as unknown as Gamepad],7100);g.poll([p as unknown as Gamepad],8000);expect(menu).toHaveBeenCalledTimes(2);
 p.buttons[10].value=p.buttons[11].value=1;g.poll([p as unknown as Gamepad],8100);g.poll([p as unknown as Gamepad],8200);expect(stats).toHaveBeenCalledTimes(1);g.reset();
});
it('modal and release latch transmit neutral for every held control until released',()=>{
 const channel=()=>Object.assign(new EventTarget(),{readyState:'open',bufferedAmount:0,send:vi.fn()});const input=channel(),control=channel(),p=pad();
 const g=new XboxGamepadInput(input as unknown as RTCDataChannel,control as unknown as RTCDataChannel,()=>[p as unknown as Gamepad]);
 p.buttons[0].value=1;p.axes[0]=1;g.setModal(true);g.poll();g.setModal(false);g.poll();
 let packet=new DataView(input.send.mock.calls[input.send.mock.calls.length-1][0]);expect(packet.getUint16(16,true)).toBe(0);expect(packet.getInt16(18,true)).toBe(0);
 p.buttons[0].value=0;p.axes[0]=0;g.poll();p.buttons[0].value=1;g.poll();packet=new DataView(input.send.mock.calls[input.send.mock.calls.length-1][0]);expect(packet.getUint16(16,true)&16).toBe(16);g.stop();
});

it('local menu remains responsive while the wire channel is backpressured',()=>{
 const input=Object.assign(new EventTarget(),{readyState:'open',bufferedAmount:100000,send:vi.fn()}),control=Object.assign(new EventTarget(),{readyState:'open',send:vi.fn()}),p=pad();
 const g=new XboxGamepadInput(input as unknown as RTCDataChannel,control as unknown as RTCDataChannel,()=>[p as unknown as Gamepad]);const menu=vi.fn();g.onMenuToggle=menu;
 p.buttons[8].value=p.buttons[9].value=1;g.poll();expect(menu).toHaveBeenCalledOnce();expect(input.send).not.toHaveBeenCalled();g.stop();
});
