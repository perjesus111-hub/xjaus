import { describe, expect, it } from 'vitest';
import { bindSystemColorScheme } from './system-theme';

describe('bindSystemColorScheme', () => {
  it('reflects the current system preference and follows later changes', () => {
    let matches = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      get matches() { return matches; },
      addEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    } as unknown as MediaQueryList;
    const root = { dataset: {} } as unknown as HTMLElement;

    const dispose = bindSystemColorScheme(media, root);
    expect(root.dataset.systemTheme).toBe('dark');
    matches = false;
    for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
    expect(root.dataset.systemTheme).toBe('light');
    dispose();
    expect(listeners.size).toBe(0);
  });
});
