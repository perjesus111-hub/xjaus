import { describe, expect, it } from 'vitest';
import { featuredForDay } from './featured-games';

const games = Array.from({ length: 8 }, (_, i) => ({ titleId: `game-${i}`, name: `Game ${i}`, playable: true, boxArt: `https://store-images.s-microsoft.com/${i}` }));

describe('featuredForDay', () => {
  it('is stable for a day, takes no more than six and never duplicates titles', () => {
    const first = featuredForDay(games, '2026-10-21');
    expect(featuredForDay(games, '2026-10-21').map(g => g.titleId)).toEqual(first.map(g => g.titleId));
    expect(first).toHaveLength(6);
    expect(new Set(first.map(g => g.titleId)).size).toBe(6);
  });
  it('shows only real playable art-backed games when fewer than six exist', () => {
    expect(featuredForDay([{ titleId: 'a', name: 'A', playable: true, boxArt: 'https://store-images.s-microsoft.com/a' }, { titleId: 'b', name: 'B', playable: false, boxArt: 'https://store-images.s-microsoft.com/b' }], '2026-10-21')).toEqual([{ titleId: 'a', name: 'A', playable: true, boxArt: 'https://store-images.s-microsoft.com/a' }]);
  });
});
