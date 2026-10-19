import { describe, expect, it } from 'vitest';
// @vitest-environment happy-dom
import { camelFallbackName, filterCatalog, normalizeSearch } from './catalog-search';
import type { CloudTitle } from './catalog';

const poster = 'https://store-images.s-microsoft.com/image/forza-poster';
const hydrated: CloudTitle = { titleId: 'FORZAHORIZON5', name: 'Forza Horizon 5', boxArt: poster, playable: true };
const unhydrated: CloudTitle = { titleId: 'FORZAHORIZON5', name: 'FORZAHORIZON5', playable: true };
const other: CloudTitle = { titleId: 'ABSOLUM', name: 'Absolum', boxArt: 'https://store-images.s-microsoft.com/image/abs', playable: true };

describe('catalog search metadata integrity', () => {
  it('returns the original hydrated object references when filtering, keeping boxArt for render', () => {
    const [kept] = filterCatalog([hydrated, other], 'forza');
    expect(kept).toBe(hydrated);
    expect(kept.boxArt).toBe(poster);
  });

  it('matches real DisplayCatalog ProductTitle with accents and case (never the slug)', () => {
    const pokemon: CloudTitle = { titleId: 'POKEMON', name: 'Pokémon Escarlata', playable: true };
    const [kept] = filterCatalog([pokemon], '  POKÉMON ');
    expect(kept).toBe(pokemon);
    expect(filterCatalog([pokemon], 'Escarlata')).toEqual([pokemon]);
    expect(filterCatalog([unhydrated], 'Forza Horizon 5')).toEqual([]);
  });

  it('derives a fallback label from slug titleIds without inventing brands', () => {
    expect(camelFallbackName('FORZAHORIZON5')).toBe('Forza Horizon 5');
    expect(camelFallbackName('HALOWARS2')).toBe('Halo Wars 2');
    expect(camelFallbackName('GOWRAAGOTI')).toBe('Gowraagoti');
    expect(camelFallbackName('FORZAMOTORSPORT7')).toBe('Forza Motorsport 7');
    expect(camelFallbackName('1000XRESIST')).toBe('1000 Xresist');
    expect(camelFallbackName('ABSOLUM')).toBe('Absolum');
    expect(camelFallbackName('PSYCHONAUTS2')).toBe('Psychonauts 2');
  });

  it('mixes partially hydrated lists keeping each original reference', () => {
    const list = [hydrated, unhydrated, other];
    const result = filterCatalog(list, 'a');
    expect(result).toContain(hydrated);
    expect(result).toContain(unhydrated);
    expect(result.every((item) => list.includes(item))).toBe(true);
    expect(normalizeSearch(unhydrated.name)).toBe('forzahorizon5');
  });

  it('shows a shimmer skeleton for unhydrated cards instead of a gray placeholder', () => {
    document.body.innerHTML = '<div id="cloud-container"></div>';
    const grid = document.getElementById('cloud-container')!;
    const card = document.createElement('article');
    card.className = 'game-card';
    card.dataset.titleId = unhydrated.titleId;
    const hasBoxArt = Boolean(unhydrated.boxArt);
    if (!hasBoxArt) {
      const cover = document.createElement('div');
      cover.className = 'game-cover game-cover-skeleton';
      cover.setAttribute('aria-hidden', 'true');
      card.append(cover);
    }
    grid.append(card);
    const skeleton = grid.querySelector('.game-cover-skeleton') as HTMLElement | null;
    expect(skeleton).toBeTruthy();
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(grid.querySelector('.game-cover-placeholder')).toBeNull();
    expect(hasBoxArt).toBe(false);
  });
});
