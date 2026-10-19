/** Shared shoulder gate; only standard-pad callers feed button indices. */
export class ShoulderTabs {
 private held = new Set<number>();
 private initialized = false;
 private last = -Infinity;
 read(pressed: number[], now: number, dashboard: boolean, index: number): number | undefined {
  const next=new Set(pressed);
  const edge=this.initialized ? [4,5].find(b=>next.has(b)&&!this.held.has(b)) : undefined;
  this.held=next;this.initialized=true;
  if(!dashboard || edge===undefined || now-this.last<200) return;
  this.last=now;return (index+(edge===4 ? -1 : 1)+3)%3;
 }
}
/** Pending async focus is conditional on the user's original focus intent. */
export class ViewFocusIntent {
 private pending?: {panel:HTMLElement; selector:string; origin:Element|null};
 begin(panel:HTMLElement,selector:string){this.pending={panel,selector,origin:document.activeElement};this.flush();}
 cancel(){this.pending=undefined;}
 flush():boolean {
  const p=this.pending;if(!p)return false;
  if(p.panel.hidden || (document.activeElement!==p.origin && document.activeElement!==document.body)){this.cancel();return false;}
  const target=[...p.panel.querySelectorAll<HTMLElement>(p.selector)].find(e=>!e.matches(':disabled')&&!e.closest('[hidden],[inert]'));
  if(!target)return false;
  this.cancel();focusGamepad(target);return true;
 }
}
export function focusGamepad(target:HTMLElement){
 document.querySelectorAll('.gamepad-focus').forEach(e=>e.classList.remove('gamepad-focus'));
 target.classList.add('gamepad-focus');target.focus({preventScroll:true});
 target.scrollIntoView?.({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'nearest',inline:'center'});
}
