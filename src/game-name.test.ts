import { expect, it } from 'vitest';
import { normalizeCloudTitles } from './catalog';
import { camelFallbackName } from './catalog-search';
it('uses the commercial details title before an opaque protocol ID', () => {
 const raw = {results:[{titleId:'ASSASSINSCREEDVALHALLA',details:{hasEntitlement:true,title:'Official localized Valhalla'}}]};
 expect(normalizeCloudTitles(raw, {})[0].name).toBe('Official localized Valhalla');
 expect(normalizeCloudTitles(raw, {})[0].titleId).toBe('ASSASSINSCREEDVALHALLA');
 expect(normalizeCloudTitles({results:[{...raw.results[0],name:'ASSASSINSCREEDVALHALLA'}]}, {})[0].name).toBe('Official localized Valhalla');
});
it('humanizes known commercial fallback without changing protocol IDs', () => {
 expect(camelFallbackName('ASSASSINSCREEDVALHALLA')).toBe("Assassin's Creed Valhalla");
});
