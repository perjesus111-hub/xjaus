type RecordValue=Record<string,unknown>;
const record=(value:unknown):RecordValue=>value&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((s):s is string=>typeof s==='string').slice(0,100).map(s=>s.slice(0,120)):[];
/** Audited public DisplayCatalog Properties. No rights, inferred tags or credentials. */
export function sanitizeGameProperties(value:unknown){
 const p=record(value);
 return {
  Category:typeof p.Category==='string'?p.Category.slice(0,120):'',
  Categories:strings(p.Categories),XboxConsoleGenOptimized:strings(p.XboxConsoleGenOptimized),
  Attributes:(Array.isArray(p.Attributes)?p.Attributes:[]).slice(0,100).flatMap(value=>{
   const a=record(value);return typeof a.Name==='string'?[{Name:a.Name.slice(0,120),ApplicablePlatforms:Array.isArray(a.ApplicablePlatforms)?strings(a.ApplicablePlatforms):null}]:[];
  }),
 };
}
export function gameFeatures(properties:unknown){
 const p=sanitizeGameProperties(properties);
 const names=p.Attributes.filter(a=>a.ApplicablePlatforms===null||a.ApplicablePlatforms.some(platform=>platform==='Xbox'||platform.startsWith('Console'))).map(a=>a.Name);
 const features:{series?:boolean;action?:boolean;multiplayer?:boolean;controller?:boolean}={};
 if(p.XboxConsoleGenOptimized.includes('ConsoleGen9')||names.includes('ConsoleGen9Optimized'))features.series=true;
 if([p.Category,...p.Categories].includes('Action & adventure'))features.action=true;
 if(names.some(name=>['XblOnlineMultiPlayer','XblLocalMultiPlayer','XblOnlineCoop','XblLocalCoop','XblCrossPlatformMultiPlayer','XblCrossPlatformCoop','XboxLiveCrossGenMP'].includes(name)))features.multiplayer=true;
 // PcGamePad applies to PC, not cloud. XboxLive / cloud membership do not prove input support.
 return features;
}
