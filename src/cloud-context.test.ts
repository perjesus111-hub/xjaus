// @vitest-environment happy-dom
/// <reference types="vite/client" />
import html from '../index.html?raw';
import { beforeEach, describe, expect, it } from 'vitest';
import { i18n } from './i18n';
import { initCloudContext } from './cloud-context';

function mount(): void {
  document.documentElement.innerHTML = html.replace(/<link\b[^>]*>/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

beforeEach(() => { mount(); i18n.setPreference('es'); });

function card(titleId: string, title: string, opts: { art?: string; description?: string; favorite?: boolean; multiplayer?: boolean; controller?: boolean } = {}): HTMLElement {
  const el = document.createElement('article');
  el.className = 'game-card';
  el.dataset.titleId = titleId;
  if (opts.description) el.dataset.description = opts.description;
  el.innerHTML = `<h3>${title}</h3><div class="game-artwork">${opts.art ? `<img class="game-cover" src="${opts.art}" alt="">` : ''}${opts.multiplayer ? '<span class="multiplayer-badge">Multijugador</span>' : ''}${opts.controller ? '<span class="controller-support">🎮</span>' : ''}</div><button class="favorite-toggle" aria-pressed="${String(!!opts.favorite)}">☆</button><button class="connect-btn">Jugar</button>`;
  return el;
}

describe('cloud catalog context', () => {
  beforeEach(mount);

  it('counts real cards and favorites from the DOM', () => {
    const grid = document.querySelector<HTMLElement>('#cloud-container')!;
    grid.replaceChildren(card('a', 'Alpha', { favorite: true }), card('b', 'Beta'), card('c', 'Gamma', { favorite: true }));
    const ctx = initCloudContext({
      grid,
      meta: document.querySelector<HTMLElement>('#cloud-meta')!,
      panel: document.querySelector<HTMLElement>('#cloud-context')!,
      title: document.querySelector<HTMLElement>('#cloud-context-title')!,
      art: document.querySelector<HTMLImageElement>('#cloud-context-art')!,
      tags: document.querySelector<HTMLElement>('#cloud-context-tags')!,
      description: document.querySelector<HTMLElement>('#cloud-context-description')!,
      play: document.querySelector<HTMLButtonElement>('#cloud-context-play')!,
    });
    ctx.updateMeta();
    expect(document.querySelector<HTMLElement>('#cloud-meta')!.dataset.total).toBe('3');
    expect(document.querySelector<HTMLElement>('#cloud-meta')!.dataset.favorites).toBe('2');
    expect(document.querySelector<HTMLElement>('#cloud-meta')!.textContent).toContain('3');
    expect(document.querySelector<HTMLElement>('#cloud-meta')!.textContent).toContain('2');
  });

  it('shows only real card data for the focused game and hides without focus', () => {
    const grid = document.querySelector<HTMLElement>('#cloud-container')!;
    grid.replaceChildren(card('a', 'Alpha Prime', { art: 'https://images.test/box.png', description: 'Official product description.', favorite: true, multiplayer: true, controller: true }));
    initCloudContext({
      grid,
      meta: document.querySelector<HTMLElement>('#cloud-meta')!,
      panel: document.querySelector<HTMLElement>('#cloud-context')!,
      title: document.querySelector<HTMLElement>('#cloud-context-title')!,
      art: document.querySelector<HTMLImageElement>('#cloud-context-art')!,
      tags: document.querySelector<HTMLElement>('#cloud-context-tags')!,
      description: document.querySelector<HTMLElement>('#cloud-context-description')!,
      play: document.querySelector<HTMLButtonElement>('#cloud-context-play')!,
    });
    expect(document.querySelector<HTMLElement>('#cloud-context')!.hidden).toBe(true);
    grid.querySelector<HTMLElement>('.favorite-toggle')!.focus();
    const panel = document.querySelector<HTMLElement>('#cloud-context')!;
    expect(panel.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#cloud-context-title')!.textContent).toBe('Alpha Prime');
    expect(document.querySelector<HTMLImageElement>('#cloud-context-art')!.src).toBe('https://images.test/box.png');
    expect(document.querySelector<HTMLElement>('#cloud-context-description')!.textContent).toBe('Official product description.');
    expect(document.querySelector<HTMLElement>('#cloud-context-description')!.hidden).toBe(false);
    const tags = document.querySelector<HTMLElement>('#cloud-context-tags')!;
    expect(tags.textContent).toContain('Multijugador');
    expect(tags.textContent).toContain(' Compatible con mando');
    expect(document.querySelector<HTMLButtonElement>('#cloud-context-play')!.dataset.titleId).toBe('a');
    // Leaving the grid hides the strip again (no stale selection).
    (document.body as HTMLElement).focus?.();
    grid.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
    expect(panel.hidden).toBe(true);
  });

  it('plays through the card button when the strip action is used', () => {
    const grid = document.querySelector<HTMLElement>('#cloud-container')!;
    grid.replaceChildren(card('a', 'Alpha', { art: 'https://images.test/box.png' }));
    let clicked = 0;
    grid.querySelector('.connect-btn')!.addEventListener('click', () => { clicked++; });
    initCloudContext({
      grid,
      meta: document.querySelector<HTMLElement>('#cloud-meta')!,
      panel: document.querySelector<HTMLElement>('#cloud-context')!,
      title: document.querySelector<HTMLElement>('#cloud-context-title')!,
      art: document.querySelector<HTMLImageElement>('#cloud-context-art')!,
      tags: document.querySelector<HTMLElement>('#cloud-context-tags')!,
      description: document.querySelector<HTMLElement>('#cloud-context-description')!,
      play: document.querySelector<HTMLButtonElement>('#cloud-context-play')!,
    });
    grid.querySelector<HTMLButtonElement>('.connect-btn')!.focus();
    document.querySelector<HTMLButtonElement>('#cloud-context-play')!.click();
    expect(clicked).toBe(1);
  });
});
