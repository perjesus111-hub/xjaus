import {expect,it} from 'vitest';
// @ts-expect-error Node types intentionally excluded from the renderer tsconfig.
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('./styles.css',import.meta.url),'utf8');
it('gives saved-session and pairing buttons explicit pointer and keyboard styling',()=>{
 expect(css).toMatch(/#manual-login\s*\{[^}]*background:\s*rgba\(32,\s*32,\s*32,\s*0\.72\)/);
 expect(css).toMatch(/#manual-login\s*\{[^}]*border-radius:\s*8px/);
 expect(css).toContain('#manual-login:focus-visible');
 expect(css).toContain('.login-feedback .device-code:focus-visible');
});
