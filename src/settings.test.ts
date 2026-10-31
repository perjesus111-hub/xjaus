import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { i18n } from "./i18n";
import { createSettingsStore, engineSettings, validateSettings, DEFAULT_SETTINGS, SETTINGS_KEY } from './settings';

let previousPreference: typeof i18n.preference;
beforeEach(() => { previousPreference = i18n.preference; i18n.setPreference("es"); });
afterEach(() => { i18n.setPreference(previousPreference); });

describe('persistent stream settings', () => {
  it('migrates only a validated legacy settings object', async () => {
    const desired={resolution:'2560x1440',bitrate:30000,codec:'h264',audio:'opus'};
    const values=new Map<string,string>([['xjaus:settings',JSON.stringify(desired)]]);const writes:unknown[]=[];
    const store=createSettingsStore({getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);}},async()=>null,async value=>{writes.push(value);});
    await store.load();expect(writes).toEqual([desired]);expect(JSON.parse(values.get(SETTINGS_KEY)!)).toEqual(desired);
  });
  it('rejects unsupported fields, wrong types and unbounded settings', () => {
    for (const value of [{...DEFAULT_SETTINGS,codec:['h264']},{...DEFAULT_SETTINGS,audio:['opus']},{...DEFAULT_SETTINGS,resolution:['1920x1080']},{...DEFAULT_SETTINGS,bitrate:'30000'},{...DEFAULT_SETTINGS,resolution:'4k'},{...DEFAULT_SETTINGS,codec:'h265'},{...DEFAULT_SETTINGS,audio:'untrusted'},{...DEFAULT_SETTINGS,bitrate:50001},{...DEFAULT_SETTINGS,bitrate:15000.5},{...DEFAULT_SETTINGS,path:'/anywhere'}]) expect(validateSettings(value)).toBeUndefined();
  });
  it('recovers corrupt disk using validated mirror and serializes rapid saves', async () => {
    const desired={resolution:'2560x1440',bitrate:30000,codec:'h264',audio:'opus'};
    const writes:unknown[]=[];
    const storage={getItem:(key:string)=>key===SETTINGS_KEY?JSON.stringify(desired):null,setItem:()=>{}};
    let release:()=>void=()=>{};
    const store=createSettingsStore(storage,async()=>{throw new Error('corrupt');},async value=>{writes.push(value);if(writes.length===2)await new Promise<void>(r=>{release=r;});});
    await store.load();
    const a=store.save({...desired,bitrate:20000}); const b=store.save({...desired,bitrate:25000});
    await Promise.resolve(); await Promise.resolve();
    expect(writes).toHaveLength(2); release(); await Promise.all([a,b]);
    expect(writes).toEqual([desired,{...desired,bitrate:20000},{...desired,bitrate:25000}]);
  });
  it('does not save corrupt mirror or defaults over hydration', async () => {
    let writes=0;const store=createSettingsStore({getItem:()=>'{bad',setItem:()=>{}},async()=>null,async()=>{writes++;});
    await expect(store.save(DEFAULT_SETTINGS)).rejects.toThrow('no cargados');
    await store.load();expect(store.current).toEqual(DEFAULT_SETTINGS);expect(writes).toBe(0);
  });
  it('awaits disk hydration without overwriting saved settings; restart preserves engine payload', async () => {
    let disk: unknown = {resolution:'2560x1440',bitrate:30000,codec:'h264',audio:'opus'};
    const local = new Map<string,string>(); let saves=0;
    const make = () => createSettingsStore({getItem:k=>local.get(k)??null,setItem:(k,v)=>{local.set(k,v);}}, async cmd => {
      if(cmd==='load_settings') return disk;
      throw new Error('unexpected');
    }, async value=>{saves++;disk=value;});
    const first=make(); await first.load(); expect(saves).toBe(0);
    expect(first.current).toEqual(disk);
    await first.save({...first.current,audio:'default'});
    const restart=make(); await restart.load();
    expect(engineSettings(restart.current)).toEqual({profile:{width:2560,height:1440},options:{bitrateKbps:30000,codec:'h264',audio:'default'}});
  });
});
