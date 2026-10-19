import {i18n} from './i18n';
i18n.setPreference('es');
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
// @ts-expect-error Node types are not part of the browser build; Vitest runs this import in Node.
import { readFileSync } from 'node:fs';
const css: string = readFileSync('src/styles.css', 'utf8');
const main: string = readFileSync('src/main.ts', 'utf8');
import { normalizeCloudTitles } from './catalog';
it('uses the requested brand and footer geometry and stop cleans loading even before binding playback', () => {
 expect(css).toContain('.xbox-cloud-brand { position: absolute; top: 36px; left: 36px;');
 expect(css).not.toContain('.loading-brand::before');
 expect(css).toContain('transition: opacity 350ms');
 expect(main.slice(main.indexOf('async function stopGame'),main.indexOf('async function startGame'))).toContain('disposeStreamLoading(overlay)');
});
import { showStreamLoading, bindLoadingPlayback } from './loading-presentation';
const raw = {results:[{titleId:'ASSASSINSCREEDVALHALLA',details:{productId:'9N2Z748SPMTM',hasEntitlement:true}}]};
it('selects only safe large horizontal artwork, independent of poster', () => {
 const products = {Products:[{ProductId:'9N2Z748SPMTM',LocalizedProperties:[{Images:[{ImagePurpose:'Hero',Uri:'https://evil.invalid/a',Width:1920,Height:1080},{ImagePurpose:'FeaturePromo',Uri:'https://store-images.s-microsoft.com/hero',Width:1920,Height:1080},{ImagePurpose:'Poster',Uri:'https://store-images.s-microsoft.com/poster'}]}]}]};
 expect(normalizeCloudTitles(raw,products)[0].heroArt).toBe('https://store-images.s-microsoft.com/hero');
});
it('accepts DisplayCatalog real SuperHeroArt and ignores undersized or square promotions', () => {
 const metadata={Products:[{ProductId:'9N2Z748SPMTM',LocalizedProperties:[{Images:[
 {ImagePurpose:'FeaturePromotionalSquareArt',Uri:'https://store-images.s-microsoft.com/square',Width:2160,Height:2160},
 {ImagePurpose:'Hero',Uri:'https://store-images.s-microsoft.com/small',Width:640,Height:360},
 {ImagePurpose:'SuperHeroArt',Uri:'https://store-images.s-microsoft.com/realhero',Width:3840,Height:2160}
 ]}]}]};
 expect(normalizeCloudTitles(raw,metadata)[0].heroArt).toBe('https://store-images.s-microsoft.com/realhero');
});
it('presents title, short cloud status and blurred poster fallback without html injection', () => {
 const overlay=document.createElement('div');
 showStreamLoading(overlay,'cloud',{titleId:'ASSASSINSCREEDVALHALLA',name:'ASSASSINSCREEDVALHALLA',fallbackLabel:true,boxArt:'https://store-images.s-microsoft.com/poster'});
 expect(overlay.querySelector('h1')?.textContent).toContain('Valhalla');
 expect(overlay.textContent).toContain('Conectando con la nube Xbox');
 expect(overlay.dataset.artwork).toBe('poster');
 expect(overlay.querySelector('img')?.src).toBe('https://store-images.s-microsoft.com/poster');
});
it('brands the loading screen with the Xbox wordmark and a flat service label, no pill border', () => {
 const overlay=document.createElement('div');
 showStreamLoading(overlay,'cloud',{titleId:'X',name:'X'});
 const brand=overlay.querySelector('.loading-brand');
 expect(brand).not.toBeNull();
 expect(brand?.className).not.toContain('loading-chip');
 const wordmark=brand?.querySelector('.loading-brand-wordmark');
 expect(wordmark?.textContent).toBe('XBOX');
 expect(brand?.classList.contains('xbox-cloud-brand')).toBe(true);
 const icon=brand?.querySelector<HTMLImageElement>('img.xbox-icon');
 expect(icon?.getAttribute('src')).toContain('xbox-user-mark.png');
 expect(icon?.width).toBe(36);
 expect(icon?.height).toBe(36);
 expect(icon?.alt).toBe('Xbox');
 expect(brand?.querySelector('svg')).toBeNull();
 const chip=brand?.querySelector('.loading-chip');
 expect(chip?.textContent).toBe('CLOUD GAMING');
 expect(brand?.querySelectorAll('.loading-chip').length).toBe(1);
 expect(chip?.classList.contains('loading-chip')).toBe(true);
});
it('randomizes the initial tip and rotates sequentially every 6500ms with a 350ms fade', () => {
 vi.useFakeTimers(); vi.spyOn(Math,'random').mockReturnValue(.99);
 const overlay=document.createElement('div'); showStreamLoading(overlay,'cloud',{titleId:'X',name:'X'});
 const tip=overlay.querySelector<HTMLElement>('.loading-tip')!;
 expect(tip.textContent).toBe('💡 Consejo: El modo Pantalla Completa reduce la latencia de entrada y mejora la fluidez visual.');
 expect(overlay.textContent).toContain('CLOUD GAMING');
 vi.advanceTimersByTime(6499); expect(tip.style.opacity).not.toBe('0');
 vi.advanceTimersByTime(1); expect(tip.style.opacity).toBe('0');
 vi.advanceTimersByTime(349); expect(tip.textContent).toContain('Pantalla Completa');
 vi.advanceTimersByTime(1); expect(tip.textContent).toBe('💡 Consejo: Puedes presionar el botón Xbox (Guía) para pausar, invocar el menú rápido o salir del juego.'); expect(tip.style.opacity).toBe('1');
 vi.advanceTimersByTime(6500); expect(tip.textContent).toContain('Ethernet');
});
for (const reason of ['remount', 'playing', 'dispose'] as const) {
 it(`clears the interval and pending fade on ${reason}`, () => {
  vi.useFakeTimers(); vi.spyOn(Math,'random').mockReturnValue(0);
  const overlay=document.createElement('div'), video=document.createElement('video');
  showStreamLoading(overlay,'cloud',{titleId:'X',name:'X'});
  const tip=overlay.querySelector('.loading-tip')!;
  const dispose=bindLoadingPlayback(video,overlay);
  vi.advanceTimersByTime(6500); expect(vi.getTimerCount()).toBe(2);
  if(reason==='remount') showStreamLoading(overlay,'cloud',{titleId:'Y',name:'Y'});
  else if(reason==='playing') video.dispatchEvent(new Event('playing'));
  else dispose();
  expect(vi.getTimerCount()).toBe(reason==='remount'?1:0);
  vi.advanceTimersByTime(350); expect(tip.textContent).toContain('Guía');
  dispose(); expect(vi.getTimerCount()).toBe(0);
 });
}
it('waits for actual playback, not metadata, and disposes its listener', () => {
 const overlay=document.createElement('div'), video=document.createElement('video');
 const dispose=bindLoadingPlayback(video,overlay);
 video.dispatchEvent(new Event('loadedmetadata')); expect(overlay.hidden).toBe(false);
 video.dispatchEvent(new Event('playing')); expect(overlay.hidden).toBe(true);
 overlay.hidden=false;dispose();video.dispatchEvent(new Event('playing'));expect(overlay.hidden).toBe(false);
});
