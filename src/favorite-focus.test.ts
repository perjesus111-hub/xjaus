// @vitest-environment happy-dom
import {it,expect} from 'vitest';import {removeUnfavoritedCards} from './favorite-focus';
it('removes only matching card, preserving siblings and nearest focus, last falls back to filter',()=>{
 document.body.innerHTML='<button id="filter"></button><div id="grid">'+['a','b','c'].map(id=>`<article data-title-id="${id}"><button>${id}</button></article>`).join('')+'</div>';
 const grid=document.getElementById('grid')!,fallback=document.getElementById('filter')!,first=grid.children[0],last=grid.children[2];(grid.children[1].firstElementChild as HTMLElement).focus();
 removeUnfavoritedCards(grid,'b',fallback);expect(grid.children[0]).toBe(first);expect(grid.children[1]).toBe(last);expect(document.activeElement).toBe(last.firstElementChild);
 removeUnfavoritedCards(grid,'c',fallback);expect(document.activeElement).toBe(first.firstElementChild);removeUnfavoritedCards(grid,'a',fallback);expect(document.activeElement).toBe(fallback);expect(grid.children).toHaveLength(0);document.body.replaceChildren();
});
