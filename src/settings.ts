import { LocalizedError } from './i18n';
import { resolutionProfile } from './stream-options';
export type StreamSettings = {resolution:string;bitrate:number;codec:string;audio:string;audioGain?:number};
export const DEFAULT_SETTINGS: StreamSettings = {resolution:'1920x1080',bitrate:30000,codec:'auto',audio:'opus',audioGain:1};
export const SETTINGS_KEY = 'xjaus:settings:v1';
export function validateSettings(value: unknown): StreamSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v=value as Record<string,unknown>;
  if(typeof v.resolution!=='string'||typeof v.codec!=='string'||typeof v.audio!=='string') return;
  if(Object.keys(v).some(k=>!['resolution','bitrate','codec','audio','audioGain'].includes(k))) return;
  if(!['1280x720','1920x1080','2560x1440'].includes(String(v.resolution)) || typeof v.bitrate!=='number' || !Number.isInteger(v.bitrate) || v.bitrate<15000 || v.bitrate>45000 || !['h264','hevc','auto'].includes(String(v.codec)) || !['opus','default'].includes(String(v.audio))) return;
  if(v.audioGain!==undefined && (typeof v.audioGain!=='number'||!Number.isFinite(v.audioGain)||v.audioGain<1||v.audioGain>1.5)) return;
  return {...(v.audioGain===undefined?{}:{audioGain:v.audioGain as number}),resolution:v.resolution as string,bitrate:v.bitrate,codec:v.codec as string,audio:v.audio as string};
}
/** Read-only migration; saves always use the strict modern bounds. */
function readSavedSettings(value:unknown):StreamSettings|undefined {
 const valid=validateSettings(value);if(valid)return valid;
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  const v=value as Record<string,unknown>;
  if(typeof v.bitrate==='number'&&Number.isInteger(v.bitrate)&&v.bitrate>=1000&&v.bitrate<=50000)return validateSettings({...v,bitrate:Math.max(15000,Math.min(45000,v.bitrate))});
 }
 return undefined;
}
export function engineSettings(value: StreamSettings) {
  const settings=validateSettings(value); if(!settings) throw new LocalizedError('invalidSettings');
  return {profile:resolutionProfile(settings.resolution),options:{bitrateKbps:settings.bitrate,codec:settings.codec,audio:settings.audio,...(settings.audioGain===undefined?{}:{audioGain:settings.audioGain})}};
}
export function createSettingsStore(storage: Pick<Storage,'getItem'|'setItem'>, loadBackend:(command:string)=>Promise<unknown>, saveBackend:(value:StreamSettings)=>Promise<unknown>) {
  let current={...DEFAULT_SETTINGS}; let ready=false; let loading:Promise<StreamSettings>|undefined; let queue:Promise<unknown>=Promise.resolve();
  const mirror=(value:StreamSettings)=>{try{storage.setItem(SETTINGS_KEY,JSON.stringify(value));}catch{/* disk remains authoritative */}};
  return {
    get current(){return {...current};},
    load():Promise<StreamSettings>{
      return loading??=(async()=>{
        let disk:unknown; try{disk=await loadBackend('load_settings');}catch{ /* recover from validated mirror */ }
        let value=readSavedSettings(disk);
        if(!value){
          try{const raw=storage.getItem(SETTINGS_KEY)??storage.getItem('xjaus:settings'); value=raw?readSavedSettings(JSON.parse(raw)):undefined;}catch{/* corrupt mirror */}
          // Only repair a missing/corrupt file after hydration, never write HTML defaults over saved data.
          if(value) await saveBackend(value);
        }
        current=value??{...DEFAULT_SETTINGS}; mirror(current); ready=true; return {...current};
      })();
    },
    save(value:StreamSettings):Promise<unknown>{
      const valid=validateSettings(value); if(!valid) return Promise.reject(new LocalizedError('invalidSettings'));
      if(!ready) return Promise.reject(new LocalizedError('settingsNotReady'));
      current=valid; mirror(valid);
      const write=queue.catch(()=>undefined).then(()=>saveBackend(valid)); queue=write; return write;
    },
    flush(){return queue;},
  };
}
