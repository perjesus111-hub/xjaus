// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { settleRemoteStop } from './stream-stop';

afterEach(() => vi.useRealTimers());

it('releases the UI after 2s while continuing to observe a late IPC rejection', async () => {
  vi.useFakeTimers();
  let rejectIpc!: (error: Error) => void;
  const ipc = new Promise<void>((_, reject) => { rejectIpc = reject; });
  const finished = vi.fn();
  const stopping = settleRemoteStop(ipc).then(finished);
  await vi.advanceTimersByTimeAsync(1999);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await stopping;
  rejectIpc(new Error('sidecar closed after the UI deadline'));
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toHaveBeenCalledTimes(1);
});
