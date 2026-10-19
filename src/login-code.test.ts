// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import html from '../index.html?raw';
const f=vi.hoisted(()=>({write:vi.fn(async(_code:string)=>{}),invoke:vi.fn(async(cmd:string)=>cmd==='begin_login_window'?{user_code:'REAL-42',verification_uri:'https://microsoft.com/link',verification_uri_complete:'https://microsoft.com/link',interval:5,expires_in:60}:{authenticated:false})}));
vi.mock('./backend',()=>({invokeBackend:f.invoke,openExternalUrl:vi.fn(async()=>{})}));
afterEach(()=>{window.dispatchEvent(new Event('pagehide'));vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('copies the real pairing code using an accessible button and localized temporary feedback',async()=>{
 vi.useFakeTimers();
 document.documentElement.innerHTML=html.replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 vi.stubGlobal('navigator',{clipboard:{writeText:f.write},getGamepads:()=>[]});
 await import('./main');const {i18n}=await import('./i18n');
 await vi.advanceTimersByTimeAsync(0);
 document.querySelector<HTMLButtonElement>('#btn-login')!.click();await vi.advanceTimersByTimeAsync(0);
 const button=document.querySelector<HTMLButtonElement>('button.device-code');
 expect(button).not.toBeNull();
 expect(button!.type).toBe('button');expect(button!.textContent).toBe('REAL-42');
 button!.click();await vi.advanceTimersByTimeAsync(0);
 expect(f.write).toHaveBeenCalledExactlyOnceWith('REAL-42');
 const status=document.querySelector('.copy-code-status')!;
 i18n.setPreference('en');expect(status.textContent).toBe('Copied!');
 i18n.setPreference('es');expect(status.textContent).toBe('¡Copiado!');
 await vi.advanceTimersByTimeAsync(1800);expect(status.textContent).toBe('');
 f.invoke.mockRejectedValueOnce(new Error('No saved session'));
 document.querySelector<HTMLButtonElement>('#manual-login')!.click();await vi.advanceTimersByTimeAsync(0);
 button!.click();await vi.advanceTimersByTimeAsync(0);
 expect(f.write).toHaveBeenCalledTimes(1);
});
