import { bindText, t } from './i18n';

/** Contextual catalog strip fed ONLY by real card DOM state (title, box art,
 *  favorite flag, verified metadata badges). No invented data, no extra
 *  backend calls: whatever the grid really shows is what the strip shows. */
export type CloudContextDeps = {
  grid: HTMLElement;
  meta: HTMLElement;
  panel: HTMLElement;
  title: HTMLElement;
  art: HTMLImageElement;
  tags: HTMLElement;
  description: HTMLElement;
  play: HTMLButtonElement;
};

export function initCloudContext(deps: CloudContextDeps): { updateMeta: () => void } {
  let activeCard: Element | null = null;

  function updateMeta(): void {
    const total = deps.grid.querySelectorAll('.game-card').length;
    const favorites = deps.grid.querySelectorAll('.favorite-toggle[aria-pressed="true"]').length;
    deps.meta.dataset.total = String(total);
    deps.meta.dataset.favorites = String(favorites);
    bindText(deps.meta, () => t('cloudMeta', { count: total, favorites }));
  }

  function showFor(card: Element): void {
    activeCard = card;
    const heading = card.querySelector('h3');
    const image = card.querySelector<HTMLImageElement>('.game-cover:not(.game-cover-skeleton)');
    deps.title.textContent = heading?.textContent ?? '';
    if (image?.src) { deps.art.src = image.src; deps.art.hidden = false; }
    else { deps.art.removeAttribute('src'); deps.art.hidden = true; }
    deps.tags.replaceChildren();
    const description = card.getAttribute('data-description');
    deps.description.textContent = description ?? '';
    deps.description.hidden = !description;
    if (card.querySelector('.multiplayer-badge')) {
      const badge = document.createElement('span');
      badge.className = 'context-tag';
      bindText(badge, () => ` ${t('multiplayer')}`);
      deps.tags.append(badge);
    }
    if (card.querySelector('.controller-support')) {
      const badge = document.createElement('span');
      badge.className = 'context-tag';
      bindText(badge, () => ` ${t('controllerSupport')}`);
      deps.tags.append(badge);
    }
    const favorite = card.querySelector<HTMLButtonElement>('.favorite-toggle');
    if (favorite?.getAttribute('aria-pressed') === 'true') {
      const badge = document.createElement('span');
      badge.className = 'context-tag context-tag-favorite';
      bindText(badge, () => ` ${t('favoriteOn')}`);
      deps.tags.append(badge);
    }
    deps.play.dataset.titleId = card.getAttribute('data-title-id') ?? '';
    deps.panel.hidden = false;
  }

  function hide(): void {
    activeCard = null;
    deps.panel.hidden = true;
  }

  deps.grid.addEventListener('focusin', (event) => {
    const card = (event.target as Element | null)?.closest?.('.game-card');
    if (card) showFor(card);
  });
  deps.grid.addEventListener('mouseover', (event) => {
    const card = (event.target as Element | null)?.closest?.('.game-card');
    if (card && document.activeElement && !deps.grid.contains(document.activeElement)) showFor(card);
  });
  deps.grid.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !deps.grid.contains(next)) hide();
  });
  deps.grid.addEventListener('mouseleave', () => {
    if (!deps.grid.contains(document.activeElement)) hide();
  });
  deps.play.addEventListener('click', () => {
    // Delegate to the card's own validated connect button: same launch checks.
    if (!activeCard) return;
    activeCard.querySelector<HTMLButtonElement>('.connect-btn')?.click();
  });

  updateMeta();
  return { updateMeta };
}
