// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import {mountStreamMenu} from './stream-menu';
it('owns modal input, focus trap, pad navigation, resume and clean exit sequencing',async()=>{
 document.body.innerHTML='<button id="before">Before</button><section id="player"><video></video></section>';
 const setModal=vi.fn(),toggle=vi.fn(),disconnect=vi.fn(async()=>{}),exit=vi.fn(async()=>{});
 const menu=mountStreamMenu(document.querySelector('#player')!,{setModal,toggleTelemetry:toggle,disconnect,exit});
 menu.toggle();expect(menu.open).toBe(true);expect(setModal).toHaveBeenLastCalledWith(true);const dialog=document.querySelector('dialog')!;expect(dialog.getAttribute('aria-modal')).toBe('true');
 const pad={index:0,buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]} as unknown as Gamepad;
 menu.poll([pad],0);(pad.buttons as GamepadButton[])[13]={pressed:true,value:1} as GamepadButton;menu.poll([pad],10);expect((document.activeElement as HTMLElement).dataset.action).toBe('telemetry');
 (pad.buttons as GamepadButton[])[0]={pressed:true,value:1} as GamepadButton;menu.poll([pad],20);expect(toggle).toHaveBeenCalledOnce();menu.poll([pad],30);expect(toggle).toHaveBeenCalledOnce();
 dialog.querySelector<HTMLButtonElement>('[data-action="exit"]')!.click();await vi.waitFor(()=>expect(exit).toHaveBeenCalledOnce());expect(disconnect).toHaveBeenCalledOnce();expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
 menu.dispose();expect(document.querySelector('dialog')).toBeNull();expect(setModal).toHaveBeenLastCalledWith(false);
});
