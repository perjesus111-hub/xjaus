// @vitest-environment happy-dom
import {expect,it} from 'vitest';
import {CloudLibrary, filterLibrary, bindSuccessfulCloudPlayback} from './cloud-library';
import type {CloudTitle} from './catalog';
const storage = () => { const data=new Map<string,string>(); return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}} as Storage; };
const games:CloudTitle[]=Array.from({length:6},(_,i)=>({titleId:String(i),name:`Game ${i}`,playable:true}));
it('ten minimal metadata records survive new store instances, isolate accounts and preserve title during hydration, never grant rights',()=>{
 const store=storage(),lib=new CloudLibrary(store,'a');
 for(let i=0;i<12;i++)lib.record({titleId:String(i),name:`Title ${i}`,boxArt:'https://store-images.s-microsoft.com/image/apps.test',playable:true});
 const restored=new CloudLibrary(store,'a');expect(restored.history()).toHaveLength(10);expect(restored.history()[0]).toEqual({type:'cloud',id:'11',title:'Title 11',art:'https://store-images.s-microsoft.com/image/apps.test'});
 expect(new CloudLibrary(store,'b').history()).toEqual([]);
 expect(restored.recent([{titleId:'11',name:'slug',fallbackLabel:true,playable:true}])[0].name).toBe('Title 11');expect(restored.recent([])).toEqual([]);
});
it('home playback metadata persists separately and never becomes cloud-playable even with same ID',()=>{
 const store=storage(),lib=new CloudLibrary(store,'a');lib.recordHome('0','My console');expect(lib.history()).toEqual([{type:'home',id:'0',title:'My console',art:''}]);expect(lib.recent(games)).toEqual([]);
 lib.record(games[0]);expect(lib.history()).toHaveLength(2);expect(new CloudLibrary(store,'a').history()[1].type).toBe('home');expect(new CloudLibrary(store,'').history()).toEqual([]);
});
it('rejects oversized history identifiers and strips unsupported art/fields from persisted records',()=>{
 const store=storage(),lib=new CloudLibrary(store,'a');store.setItem(lib.key,JSON.stringify({recent:[{type:'cloud',id:'x'.repeat(257),title:'bad',art:''},{type:'home',id:'valid',title:'Console',art:'https://evil.example/art',secret:'not metadata'}]}));
 expect(lib.history()).toEqual([{type:'home',id:'valid',title:'Console',art:''}]);
});
it('favorites isolate accounts and persist identifiers only',()=>{
 const store=storage();const a=new CloudLibrary(store,'a'),b=new CloudLibrary(store,'b');
 a.toggle(games[0]);expect(a.favorites()).toEqual(['0']);expect(b.favorites()).toEqual([]);expect(new CloudLibrary(store,'a').favorites()).toEqual(['0']);
 expect(store.getItem(a.key)).not.toContain('Game');a.toggle(games[0]);expect(a.favorites()).toEqual([]);
});
it('history capped ten, fresh rights only, no launch or failed video evidence',()=>{
 const store=storage();const lib=new CloudLibrary(store,'a');const video=document.createElement('video');
 const release=bindSuccessfulCloudPlayback(video,()=>true,()=>lib.record(games[0]));
 expect(lib.recent(games)).toEqual([]);video.dispatchEvent(new Event('playing'));expect(lib.recent(games)).toEqual([]);
 Object.defineProperties(video,{videoWidth:{value:1920},videoHeight:{value:1080},readyState:{value:3}});
 video.dispatchEvent(new Event('playing'));expect(lib.recent(games)).toEqual([]);
 Object.defineProperty(video,'getVideoPlaybackQuality',{value:()=>({totalVideoFrames:1})});
 video.dispatchEvent(new Event('playing'));expect(lib.recent(games).map(g=>g.titleId)).toEqual(['0']);release();
 for(const game of games)lib.record(game);
 expect(lib.recent(games).map(g=>g.titleId)).toEqual(['5','4','3','2','1','0']);
 expect(lib.recent([{...games[5],playable:false}])).toEqual([]);
});
it('presented-frame callback is attempt scoped, one-shot, and cancelled on disposal',()=>{
 const video=document.createElement('video');let callback:VideoFrameRequestCallback=()=>{};let active=true;let records=0;let cancelled=0;
 Object.defineProperties(video,{videoWidth:{value:1280},videoHeight:{value:720},readyState:{value:3},requestVideoFrameCallback:{value:(cb:VideoFrameRequestCallback)=>{callback=cb;return 7;}},cancelVideoFrameCallback:{value:()=>{cancelled++;}}});
 const release=bindSuccessfulCloudPlayback(video,()=>active,()=>{records++;});
 video.dispatchEvent(new Event('playing'));expect(records).toBe(0);active=false;callback(1,{presentedFrames:1} as VideoFrameCallbackMetadata);expect(records).toBe(0);
 active=true;video.dispatchEvent(new Event('playing'));callback(2,{presentedFrames:1} as VideoFrameCallbackMetadata);callback(3,{presentedFrames:2} as VideoFrameCallbackMetadata);expect(records).toBe(1);release();
 const release2=bindSuccessfulCloudPlayback(video,()=>true,()=>{records++;});video.dispatchEvent(new Event('playing'));release2();expect(cancelled).toBe(1);callback(4,{presentedFrames:1} as VideoFrameCallbackMetadata);expect(records).toBe(1);
});
it('unknown account cannot persist favorites or history; repeated playback deduplicates IDs',()=>{
 const store=storage(),unknown=new CloudLibrary(store,''),known=new CloudLibrary(store,'known');
 unknown.toggle(games[0]);unknown.record(games[0]);expect(unknown.favorites()).toEqual([]);expect(unknown.recent(games)).toEqual([]);
 known.record(games[0]);known.record(games[1]);known.record(games[0]);expect(known.recent(games).map(g=>g.titleId)).toEqual(['0','1']);
});
it('filters exclude unknown metadata, local recents and favorites only',()=>{
 const list=[...games,{titleId:'known',name:'Known',playable:true,features:{series:true,action:true,multiplayer:true,controller:true}}];
 for(const filter of ['series','action','multiplayer'] as const)expect(filterLibrary(list,filter,[],[]).map(g=>g.titleId)).toEqual(['known']);
 expect(filterLibrary(list,'favorites',['1'],[])).toEqual([games[1]]);
 expect(filterLibrary(list,'recent',[],['2'])).toEqual([games[2]]);
});
