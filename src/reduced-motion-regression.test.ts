import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
it('stops the console wake spinner for reduced motion',()=>{
 const css=readFileSync(new URL('./console-wake.css',import.meta.url),'utf8');
 expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.console-wake-spinner\s*\{\s*animation:\s*none/);
});
it('stops loading rings for reduced motion in all connection modes',()=>{
 const css=readFileSync(new URL('./styles.css',import.meta.url),'utf8');
 expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.loading-ring\s*\{\s*animation:\s*none/);
});
it('retains a visible keyboard outline for settings selects',()=>{
 const css=readFileSync(new URL('./styles.css',import.meta.url),'utf8');
 expect(css).not.toMatch(/select:focus\s*\{\s*outline:\s*none/);
});
