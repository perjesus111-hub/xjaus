/** One physical request across view epochs; stale work never paints. */
export function createConsolePolling<T>(fetch:()=>Promise<T>,render:(value:T)=>void,enabled:()=>boolean) {
 let active=false,disposed=false,busy=false,queued=false,epoch=0;
 let timer:ReturnType<typeof setInterval>|undefined;
 const refresh=()=>{
  if(disposed||!active||!enabled())return;
  if(busy){queued=true;return;}
  busy=true;queued=false;const request=epoch;
  void fetch().then(value=>{if(!disposed&&active&&enabled()&&request===epoch)render(value);}).catch(()=>{
   // Background discovery must not replace working cards or display banners.
  }).finally(()=>{busy=false;if(queued){queued=false;refresh();}});
 };
 const sync=()=>{
  const next=!disposed&&enabled();if(next===active)return;
  active=next;epoch++;queued=false;
  if(timer!==undefined)clearInterval(timer);timer=undefined;
  if(active){refresh();timer=setInterval(()=>{if(!busy)refresh();},7000);}
 };
 const onVisible=()=>{const was=active;sync();if(was&&active)refresh();};
 window.addEventListener('focus',onVisible);document.addEventListener('visibilitychange',onVisible);
 return {sync,refresh,invalidate(){active=false;epoch++;queued=false;if(timer!==undefined)clearInterval(timer);timer=undefined;},dispose(){disposed=true;sync();window.removeEventListener('focus',onVisible);document.removeEventListener('visibilitychange',onVisible);}};
}
