import {transferBinding} from './i18n';
// Cloud grid render controller for XJAUS (mock DOM contract, verified by cloud-grid.test.ts).
// Full render: rebuild cards (search-driven rebuilds are intentional).
// Append batch: nodes are APPENDED to the end, previous nodes are never touched,
// scrollTop is saved before mutating and restored after appending, and there is
// never a window.scrollTo(0, 0) or a focus steal to the first element.
type Card = HTMLElement;
type AnyRecord = Record<string, unknown>;

export type CloudGridDeps = {
  scroller?: () => Window;
};

export function createCloudGridController(
  grid: HTMLElement,
  search: HTMLInputElement,
  onRender: () => HTMLElement[],
  deps: CloudGridDeps = {},
): {
  renderCards: (cards: Card[]) => HTMLElement | null;
  appendBatch: (cards: Card[]) => HTMLElement | null;
  syncCards: (cards: Card[]) => HTMLElement | null;
  restoreFocus: (focusedTitleId: string | undefined) => void;
} {
  const scroller = deps.scroller ?? ((): Window => window);

  function scrollTopOf(sc: Window | undefined): number | undefined {
    const top = (sc as unknown as AnyRecord | undefined)?.scrollTop ?? sc?.scrollY;
    return typeof top === "number" ? top : undefined;
  }

  function scrollToTop(sc: Window | undefined, top: number): void {
    if (typeof (sc as unknown as AnyRecord | undefined)?.scrollTo !== "function") return;
    (sc as Window).scrollTo(0, top);
  }

  function restoreFocus(focusedTitleId: string | undefined): void {
    if (!focusedTitleId) return;
    const cards = [...grid.children] as HTMLElement[];
    const restored = cards.find((card) => card.dataset.titleId === focusedTitleId);
    (restored?.querySelector("button") ?? search).focus();
  }

  function renderCards(cards: Card[]): HTMLElement | null {
    onRender();
    const sc = scroller();
    const top = scrollTopOf(sc);
    grid.replaceChildren(...cards);
    if (top !== undefined) scrollToTop(sc, top);
    return null;
  }

  function appendBatch(cards: Card[]): HTMLElement | null {
    if (!cards.length) return null;
    const sc = scroller();
    const scrollTop = scrollTopOf(sc) ?? 0; // guardar scrollTop ANTES de mutar
    for (const card of cards) grid.append(card); // append al final; nodos previos intactos
    scrollToTop(sc, scrollTop); // restaurar tras el append; nunca (0, 0)
    return cards[0]; // primera tarjeta NUEVA para focus natural (catalog-navigation)
  }

  // Append de nuevas al final + refresco in-place de existentes (metadata).
  // Nodos previos NUNCA se destruyen; scrollTop se conserva; focus hint = primera nueva.
  function syncCards(cards: Card[]): HTMLElement | null {
    const sc = scroller();
    const scrollTop = scrollTopOf(sc) ?? 0;
    const existing = new Map<string, HTMLElement>();
    for (const child of [...grid.children] as HTMLElement[]) {
      const id = child.dataset?.titleId;
      if (id) existing.set(id, child);
    }
    const fresh: Card[] = [];
    const updated = new Set<HTMLElement>();
    for (const card of cards) {
      const id = card.dataset?.titleId;
      const current = id ? existing.get(id) : undefined;
      if (current && !updated.has(current)) {
        updated.add(current);
        // Keep the article, play listener and focus target alive during hydration.
        if (current !== card && typeof current.querySelector === "function") {
          const button = current.querySelector("button");
          const title = current.querySelector("h3");
          const nextTitle = card.querySelector("h3");
          if (title && nextTitle) title.textContent = nextTitle.textContent;
          const cover = current.querySelector(".game-cover, img");
          const nextCover = card.querySelector(".game-cover, img");
          if (nextCover) { if (cover) cover.replaceWith(nextCover); else current.prepend(nextCover); }
          if (!button) { const nextButton = card.querySelector("button"); if (nextButton) current.append(nextButton); }
          const favorite=current.querySelector('.favorite-toggle'), nextFavorite=card.querySelector('.favorite-toggle');
          if(favorite && nextFavorite && !transferBinding(nextFavorite,favorite,'ariaLabel'))favorite.setAttribute('aria-label',nextFavorite.getAttribute('aria-label') ?? '');
          for(const selector of ['.controller-support','.multiplayer-badge']) {
            const old=current.querySelector(selector), fresh=card.querySelector(selector);
            if(old)old.remove();
            if(fresh)(current.querySelector('.game-artwork') ?? current).append(fresh);
          }
        }
        continue;
      }
      if (current) continue;
      fresh.push(card);
    }
    for (const card of fresh) grid.append(card);
    scrollToTop(sc, scrollTop);
    return fresh[0] ?? null;
  }

  return { renderCards, appendBatch, syncCards, restoreFocus };
}
