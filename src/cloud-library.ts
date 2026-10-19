import type {MessageKey} from './i18n';
import type { CloudTitle } from './catalog';
export type LibraryFilter='all'|'recent'|'series'|'action'|'multiplayer'|'favorites';
export const LIBRARY_FILTERS:ReadonlyArray<readonly [LibraryFilter,MessageKey]>=[['all','all'],['recent','recent'],['series','series'],['action','action'],['multiplayer','multiplayer'],['favorites','favorites']];
type Entry={titleId:string;productId?:string};
export type PlaybackEntry={type:'cloud'|'home';id:string;title:string;art:string;productId?:string};
type Data={favorites:Entry[];recent:PlaybackEntry[]};
const text=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):'';
function art(value:unknown){try{const url=new URL(text(value,4096));return url.protocol==='https:'&&['store-images.s-microsoft.com','images-eds.xboxlive.com','images-eds-ssl.xboxlive.com'].includes(url.hostname)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
function historyEntry(value:unknown):PlaybackEntry[]{
 if(!value||typeof value!=='object')return [];const e=value as Record<string,unknown>;
 const id=e.id??e.titleId;if(typeof id!=='string'||!id.length||id.length>256)return [];
 if(e.type!==undefined&&e.type!=='cloud'&&e.type!=='home')return [];
 return [{type:e.type==='home'?'home':'cloud',id,title:text(e.title,512),art:art(e.art),...(typeof e.productId==='string'?{productId:e.productId.slice(0,256)}:{})}];
}
const valid=(value:unknown):value is Entry=>!!value&&typeof value==='object'&&typeof (value as Entry).titleId==='string'&&(value as Entry).titleId.length>0&&(value as Entry).titleId.length<=256;
export class CloudLibrary {
 readonly key:string;
 constructor(private storage:Storage,private scope:string){this.key=`xjaus.library.v1:${encodeURIComponent(scope)}`;}
 private read():Data{
  if(!this.scope)return {favorites:[],recent:[]};
  try{const value=JSON.parse(this.storage.getItem(this.key)??'{}');return {favorites:Array.isArray(value.favorites)?value.favorites.filter(valid):[],recent:Array.isArray(value.recent)?value.recent.flatMap(historyEntry).slice(0,10):[]};}catch{return {favorites:[],recent:[]};}
 }
 private write(data:Data){if(this.scope)try{this.storage.setItem(this.key,JSON.stringify(data));}catch{/* optional personal state */}}
 favorites(){return this.read().favorites.map(e=>e.titleId);}
 toggle(game:CloudTitle){const data=this.read();data.favorites=data.favorites.some(e=>e.titleId===game.titleId)?data.favorites.filter(e=>e.titleId!==game.titleId):[...data.favorites,this.entry(game)];this.write(data);}
 history(){return this.read().recent;}
 recordHome(id:string,title:string){this.recordEntry({type:'home',id,title,art:''});}
 record(game:CloudTitle){if(game.playable!==true)return;this.recordEntry({type:'cloud',id:game.titleId,title:game.name,art:game.boxArt??'',...(game.productId?{productId:game.productId}:{})});}
 private recordEntry(entry:PlaybackEntry){const safe=historyEntry(entry)[0];if(!safe)return;const data=this.read();data.recent=[safe,...data.recent.filter(e=>e.id!==safe.id||e.type!==safe.type)].slice(0,10);this.write(data);}
 recent(fresh:CloudTitle[]){return this.read().recent.flatMap(e=>{if(e.type!=='cloud')return [];const game=fresh.find(g=>g.titleId===e.id&&g.playable===true&&(!e.productId||e.productId===g.productId));return game?[{...game,...(game.fallbackLabel&&e.title?{name:e.title,fallbackLabel:false}:{}),boxArt:game.boxArt||e.art||undefined}]:[];});}
 private entry(game:CloudTitle):Entry{return {titleId:game.titleId,...(game.productId?{productId:game.productId}:{})};}
}
export function filterLibrary(games:CloudTitle[],filter:LibraryFilter,favorites:string[],recent:string[]):CloudTitle[]{
 return games.filter(game=>filter==='all'||filter==='favorites'&&favorites.includes(game.titleId)||filter==='recent'&&recent.includes(game.titleId)||(['series','action','multiplayer'].includes(filter)&&game.features?.[filter as 'series'|'action'|'multiplayer']===true));
}
/** The active attempt owns this listener; launching/provisioning never writes history. */
export function bindSuccessfulCloudPlayback(video:HTMLVideoElement,active:()=>boolean,record:()=>void){
 let recorded=false,disposed=false,frame:number|undefined;
 const initialFrames=video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
 const commit=(presented:number)=>{
  if(!disposed&&!recorded&&active()&&presented>0&&video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0){recorded=true;record();}
 };
 const playing=()=>{
  if(!video.requestVideoFrameCallback)commit((video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0)-initialFrames);
  if(!recorded&&frame===undefined&&video.requestVideoFrameCallback)frame=video.requestVideoFrameCallback((_now,metadata)=>{frame=undefined;commit(metadata.presentedFrames);});
 };
 video.addEventListener('playing',playing);
 return ()=>{disposed=true;video.removeEventListener('playing',playing);if(frame!==undefined)video.cancelVideoFrameCallback?.(frame);};
}
