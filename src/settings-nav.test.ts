// @vitest-environment happy-dom
/// <reference types="vite/client" />
import html from '../index.html?raw';
import { beforeEach, describe, expect, it } from 'vitest';
import { initSettingsNavigation, type SettingsSection } from './settings-nav';

function mount(): void {
  document.documentElement.innerHTML = html.replace(/<link\b[^>]*>/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

describe('settings subnavigation', () => {
  beforeEach(mount);

  it('exposes one navigation item per real section, each with a matching panel', () => {
    const items = [...document.querySelectorAll<HTMLButtonElement>('.settings-subnav [data-settings-section]')];
    const sections = items.map((item) => item.dataset.settingsSection);
    for (const id of ['general', 'streaming', 'video', 'interfaz', 'diagnostico', 'acerca']) expect(sections).toContain(id);
    expect(new Set(sections).size).toBe(items.length);
    for (const item of items) {
      expect(item.getAttribute('role')).toBe('tab');
      expect(document.querySelector(`[data-settings-panel="${item.dataset.settingsSection}"]`)).toBeTruthy();
    }
    // Real controls stay in the DOM, grouped under their sections.
    expect(document.getElementById('app-language')).toBeTruthy();
    expect(document.getElementById('stream-resolution')).toBeTruthy();
    expect(document.getElementById('stream-bitrate')).toBeTruthy();
    expect(document.getElementById('stream-codec')).toBeTruthy();
    expect(document.getElementById('stream-audio')).toBeTruthy();
    expect(document.getElementById('stream-audioGain')).toBeTruthy();
    expect(document.getElementById('copy-diagnostics')).toBeTruthy();
  });

  it('selects a section on click, hides the others and keeps engine controls intact', () => {
    const nav = initSettingsNavigation(document);
    const streaming = document.querySelector<HTMLButtonElement>('[data-settings-section="streaming"]')!;
    streaming.click();
    expect(nav.current).toBe('streaming');
    expect(streaming.getAttribute('aria-selected')).toBe('true');
    expect(streaming.classList.contains('active')).toBe(true);
    for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
      expect(panel.hidden).toBe(panel.dataset.settingsPanel !== 'streaming');
    }
    // The engine payload grid must remain queryable for updateSettingsDiagnostics.
    expect(document.querySelector<HTMLElement>('#panel-settings .settings-grid')!.dataset).toBeTruthy();
    const general = document.querySelector<HTMLButtonElement>('[data-settings-section="general"]')!;
    general.click();
    expect(nav.current).toBe('general');
    expect(document.querySelector<HTMLElement>('[data-settings-panel="streaming"]')!.hidden).toBe(true);
  });

  it('supports arrow-key roving focus and rejects unknown sections', () => {
    const nav = initSettingsNavigation(document);
    expect(nav.select('nope' as Extract<SettingsSection, 'nope'>)).toBe(false);
    const items = [...document.querySelectorAll<HTMLButtonElement>('.settings-subnav [data-settings-section]')];
    items[0]!.focus();
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    items[items.length - 1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });
});
