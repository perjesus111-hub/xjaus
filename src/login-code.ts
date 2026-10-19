import { i18n, t } from './i18n';

/** Own the backend-provided pairing code, never a displayed placeholder. */
export function createLoginCode(value: unknown) {
  const code = typeof value === 'string' ? value : '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'device-code';
  button.textContent = code;
  button.disabled = !code.trim();
  const status = document.createElement('div');
  status.className = 'copy-code-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  let feedback: 'copiedCode' | 'copyCodeFailed' | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let pending = false;
  const render = () => {
    button.setAttribute('aria-label', t('copyLoginCode', { code }));
    button.title = t('copyLoginCode', { code });
    status.textContent = feedback ? t(feedback) : '';
  };
  render();
  const unsubscribe = i18n.subscribe(render);
  const copy = async () => {
    if (disposed || pending || !code.trim()) return;
    pending = true;
    if (timer !== undefined) clearTimeout(timer);
    feedback = undefined;
    render();
    try {
      await navigator.clipboard.writeText(code);
      if (!disposed) feedback = 'copiedCode';
    } catch {
      // Do not expose native clipboard errors or the code in diagnostics.
      if (!disposed) feedback = 'copyCodeFailed';
    } finally {
      pending = false;
      if (!disposed) {
        render();
        timer = setTimeout(() => { feedback = undefined; render(); }, 1800);
      }
    }
  };
  button.addEventListener('click', copy);
  return { button, status, dispose() {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    button.removeEventListener('click', copy);
    unsubscribe();
  } };
}
