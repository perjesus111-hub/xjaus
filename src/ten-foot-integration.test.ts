// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import html from '../index.html?raw';
const backend=vi.hoisted(()=>vi.fn(async (command:string)=>{
 if(command==='auth_status')return {authenticated:true,account:'test-account',catalogAccountScope:'account-a'};
 if(command==='list_cloud_titles')return {results:[{titleId:'real-game',details:{hasEntitlement:true,productId:'9N2Z748SPMTM'}}]};
 if(command==='catalog_products')return {Products:[{ProductId:'9N2Z748SPMTM',Properties:{Category:'Action & adventure',XboxConsoleGenOptimized:['ConsoleGen9'],Attributes:[{Name:'XblOnlineMultiPlayer'}]},LocalizedProperties:[{ProductTitle:'Real metadata test',Images:[]}]}]};
 return {};
}));
vi.mock('./backend',()=>({invokeBackend:backend,openExternalUrl:vi.fn()}));
afterEach(()=>{window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();document.body.replaceChildren();});
it('real main UI: synthetic RB changes tabs/focus, local pills keep focus, favorite never launches',async()=>{
 const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});
 document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'));
 let rafId=0;const frames=new Map<number,FrameRequestCallback>();const frame=(now:number)=>{const batch=[...frames.values()];frames.clear();for(const cb of batch)cb(now);};
 const pad={connected:true,mapping:'standard',index:0,axes:[0,0],buttons:Array.from({length:16},()=>({pressed:false}))};
 vi.stubGlobal('navigator',{getGamepads:()=>[pad]});vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.set(++rafId,cb);return rafId;});vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
 await import('./main');await vi.waitFor(()=>expect(document.querySelector('#dashboard')?.hasAttribute('hidden')).toBe(false));
 frame(0);pad.buttons[5].pressed=true;frame(250);
 await vi.waitFor(()=>expect(document.querySelectorAll('#cloud-container .game-card')).toHaveLength(1));
 await vi.waitFor(()=>expect(document.activeElement?.classList.contains('connect-btn')).toBe(true));
 const before=backend.mock.calls.filter(([cmd])=>cmd==='list_cloud_titles').length;
 const pill=document.querySelector<HTMLButtonElement>('[data-filter="series"]')!;pill.focus();pill.click();expect(document.activeElement).toBe(pill);expect(pill.getAttribute('aria-pressed')).toBe('true');
 expect(document.querySelectorAll('#cloud-container .game-card')).toHaveLength(1);
 const favorite=document.querySelector<HTMLButtonElement>('.favorite-toggle')!;favorite.click();expect(favorite.getAttribute('aria-pressed')).toBe('true');
 expect(backend.mock.calls.filter(([cmd])=>cmd==='list_cloud_titles')).toHaveLength(before);
 expect(backend.mock.calls.some(([cmd])=>cmd==='start_stream')).toBe(false);
 const favoritesPill=document.querySelector<HTMLButtonElement>('[data-filter="favorites"]')!;favoritesPill.focus();favoritesPill.click();
 expect(document.querySelectorAll('#cloud-container .game-card')).toHaveLength(1);
 const removeFavorite=document.querySelector<HTMLButtonElement>('.favorite-toggle')!;removeFavorite.focus();removeFavorite.click();
 expect(document.querySelectorAll('#cloud-container .game-card')).toHaveLength(0);
 expect(document.activeElement).toBe(favoritesPill);
 expect(document.querySelector('#cloud-recent')?.hasAttribute('hidden')).toBe(true);
 frame(1000);expect(document.querySelector('#panel-cloud')?.hasAttribute('hidden')).toBe(false);
 pad.buttons[5].pressed=false;frame(1016);pad.buttons[5].pressed=true;frame(1250);
 expect(document.querySelector('#panel-settings')?.hasAttribute('hidden')).toBe(false);
 // Gamepad lands on the settings subnavigation (first real focus target).
 expect(document.activeElement?.getAttribute('data-settings-section')).toBe('general');
});
