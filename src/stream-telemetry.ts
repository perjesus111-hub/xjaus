export type Telemetry = {fps:number|null;mbps:number|null;rttMs:number|null;lossPercent:number|null;decodeMs:number|null};
type VideoStat = {id:string;timestamp:number;framesDecoded?:number;bytesReceived?:number;totalDecodeTime?:number;packetsLost?:number;packetsReceived?:number};
function video(report?:RTCStatsReport): VideoStat|undefined {
 let result:VideoStat|undefined;
 report?.forEach(s=>{if(s.type==='inbound-rtp' && (s.kind==='video'||s.mediaType==='video') && !s.isRemote) result=s;});return result;
}
export function telemetryDelta(report:RTCStatsReport,previous?:RTCStatsReport):Telemetry {
 const a=video(previous),b=video(report);let rttMs:number|null=null;
 report.forEach(s=>{if(s.type==='transport' && s.selectedCandidatePairId){const pair=report.get(s.selectedCandidatePairId);if(typeof pair?.currentRoundTripTime==='number')rttMs=pair.currentRoundTripTime*1000;}});
 if(rttMs===null)report.forEach(s=>{if(s.type==='candidate-pair' && s.state==='succeeded' && (s.selected||s.nominated) && typeof s.currentRoundTripTime==='number')rttMs=s.currentRoundTripTime*1000;});
 const delta=(key:keyof VideoStat)=>a&&b&&a.id===b.id&&typeof a[key]==='number'&&typeof b[key]==='number' ? (b[key] as number)-(a[key] as number):NaN;
 const seconds=delta('timestamp')/1000,frames=delta('framesDecoded'),bytes=delta('bytesReceived'),decode=delta('totalDecodeTime'),lost=delta('packetsLost'),received=delta('packetsReceived');
 const valid=Number.isFinite(seconds)&&seconds>0;
 return {fps:valid&&frames>=0?frames/seconds:null,mbps:valid&&bytes>=0?bytes*8/seconds/1e6:null,rttMs,
 lossPercent:valid&&lost>=0&&received>=0&&lost+received>0?lost/(lost+received)*100:null,
 decodeMs:valid&&frames>0&&decode>=0?decode*1000/frames:null};
}
/** Hidden means zero sampling; generation guards prevent stale async rendering. */
export function createStreamTelemetry(peer:Pick<RTCPeerConnection,'getStats'>,render:(stats:Telemetry)=>void) {
 let visible=false,disposed=false,generation=0,timer:ReturnType<typeof setInterval>|undefined,previous:RTCStatsReport|undefined;
 const sample=async(epoch:number)=>{
  try{const report=await peer.getStats();if(disposed||!visible||epoch!==generation)return;render(telemetryDelta(report,previous));previous=report;}catch{/* next visible tick can retry */}
 };
 let busyEpoch:number|undefined;
 const poll=(epoch:number)=>{if(busyEpoch===epoch)return;busyEpoch=epoch;void sample(epoch).finally(()=>{if(busyEpoch===epoch)busyEpoch=undefined;});};
 return {get visible(){return visible;},setVisible(value:boolean){
  if(disposed||value===visible)return;visible=value;generation++;previous=undefined;
  if(timer!==undefined)clearInterval(timer);timer=undefined;
  if(visible){const epoch=generation;poll(epoch);timer=setInterval(()=>poll(epoch),1000);}
 },dispose(){disposed=true;visible=false;generation++;previous=undefined;if(timer!==undefined)clearInterval(timer);timer=undefined;}};
}
/** A grace period only; no unsupported signaling or renegotiation. */
export class ConnectionGrace {
 private timer?:ReturnType<typeof setTimeout>;private disposed=false;private ended=false;
 constructor(private end:()=>void,private indicator:(visible:boolean)=>void){}
 update(connection:string,ice:string):void {
  if(this.disposed||this.ended)return;
  if([connection,ice].some(s=>s==='failed'||s==='closed')){this.finish();return;}
  if(connection==='disconnected'||ice==='disconnected'){
   this.indicator(true);if(this.timer===undefined)this.timer=setTimeout(()=>this.finish(),6000);
  }else if(connection==='connected'&&(ice==='connected'||ice==='completed')){this.clear();this.indicator(false);}
 }
 private clear(){if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
 private finish(){this.clear();if(this.disposed||this.ended)return;this.ended=true;this.indicator(false);this.end();}
 dispose(){this.disposed=true;this.clear();this.indicator(false);}
}
