import { t, bindText } from './i18n';
import type { CloudTitle } from './catalog';
import xboxUserMark from './assets/hardware/xbox-user-mark.png';
import seriesXReference from './assets/consoles/xbox-series-x-remote-reference-gold.png';
import { gameDisplayName } from './game-name';
import { consolePresentation } from './console-presentation';

const cloudTips = ['tip0','tip1','tip2','tip3','tip4','tip5','tip6'] as const;
const homeTips = ['tip7','tip8','tip9','tip10'] as const;
const loadingCleanup = new WeakMap<HTMLElement, () => void>();
export function disposeStreamLoading(overlay: HTMLElement): void {
  loadingCleanup.get(overlay)?.();
  loadingCleanup.delete(overlay);
}

/** Presentation only. Never starts a session or grants access. */
export function showStreamLoading(overlay: HTMLElement, kind: 'home' | 'cloud', game: CloudTitle, console?: { consoleType?: string }): void {
  disposeStreamLoading(overlay);
  overlay.replaceChildren(); overlay.hidden = false;
  overlay.dataset.kind = kind;
  const source = kind === 'cloud' ? game.heroArt || game.boxArt : undefined;
  overlay.dataset.artwork = game.heroArt ? 'hero' : game.boxArt ? 'poster' : 'none';
  if (source) {
    const image = document.createElement('img'); image.className = 'loading-artwork'; image.alt = '';
    // Safe store host only, including data restored from metadata cache.
    try {
      const url = new URL(source);
      if (url.protocol === 'https:' && url.hostname === 'store-images.s-microsoft.com') image.src = url.toString();
    } catch { /* render the neutral background */ }
    image.addEventListener('error', () => {
      if (game.heroArt && game.boxArt && image.src !== game.boxArt) {
        try { const fallback = new URL(game.boxArt); if (fallback.protocol === 'https:' && fallback.hostname === 'store-images.s-microsoft.com') { overlay.dataset.artwork = 'poster'; image.src = fallback.toString(); return; } } catch { /* no unsafe fallback */ }
      }
      image.hidden = true; overlay.dataset.artwork = 'none';
    });
    overlay.append(image);
  }
  if (kind === 'home') {
    overlay.dataset.artwork = 'console';
    const art = document.createElement('div'); art.className = 'loading-console-scene';
    const model = consolePresentation(console?.consoleType);
    const reference = console?.consoleType === 'XboxSeriesX';
    art.classList.toggle('loading-console-scene--reference', reference);
    const image = document.createElement('img'); image.className = 'loading-console'; image.src = reference ? seriesXReference : model.image; image.alt = model.name;
    if (!reference) {
      for (let i = 0; i < 3; i++) { const orbit = document.createElement('span'); orbit.className = `loading-orbit orbit-${i}`; art.append(orbit); }
      for (let i = 0; i < 8; i++) { const particle = document.createElement('span'); particle.className = 'loading-particle'; particle.style.setProperty('--i', String(i)); art.append(particle); }
    }
    art.append(image); overlay.append(art);
  }
  const brand = document.createElement('div'); brand.className = 'loading-brand xbox-cloud-brand';
  const icon = document.createElement('img'); icon.src = xboxUserMark;
  icon.width = 36; icon.height = 36; icon.alt = 'Xbox'; icon.className = 'xbox-icon';
  const lockup = document.createElement('div'); lockup.className = 'loading-brand-lockup';
  const wordmark = document.createElement('span'); wordmark.className = 'loading-brand-wordmark'; wordmark.textContent = 'XBOX';
  const chip = document.createElement('span'); chip.className = 'loading-chip'; chip.textContent = kind === 'cloud' ? 'CLOUD GAMING' : 'REMOTE PLAY';
  lockup.append(wordmark, chip); brand.append(icon, lockup);
  const content = document.createElement('div'); content.className = 'loading-content';
  const label = document.createElement('span'); label.className = 'loading-eyebrow'; bindText(label,()=>t('preparingGame'));
  const title = document.createElement('h1'); bindText(title,()=>kind === 'home' ? t('connectTo',{name:game.name}) : gameDisplayName(game));
  const status = document.createElement('div'); status.className = 'loading-status';
  const ring = document.createElement('span'); ring.className = 'loading-ring'; ring.setAttribute('aria-hidden','true');
  const message = document.createElement('p'); message.id = 'stream-message'; bindText(message,()=>kind === 'cloud' ? t('connectingCloud') : t('preparingConsole'));
  status.append(ring, message); content.append(label, title, status);
  const footer = document.createElement('p'); footer.className = 'loading-tip';
  const tips = kind === 'home' ? homeTips : cloudTips;
  let index = Math.floor(Math.random() * tips.length);
  bindText(footer,()=>t(tips[index])); footer.style.opacity = '1';
  let fade: ReturnType<typeof setTimeout> | undefined;
  const interval = setInterval(() => {
    footer.style.opacity = '0';
    fade = setTimeout(() => {
      index = (index + 1) % tips.length;
      bindText(footer,()=>t(tips[index])); footer.style.opacity = '1';
    }, 350);
  }, 6500);
  loadingCleanup.set(overlay, () => { clearInterval(interval); clearTimeout(fade); });
  overlay.append(brand, content, footer);
}
export function bindLoadingPlayback(video: HTMLVideoElement, overlay: HTMLElement): () => void {
  const ready = () => { disposeStreamLoading(overlay); overlay.hidden = true; };
  video.addEventListener('playing', ready);
  return () => { video.removeEventListener('playing', ready); disposeStreamLoading(overlay); };
}
