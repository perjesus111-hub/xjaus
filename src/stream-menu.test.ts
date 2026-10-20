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
it('marks gamepad focus visually while navigating the menu with the pad',()=>{
 document.body.innerHTML='<section id="player"><video></video></section>';
 const menu=mountStreamMenu(document.querySelector('#player')!,{setModal:vi.fn(),toggleTelemetry:vi.fn(),disconnect:vi.fn(async()=>{}),exit:vi.fn(async()=>{})});
 menu.toggle();
 // Initial focus lands on the first option with a visible gamepad-focus marker.
 const first=document.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
 expect(first.classList.contains('gamepad-focus')).toBe(true);
 // D-pad down moves both DOM focus and the visual marker together.
 const pad={index:0,buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]} as unknown as Gamepad;
 menu.poll([pad],0);
 (pad.buttons as GamepadButton[])[13]={pressed:true,value:1} as GamepadButton;
 menu.poll([pad],10);
 const telemetry=document.querySelector<HTMLButtonElement>('[data-action="telemetry"]')!;
 expect(document.activeElement).toBe(telemetry);
 expect(telemetry.classList.contains('gamepad-focus')).toBe(true);
 expect(first.classList.contains('gamepad-focus')).toBe(false);
 // Left stick (axis 1 down) moves focus too and keeps the marker on the target.
 (pad.buttons as GamepadButton[])[13]={pressed:false,value:0} as GamepadButton;
 (pad as unknown as {axes:number[]}).axes=[0,1,0,0];
 menu.poll([pad],300);
 expect(document.activeElement).toBe(document.querySelector('[data-action="disconnect"]'));
 expect(document.querySelector('[data-action="disconnect"]')!.classList.contains('gamepad-focus')).toBe(true);
 // Mouse/keyboard focus movement inside the dialog clears the pad marker; the next D-pad press restores it.
 telemetry.focus();
 expect(document.querySelectorAll('.stream-menu .gamepad-focus').length).toBe(0);
 expect(document.activeElement).toBe(telemetry);
 // Pad navigation re-marks the newly focused option.
 (pad as unknown as {axes:number[]}).axes=[0,0,0,0];
 menu.poll([pad],600);
 (pad.buttons as GamepadButton[])[12]={pressed:true,value:1} as GamepadButton;
 menu.poll([pad],610);
 const resume2=document.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
 expect(document.activeElement).toBe(resume2);
 expect(resume2.classList.contains('gamepad-focus')).toBe(true);
 // Closing the menu clears the marker class entirely.
 menu.toggle();
 expect(document.querySelector('.stream-menu .gamepad-focus')).toBeNull();
 menu.dispose();
});
it('shows button hints so the pad mapping is discoverable',()=>{
 document.body.innerHTML='<section id="player"><video></video></section>';
 const menu=mountStreamMenu(document.querySelector('#player')!,{setModal:vi.fn(),toggleTelemetry:vi.fn(),disconnect:vi.fn(async()=>{}),exit:vi.fn(async()=>{})});
 menu.toggle();
 const dialog=document.querySelector('dialog')!;
 const hints=dialog.querySelectorAll('.stream-menu-hints span');
 expect(hints.length).toBeGreaterThanOrEqual(2);
 expect([...hints].some(hint=>hint.textContent!.includes('A'))).toBe(true);
 expect([...hints].some(hint=>hint.textContent!.includes('B'))).toBe(true);
 menu.dispose();
});
