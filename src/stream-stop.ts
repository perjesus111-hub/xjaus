/** UI-side deadline only: the backend still owns its exact session handle.
 * Both completion and rejection are consumed even after the deadline. */
export function settleRemoteStop(operation:Promise<unknown>):Promise<void>{
 return new Promise(resolve=>{
  const finish=()=>{clearTimeout(timer);resolve();};
  const timer=setTimeout(finish,2000);
  void operation.then(finish,finish);
 });
}
