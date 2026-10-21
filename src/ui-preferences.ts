/** Local UI-only preferences (density, focus ring, cover titles, stats autoplay).
 *  Deliberately separate from StreamSettings: these never reach the engine,
 *  never affect the Rust sidecar, and are localStorage-only. */
export type UiPreferences = {
  density: 'comfortable' | 'compact';
  cardTitles: 'visible' | 'focus';
  focusIntensity: 'subtle' | 'normal' | 'strong';
  statsOnStart: boolean;
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  density: 'comfortable',
  cardTitles: 'visible',
  focusIntensity: 'normal',
  statsOnStart: false,
};

export const UI_PREFS_KEY = 'xjaus:ui:v1';

const DENSITIES = ['comfortable', 'compact'] as const;
const CARD_TITLES = ['visible', 'focus'] as const;
const FOCUS_INTENSITIES = ['subtle', 'normal', 'strong'] as const;

/** Per-key validation merged over defaults: unknown keys and wrong-typed
 *  values fall back individually so older payloads stay loadable. */
export function validateUiPreferences(value: unknown): UiPreferences {
  const merged: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return merged;
  const v = value as Record<string, unknown>;
  if (typeof v.density === 'string' && (DENSITIES as readonly string[]).includes(v.density)) merged.density = v.density as UiPreferences['density'];
  if (typeof v.cardTitles === 'string' && (CARD_TITLES as readonly string[]).includes(v.cardTitles)) merged.cardTitles = v.cardTitles as UiPreferences['cardTitles'];
  if (typeof v.focusIntensity === 'string' && (FOCUS_INTENSITIES as readonly string[]).includes(v.focusIntensity)) merged.focusIntensity = v.focusIntensity as UiPreferences['focusIntensity'];
  if (typeof v.statsOnStart === 'boolean') merged.statsOnStart = v.statsOnStart;
  return merged;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function createUiPreferencesStore(storage?: StorageLike) {
  let current: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  let loaded = false;
  return {
    get current(): UiPreferences { return { ...current }; },
    get ready(): boolean { return loaded; },
    load(): UiPreferences {
      try {
        const raw = storage?.getItem(UI_PREFS_KEY);
        if (raw) current = validateUiPreferences(JSON.parse(raw));
      } catch { current = { ...DEFAULT_UI_PREFERENCES }; }
      loaded = true;
      return { ...current };
    },
    save(prefs: UiPreferences): UiPreferences {
      current = validateUiPreferences(prefs);
      try { storage?.setItem(UI_PREFS_KEY, JSON.stringify(current)); } catch { /* session-only preferences still apply */ }
      return { ...current };
    },
  };
}

/** Reflect preferences on the root element; CSS keys off these data attributes. */
export function applyUiPreferences(prefs: UiPreferences, root: HTMLElement = document.documentElement): void {
  root.dataset.density = prefs.density;
  root.dataset.cardTitles = prefs.cardTitles;
  root.dataset.focusIntensity = prefs.focusIntensity;
  root.dataset.statsOnStart = String(prefs.statsOnStart);
}
