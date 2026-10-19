import type { CloudTitle } from './catalog';
import { camelFallbackName } from './catalog-search';
/** Shared by cards and launch/loading. Never use this value as a protocol ID. */
export function gameDisplayName(game: CloudTitle): string {
  return game.name && game.name !== game.titleId && !game.fallbackLabel ? game.name : camelFallbackName(game.titleId);
}
