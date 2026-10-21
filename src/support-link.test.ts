// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import html from '../index.html?raw';
const f=vi.hoisted(()=>({open:vi.fn(async(_url:string)=>{}),invoke:vi.fn(async(cmd:string)=>cmd==='auth_status'?{authenticated:false}: {})}));
vi.mock('./backend',()=>({invokeBackend:f.invoke,openExternalUrl:f.open}));
it('localized final support card: pointer, synthetic dpad/stick focus and single A-edge dispatch',async()=>{
 vi.useFakeTimers();
 document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 const callbacks=new Map<number,FrameRequestCallback>();let next=0;
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{callbacks.set(++next,cb);return next;});
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>callbacks.delete(id));
 const pad={connected:true,mapping:'standard',index:0,buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]};
 vi.stubGlobal('navigator',{getGamepads:()=>[pad]});
 const tick=(time:number)=>{const batch=[...callbacks.values()];callbacks.clear();batch.forEach(cb=>cb(time));};
 let active:ReturnType<typeof import('./catalog-navigation').createCatalogNavigation>|undefined;
 try{
  const {i18n}=await import('./i18n');await import('./main');
  for(let n=0;n<20;n++)await Promise.resolve();
  // Dispose main's menu owner before installing the isolated navigation owner.
  window.dispatchEvent(new Event('pagehide'));
  document.querySelector<HTMLElement>('#login-screen')!.hidden=true;
  document.querySelector<HTMLElement>('#dashboard')!.hidden=false;
  document.querySelector<HTMLElement>('#panel-settings')!.hidden=false;
  // Real user flow: the support card lives in the "Diagnóstico" sub-section.
  document.querySelector<HTMLButtonElement>('[data-settings-section="diagnostico"]')!.click();
  vi.spyOn(window,'getComputedStyle').mockImplementation(()=>({display:'block',visibility:'visible'}) as CSSStyleDeclaration);
  const button=document.querySelector<HTMLButtonElement>('#support-us')!;
  // Support card lives inside the "Diagnóstico" settings sub-section now.
  expect(button.closest('.support-card')).toBeTruthy();
  expect(button.closest('[data-settings-panel="diagnostico"]')).toBe(document.querySelector('#settings-panel-diagnostico'));
  i18n.setPreference('es');expect(button.textContent).toBe('Apóyanos');
  expect(document.querySelector('#support-desc')!.textContent).toBe('Apoya el desarrollo continuo de XJAUS');
  i18n.setPreference('en');expect(button.textContent).toBe('Support Us');
  expect(document.querySelector('#support-desc')!.textContent).toBe('Support the ongoing development of XJAUS');
  button.click();await Promise.resolve();expect(f.open).toHaveBeenCalledExactlyOnceWith('https://paypal.me/Comicoon');f.open.mockClear();
  const {createCatalogNavigation}=await import('./catalog-navigation');
  active=createCatalogNavigation(document.querySelector('#cloud-search')!,document.querySelector('#cloud-container')!,()=>true,()=>false,{enabled:()=>true,index:()=>2,switch:()=>{}});
  active.sync();tick(0);
  const controls=active.settingsControls();expect(controls[controls.length-1]).toBe(button);
  controls[controls.length-2].focus();pad.buttons[13].pressed=true;tick(100);
  expect(document.activeElement).toBe(button);expect(button.classList.contains('gamepad-focus')).toBe(true);
  pad.buttons[13].pressed=false;tick(200);
  pad.axes[1]=-1;tick(300);expect(document.activeElement).toBe(controls[controls.length-2]);
  pad.axes[1]=0;tick(400);pad.axes[1]=1;tick(500);expect(document.activeElement).toBe(button);
  pad.axes[1]=0;tick(600);pad.buttons[0].pressed=true;tick(700);tick(900);tick(1200);
  expect(f.open).toHaveBeenCalledExactlyOnceWith('https://paypal.me/Comicoon');
  pad.buttons[0].pressed=false;tick(1300);pad.buttons[0].pressed=true;tick(1400);
  expect(f.open).toHaveBeenCalledTimes(2);
 }finally{active?.dispose();window.dispatchEvent(new Event('pagehide'));vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();document.body.replaceChildren();}
});
