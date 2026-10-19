import {it,expect} from 'vitest';
import {DEFAULT_SETTINGS,validateSettings,engineSettings,createSettingsStore} from './settings';
it('defaults to 30Mbps Auto and unity gain, validates HEVC and gain boundaries',()=>{
 expect(DEFAULT_SETTINGS).toMatchObject({bitrate:30000,codec:'auto',audioGain:1});
 expect(validateSettings({...DEFAULT_SETTINGS,codec:'hevc',audioGain:1.5})).toMatchObject({codec:'hevc',audioGain:1.5});
 for(const patch of [{audioGain:.9},{audioGain:1.51},{audioGain:NaN},{bitrate:14999},{bitrate:45001}])expect(validateSettings({...DEFAULT_SETTINGS,...patch})).toBeUndefined();
 expect(engineSettings({...DEFAULT_SETTINGS,audioGain:1.3}).options).toMatchObject({audioGain:1.3});
});

it('migrates legacy bounded bitrate on load without losing codec/resolution preferences',async()=>{
 const old={resolution:'2560x1440',bitrate:12000,codec:'h264',audio:'default'};
 const store=createSettingsStore({getItem:()=>JSON.stringify(old),setItem:()=>{}},async()=>null,async()=>{});
 expect(await store.load()).toEqual({...old,bitrate:15000});
});
