// @vitest-environment happy-dom
import {beforeEach,describe,it,expect} from 'vitest';
import {createI18n, dictionaries, resolveLocale, LANGUAGE_KEY, bindText, i18n, LocalizedError, errorMessage} from './i18n';
class MapStorage {data=new Map<string,string>();getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,v);}clear(){this.data.clear();}}
describe('language preference',()=>{
 const localStorage=new MapStorage();
 beforeEach(()=>localStorage.clear());
 it.each(['es','ES','es-MX','Es_419','ES-es'])('detects Spanish OS %s',value=>expect(resolveLocale('auto',[value],'en-US')).toBe('es'));
 it('follows the OS language on first launch instead of forcing Spanish',()=>{
  expect(createI18n(new MapStorage(),['en-US'],'en-US').locale).toBe('en');
  expect(createI18n(new MapStorage(),['es-MX'],'es-MX').locale).toBe('es');
  expect(createI18n(new MapStorage(),[],'fr-FR').locale).toBe('en');
  expect(createI18n(new MapStorage(),[]).locale).toBe('en');
 });
 it('a saved manual preference still wins over the OS language on later launches',()=>{
  const saved=new MapStorage();saved.setItem(LANGUAGE_KEY,'es');
  expect(createI18n(saved,['en-US'],'en-US').locale).toBe('es');
 });
 it('normalizes script, numeric-region and environment locales to Spanish',()=>{for(const locale of ['es-MX','es-ES','es-419','es_MX.UTF-8','ES'])expect(resolveLocale('auto',[],locale)).toBe('es');});
 it('checks all preferred OS languages and falls back to English',()=>{expect(resolveLocale('auto',['fr','ES-ar'],'en')).toBe('es');expect(resolveLocale('auto',['fr'],'en')).toBe('en');expect(resolveLocale('auto',[],'es-ES')).toBe('es');});
 it('manual preference wins and persists without overwriting streaming settings',()=>{localStorage.setItem('xjaus:settings:v1','original');const store=createI18n(localStorage,['es-MX'],'es');store.setPreference('en');expect(store.locale).toBe('en');expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');expect(createI18n(localStorage,['es']).locale).toBe('en');expect(localStorage.getItem('xjaus:settings:v1')).toBe('original');store.setPreference('auto');expect(store.locale).toBe('es');});
 it('centralizes app-owned generic and control-channel errors',()=>{const store=createI18n(undefined,[],'en');expect(store.t('genericError',{error:'raw unchanged'})).toBe('Error: raw unchanged');store.setPreference('es');expect(store.t('controlChannelClosed')).toBe('El canal de control de Xbox no está abierto');});
 it('relocalizes app-owned errors but preserves raw backend diagnostic originals',()=>{i18n.setPreference('es');const owned=new LocalizedError('wakeHelp'),raw=new Error('Inicia sesión: SessionNotConnectable');i18n.setPreference('en');expect(errorMessage(owned)).toBe(dictionaries.en.wakeHelp);expect(errorMessage(raw)).toBe('Inicia sesión: SessionNotConnectable');expect(errorMessage('raw string')).toBe('raw string');});
 it('has exact dictionary parity and no blank translations',()=>{expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.es).sort());for(const value of Object.values(dictionaries.en))expect(value.trim()).not.toBe('');});
 it('updates owned text immediately without replacing focused controls or values',()=>{document.body.innerHTML='<button id="test">x</button><input value="keep">';const button=document.querySelector('button')!;i18n.setPreference('es');bindText(button,()=>i18n.t('play'));button.focus();i18n.setPreference('en');expect(button.textContent).toBe('Play');expect(document.activeElement).toBe(button);expect(document.querySelector('input')!.value).toBe('keep');});
});
