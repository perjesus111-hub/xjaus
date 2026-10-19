// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import {createPlayerHudController} from './hud';
it('playing blurs toolbar focus; later explicit focus reveals it but cannot trap autohide',()=>{
 vi.useFakeTimers();document.body.innerHTML='<div class="player-toolbar"><button>Salir</button></div><div id="cursor"></div><video></video>';
 const hud=document.querySelector<HTMLElement>('.player-toolbar')!,video=document.querySelector('video')!;
 hud.querySelector('button')!.focus();
 const controller=createPlayerHudController({hud,cursor:document.querySelector('#cursor')!,video,window});video.dispatchEvent(new Event('playing'));
 expect(document.activeElement).not.toBe(hud.querySelector('button'));
 hud.querySelector('button')!.focus();expect(controller.peek()).toBe(false);vi.advanceTimersByTime(2500);expect(controller.peek()).toBe(true);
 hud.querySelector('button')!.blur();controller.reveal();vi.advanceTimersByTime(2500);expect(controller.peek()).toBe(true);
 controller.reveal();controller.dispose();controller.reveal();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();document.body.replaceChildren();
});
