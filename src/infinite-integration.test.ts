import {it,expect} from 'vitest';
import source from './main.ts?raw';
it('replaces all manual pagination DOM with an automatic catalog owner',()=>{expect(source).not.toContain('Cargar más juegos');expect(source).not.toContain('catalogMore');expect(source).toContain('createInfiniteCatalog(cloudGrid');expect(source).toContain('catalogPager.dispose()');expect(source).toContain('catalogPager.reset()');});
