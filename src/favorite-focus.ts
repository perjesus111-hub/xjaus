/** Incremental removal: untouched nodes retain their focus/listeners/artwork. */
export function removeUnfavoritedCards(grid:HTMLElement,id:string,fallback:HTMLElement){
 const cards=[...grid.querySelectorAll<HTMLElement>('[data-title-id]')];
 const focused=cards.findIndex(card=>card.contains(document.activeElement));
 const removing=cards.filter(card=>card.dataset.titleId===id);
 const hadFocus=removing.some(card=>card.contains(document.activeElement));
 const remaining=cards.filter(card=>card.dataset.titleId!==id);
 if(hadFocus)(remaining[Math.min(Math.max(focused,0),remaining.length-1)]?.querySelector<HTMLElement>('button:not(:disabled)')??fallback).focus({preventScroll:true});
 removing.forEach(card=>card.remove());
}
