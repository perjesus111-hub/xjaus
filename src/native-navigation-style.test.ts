import {it,expect} from 'vitest';
import html from '../index.html?raw';import main from './main.ts?raw';
// @ts-expect-error Node types intentionally excluded from the renderer tsconfig.
import {readFileSync} from 'node:fs';
const css:string=readFileSync(new URL('./styles.css',import.meta.url),'utf8');
it('home recent UI resolves only a freshly discovered console, never dispatches a cloud launch',()=>{
 expect(main).toContain('renderHomeRecent(consoles)');expect(main).toContain("entry.type==='home'");expect(main).toContain('resolveHomeTarget(item, homeServers, consoles.length)');expect(main).toContain('playbackLibrary.recordHome(target,name)');
});
it('bumper hints are hidden siblings outside intact tabs; exit is glass and reduced motion',()=>{

 const nav=html.match(/<nav class="[^"]*sidebar-nav[^"]*"[\s\S]*?<\/nav>/)![0];expect(nav).not.toContain('shoulder-hint');expect(html).toContain('aria-hidden="true" hidden>LB');expect(html).toContain('aria-hidden="true" hidden>RB');
 expect(css).toContain('.topbar .tab-navigation { order: 2;');expect(css).toContain('.topbar .tab-navigation .tabs { order: 0;');
 expect(css).toContain('.tab-navigation { display: flex; align-items: center; gap: 12px; }');expect(css).toContain('.shoulder-hint[hidden] { display: none; }');expect(css).toContain('background: rgba(20,22,28,.75)');expect(css).toContain('backdrop-filter: blur(12px)');expect(css).toContain('.player-toolbar { transition: none; }');
});
