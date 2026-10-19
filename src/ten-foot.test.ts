// @vitest-environment happy-dom
import {expect,it,vi,afterEach} from 'vitest';
import {ShoulderTabs, ViewFocusIntent,focusGamepad} from './ten-foot';
afterEach(()=>{vi.restoreAllMocks();document.body.replaceChildren();});
it('shoulders wrap on rising edges, debounce 200ms, never repeat held, dashboard only',()=>{
 const tabs=new ShoulderTabs();
 expect(tabs.read([],0,true,0)).toBeUndefined();
 expect(tabs.read([5],10,true,0)).toBe(1);
 expect(tabs.read([5],900,true,1)).toBeUndefined();
 tabs.read([],910,true,1);
 expect(tabs.read([4],920,true,0)).toBe(2);
 tabs.read([],930,true,2);
 expect(tabs.read([5],940,true,2)).toBeUndefined();
 tabs.read([],1200,false,2);
 expect(tabs.read([5],1210,false,2)).toBeUndefined();
 expect(tabs.read([5],1500,true,2)).toBeUndefined();
});
it('gamepad focus scrolls smoothly nearest/center and honors reduced motion',()=>{
 document.body.innerHTML='<button id="target">Play</button>';
 const target=document.querySelector<HTMLElement>('#target')!,scroll=vi.fn();target.scrollIntoView=scroll;
 const media=vi.spyOn(window,'matchMedia').mockReturnValue({matches:false} as MediaQueryList);
 focusGamepad(target);expect(scroll).toHaveBeenLastCalledWith({behavior:'smooth',block:'nearest',inline:'center'});
 media.mockReturnValue({matches:true} as MediaQueryList);focusGamepad(target);expect(scroll).toHaveBeenLastCalledWith({behavior:'auto',block:'nearest',inline:'center'});
 expect(document.activeElement).toBe(target);expect(target.classList.contains('gamepad-focus')).toBe(true);
});
it('async view focus waits for card but user editing cancels intent',()=>{
 document.body.innerHTML='<button id="tab">Cloud</button><section id="panel"></section><input id="edit">';
 const panel=document.querySelector<HTMLElement>('#panel')!,tab=document.querySelector<HTMLElement>('#tab')!;
 const intent=new ViewFocusIntent(); tab.focus(); intent.begin(panel,'.card button');
 expect(intent.flush()).toBe(false);
 panel.innerHTML='<article class="card"><button>Play</button></article>';
 expect(intent.flush()).toBe(true);expect(document.activeElement?.textContent).toBe('Play');
 tab.focus();panel.replaceChildren();intent.begin(panel,'.card button');document.querySelector<HTMLInputElement>('#edit')!.focus();panel.innerHTML='<article class="card"><button>Play</button></article>';
 expect(intent.flush()).toBe(false);expect(document.activeElement?.id).toBe('edit');
});
