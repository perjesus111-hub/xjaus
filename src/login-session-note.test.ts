// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { i18n, localizeDocument } from './i18n';

const previousPreference = i18n.preference;
afterEach(() => { i18n.setPreference(previousPreference); document.body.innerHTML = ''; });

it('presents the restart sign-in notice accessibly in Spanish and English', () => {
  const html = readFileSync('index.html', 'utf8');
  const parsed = new DOMParser().parseFromString(html.replace(/<head>[\s\S]*?<\/head>/, '<head></head>'), 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  const login = document.querySelector<HTMLButtonElement>('#btn-login')!;
  const noteId = login.getAttribute('aria-describedby');
  expect(noteId).toBeTruthy();
  const note = document.getElementById(noteId!);
  expect(note).not.toBeNull();
  expect(note!.closest('#login-screen')).not.toBeNull();
  expect(note!.hidden).toBe(false);
  expect(note!.getAttribute('aria-hidden')).not.toBe('true');
  localizeDocument();
  i18n.setPreference('es');
  expect(note!.textContent).toBe('Debes iniciar sesión de nuevo cada vez que abras XJAUS.');
  i18n.setPreference('en');
  expect(note!.textContent).toBe('You must sign in again each time you open XJAUS.');
});
