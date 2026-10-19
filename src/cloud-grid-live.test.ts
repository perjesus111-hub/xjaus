// @vitest-environment happy-dom
import source from './main.ts?raw';
import {it,expect} from 'vitest';
it('catalog append does not autofocus the first new card asynchronously',()=>{
 expect(source).not.toContain('if (firstNew) firstNew.querySelector');
 expect(source).not.toContain('Cargar más juegos');
 expect(source).toContain('createInfiniteCatalog(cloudGrid');
});
import {createCloudGridController} from './cloud-grid';
it('delayed append preserves selected node identity and scroll',async()=>{
 const grid=document.createElement('div'),search=document.createElement('input');document.body.append(grid,search);
 const card=document.createElement('article');card.dataset.titleId='selected';card.innerHTML='<button>Selected</button>';grid.append(card);
 const selected=card.querySelector('button')!;selected.focus();
 let top=937;const positions:number[]=[];
 const controller=createCloudGridController(grid,search,()=>[],{scroller:()=>({get scrollY(){return top;},scrollTo(_x:number,y:number){top=y;positions.push(y);}} as unknown as Window)});
 await new Promise(resolve=>setTimeout(resolve,10));
 const fresh=document.createElement('article');fresh.innerHTML='<button>New</button>';controller.appendBatch([fresh]);
 expect(grid.firstElementChild).toBe(card);expect(document.activeElement).toBe(selected);expect(top).toBe(937);expect(positions).toEqual([937]);
 grid.remove();search.remove();
});
it('hydration preserves card and focused button references while replacing metadata',()=>{
 const grid=document.createElement('div'), search=document.createElement('input'); document.body.append(grid);
 const card=document.createElement('article');card.dataset.titleId='a';card.innerHTML='<h3>Fallback</h3><button>Play</button>';grid.append(card);
 const button=card.querySelector('button')!;button.focus();
 const next=document.createElement('article');next.dataset.titleId='a';next.innerHTML='<img src="https://store-images.s-microsoft.com/a"><h3>Official</h3><button>Play</button>';
 createCloudGridController(grid,search,()=>[],{scroller:()=>({scrollTop:900,scrollTo:()=>{}} as unknown as Window)}).syncCards([next]);
 expect(grid.firstElementChild).toBe(card);expect(card.querySelector('button')).toBe(button);expect(document.activeElement).toBe(button);expect(card.querySelector('h3')?.textContent).toBe('Official');
});
it('hydration adds factual badges without replacing play or favorite focus',()=>{
 const grid=document.createElement('div'),search=document.createElement('input');document.body.append(grid);
 const card=document.createElement('article');card.dataset.titleId='a';card.innerHTML='<div class="game-artwork"><div class="game-cover"></div></div><h3>Fallback</h3><button class="connect-btn">Play</button><button class="favorite-toggle" aria-label="Favorito: Fallback">☆</button>';grid.append(card);
 const favorite=card.querySelector<HTMLButtonElement>('.favorite-toggle')!;favorite.focus();
 const next=document.createElement('article');next.dataset.titleId='a';next.innerHTML='<div class="game-artwork"><img class="game-cover"><span class="multiplayer-badge">Multijugador</span></div><h3>Official</h3><button class="connect-btn">Play</button><button class="favorite-toggle" aria-label="Favorito: Official">☆</button>';
 createCloudGridController(grid,search,()=>[],{scroller:()=>({scrollY:200,scrollTo:()=>{}} as unknown as Window)}).syncCards([next]);
 expect(document.activeElement).toBe(favorite);expect(favorite.getAttribute('aria-label')).toBe('Favorito: Official');expect(card.querySelector('.game-artwork .multiplayer-badge')?.textContent).toBe('Multijugador');
});
