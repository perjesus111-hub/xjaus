import { describe, expect, it, vi } from 'vitest';
import { createToastManager } from './toast-manager';

describe('toast manager', () => {
  it('replaces a prior notification and auto-hides the latest one', () => {
    vi.useFakeTimers();
    const shown: string[] = []; let hides = 0;
    const toast = createToastManager((value) => shown.push(value), () => { hides++; });
    toast.show('first', 3000);
    vi.advanceTimersByTime(2000);
    toast.show('second', 4000);
    vi.advanceTimersByTime(1500); expect(hides).toBe(0);
    vi.advanceTimersByTime(2500); expect(hides).toBe(1);
    expect(shown).toEqual(['first', 'second']);
    vi.useRealTimers();
  });

  it('cancels pending expiry during disposal', () => {
    vi.useFakeTimers(); let hides = 0;
    const toast = createToastManager(() => {}, () => { hides++; });
    toast.show('message', 3000); toast.dispose(); vi.advanceTimersByTime(5000);
    expect(hides).toBe(1);
    vi.useRealTimers();
  });
});
