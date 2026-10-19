import {i18n} from './i18n';
i18n.setPreference('es');
// @vitest-environment happy-dom
import { it, expect, vi, afterEach } from 'vitest';
import { mountLoadingControls } from './loading-controls';
// @ts-expect-error Node types are not part of the browser build; Vitest runs in Node.
import { readFileSync } from 'node:fs';
const css: string = readFileSync('src/styles.css', 'utf8');
afterEach(()=>vi.unstubAllGlobals());
it('groups live profile beside accessible cancel and routes click/Escape/B once, disposes input',()=>{
 let frame: FrameRequestCallback=()=>{};
 vi.stubGlobal('requestAnimationFrame',vi.fn(fn=>{frame=fn;return 1;}));
 vi.stubGlobal('cancelAnimationFrame',vi.fn());
 let pressed=false;
 vi.stubGlobal('navigator',{getGamepads:()=>[{buttons:[{}, {pressed}]}]});
 const cancel=vi.fn(), root=document.createElement('div');document.body.append(root);
 const dispose=mountLoadingControls(root,cancel,{gamertag:'Dynamic',gamerscore:'42',gameDisplayPicRaw:'https://images-eds.xboxlive.com/image',gameDisplayName:'',accountTier:''});
 const button=root.querySelector<HTMLButtonElement>('.loading-exit-btn')!;
 expect(button.textContent).toContain('Cancelar conexión'); expect(button.textContent).toContain('B');
 expect(button.querySelector('svg')?.getAttribute('width')).toBe('14');
 expect(root.textContent).toContain('Dynamic'); expect(root.querySelector('img')?.src).toContain('images-eds.xboxlive.com');
 button.click();
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 pressed=true;frame(0);frame(16);
 expect(cancel).toHaveBeenCalledTimes(3);
 dispose();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));expect(cancel).toHaveBeenCalledTimes(3);
 expect(cancelAnimationFrame).toHaveBeenCalled();
});
it('keeps the requested glass button, accessible focus and responsive header contract',()=>{
 const button=css.match(/\.loading-exit-btn \{([^}]+)\}/)![1];
 for(const value of ['inline-flex','gap: 8px','rgba(255,255,255,.08)','blur(12px)','1px solid rgba(255,255,255,.15)','color: white','8px 16px','20px','13px','600','.2s'])expect(button).toContain(value);
 expect(css).toContain('.loading-exit-btn:focus-visible');expect(css).toContain('outline-offset: 4px');
 expect(css).toContain('rgba(255,255,255,.2)');expect(css).toContain('rgba(255,255,255,.4)');expect(css).toContain('scale(1.02)');
 expect(css).toContain('gap: 16px');expect(css).toContain('@media (max-width: 760px)');
 expect(css).toContain('.player-screen:has(.stream-overlay:not([hidden])) .player-toolbar { display: none; }');
});
