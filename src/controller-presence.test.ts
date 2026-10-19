// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import {createControllerPresence} from './controller-presence';
it('hidden by default, polls real connected API including nonstandard pads and disconnects; disposes',()=>{
 document.body.innerHTML='<kbd class="shoulder-hint" hidden>LB</kbd><kbd class="shoulder-hint" hidden>RB</kbd>';
 let connected=false;const raf=vi.fn();vi.stubGlobal('requestAnimationFrame',raf);
 vi.stubGlobal('navigator',{getGamepads:()=>[null,{connected,mapping:''}]});
 const presence=createControllerPresence();expect(document.querySelector('kbd')!.hidden).toBe(true);
 connected=true;window.dispatchEvent(new Event('gamepadconnected'));expect(document.querySelector('kbd')!.hidden).toBe(false);
 connected=false;window.dispatchEvent(new Event('gamepaddisconnected'));expect(document.querySelector('kbd')!.hidden).toBe(true);
 presence.dispose();expect(raf).not.toHaveBeenCalled();vi.unstubAllGlobals();document.body.replaceChildren();
});
