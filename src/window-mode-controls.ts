/** Native window mode is renderer-triggered but remains capability-limited in Electron. */
export function bindWindowModeControls(root: ParentNode, toggle: () => void): () => void {
  const controls = [...root.querySelectorAll<HTMLButtonElement>('[data-window-mode-toggle]')];
  const click = () => toggle();
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'F11' || event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.defaultPrevented) return;
    event.preventDefault();
    toggle();
  };
  controls.forEach(control => control.addEventListener('click', click));
  window.addEventListener('keydown', keydown);
  return () => {
    controls.forEach(control => control.removeEventListener('click', click));
    window.removeEventListener('keydown', keydown);
  };
}
