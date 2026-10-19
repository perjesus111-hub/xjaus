import { describe, it, expect, vi } from 'vitest';
import { createMetadataQueue } from './metadata-queue';
describe('settled visible metadata', () => {
 it('debounces typing, batches at 25, coalesces and caches in-flight ids', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_ids: string[]) => {});
  const queue = createMetadataQueue(fetch);
  const ids = Array.from({length:60},(_,i)=>String(i));
  queue.schedule(ids); queue.schedule(ids); queue.schedule(ids);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(179); expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch.mock.calls.map(c=>c[0].length)).toEqual([25,25,10]);
  queue.schedule(ids); await vi.advanceTimersByTimeAsync(180); expect(fetch).toHaveBeenCalledTimes(3);
  queue.dispose(); vi.useRealTimers();
 });
});
