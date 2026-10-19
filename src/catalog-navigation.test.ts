import { it, expect, vi } from 'vitest';
import { CatalogPadEdges, catalogDestination, createCatalogNavigation } from './catalog-navigation';
it('cancels own RAF on stream/tab stop or hidden and removes listener on disposal (mock DOM)', () => {
  const doc = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const win = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window',win);vi.stubGlobal('navigator',{getGamepads:()=>[{connected:true,mapping:'standard'}]});
  const raf = vi.fn(() => 41), cancel = vi.fn();
  vi.stubGlobal('document', doc); vi.stubGlobal('requestAnimationFrame', raf); vi.stubGlobal('cancelAnimationFrame', cancel);
  try {
    let enabled = true;
    const nav = createCatalogNavigation({} as HTMLInputElement, {} as HTMLElement, () => enabled);
    nav.sync(); nav.sync(); expect(raf).toHaveBeenCalledTimes(1);
    enabled = false; nav.sync(); expect(cancel).toHaveBeenCalledWith(41);
    enabled = true; nav.sync(); doc.hidden = true; nav.sync(); expect(cancel).toHaveBeenCalledTimes(2);
    nav.dispose(); expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  } finally { vi.unstubAllGlobals(); }
});
it('uses rising edges, primes on start, ignores held buttons and rearms on release', () => {
  const edges = new CatalogPadEdges();
  expect(edges.read([12])).toEqual([]);
  expect(edges.read([12])).toEqual([]);
  edges.read([]); expect(edges.read([12])).toEqual([12]);
  expect(edges.read([12])).toEqual([]);
  edges.reset(); expect(edges.read([0])).toEqual([]);
});
it('moves first row up to search, search B/down to first poster, clamps grid edges', () => {
  expect(catalogDestination(2, 12, 4, 10)).toBe(-1);
  expect(catalogDestination(-1, 1, 4, 10)).toBe(0);
  expect(catalogDestination(-1, 13, 4, 10)).toBe(0);
  expect(catalogDestination(0, 14, 4, 10)).toBe(0);
  expect(catalogDestination(9, 13, 4, 10)).toBe(9);
  expect(catalogDestination(-1, 13, 4, 0)).toBe(-1);
});
