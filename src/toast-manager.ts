export function createToastManager(show: (message: string) => void, hide: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  return {
    show(message: string, timeoutMs = 4000): void {
      cancel(); show(message);
      timer = setTimeout(() => { timer = undefined; hide(); }, timeoutMs);
    },
    dispose(): void { cancel(); hide(); },
  };
}
