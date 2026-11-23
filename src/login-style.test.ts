import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('./styles.css',import.meta.url),'utf8');
it('gives pairing buttons explicit keyboard styling',()=>{
 expect(css).toContain('.login-feedback .device-code:focus-visible');
});
