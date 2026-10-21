/** Settings subnavigation: one real section per mockup category, wired as
 *  ARIA tabs so mouse, keyboard arrows and gamepad (focus + A) all work.
 *  Sections without real controls are intentionally not listed. */
export type SettingsSection = 'general' | 'streaming' | 'video' | 'interfaz' | 'diagnostico' | 'acerca';

export type SettingsNavigation = {
  readonly current: SettingsSection | null;
  /** Returns false for unknown sections (callers can rely on real selection). */
  select(id: SettingsSection, focus?: boolean): boolean;
};

export function initSettingsNavigation(doc: Document): SettingsNavigation {
  const items = [...doc.querySelectorAll<HTMLButtonElement>('.settings-subnav [data-settings-section]')];
  const panels = [...doc.querySelectorAll<HTMLElement>('[data-settings-panel]')];
  const known = new Set(items.map((item) => item.dataset.settingsSection as SettingsSection));
  let current: SettingsSection | null = null;

  function select(id: SettingsSection, focus = false): boolean {
    if (!known.has(id)) return false;
    current = id;
    for (const item of items) {
      const active = item.dataset.settingsSection === id;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      if (active && focus) item.focus();
    }
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== id;
    return true;
  }

  const nav = items[0]?.closest<HTMLElement>('.settings-subnav');
  const selectFrom = (target: EventTarget | null, focus = false): boolean => {
    const item = (target as Element | null)?.closest?.<HTMLButtonElement>('[data-settings-section]');
    return item ? select(item.dataset.settingsSection as SettingsSection, focus) : false;
  };
  // Delegate from the stable nav root; nested icon/text targets and pointer
  // delivery now share the same path as direct keyboard activation.
  nav?.addEventListener('pointerdown', (event) => { selectFrom(event.target); });
  nav?.addEventListener('click', (event) => { selectFrom(event.target); });

  for (const item of items) {
    // that do not bubble synthetic activation events.
    item.addEventListener('click', () => { select(item.dataset.settingsSection as SettingsSection); });
    // Roving focus without selection: arrows move focus, Enter/click/A selects.
    item.addEventListener('keydown', (event) => {
      const index = items.indexOf(item);
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); items[(index + 1) % items.length]!.focus(); }
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); items[(index - 1 + items.length) % items.length]!.focus(); }
      else if (event.key === 'Home') { event.preventDefault(); items[0]!.focus(); }
      else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]!.focus(); }
    });
  }

  return {
    get current() { return current; },
    select,
  };
}
