import {bindText,t,clearTextBinding} from './i18n';
/** Null is the viewport, not an arbitrarily chosen dashboard ancestor. */
export function findCatalogScrollRoot(grid:HTMLElement):HTMLElement|null {
 for(let parent=grid.parentElement;parent && parent!==document.body && parent!==document.documentElement;parent=parent.parentElement){if(/auto|scroll|overlay/.test(getComputedStyle(parent).overflowY))return parent;}
 return null;
}
/** Pagination is local: metadata hydration is a separate queue. One append per
 * event turn; neither pointer loading nor metadata may claim selection ownership. */
export function createInfiniteCatalog(grid:HTMLElement,load:()=>void|Promise<void>) {
 const sentinel=document.createElement('p');sentinel.className='catalog-sentinel';sentinel.setAttribute('role','status');sentinel.setAttribute('aria-live','polite');sentinel.setAttribute('aria-atomic','true');grid.after(sentinel);
 let root:HTMLElement|null=null,observer:IntersectionObserver|undefined,observerVersion=0;
 let shown=0,total=0,enabled=false,disposed=false,pending=false,generation=0;
 let frame:number|undefined, pendingOrigin:HTMLElement|undefined;
 function status(){bindText(sentinel,()=>pending?t('catalogLoading'):shown>=total?t('catalogEnd',{total}):t('catalogLoaded',{shown,total}));}
 function request(origin?:HTMLElement):boolean {
  if(disposed||!enabled)return false;
  if(pending){if(origin)pendingOrigin=origin;return !!origin;}
  if(shown>=total)return false;
  pendingOrigin=origin;
  const token=generation,oldLast=grid.lastElementChild;
  pending=true;status();
  let work:void|Promise<void>;
  try{work=load();}catch{pending=false;status();return false;}
  Promise.resolve(work).then(()=>{
   if(disposed||generation!==token)return;
   pending=false;status();
   // Explicit input alone may advance selection; changing focus revokes intent.
   const intention=pendingOrigin;pendingOrigin=undefined;
   if(intention && document.activeElement===intention && enabled){const first=oldLast?.nextElementSibling?.querySelector<HTMLButtonElement>('.connect-btn,button');first?.focus({preventScroll:true});first?.scrollIntoView?.({block:'nearest',inline:'nearest'});}
  },()=>{if(disposed||generation!==token)return;pending=false;status();});
  return true;
 }
 function threshold(){
  if(disposed||!enabled||pending||sentinel.closest('[hidden],[inert]'))return;
  // A hidden/remounting view has no usable geometry.
  if(root){if(root.clientHeight>0 && root.scrollHeight-root.scrollTop-root.clientHeight<=480)request();}
  else if(document.documentElement.clientHeight>0 && sentinel.getBoundingClientRect().top<=document.documentElement.clientHeight+480)request();
 }
 function mount(){
  observerVersion++;
  observer?.disconnect();const oldRoot=root;root=findCatalogScrollRoot(grid);
  if(sentinel.previousElementSibling!==grid)grid.after(sentinel);
  (oldRoot??window).removeEventListener('scroll',threshold);
  (root??window).addEventListener('scroll',threshold,{passive:true});
  if(typeof IntersectionObserver!=='undefined'){
   const observedGeneration=generation,version=observerVersion;
   observer=new IntersectionObserver(entries=>{if(version===observerVersion && observedGeneration===generation && entries.some(entry=>entry.isIntersecting))request();},{root,rootMargin:'480px 0px',threshold:0});observer.observe(sentinel);
  }
 }
 mount();window.addEventListener('resize',threshold);
 return {
  request,
  update(nextShown:number,nextTotal:number,active:boolean){
   if(disposed)return;
   shown=nextShown;total=nextTotal;enabled=active;sentinel.hidden=!active||!total;
   if(findCatalogScrollRoot(grid)!==root)mount();
   status();
   if(frame!==undefined)cancelAnimationFrame(frame);
   frame=requestAnimationFrame(()=>{frame=undefined;threshold();});
  },
  reset(){generation++;pendingOrigin=undefined;pending=false;enabled=false;shown=total=0;sentinel.hidden=true;observer?.disconnect();mount();},
  dispose(){if(disposed)return;disposed=true;generation++;observer?.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);(root??window).removeEventListener('scroll',threshold);window.removeEventListener('resize',threshold);clearTextBinding(sentinel);sentinel.remove();},
 };
}
