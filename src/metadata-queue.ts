// Only settled, currently visible missing metadata. Never a rights request.
// One bounded request at a time; pending snapshots replace stale query work.
export function createMetadataQueue(fetch: (ids: string[]) => Promise<void>) {
 let timer: ReturnType<typeof setTimeout> | undefined;
 let pending: string[] = [], running = false, disposed = false;
 const done = new Set<string>(), inFlight = new Set<string>();
 async function drain() {
  if (running || disposed) return;
  running = true;
  try {
   while (pending.length && !disposed) {
    const batch = pending.splice(0,25).filter(id=>!done.has(id) && !inFlight.has(id));
    if (!batch.length) continue;
    batch.forEach(id=>inFlight.add(id));
    try { await fetch(batch); batch.forEach(id=>done.add(id)); }
    catch { /* retry on the next settled snapshot; never spin on errors */ }
    finally { batch.forEach(id=>inFlight.delete(id)); }
   }
  } finally { running = false; }
 }
 return {
  schedule(ids: string[]) {
   clearTimeout(timer);
   pending = [];
   timer = setTimeout(()=>{ pending=[...new Set(ids)].filter(id=>!done.has(id)&&!inFlight.has(id)); void drain(); },180);
  },
  cancelPending() { clearTimeout(timer); pending=[]; },
  dispose() { disposed=true; clearTimeout(timer); pending=[]; },
 };
}
