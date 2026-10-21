import type { CloudTitle } from './catalog';

/** Stable per local calendar day; never invents a title or duplicates one. */
export function featuredForDay(games: CloudTitle[], dayKey: string, limit = 6): CloudTitle[] {
  const unique = [...new Map(games.filter(game => game.playable === true && !!(game.heroArt || game.boxArt)).map(game => [game.titleId, game])).values()];
  if (unique.length <= limit) return unique;
  let hash = 2166136261;
  for (const char of dayKey) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const sorted = [...unique].sort((a, b) => a.titleId.localeCompare(b.titleId));
  const start = (hash >>> 0) % sorted.length;
  return Array.from({ length: limit }, (_, index) => sorted[(start + index) % sorted.length]!);
}
