/// <reference lib="es2021.weakref" />
import { dictionaries, type MessageKey } from './i18n-dictionary';
export {dictionaries};
export type {MessageKey};
export type Locale='es'|'en';
export type LanguagePreference=Locale|'auto';
export const LANGUAGE_KEY='xjaus:language:v1';
export function resolveLocale(preference:LanguagePreference,languages:readonly string[]=[],language=''):Locale {
 if(preference!=='auto')return preference;
 return [...languages,language].some(value=>/^es(?:[-_]|$)/i.test(value))?'es':'en';
}
export function createI18n(storage?:Pick<Storage,'getItem'|'setItem'>,languages:readonly string[]=[],language='') {
 // First launch follows the OS language ('auto'); only an explicit saved preference overrides it.
 let preference:LanguagePreference='auto';
 try{const saved=storage?.getItem(LANGUAGE_KEY);if(saved==='en'||saved==='es'||saved==='auto')preference=saved;}catch{/* storage may be denied */}
 const listeners=new Set<()=>void>();
 return {
  get preference(){return preference;},
  get locale(){return resolveLocale(preference,languages,language);},
  t(key:MessageKey,params:Record<string,string|number>={}) {return dictionaries[resolveLocale(preference,languages,language)][key].replace(/\{(\w+)\}/g,(match,name)=>Object.prototype.hasOwnProperty.call(params,name)?String(params[name]):match);},
  setPreference(value:LanguagePreference){if(!['es','en','auto'].includes(value))return;preference=value;try{storage?.setItem(LANGUAGE_KEY,value);}catch{/* session preference still works */}for(const listener of listeners)listener();},
  subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
 };
}
let storage:Storage|undefined;try{if(typeof window!=='undefined')storage=window.localStorage;}catch{/* denied */}
export const i18n=createI18n(storage,globalThis.navigator?.languages??[],globalThis.navigator?.language??'');
export const t=i18n.t;
if(typeof window!=='undefined')console.info('[XJAUS i18n]', {preference:i18n.preference, locale:i18n.locale, languages:globalThis.navigator?.languages});
/** Only explicit app errors are localizable; never pattern-match raw diagnostics. */
export class LocalizedError extends Error {
 constructor(readonly key:MessageKey,readonly params:Record<string,string|number>={}) { super(t(key,params));this.name='LocalizedError'; }
}
export function errorMessage(error:unknown):string {
 return error instanceof LocalizedError ? t(error.key,error.params) : error instanceof Error ? error.message : String(error);
}
// Weak targets: locale changes update owned copy, never remount controls, steal focus,
// reset values, or retain disposed views. Multiple properties on a target are distinct.
// Keep callbacks exclusively in a WeakMap ephemeron. A global callback Set can
// retain a detached element indirectly through its own render closure even when
// the binding's explicit target is a WeakRef (covered by a real --expose-gc test).
const targets=new Set<WeakRef<object>>();
const references=new WeakMap<object,WeakRef<object>>();
const owned=new WeakMap<object,Map<string,()=>string>>();
export function bindText<T extends {textContent:string|null}>(target:T,render:()=>string):void { bindProperty(target,'textContent',render); }
export function bindProperty(target:object,property:string,render:()=>string):void {
 let map=owned.get(target);
 if(!map){map=new Map();owned.set(target,map);const reference=new WeakRef(target);references.set(target,reference);targets.add(reference);}
 map.set(property,render);
 (target as Record<string,unknown>)[property]=render();
}
export function transferBinding(source:object,target:object,property:string):boolean {
 const render=owned.get(source)?.get(property);
 if(!render)return false;
 bindProperty(target,property,render);return true;
}
export function clearTextBinding(target:object):void {
 const map=owned.get(target);map?.delete('textContent');
 if(map && !map.size){const reference=references.get(target);if(reference)targets.delete(reference);references.delete(target);owned.delete(target);}
}
i18n.subscribe(()=>{
 if(typeof document!=='undefined')document.documentElement.lang=i18n.locale;
 for(const reference of targets){const target=reference.deref();if(!target){targets.delete(reference);continue;}for(const [property,render] of owned.get(target)??[])(target as Record<string,unknown>)[property]=render();}
});
export function localizeDocument(root:Document=document):void {
 root.documentElement.lang=i18n.locale;
 for(const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
  const key=element.dataset.i18n as MessageKey;
  // Direct text child keeps labels, buttons and icons intact.
  const text=[...element.childNodes].find(node=>node.nodeType===3&&!!node.textContent?.trim());
  if(text)bindText(text,()=>t(key));else bindText(element,()=>t(key));
 }
 for(const element of root.querySelectorAll<HTMLElement>('[data-i18n-aria],[data-i18n-placeholder],[data-i18n-title]')) {
  for(const [data,property] of [['i18nAria','ariaLabel'],['i18nPlaceholder','placeholder'],['i18nTitle','title']] as const){const key=element.dataset[data] as MessageKey|undefined;if(key)bindProperty(element,property,()=>t(key));}
 }
}
