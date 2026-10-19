import type { CloudTitle } from './catalog';
export const normalizeSearch = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
export const filterCatalog = (titles: CloudTitle[], query: string): CloudTitle[] => titles.filter(title => title.playable === true && normalizeSearch(title.name).includes(normalizeSearch(query)));
// Lexicon of real franchise words that appear in Xbox cloud titleIds. Used ONLY to
// carve ALL-CAPS slug runs; every unmatched character stays inside its word, so a
// slug with no lexicon word renders as one capitalized word — never an invented brand.
const FALLBACK_WORDS = [
  'FORZAHORIZON', 'FORZAMOTORSPORT', 'FORZAVISTA', 'HALOCAMPAIGN', 'HALOINFINITE',
  'HALOWARS', 'HALOSPARTANASSAULT', 'GEARSOFWAR', 'SEATHIEVES', 'PSYCHONAUTS',
  'FLIGHTSIMULATOR', 'FORZA', 'HORIZON', 'MOTORSPORT', 'HALO', 'WARS', 'GEARS',
  'CAMPAIGN', 'EVOLVED', 'INFINITE', 'ASSAULT', 'SPARTAN',
];
const FALLBACK_SET = new Set(FALLBACK_WORDS);
const FALLBACK_MAX = Math.max(...FALLBACK_WORDS.map((word) => word.length));
const splitLexiconWord = (word: string): string[] => {
  const n = word.length;
  // dp[i]: maximize characters covered by lexicon words; tie -> carve more words.
  const covered = new Array<number>(n + 1).fill(-1);
  const carved = new Array<number>(n + 1).fill(0);
  const prev = new Array<number>(n + 1).fill(-1);
  covered[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let len = 1; len <= Math.min(FALLBACK_MAX, i); len++) {
      const j = i - len;
      if (covered[j] < 0) continue;
      const segment = word.slice(j, i);
      const known = FALLBACK_SET.has(segment);
      const nextCovered = covered[j] + (known ? len : 0);
      const nextCarved = carved[j] + (known ? 1 : 0);
      if (nextCovered > covered[i] || (nextCovered === covered[i] && nextCarved > carved[i])) {
        covered[i] = nextCovered; carved[i] = nextCarved; prev[i] = j;
      }
    }
  }
  const raw: string[] = [];
  for (let i = n; i > 0; i = prev[i]) raw.unshift(word.slice(prev[i], i));
  // Merge consecutive unknown filler into a single word; never letter-split brands.
  const merged: string[] = [];
  for (const segment of raw) {
    if (FALLBACK_SET.has(segment) || !merged.length || FALLBACK_SET.has(merged[merged.length - 1])) merged.push(segment);
    else merged[merged.length - 1] += segment;
  }
  return merged;
};
// FORZAHORIZON5 -> "Forza Horizon 5". Lexical only: no network, no brand guessing.
export const camelFallbackName = (titleId: string): string => {
  if (titleId === 'ASSASSINSCREEDVALHALLA') return "Assassin's Creed Valhalla";
  const segments = titleId
    .replace(/(?<=[a-z])(?=[A-Z])/g, ' ')
    .replace(/(?<=[A-Za-z])(?=\d)/g, ' ')
    .replace(/(?<=\d)(?=[A-Za-z])/g, ' ')
    .split(/\s+/).filter(Boolean);
  if (!segments.length) return titleId;
  const words = segments.flatMap((segment) => (/^\d+$/.test(segment) ? [segment] : splitLexiconWord(segment)));
  if (!words.length) return titleId;
  return words.map((word) => (/^\d+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join(' ');
};
export type CatalogSearchHooks = {
  // Render hooks returning the first APPENDED card (null = full re-render / no focus hint).
  onAppend?: (batch: 'more' | 'hydrate') => HTMLElement | null;
  // Hydration callback; return true when a render already happened (append mode).
  onHydrate?: () => boolean | Promise<boolean>;
};
// No backend dependency: filtering and pagination are deliberately local.
export function createCatalogSearch(render: (query: string, visible: number) => void, hooks: CatalogSearchHooks = {}) {
  let query = '', visible = 24;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    input(value: string) {
      clearTimeout(timer);
      query = value;
      timer = setTimeout(() => { visible = 24; render(query, visible); }, 180);
    },
    // onAppend runs BEFORE render so the renderer can append instead of rebuilding
    // (append mode preserves scrollTop and keeps previous nodes alive).
    more() { visible += 24; const firstNew = hooks.onAppend?.('more'); render(query, visible); return firstNew ?? null; },
    async hydrate(): Promise<boolean> { return (await hooks.onHydrate?.()) ?? false; },
    resetPage() { clearTimeout(timer); visible = 24; render(query, visible); },
    reset() { clearTimeout(timer); query = ''; visible = 24; },
    dispose() { clearTimeout(timer); },
  };
}
