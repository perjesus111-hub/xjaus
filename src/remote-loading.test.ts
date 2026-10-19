import {i18n} from './i18n';
i18n.setPreference('es');
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { showStreamLoading, disposeStreamLoading } from './loading-presentation';
const homeTips = [
 '💡 Consejo: Para una experiencia óptima de juego remoto, se recomienda que tu Xbox esté conectada por cable Ethernet a tu router.',
 "💡 Consejo: Puedes despertar y apagar tu consola de forma remota configurando tu Xbox en modo de energía 'Suspensión'.",
 '💡 Consejo: La transmisión local se beneficia enormemente de una red Wi-Fi de 5 GHz o superior.',
 '💡 Consejo: Puedes usar cualquier control de Xbox compatible por Bluetooth o USB para controlar tu consola desde aquí.',
];
it('home rotates its four exact tips and clears pending fades on replacement and disposal', () => {
 vi.useFakeTimers(); vi.spyOn(Math,'random').mockReturnValue(0);
 const overlay=document.createElement('div'); showStreamLoading(overlay,'home',{titleId:'id',name:'S'});
 const tip=overlay.querySelector<HTMLElement>('.loading-tip')!;
 for (const [index, text] of [...homeTips, homeTips[0]].entries()) {
  expect(tip.textContent).toBe(text); vi.advanceTimersByTime(index === 0 ? 6500 : 6150); expect(tip.style.opacity).toBe('0');
  vi.advanceTimersByTime(350); expect(tip.style.opacity).toBe('1');
 }
 vi.advanceTimersByTime(6150); expect(vi.getTimerCount()).toBe(2);
 showStreamLoading(overlay,'home',{titleId:'id',name:'S'}, {consoleType:'XboxSeriesS'});
 expect(overlay.querySelector<HTMLImageElement>('.loading-console')?.alt).toBe('Xbox Series S');
 expect(vi.getTimerCount()).toBe(1);
 vi.advanceTimersByTime(6500); disposeStreamLoading(overlay); disposeStreamLoading(overlay);
 expect(vi.getTimerCount()).toBe(0);
});
// @ts-expect-error Node fs is test-only
import { readFileSync } from 'node:fs';
it('home metadata reaches presentation and progress cannot replace home status', () => {
 const main=readFileSync('src/main.ts','utf8');
 expect(main).toContain('startGame(\'home\',target,name,undefined,item)');
 expect(main).toContain('fallbackLabel: false }, console)');
 expect(main).toContain('if (kind === "home") return;');
 expect(main).toContain(`if (kind === "cloud") bindText(message,()=>t('waitingVideo'));`);
});
it('home CSS isolates the centered console variant with reduced motion and responsive rules', () => {
 const css=readFileSync('src/styles.css','utf8');
 expect(css).toContain('[data-kind="home"]');
 expect(css).toContain('.loading-orbit');
 expect(css).toContain('.loading-particle');
 expect(css).toContain('prefers-reduced-motion: reduce');
 expect(css).toContain('--remote-gold: var(--gold)');
 expect(css).toContain('[data-kind="home"] .loading-status .loading-ring { border-top-color: var(--remote-gold); }');
 expect(css).toContain('[data-kind="home"] .loading-exit-btn:focus-visible { outline: 2px solid var(--gold)');
 expect(css).toContain('drop-shadow(0 0 26px rgba(255,200,59,.45)) drop-shadow(0 18px 36px rgba(0,0,0,.85))');
});
it('reference artwork keeps its baked-in golden trails without shadowing its rectangular alpha field', () => {
 const css=readFileSync('src/styles.css','utf8');
 const reference=css.match(/\.loading-console-scene--reference \.loading-console\s*\{([^}]+)\}/)?.[1];
 expect(reference).toBeDefined();
 expect(reference).toMatch(/filter:\s*none\s*;/);
 expect(reference).not.toContain('drop-shadow');
 expect(css).toContain('.loading-console-scene--reference::before { content: none; }');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('home names the console and selects local model art instead of game artwork', () => {
 const overlay=document.createElement('div');
 showStreamLoading(overlay,'home',{titleId:'id',name:'ExampleConsole',heroArt:'https://store-images.s-microsoft.com/game'}, {consoleType:'XboxSeriesX'});
 expect(overlay.dataset.kind).toBe('home');
 expect(overlay.querySelector('h1')?.textContent).toBe('Conectando a ExampleConsole...');
 expect(overlay.querySelector<HTMLImageElement>('.loading-console')?.src).toContain('xbox-series-x-remote-reference-gold.png');
 expect(overlay.querySelectorAll('.loading-console')).toHaveLength(1);
 expect(overlay.querySelector('.loading-console-scene--reference')).not.toBeNull();
 expect(overlay.querySelector('.loading-orbit, .loading-particle')).toBeNull();
 expect(overlay.querySelector('.loading-artwork')).toBeNull();
 expect(overlay.querySelector('#stream-message')?.textContent).toBe('Preparando tu consola...');
 disposeStreamLoading(overlay);
});
