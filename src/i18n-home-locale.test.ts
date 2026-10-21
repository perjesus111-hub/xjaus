// @vitest-environment happy-dom
import { afterEach, it, expect } from 'vitest';
import html from '../index.html?raw';
import { createI18n, i18n, dictionaries, localizeDocument } from './i18n';

afterEach(() => {
  document.body.replaceChildren();
  i18n.setPreference('auto');
});

it('switches the Home screen Spanish→English→Spanish and persists English in a new i18n instance', () => {
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  i18n.setPreference('es');
  localizeDocument();
  const markedElements = Array.from(document.querySelectorAll<HTMLElement>('[data-i18n],[data-i18n-aria],[data-i18n-placeholder],[data-i18n-title]'));
  const translationKeys = markedElements.flatMap(element => ['i18n','i18nAria','i18nPlaceholder','i18nTitle'].flatMap(property => { const key = element.dataset[property]; return key ? [key] : []; }));
  expect(translationKeys.filter(key => !Object.prototype.hasOwnProperty.call(dictionaries.en, key))).toEqual([]);
  expect(document.documentElement.lang).toBe('es');
  expect(i18n.t('favorites')).toBe('Favoritos');
  expect(document.querySelector('.sidebar-footer')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Tu Xbox. Tus juegos. En Linux.');
  expect(document.querySelector('#featured-title')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Juega tus juegos de Xbox en Linux');
  expect(document.querySelector('[data-action="home"]')?.textContent?.trim()).toBe('Inicio');

  i18n.setPreference('en');
  expect(document.documentElement.lang).toBe('en');
  expect(document.querySelector('[data-action="home"]')?.textContent?.trim()).toBe('Home');
  expect(i18n.t('favorites')).toBe('Favorites');
  expect(i18n.t('playNow')).toBe('Play now');
  expect(i18n.t('addFavorite')).toBe('Add to favorites');
  expect(i18n.t('removeFavorite')).toBe('Remove from favorites');
  expect(i18n.t('cancel')).toBe('Cancel');
  expect(document.querySelector('.sidebar-footer')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Your Xbox. Your games. On Linux.');
  expect(document.querySelector('#featured-title')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Play your Xbox games on Linux');
  expect(document.querySelector('#featured-meta')?.textContent?.trim()).toBe('Cloud Gaming and Remote Play in one app.');
  expect(document.querySelector('#featured-open')?.textContent?.trim()).toBe('View game');
  expect(document.querySelector('[data-home-action="cloud"] span')?.textContent?.trim()).toBe('Play hundreds of games from the cloud.');
  expect(document.querySelector('[data-home-action="consoles"] span')?.textContent?.trim()).toBe('Stream from your Xbox console.');
  expect(document.querySelector('#dashboard-recent-title')?.textContent?.trim()).toBe('Recent games');
  expect(document.querySelector('#panel-home .dashboard-recent p')?.textContent?.trim()).toBe('Your activity will appear here after you start a game.');

  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const firstLaunch = createI18n(storage, ['es-MX']);
  firstLaunch.setPreference('en');
  expect(createI18n(storage, ['es-MX']).locale).toBe('en');

  i18n.setPreference('es');
  expect(document.documentElement.lang).toBe('es');
  expect(document.querySelector('[data-action="home"]')?.textContent?.trim()).toBe('Inicio');
  expect(document.querySelector('.sidebar-footer')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Tu Xbox. Tus juegos. En Linux.');
  expect(i18n.t('diagnosticsCopied')).toBe('Informe técnico copiado');
});
