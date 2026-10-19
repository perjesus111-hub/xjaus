import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
let readFileSync: (path:URL,encoding:string)=>string;
beforeAll(async()=>{readFileSync=(await vi.importActual<{readFileSync:typeof readFileSync}>('node:fs')).readFileSync;});
import {createPlayerHudController} from './hud';
import {classListOf,createElement,host,playerVideo,resetTestState} from './test-helpers';
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();resetTestState();});
function fixture(focused=false){
 const hud=createElement('player-toolbar'),cursor=createElement('xjaus-cursor');
 const {video,dispatch,handlers}=playerVideo();
 const events=new Map<string,(e:unknown)=>void>();const blur=vi.fn();
 const win={...host.ownerWindow,document:{...host.ownerWindow.document,activeElement:{blur}},
 setTimeout:(f:()=>void,ms:number)=>setTimeout(f,ms),clearTimeout:(id:unknown)=>clearTimeout(id as ReturnType<typeof setTimeout>),
 addEventListener:(name:string,handler:(e:unknown)=>void)=>{events.set(name,handler);},removeEventListener:(name:string)=>{events.delete(name);}};
 const controller=createPlayerHudController({hud:{...hud,matches:()=>focused},cursor,video,window:win});
 return {hud,cursor,dispatch,handlers,events,controller,blur,move:(y:number)=>events.get('mousemove')?.({clientX:400,clientY:y})};
}
it('playing hides toolbar and cursor together only after 2500ms',()=>{
 const f=fixture();f.dispatch('playing');expect(f.controller.peek()).toBe(false);
 vi.advanceTimersByTime(2499);expect(f.controller.peek()).toBe(false);
 vi.advanceTimersByTime(1);expect(f.controller.peek()).toBe(true);expect(classListOf(f.hud)).toContain('hud-hidden');
 expect(f.cursor.getAttribute('data-hud')).toBe('hidden');expect(host.ownerWindow.document.documentElement.classList.contains('cursor-none')).toBe(true);f.controller.dispose();
});
it('only clientY < 60 wakes HUD; other moves never reset its deadline',()=>{
 const f=fixture();f.dispatch('playing');vi.advanceTimersByTime(2500);
 for(const y of [60,61,400,-1]){f.move(y);expect(f.controller.peek()).toBe(true);}
 f.move(59);expect(f.controller.peek()).toBe(false);vi.advanceTimersByTime(2400);f.move(400);vi.advanceTimersByTime(100);expect(f.controller.peek()).toBe(true);f.controller.dispose();
});
it('blurs focused toolbar on playing and does not let focus trap autohide',()=>{
 const f=fixture(true);f.dispatch('playing');expect(f.blur).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(2500);expect(f.controller.peek()).toBe(true);expect(f.blur).toHaveBeenCalledTimes(2);f.controller.dispose();
});
it('disposes playing/mouse listeners, timers and cursor state',()=>{
 const f=fixture();f.dispatch('playing');expect(vi.getTimerCount()).toBe(1);f.controller.dispose();expect(vi.getTimerCount()).toBe(0);expect(f.events.size).toBe(0);expect(f.handlers.get('playing')?.size).toBe(0);vi.advanceTimersByTime(5000);expect(f.controller.peek()).toBe(false);expect(host.ownerWindow.document.documentElement.classList.contains('cursor-none')).toBe(false);
});
it('preserves explicit autohide-off preference',()=>{
 host.ownerWindow.localStorage.setItem('xjaus:hudAutohide','off');const f=fixture();f.dispatch('playing');vi.advanceTimersByTime(5000);expect(f.controller.peek()).toBe(false);f.controller.dispose();host.ownerWindow.localStorage.removeItem('xjaus:hudAutohide');
});
it('hidden class and children block pointer interaction; only modal close explicitly reveals toolbar',()=>{
 const css=readFileSync(new URL('./styles.css',import.meta.url),'utf8');const main=readFileSync(new URL('./main.ts',import.meta.url),'utf8');
 expect(css).toContain('.player-toolbar.hud-hidden { opacity: 0; pointer-events: none; transition: opacity .3s');expect(css).toContain(".player-toolbar[data-hud='hidden'] > * { pointer-events: none; }");expect(main).toContain('if(!value)hud.reveal();');expect(main.replace('if(!value)hud.reveal();','')).not.toContain('hud.reveal()');
});
