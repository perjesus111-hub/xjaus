// @vitest-environment happy-dom
import {afterEach,it,expect,vi} from 'vitest';
import {showStreamLoading,disposeStreamLoading} from './loading-presentation';
import {i18n,t,bindText,bindProperty,transferBinding} from './i18n';
import {localizeDocument} from './i18n';
afterEach(()=>{vi.useRealTimers();document.body.replaceChildren();i18n.setPreference('auto');});
it('localizes the current tip immediately and every rotation without remounting',()=>{
 vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0);i18n.setPreference('es');const overlay=document.createElement('div');document.body.append(overlay);
 showStreamLoading(overlay,'cloud',{titleId:'a',name:'Official Product',playable:true});const title=overlay.querySelector('h1')!,tip=overlay.querySelector('.loading-tip')!;
 expect(tip.textContent).toBe(t('tip0'));i18n.setPreference('en');expect(tip.textContent).toBe(t('tip0'));expect(tip.textContent).toContain('Tip:');expect(overlay.querySelector('h1')).toBe(title);expect(title.textContent).toBe('Official Product');vi.advanceTimersByTime(6850);expect(tip.textContent).toBe(t('tip1'));i18n.setPreference('es');expect(tip.textContent).toBe(t('tip1'));disposeStreamLoading(overlay);expect(vi.getTimerCount()).toBe(0);vi.restoreAllMocks();
});
it('transfers hydrated localized labels without reviving provisional product names',()=>{const old=document.createElement('button'),fresh=document.createElement('button');bindProperty(old,'ariaLabel',()=>t('favoriteLabel',{name:'Provisional'}));bindProperty(fresh,'ariaLabel',()=>t('favoriteLabel',{name:'Official Product'}));expect(transferBinding(fresh,old,'ariaLabel')).toBe(true);i18n.setPreference('en');expect(old.ariaLabel).toBe('Favorite: Official Product');i18n.setPreference('es');expect(old.ariaLabel).toBe('Favorito: Official Product');});
it('localizes direct label text without replacing select or state',()=>{document.body.innerHTML='<label data-i18n="language">Idioma<select><option value="es">Español</option></select></label>';const select=document.querySelector('select')!;select.focus();localizeDocument();i18n.setPreference('en');expect(document.querySelector('label')!.firstChild!.textContent).toBe('Language');expect(document.activeElement).toBe(select);expect(select.value).toBe('es');});
it('does not translate identities or raw diagnostic details',()=>{const node=document.createElement('p');const raw='Inicia sesión: SessionNotConnectable';bindText(node,()=>t('connectionFailed',{name:'Jugar',error:raw}));i18n.setPreference('en');expect(node.textContent).toBe('Could not connect to Jugar: '+raw);});
