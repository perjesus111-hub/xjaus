import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCatalogSearch, filterCatalog } from './catalog-search';

afterEach(() => vi.useRealTimers());
describe('local catalog search', () => {
  it('matches NFD accents, case and trimmed queries and excludes unplayable metadata', () => {
    const titles = [{ titleId: '1', name: 'Pokémon Édition', playable: true }, { titleId: '2', name: 'Pokemon', playable: false }];
    expect(filterCatalog(titles, '  POKE\u0301MON  ')).toEqual([titles[0]]);
  });
  it('filter resets batches to 24 and flushes only the latest pending search',()=>{vi.useFakeTimers();const render=vi.fn();const search=createCatalogSearch(render);search.more();search.input('latest');search.resetPage();expect(render).toHaveBeenLastCalledWith('latest',24);vi.runAllTimers();expect(render).toHaveBeenCalledTimes(2);});
  it('debounces latest query at 180ms and resets pagination including clear without network', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const search = createCatalogSearch(render);
    search.input('halo'); vi.advanceTimersByTime(100); search.input('forza');
    vi.advanceTimersByTime(179); expect(render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(render).toHaveBeenLastCalledWith('forza', 24);
    search.more(); expect(render).toHaveBeenLastCalledWith('forza', 48);
    search.input(''); vi.advanceTimersByTime(180); expect(render).toHaveBeenLastCalledWith('', 24);
    search.input('stale'); search.dispose(); vi.runAllTimers(); expect(render).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  });
});

describe('catalog search scroll/focus preservation', () => {
  it('more() marks append batches and hydrate() callback re-renders in append mode (mock DOM)', async () => {
    const batches: string[] = [];
    const render = vi.fn(); // mock DOM render
    const hooks = {
      onAppend: (batch: 'more' | 'hydrate') => { batches.push(batch); return batch.length ? ({} as HTMLElement) : null; },
      onHydrate: () => { render('hydrate', 0); hooks.onAppend?.('hydrate'); return true; },
    };
    const search = createCatalogSearch(render, hooks);
    search.more();
    expect(render).toHaveBeenLastCalledWith('', 48);
    expect(batches).toEqual(['more']);
    const hydrated = await search.hydrate();
    expect(hydrated).toBe(true);
    expect(render).toHaveBeenLastCalledWith('hydrate', 0);
    expect(batches).toEqual(['more', 'hydrate']);
  });
});
