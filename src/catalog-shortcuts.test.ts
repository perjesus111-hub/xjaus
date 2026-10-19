// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createCatalogNavigation } from './catalog-navigation';
afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();});
function harness(){
 document.body.innerHTML='<input id="search"><div id="grid"><article data-title-id="one"><button id="first">Play</button></article><article data-title-id="last"><button id="last">Last</button></article></div><textarea></textarea><div contenteditable="true" tabindex="0"></div>';
 let tick:FrameRequestCallback=()=>{};let enabled=true,cloud=true,tabIndex=1;
 const pad={connected:true,mapping:'standard',index:0,buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]};
 vi.stubGlobal('navigator',{getGamepads:()=>[pad]});vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{tick=cb;return 1;});vi.stubGlobal('cancelAnimationFrame',()=>{});
 const search=document.querySelector<HTMLInputElement>('#search')!;
 const nav=createCatalogNavigation(search,document.querySelector('#grid')!,()=>enabled,()=>cloud,{enabled:()=>enabled,index:()=>tabIndex,switch:(i)=>{tabIndex=i;cloud=i===1;}});nav.sync();tick(0);
 return {search,nav,pad,tab(i:number){tabIndex=i;cloud=i===1;},step(){tick(100);},scope(value:boolean){cloud=value;},stream(){enabled=false;nav.sync();},key(key='b',options:KeyboardEventInit={}){const e=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});(document.activeElement??document).dispatchEvent(e);return e;}};
}
it('synthetic X refreshes only consoles, preserves Cloud search, emits no mouse and ignores settings/gameplay',()=>{
 const h=harness();const refresh=document.createElement('button');refresh.id='refresh-consoles';const click=vi.fn();refresh.onclick=click;document.body.append(refresh);
 const mouse=vi.fn();window.addEventListener('mousemove',mouse);
 h.tab(0);h.pad.buttons[2].pressed=true;h.step();h.step();expect(click).toHaveBeenCalledTimes(1);
 h.pad.buttons[2].pressed=false;h.step();h.tab(1);h.pad.buttons[2].pressed=true;h.step();expect(document.activeElement).toBe(h.search);expect(click).toHaveBeenCalledTimes(1);
 h.pad.buttons[2].pressed=false;h.step();h.tab(2);h.pad.buttons[2].pressed=true;h.step();expect(click).toHaveBeenCalledTimes(1);
 h.pad.buttons[2].pressed=false;h.step();h.tab(0);h.stream();h.pad.buttons[2].pressed=true;h.step();expect(click).toHaveBeenCalledTimes(1);expect(mouse).not.toHaveBeenCalled();h.nav.dispose();window.removeEventListener('mousemove',mouse);
});
it('F and synthetic Y toggle only the focused cloud card, once per press, never typing or streaming',()=>{
 const h=harness();const favorite=document.createElement('button');favorite.className='favorite-toggle';const click=vi.fn();favorite.onclick=click;document.getElementById('last')!.parentElement!.append(favorite);
 document.getElementById('last')!.focus();expect(h.key('f').defaultPrevented).toBe(true);expect(click).toHaveBeenCalledTimes(1);
 h.pad.buttons[3].pressed=true;h.step();h.step();expect(click).toHaveBeenCalledTimes(2);
 for(const options of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{repeat:true}])expect(h.key('f',options).defaultPrevented).toBe(false);
 h.search.focus();expect(h.key('f').defaultPrevented).toBe(false);h.scope(false);document.getElementById('last')!.focus();expect(h.key('f').defaultPrevented).toBe(false);h.stream();expect(h.key('f').defaultPrevented).toBe(false);h.nav.dispose();
});
it('synthetic standard X rising edge focuses search from any row; X/B clear then return first card',()=>{
 const h=harness();document.getElementById('last')!.focus();h.pad.buttons[2].pressed=true;h.step();expect(document.activeElement).toBe(h.search);h.step();expect(document.activeElement).toBe(h.search);
 h.pad.buttons[2].pressed=false;h.step();h.search.value='halo';const input=vi.fn();h.search.addEventListener('input',input);
 h.pad.buttons[2].pressed=true;h.step();expect(h.search.value).toBe('');expect(input).toHaveBeenCalledTimes(1);expect(document.activeElement).toBe(h.search);
 h.pad.buttons[1].pressed=true;h.step();expect(document.activeElement?.id).toBe('first');h.nav.dispose();
});
it('synthetic B clears the focused query once and second X returns the first card',()=>{
 const h=harness();h.search.focus();h.search.value='Forza';const input=vi.fn();h.search.addEventListener('input',input);
 h.pad.buttons[1].pressed=true;h.step();h.step();expect(h.search.value).toBe('');expect(input).toHaveBeenCalledTimes(1);expect(document.activeElement).toBe(h.search);
 h.pad.buttons[1].pressed=false;h.step();h.pad.buttons[2].pressed=true;h.step();expect(document.activeElement?.id).toBe('first');h.nav.dispose();
});
it('keyboard b/B is cloud dashboard only and never captures typing/modifiers/repeat/stream',()=>{
 const h=harness();document.getElementById('last')!.focus();expect(h.key('B').defaultPrevented).toBe(true);expect(document.activeElement).toBe(h.search);expect(h.key().defaultPrevented).toBe(false);
 for(const el of [document.querySelector('textarea')!,document.querySelector('[contenteditable]')!]){(el as HTMLElement).focus();expect(h.key().defaultPrevented).toBe(false);expect(document.activeElement).toBe(el);}
 document.getElementById('last')!.focus();for(const options of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{repeat:true},{isComposing:true}])expect(h.key('b',options).defaultPrevented).toBe(false);
 h.scope(false);expect(h.key().defaultPrevented).toBe(false);h.pad.buttons[2].pressed=true;h.step();expect(document.activeElement?.id).toBe('last');h.scope(true);h.stream();expect(h.key().defaultPrevented).toBe(false);h.nav.dispose();
});
