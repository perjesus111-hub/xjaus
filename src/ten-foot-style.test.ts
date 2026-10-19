// @ts-expect-error Node types intentionally excluded from the renderer tsconfig.
import { readFileSync } from 'node:fs';
const css: string = readFileSync(new URL('./styles.css',import.meta.url),'utf8');
import {expect,it} from 'vitest';
it('focus presentation covers cards, child focus, reduced motion and shoulder chips',()=>{
 expect(css).toContain('scale(1.04)');expect(css).toContain('.game-card:focus-within');expect(css).toContain('rgba(212,175,55,.4)');expect(css).toContain('prefers-reduced-motion: reduce');expect(css).toContain('.shoulder-hint');
});
