// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from 'vitest';
import { mountStreamMenu } from './stream-menu';
import { i18n } from './i18n';

afterEach(() => {
  document.body.replaceChildren();
  i18n.setPreference('auto');
});

it('updates the open stream menu and gamepad hints immediately when the locale changes', () => {
  document.body.innerHTML = '<section id="player"><video></video></section>';
  i18n.setPreference('es');
  const menu = mountStreamMenu(document.querySelector('#player')!, {
    setModal: vi.fn(), toggleTelemetry: vi.fn(), disconnect: vi.fn(async () => {}), exit: vi.fn(async () => {}),
  });
  menu.toggle();
  const text = (selector: string) => document.querySelector(selector)?.textContent?.trim();
  expect(text('[data-action="resume"]')).toBe('Reanudar');
  expect(text('[data-action="screenshot"]')).toBe('Captura de pantalla');
  expect(text('[data-action="disconnect"]')).toBe('Desconectar');
  expect(text('[data-action="exit"]')).toBe('Salir de la aplicación');
  expect(document.querySelector('.hint-a')?.textContent).toContain('Seleccionar');
  expect(document.querySelector('.hint-b')?.textContent).toContain('Volver al juego');

  i18n.setPreference('en');
  expect(document.documentElement.lang).toBe('en');
  expect(text('[data-action="resume"]')).toBe('Resume');
  expect(text('[data-action="screenshot"]')).toBe('Screenshot');
  expect(text('[data-action="disconnect"]')).toBe('Disconnect');
  expect(text('[data-action="exit"]')).toBe('Quit application');
  expect(document.querySelector('.hint-a')?.textContent).toContain('Select');
  expect(document.querySelector('.hint-b')?.textContent).toContain('Back to game');
  menu.dispose();
});
