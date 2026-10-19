// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import html from '../index.html?raw';
const backend=vi.hoisted(()=>vi.fn(async(command:string)=>{if(command==='load_settings')return {resolution:'1920x1080',bitrate:15000,codec:'h264',audio:'opus'};if(command==='auth_status')throw new Error('invalid_grant: Raw backend diagnostic Inicia sesión');return {};}));
vi.mock('./backend',()=>({invokeBackend:backend,openExternalUrl:vi.fn()}));
it('a runtime locale switch preserves the focused reauth action and raw error details',async()=>{
 const local=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>local.get(k)??null,setItem:(k:string,v:string)=>local.set(k,v)});
 document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'));
 await import('./main');await vi.waitFor(()=>expect(document.querySelector('#toast button')).not.toBe(null));
 const button=document.querySelector<HTMLButtonElement>('#toast button')!;button.focus();const selector=document.querySelector<HTMLSelectElement>('#app-language')!;selector.value='en';selector.dispatchEvent(new Event('change'));
 expect(document.querySelector('#toast button')).toBe(button);expect(document.activeElement).toBe(button);expect(button.textContent).toContain('Your Microsoft session');expect(document.querySelector('#toast')!.textContent).toContain('Raw backend diagnostic Inicia sesión');expect(document.querySelector('#toast')!.textContent).toContain('Session status:');window.dispatchEvent(new Event('pagehide'));vi.unstubAllGlobals();
});
