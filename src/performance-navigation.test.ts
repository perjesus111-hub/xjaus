// @vitest-environment happy-dom
import {it, expect, vi} from 'vitest';
import {createControllerPresence} from './controller-presence';
import {createCatalogNavigation} from './catalog-navigation';

it('presence does not poll or rewrite unchanged hints and handles dynamic hints', () => {
 document.body.innerHTML='<kbd class="shoulder-hint" hidden></kbd>';
 let connected=false; const raf=vi.fn(); vi.stubGlobal('requestAnimationFrame',raf);
 vi.stubGlobal('navigator',{getGamepads:()=>connected?[{connected:true}]:[]});
 const hint=document.querySelector<HTMLElement>('.shoulder-hint')!;
 const presence=createControllerPresence();
 expect(raf).not.toHaveBeenCalled();
 connected=true;window.dispatchEvent(new Event('gamepadconnected'));
 expect(hint.hidden).toBe(false);
 const added=document.createElement('kbd');added.className='shoulder-hint';added.hidden=true;document.body.append(added);
 // Re-sync after a mount even if the hardware state did not change.
 window.dispatchEvent(new Event('gamepadconnected'));
 expect(added.hidden).toBe(false);
 presence.dispose(); vi.unstubAllGlobals();document.body.replaceChildren();
});

it('navigation gates idle RAF, starts on connection and cancels on disconnect', () => {
 document.body.innerHTML='<input id="search"><div id="grid"></div>';
 let connected=false;vi.stubGlobal('navigator',{getGamepads:()=>connected?[{connected:true,index:0,mapping:'standard',buttons:[],axes:[]}]:[]});
 const callbacks=new Map<number,FrameRequestCallback>();let id=0;
 const raf=vi.fn((cb:FrameRequestCallback)=>{callbacks.set(++id,cb);return id;});const cancel=vi.fn((n:number)=>callbacks.delete(n));
 vi.stubGlobal('requestAnimationFrame',raf);vi.stubGlobal('cancelAnimationFrame',cancel);
 const nav=createCatalogNavigation(document.querySelector('input')!,document.querySelector('#grid')!,()=>true);
 nav.sync();expect(raf).not.toHaveBeenCalled();
 connected=true;window.dispatchEvent(new Event('gamepadconnected'));expect(callbacks.size).toBe(1);
 const current=id;callbacks.get(current)!(0);callbacks.delete(current);expect(callbacks.size).toBe(1);
 connected=false;window.dispatchEvent(new Event('gamepaddisconnected'));expect(callbacks.size).toBe(0);expect(cancel).toHaveBeenCalled();
 nav.dispose();vi.unstubAllGlobals();document.body.replaceChildren();
});
