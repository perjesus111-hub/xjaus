// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import html from '../index.html?raw';
const backend=vi.hoisted(()=>vi.fn(async(command:string)=>{if(command==='load_settings')return {resolution:'1920x1080',bitrate:15000,codec:'h264',audio:'opus'};if(command==='auth_status')throw new Error('invalid_grant: Raw backend diagnostic Inicia sesión');return {};}));
vi.mock('./backend',()=>({invokeBackend:backend,openExternalUrl:vi.fn()}));
it('a runtime locale switch preserves the focused reauth action and raw error details',async()=>{
 const values=new Map<string,string>();
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 Object.defineProperty(window,'localStorage',{configurable:true,value:storage});vi.stubGlobal('localStorage',storage);
 const {createI18n,i18n,LANGUAGE_KEY}=await import('./i18n');
 i18n.setPreference('auto');window.localStorage.removeItem(LANGUAGE_KEY);
 document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'));
 await import('./main');await vi.waitFor(()=>expect(document.querySelector('#toast button')).not.toBe(null));
 const button=document.querySelector<HTMLButtonElement>('#toast button')!;button.focus();const selector=document.querySelector<HTMLSelectElement>('#app-language')!;selector.value='en';selector.dispatchEvent(new Event('change'));
 expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('en');expect(createI18n(window.localStorage,['es-MX']).locale).toBe('en');
 expect(document.querySelector('#toast button')).toBe(button);expect(document.activeElement).toBe(button);expect(button.textContent).toContain('Your Microsoft session');expect(document.querySelector('#toast')!.textContent).toContain('Raw backend diagnostic Inicia sesión');expect(document.querySelector('#toast')!.textContent).toContain('Session status:');
 expect(document.querySelector<HTMLElement>('#output')!.textContent).toContain('Session status:');
 selector.value='es';selector.dispatchEvent(new Event('change'));
 expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('es');expect(createI18n(window.localStorage,['en-US']).locale).toBe('es');
 expect(document.querySelector<HTMLElement>('#output')!.textContent).toContain('Estado de sesión:');
 expect(document.querySelector('#toast')!.textContent).toContain('Estado de sesión:');
 expect(document.querySelector('#toast')!.textContent).toContain('Raw backend diagnostic Inicia sesión');
 i18n.setPreference('auto');window.localStorage.removeItem(LANGUAGE_KEY);window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();
});
