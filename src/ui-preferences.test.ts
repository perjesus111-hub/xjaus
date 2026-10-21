// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFS_KEY,
  applyUiPreferences,
  createUiPreferencesStore,
  validateUiPreferences,
} from './ui-preferences';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    dump: () => map,
  };
}

describe('ui preferences', () => {
  it('keeps defaults accessible and validates strict enum values', () => {
    expect(DEFAULT_UI_PREFERENCES).toEqual({ density: 'comfortable', cardTitles: 'visible', focusIntensity: 'normal', statsOnStart: false });
    expect(validateUiPreferences({ density: 'compact', statsOnStart: true })).toEqual({ density: 'compact', cardTitles: 'visible', focusIntensity: 'normal', statsOnStart: true });
    // Unknown keys and wrong types fall back per-key instead of rejecting everything (migration-friendly).
    expect(validateUiPreferences({ density: 'huge', cardTitles: 42, futureKey: 'x' })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(validateUiPreferences('junk')).toEqual(DEFAULT_UI_PREFERENCES);
    expect(validateUiPreferences(null)).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('persists preferences and restores them across store instances', () => {
    const storage = fakeStorage();
    const first = createUiPreferencesStore(storage);
    const saved = first.save({ ...DEFAULT_UI_PREFERENCES, density: 'compact', focusIntensity: 'strong', statsOnStart: true });
    expect(saved.density).toBe('compact');
    expect(JSON.parse(storage.dump().get(UI_PREFS_KEY)!)).toMatchObject({ density: 'compact', focusIntensity: 'strong', statsOnStart: true });
    const second = createUiPreferencesStore(storage);
    expect(second.load()).toEqual({ density: 'compact', cardTitles: 'visible', focusIntensity: 'strong', statsOnStart: true });
  });

  it('recovers from corrupt or missing storage with defaults', () => {
    const storage = fakeStorage();
    storage.setItem(UI_PREFS_KEY, '{not json');
    expect(createUiPreferencesStore(storage).load()).toEqual(DEFAULT_UI_PREFERENCES);
    expect(createUiPreferencesStore(fakeStorage()).load()).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('applies preferences as data attributes on the document root', () => {
    applyUiPreferences({ density: 'compact', cardTitles: 'focus', focusIntensity: 'subtle', statsOnStart: true });
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(document.documentElement.dataset.cardTitles).toBe('focus');
    expect(document.documentElement.dataset.focusIntensity).toBe('subtle');
    expect(document.documentElement.dataset.statsOnStart).toBe('true');
  });
});
