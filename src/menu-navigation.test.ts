// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createCatalogNavigation } from './catalog-navigation';
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it('recovers gamepad-selected title after DOM replacement without stealing search focus',async()=>{
 const h=harness();const grid=document.querySelector<HTMLElement>('#grid')!;
 grid.innerHTML='<article data-title-id="a"><button id="a">A</button></article><article data-title-id="b"><button id="b">B</button></article>';
 document.getElementById('b')!.focus();h.pad.buttons[0].pressed=true;h.step();h.pad.buttons[0].pressed=false;
 grid.innerHTML='<article data-title-id="a"><button id="a2">A</button></article><article data-title-id="b"><button id="b2">B</button></article>';
 await new Promise(resolve=>setTimeout(resolve,0));expect(document.activeElement?.id).toBe('b2');
 document.querySelector<HTMLInputElement>('#search')!.focus();h.step();expect(document.activeElement?.id).toBe('search');
 document.querySelector<HTMLSelectElement>('#setting')!.focus();h.step();expect(document.activeElement?.id).toBe('setting');
 document.getElementById('b2')!.focus();h.pad.buttons[0].pressed=true;h.step();h.pad.buttons[0].pressed=false;document.getElementById('b2')!.closest('article')!.remove();await new Promise(resolve=>setTimeout(resolve,0));expect(document.activeElement?.id).toBe('a2');
 document.querySelector<HTMLInputElement>('#search')!.focus();
 h.disable();document.getElementById('search')!.remove();h.step();expect(document.activeElement).toBe(document.body);h.nav.dispose();
});
it('down from the final row requests an automatic batch without focusing a pagination control',()=>{
 const load=vi.fn(()=>true);const h=harness(load);const play=document.getElementById('play')!;
 const rect=(x:number,y:number)=>({left:x,top:y,width:100,height:100} as DOMRect);
 play.getBoundingClientRect=()=>rect(900,200);
 document.getElementById('setting')!.getBoundingClientRect=()=>rect(900,700);
 play.focus();h.pad.buttons[13].pressed=true;h.step();expect(load).toHaveBeenCalledWith(play);expect(document.activeElement).toBe(play);h.nav.dispose();
});
function harness(next?: (origin:HTMLElement)=>boolean) {
 let tick: FrameRequestCallback = () => {}; let now = 0;
 const pad = {connected:true,mapping:'standard',index:0,buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]};
 vi.stubGlobal('navigator',{getGamepads:()=>[pad]});
 vi.stubGlobal('requestAnimationFrame',vi.fn((cb:FrameRequestCallback)=>{tick=cb;return 1;}));
 vi.stubGlobal('cancelAnimationFrame',vi.fn());
 document.body.innerHTML='<button id="tab">Tab</button><input id="search"><div id="grid"><button id="play">Play</button></div><select id="setting"><option value="a">a</option><option value="b">b</option></select><button id="more">More</button>';
 let enabled = true;
 const nav=createCatalogNavigation(document.querySelector('#search')!,document.querySelector('#grid')!,()=>enabled,()=>true,undefined,next);
 nav.sync(); tick(now);
 return {pad,nav,step(ms=16){now+=ms;tick(now);},disable(){enabled=false;nav.sync();}};
}
it('synthetic standard pad navigates all controls, .25 deadzone and 180ms repeat; A is edge only',()=>{
 const h=harness(); const tab=document.querySelector<HTMLButtonElement>('#tab')!; tab.focus();
 h.pad.axes[0]=.24;h.step();expect(document.activeElement).toBe(tab);
 h.pad.axes[0]=.8;h.step();expect(document.activeElement?.id).toBe('search');
 h.step(179);expect(document.activeElement?.id).toBe('search');
 h.step(1);expect(document.activeElement?.id).toBe('play');
 h.pad.axes[0]=0;h.step();
 const click=vi.fn();document.querySelector('#play')!.addEventListener('click',click);
 h.pad.buttons[0].pressed=true;h.step();h.step(500);expect(click).toHaveBeenCalledTimes(1);
 h.pad.buttons[0].pressed=false;h.step();h.pad.buttons[0].pressed=true;h.step();expect(click).toHaveBeenCalledTimes(2);
 h.nav.dispose();
});
it('Dpad changes select with change, never clicks native popup; B returns to active tab',()=>{
 const h=harness();const select=document.querySelector<HTMLSelectElement>('#setting')!;select.focus();
 const change=vi.fn(),click=vi.fn();select.addEventListener('change',change);select.addEventListener('click',click);
 h.pad.buttons[15].pressed=true;h.step();expect(select.value).toBe('b');expect(change).toHaveBeenCalledTimes(1);
 h.pad.buttons[0].pressed=true;h.step();expect(click).not.toHaveBeenCalled();
 h.pad.buttons[1].pressed=true;h.step();expect(document.activeElement?.id).toBe('tab');
 h.nav.dispose();
});
it('stream ownership stops RAF, disposal cannot be revived by sync, skips hidden and disabled controls',()=>{
 const h=harness();document.querySelector<HTMLButtonElement>('#tab')!.disabled=true;
 document.querySelector<HTMLElement>('#grid')!.hidden=true;
 document.querySelector<HTMLInputElement>('#search')!.focus();
 h.pad.buttons[13].pressed=true;h.step();expect(document.activeElement?.id).toBe('setting');
 h.disable();expect(cancelAnimationFrame).toHaveBeenCalled();
 h.nav.dispose();const before=vi.mocked(requestAnimationFrame).mock.calls.length;h.nav.sync();expect(vi.mocked(requestAnimationFrame).mock.calls.length).toBe(before);
});
