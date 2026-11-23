/** The UI deadline never aborts or retries IPC. Electron may still be waiting
 * for its pipe to drain; the backend owns cleanup for the exact session handle.
 * Observe both outcomes even after the caller has stopped waiting. */
export function settleRemoteStop(operation: Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, 2000);
    void operation.then(finish, finish);
  });
}
