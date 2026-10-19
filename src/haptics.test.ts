import {afterEach,expect,it,vi} from 'vitest';
import {XboxGamepadInput,parseRumble} from './gamepad';
function setup(actuator:any, legacy=false){
 vi.useFakeTimers();
 const channel=()=>Object.assign(new EventTarget(),{readyState:'open',bufferedAmount:0,send:vi.fn(),binaryType:'blob'});
 const input=channel(),control=channel();
 const pad={index:2,connected:true,mapping:'standard',buttons:[],axes:[],[legacy?'hapticActuators':'vibrationActuator']:legacy?[actuator]:actuator};
 const driver=new XboxGamepadInput(input as any,control as any,()=>[null,null,pad] as any);driver.start();
 const send=(values=[100,50,25,75],repeat=0,target=input)=>target.dispatchEvent(new MessageEvent('message',{data:new Uint8Array([128,0,0,2,...values,10,0,10,0,repeat]).buffer}));
 return {driver,input,control,send};
}
afterEach(()=>{vi.useRealTimers();});
it('reset packet cancels repeats without scheduling zero effects',()=>{
 const actuator={playEffect:vi.fn(async()=>{}),reset:vi.fn(async()=>{})};const s=setup(actuator);
 s.send(undefined,3);s.send([0,0,0,0],255);vi.advanceTimersByTime(100);
 expect(actuator.reset).toHaveBeenCalledOnce();expect(actuator.playEffect).toHaveBeenCalledOnce();s.driver.stop();
});
it('supports effectTypes capability and real index on binary control messages',()=>{
 const actuator={effectTypes:['dual-rumble','trigger-rumble'],playEffect:vi.fn(async()=>{}),reset:vi.fn(async()=>{})};const s=setup(actuator);
 s.send(undefined,0,s.control);
 expect(actuator.playEffect).toHaveBeenCalledWith('trigger-rumble',expect.objectContaining({strongMagnitude:1,weakMagnitude:.5,leftTrigger:.25,rightTrigger:.75}));
 expect(s.control.binaryType).toBe('arraybuffer');s.driver.stop();
});
it('falls back to legacy pulse actuator and stops on teardown',()=>{
 const actuator={pulse:vi.fn(async()=>true)};const s=setup(actuator,true);s.send();
 expect(actuator.pulse).toHaveBeenCalledWith(1,10);s.driver.stop();expect(actuator.pulse).toHaveBeenLastCalledWith(0,0);
});
it('records denied browser haptics without throwing or unhandled rejection', async()=>{
 const s=setup({playEffect:vi.fn(()=>{throw new Error('denied');}),reset:vi.fn(async()=>{})});
 expect(()=>s.send()).not.toThrow();await Promise.resolve();
 expect(s.driver.stats.hapticErrors).toBe(1);s.driver.stop();
});
it('does not reinterpret unsupported rumble types or malformed bytes',()=>{
 expect(parseRumble(new Uint8Array([128,0,1,2,100,50,25,75,10,0,10,0,0]).buffer)).toBeNull();
 expect(parseRumble('text' as any)).toBeNull();
});

it('supportedEffects trigger failure falls back to dual rumble',async()=>{
 const actuator={supportedEffects:['trigger-rumble','dual-rumble'],playEffect:vi.fn((type:string)=>type==='trigger-rumble'?Promise.reject(new Error('unsupported')):Promise.resolve()),reset:vi.fn(async()=>{})};
 const s=setup(actuator);s.send();await Promise.resolve();await Promise.resolve();
 expect(actuator.playEffect).toHaveBeenNthCalledWith(1,'trigger-rumble',expect.objectContaining({leftTrigger:.25,rightTrigger:.75}));
 expect(actuator.playEffect).toHaveBeenNthCalledWith(2,'dual-rumble',expect.objectContaining({leftTrigger:0,rightTrigger:0}));s.driver.stop();
});
