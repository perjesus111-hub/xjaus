import { ShoulderTabs, focusGamepad } from './ten-foot';
export class CatalogPadEdges {
  private previous: Set<number> | undefined;
  reset() { this.previous = undefined; }
  read(pressed: number[]): number[] {
    const next = new Set(pressed);
    const edges = this.previous ? pressed.filter(button => !this.previous!.has(button)) : [];
    this.previous = next;
    return edges;
  }
}
export function catalogDestination(index: number, button: number, columns: number, count: number): number {
  if (!count) return -1;
  if (index < 0) return button === 1 || button === 13 ? 0 : -1;
  if (button === 12) return index < columns ? -1 : index - columns;
  if (button === 13) return Math.min(count - 1, index + columns);
  if (button === 14) return Math.max(0, index - 1);
  if (button === 15) return Math.min(count - 1, index + 1);
  return index;
}
/** One menu owner for login/dashboard/tabs/settings/catalog. Disabled before the
 * player constructs its input owner. No synthetic keyboard/gamepad events. */
export function createCatalogNavigation(_search: HTMLInputElement, _grid: HTMLElement, enabled: () => boolean, cloudEnabled: () => boolean = () => false, tabNavigation?: {enabled:()=>boolean; index:()=>number; switch:(index:number)=>void}, requestNext?: (origin:HTMLElement)=>boolean) {
  let frame: number | undefined, disposed = false;
  const pads = new Map<number, {edges: CatalogPadEdges; shoulders: ShoulderTabs; direction?: number; repeatAt: number}>();
  let lastTitle: string | undefined, lastIndex = 0;
  let modality: 'pointer' | 'keyboard' | 'gamepad' = 'pointer';
  let remembered: HTMLElement | undefined;
  let geometry: {item:HTMLElement; rect:DOMRect}[] | undefined;
  let cachedControls: HTMLElement[] | undefined;
  const invalidate = () => { geometry=undefined; cachedControls=undefined; };
  const remember = (event: FocusEvent) => {
    const card=(event.target as HTMLElement).closest<HTMLElement>('[data-title-id]');
    if (card && _grid.contains(card)) {
      lastTitle=card.dataset.titleId;
      remembered=card;
      lastIndex=[..._grid.querySelectorAll('[data-title-id]')].indexOf(card);
    }
  };
  const recover = () => {
    if(modality!=='gamepad' || !lastTitle || remembered?.isConnected || document.activeElement!==document.body)return;
    const cards=[..._grid.querySelectorAll<HTMLElement>('[data-title-id]')];
    const card=cards.find(item=>item.dataset.titleId===lastTitle)??cards[Math.min(lastIndex,cards.length-1)];
    card?.querySelector<HTMLElement>('.connect-btn,button')?.focus({preventScroll:true});
  };
  const observer=typeof MutationObserver==='undefined' ? undefined : new MutationObserver(()=>{invalidate();recover();});
  observer?.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','disabled','style','class','inert']});
  const resize=typeof ResizeObserver==='undefined' ? undefined : new ResizeObserver(invalidate);
  resize?.observe(_grid);
  const pointer=()=>{modality='pointer';};
  const keyboardModality=()=>{modality='keyboard';};
  document.addEventListener('pointerdown',pointer);
  document.addEventListener('keydown',keyboardModality);
  document.addEventListener('focusin',remember);
  window.addEventListener('resize',invalidate);
  document.addEventListener('scroll',invalidate,true);
  function stop() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined; pads.clear();
  }
  function controls(): HTMLElement[] {
    return cachedControls ?? (cachedControls=[...document.querySelectorAll<HTMLElement>('button,select,input,summary,a[href],[tabindex]')].filter(el => {
      if (el.tabIndex < 0 || el.matches(':disabled') || el.closest('[hidden],[inert]') || el.matches('input[type="hidden"]')) return false;
      for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    }));
  }
  /** Test seam: the same visibility-filtered controls the dpad navigates. */
  function settingsControls(): HTMLElement[] { return controls().filter(el => document.getElementById('panel-settings')?.contains(el)); }
  function focus(target?: HTMLElement) {
    if (!target) return;
    focusGamepad(target);
  }
  function toggleSearch() {
    if (document.activeElement !== _search) { focus(_search); return; }
    if (_search.value) {
      _search.value = ''; _search.dispatchEvent(new Event('input', {bubbles:true}));
    } else focus(controls().find(item => _grid.contains(item)));
  }
  function toggleFocusedFavorite(): boolean {
    if (!cloudEnabled()) return false;
    const active=document.activeElement as HTMLElement|null;
    if(active?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return false;
    const button=active?.closest('.game-card,[data-title-id]')?.querySelector<HTMLButtonElement>('.favorite-toggle');
    if(!button || button.disabled)return false;
    button.click();return true;
  }
  function keyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (disposed || !enabled() || !cloudEnabled() || document.hidden || event.defaultPrevented || event.repeat || event.isComposing ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['b','B','f','F'].includes(event.key) ||
        target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    if(event.key.toLowerCase()==='f'){if(toggleFocusedFavorite())event.preventDefault();return;}
    event.preventDefault(); focus(_search);
  }
  document.addEventListener('keydown',keyboard);
  function action(button: number) {
    if(button===3){toggleFocusedFavorite();return;}
    if (button === 2 && !cloudEnabled()) {
      if (tabNavigation?.enabled() && tabNavigation.index() === 0) document.querySelector<HTMLButtonElement>('#refresh-consoles')?.click();
      return;
    }
    if (cloudEnabled() && (button === 2 || (button === 1 && document.activeElement === _search))) { toggleSearch(); return; }
    const items = controls(); if (!items.length) return;
    const active = document.activeElement as HTMLElement | null;
    const index = items.indexOf(active!);
    if (button === 1) {
      focus(document.querySelector<HTMLElement>('.tabs button.active') ?? items[0]); return;
    }
    if (button === 0) {
      if (index < 0) { focus(items[0]); return; }
      // A never opens a native select popup (which would consume the next A).
      if (active?.tagName !== 'SELECT' && active?.tagName !== 'INPUT') active?.click();
      return;
    }
    if (index < 0) { focus(items[0]); return; }
    if ((button === 14 || button === 15) && active?.tagName === 'SELECT') {
      const select = active as HTMLSelectElement;
      const options = [...select.options].filter(option => !option.disabled && !option.hidden);
      const next = options[Math.max(0, Math.min(options.length - 1, options.indexOf(select.selectedOptions[0]) + (button === 15 ? 1 : -1)))];
      if (next && select.value !== next.value) { select.value = next.value; select.dispatchEvent(new Event('change',{bubbles:true})); }
      return;
    }
    if ((button === 14 || button === 15) && active?.matches('input[type="number"],input[type="range"]')) {
      const input = active as HTMLInputElement; const before = input.value;
      if (button === 15) input.stepUp(); else input.stepDown();
      if (input.value !== before) input.dispatchEvent(new Event('change',{bubbles:true}));
      return;
    }
    const positions=geometry ?? (geometry=items.map(item=>({item,rect:item.getBoundingClientRect()})));
    const origin = positions.find(entry=>entry.item===active)?.rect ?? active!.getBoundingClientRect();
    if ((button === 13 || button === 15) && _grid.contains(active) && cloudEnabled()) {
      const gridItems = positions.filter(entry => _grid.contains(entry.item));
      const below = gridItems.some(entry => entry.rect.top > origin.top + 1);
      const lastCard = _grid.lastElementChild;
      const atEnd = button === 13 ? !below : !!lastCard?.contains(active);
      if (atEnd && requestNext?.(active!)) return;
      // Exhaustion is a grid boundary, not an invisible focus destination.
      if (atEnd && requestNext) return;
    }
    const ox = origin.left + origin.width / 2, oy = origin.top + origin.height / 2;
    const horizontal = button === 14 || button === 15, sign = button === 12 || button === 14 ? -1 : 1;
    const candidates = positions.filter(entry => entry.item !== active).map(({item,rect}) => {
      const dx = rect.left + rect.width/2 - ox, dy = rect.top + rect.height/2 - oy;
      const forward = (horizontal ? dx : dy) * sign, lateral = Math.abs(horizontal ? dy : dx);
      return {item,forward,score:forward + lateral * 3};
    }).filter(candidate => candidate.forward > 1).sort((a,b)=>a.score-b.score);
    // Linear fallback also makes all controls reachable in dense/overlapping layouts.
    focus(candidates[0]?.item ?? items[Math.max(0,Math.min(items.length-1,index+sign))]);
  }
  function poll(now: number) {
    frame = undefined;
    if (disposed || !enabled() || document.hidden) { stop(); return; }
    const connected = new Set<number>();
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad?.connected || pad.mapping !== 'standard') continue;
      if (pad.buttons.some(button=>button.pressed) || pad.axes.some(axis=>Math.abs(axis)>.25)) modality='gamepad';
      connected.add(pad.index);
      let state = pads.get(pad.index);
      if (!state) { state = {edges:new CatalogPadEdges(),shoulders:new ShoulderTabs(),repeatAt:0}; pads.set(pad.index,state); }
      const pressed = pad.buttons.flatMap((button,index)=>button.pressed ? [index] : []);
      const x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0;
      let direction = pressed.find(button => button >= 12 && button <= 15);
      if (direction === undefined && Math.max(Math.abs(x),Math.abs(y)) > .25) direction = Math.abs(x) > Math.abs(y) ? (x < 0 ? 14 : 15) : (y < 0 ? 12 : 13);
      const nextTab = state.shoulders.read(pressed, now, !!tabNavigation?.enabled(), tabNavigation?.index() ?? 0);
      if (nextTab !== undefined) tabNavigation?.switch(nextTab);
      const edges = state.edges.read(pressed);
      for (const button of edges) {
        if (!enabled() || disposed) break;
        if (button === 0 || button === 1 || button === 2 || button === 3) action(button);
      }
      if (!enabled() || disposed) break; // A can synchronously transfer ownership.
      if (direction !== undefined && (direction !== state.direction || now >= state.repeatAt)) { action(direction); state.repeatAt=now+180; }
      state.direction=direction;
    }
    for (const index of pads.keys()) if (!connected.has(index)) pads.delete(index);
    if (!disposed && enabled() && !document.hidden && connected.size) frame=requestAnimationFrame(poll);
  }
  function hasPad(){try{return Array.from(navigator.getGamepads?.()??[]).some(p=>p?.connected && p.mapping==='standard');}catch{return false;}}
  function sync() {
    invalidate();
    if (disposed || !enabled() || document.hidden || !hasPad()) stop();
    else if (frame === undefined) frame=requestAnimationFrame(poll);
  }
  document.addEventListener('visibilitychange',sync);
  window.addEventListener('gamepadconnected',sync);
  window.addEventListener('gamepaddisconnected',sync);
  return {sync,stop,settingsControls,dispose(){disposed=true;stop();observer?.disconnect();resize?.disconnect();document.removeEventListener('visibilitychange',sync);window.removeEventListener('gamepadconnected',sync);window.removeEventListener('gamepaddisconnected',sync);document.removeEventListener('pointerdown',pointer);document.removeEventListener('keydown',keyboardModality);document.removeEventListener('focusin',remember);window.removeEventListener('resize',invalidate);document.removeEventListener('scroll',invalidate,true);document.removeEventListener('keydown',keyboard);}};
}
