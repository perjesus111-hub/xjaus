export type FullscreenAction = 'enter' | 'exit' | 'toggle' | 'restore';
export function requestPlayerFullscreen(action: FullscreenAction): void {
  const bridge = (window as Window & { xjaus?: { fullscreen?: (action: FullscreenAction) => Promise<void> } }).xjaus;
  void bridge?.fullscreen?.(action).catch(() => undefined);
}
/** Session-owned listeners; readiness is one-shot even after pause/resume. */
export function bindPlayerFullscreen(video: HTMLVideoElement, keys: EventTarget, send = requestPlayerFullscreen): () => void {
  let entered = false;
  let closed = false;
  const playing = () => { if (!entered && !closed) { entered = true; send('enter'); } };
  const keydown = (event: Event) => {
    const key = event as KeyboardEvent;
    if (key.ctrlKey || key.defaultPrevented || key.repeat || (key.key !== 'F11' && key.key !== 'Escape')) return;
    key.preventDefault();
    send(key.key === 'F11' ? 'toggle' : 'exit');
  };
  video.addEventListener('playing', playing);
  keys.addEventListener('keydown', keydown);
  return () => {
    if (closed) return;
    closed = true;
    video.removeEventListener('playing', playing);
    keys.removeEventListener('keydown', keydown);
    send('restore');
  };
}
