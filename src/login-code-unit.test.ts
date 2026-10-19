// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {createLoginCode} from './login-code';
import {i18n} from './i18n';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it.each([undefined,null,{},'', '   '])('never copies absent or invalid backend code %j',value=>{
 const writeText=vi.fn();vi.stubGlobal('navigator',{clipboard:{writeText}});
 const view=createLoginCode(value);view.button.click();expect(writeText).not.toHaveBeenCalled();expect(view.button.disabled).toBe(true);view.dispose();
});
it.each(['denied','missing'])('reports safe localized feedback when clipboard is %s',async mode=>{
 vi.useFakeTimers();i18n.setPreference('en');
 vi.stubGlobal('navigator',mode==='missing'?{}:{clipboard:{writeText:vi.fn().mockRejectedValue(new Error('PRIVATE NATIVE DETAIL'))}});
 const view=createLoginCode('TEST-CODE');view.button.click();await Promise.resolve();await Promise.resolve();
 expect(view.status.textContent).toBe('Could not copy. Select the code and copy it manually.');
 i18n.setPreference('es');expect(view.status.textContent).toBe('No se pudo copiar. Selecciona el código y cópialo manualmente.');
 expect(view.button.textContent).toBe('TEST-CODE');
 await vi.advanceTimersByTimeAsync(1800);expect(view.status.textContent).toBe('');view.dispose();
});
it('cleans its feedback timer and listener on disposal',async()=>{
 vi.useFakeTimers();vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn().mockResolvedValue(undefined)}});
 const view=createLoginCode('TEST-CODE');view.button.click();await Promise.resolve();
 expect(vi.getTimerCount()).toBe(1);view.dispose();expect(vi.getTimerCount()).toBe(0);
 view.button.click();expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
});
it('ignores clipboard completion after disposal',async()=>{
 vi.useFakeTimers();let finish!:()=>void;
 vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}))}});
 const view=createLoginCode('TEST-CODE');view.button.click();view.dispose();finish();await Promise.resolve();
 expect(view.status.textContent).toBe('');expect(vi.getTimerCount()).toBe(0);
});
