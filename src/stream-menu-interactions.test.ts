// @vitest-environment happy-dom
import {it,expect,vi,afterEach} from 'vitest';
import {mountStreamMenu} from './stream-menu';
import {createPlayerHudController} from './hud';
import {XboxGamepadInput} from './gamepad';

const disposers:Array<()=>void>=[];
afterEach(()=>{disposers.splice(0).forEach(dispose=>dispose());vi.useRealTimers();vi.restoreAllMocks();});
function mount(...args:Parameters<typeof mountStreamMenu>){const menu=mountStreamMenu(...args);disposers.push(()=>menu.dispose());return menu;}

it('releases pointer lock and owns mouse hit testing, backdrop dismissal and cursor lifetime',()=>{
 document.body.innerHTML='<section id="player"><video></video><div id="hud"></div></section>';
 const player=document.querySelector<HTMLElement>('#player')!;
 const exitPointerLock=vi.fn();Object.defineProperty(document,'exitPointerLock',{configurable:true,value:exitPointerLock});
 const setModal=vi.fn();const menu=mount(player,{setModal,toggleTelemetry:vi.fn(),disconnect:vi.fn(async()=>{}),exit:vi.fn(async()=>{})});
 const mouse=vi.fn();player.addEventListener('mousedown',mouse);player.addEventListener('click',mouse);
 menu.toggle();
 expect(exitPointerLock).toHaveBeenCalledOnce();
 expect(document.documentElement.classList.contains('stream-menu-open')).toBe(true);
 const dialog=document.querySelector('dialog')!;
 dialog.querySelector('h2')!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
 document.querySelector('video')!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
 expect(mouse).not.toHaveBeenCalled();
 vi.spyOn(dialog,'getBoundingClientRect').mockReturnValue({left:100,right:500,top:100,bottom:500} as DOMRect);
 dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:150,clientY:150}));expect(menu.open).toBe(true);
 dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:50,clientY:50}));expect(menu.open).toBe(false);
 expect(document.documentElement.classList.contains('stream-menu-open')).toBe(false);
 expect(mouse).not.toHaveBeenCalled();menu.dispose();
});

it('returns to the game by visible button, Escape and rising-edge B without disconnecting',()=>{
 document.body.innerHTML='<section></section>';
 const disconnect=vi.fn(async()=>{});const menu=mount(document.querySelector('section')!,{setModal:vi.fn(),toggleTelemetry:vi.fn(),disconnect,exit:vi.fn(async()=>{})});
 menu.toggle();const resume=document.querySelector<HTMLButtonElement>('[data-action="resume"]')!;expect(resume.textContent).not.toBe('');resume.click();expect(menu.open).toBe(false);
 menu.toggle();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(menu.open).toBe(false);
 menu.toggle();const pad={index:0,buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]} as unknown as Gamepad;
 menu.poll([pad]);(pad.buttons as GamepadButton[])[1]={pressed:true,value:1} as GamepadButton;menu.poll([pad]);expect(menu.open).toBe(false);expect(disconnect).not.toHaveBeenCalled();menu.dispose();
});

it('resumes the normal 2.5 second HUD idle timer when the menu closes',()=>{
 vi.useFakeTimers();document.body.innerHTML='<section><video></video><div id="hud"></div><div id="cursor"></div></section>';
 const hud=createPlayerHudController({hud:document.querySelector('#hud')!,cursor:document.querySelector('#cursor')!,video:document.querySelector('video')!,window,storage:localStorage});
 const menu=mount(document.querySelector('section')!,{setModal:value=>{if(!value)hud.reveal();},toggleTelemetry:vi.fn(),disconnect:vi.fn(async()=>{}),exit:vi.fn(async()=>{})});
 hud.reveal();menu.toggle();vi.advanceTimersByTime(3000);expect(document.documentElement.classList.contains('stream-menu-open')).toBe(true);
 menu.toggle();expect(hud.peek()).toBe(false);vi.advanceTimersByTime(2499);expect(hud.peek()).toBe(false);vi.advanceTimersByTime(1);expect(hud.peek()).toBe(true);
 menu.dispose();hud.dispose();vi.useRealTimers();
});

it('keeps B and held sticks neutral on the wire through dismissal until all controls release',()=>{
 document.body.innerHTML='<section></section>';
 const channel=()=>Object.assign(new EventTarget(),{readyState:'open',bufferedAmount:0,send:vi.fn()});
 const input=channel(),control=channel();
 const pad={index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
 const driver=new XboxGamepadInput(input as unknown as RTCDataChannel,control as unknown as RTCDataChannel,()=>[pad as unknown as Gamepad]);
 const menu=mount(document.querySelector('section')!,{setModal:value=>driver.setModal(value),toggleTelemetry:vi.fn(),disconnect:vi.fn(async()=>{}),exit:vi.fn(async()=>{})});
 driver.onModalPoll=pads=>menu.poll(pads);menu.toggle();driver.poll();
 pad.buttons[1]={pressed:true,value:1};pad.axes[0]=1;driver.poll();expect(menu.open).toBe(false);
 const packet=()=>new DataView(input.send.mock.calls[input.send.mock.calls.length-1][0]);
 expect(packet().getUint16(16,true)).toBe(0);expect(packet().getInt16(18,true)).toBe(0);
 driver.poll();expect(packet().getUint16(16,true)).toBe(0);expect(packet().getInt16(18,true)).toBe(0);
 pad.buttons[1]={pressed:false,value:0};pad.axes[0]=0;driver.poll();pad.buttons[0]={pressed:true,value:1};driver.poll();expect(packet().getUint16(16,true)&16).toBe(16);driver.stop();
});

it('ships modal hit-testing and a default cursor override stronger than HUD idle styling',async()=>{
 const {readFileSync}=await vi.importActual<{readFileSync:(path:string,encoding:string)=>string}>('node:fs');
 const css=readFileSync('src/styles.css','utf8');
 expect(css).toMatch(/\.stream-menu\s*\{[^}]*z-index:\s*9999[^}]*pointer-events:\s*auto/);
 expect(css.indexOf('html.stream-menu-open, html.stream-menu-open * { cursor:default !important; }')).toBeGreaterThan(css.indexOf('html.cursor-none, html.cursor-none *'));
});
