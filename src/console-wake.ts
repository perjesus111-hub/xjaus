import { t, bindText } from './i18n';
import './console-wake.css';
import type { ConsoleItem } from './ui-state';
const pending = new WeakSet<HTMLElement>();
/** Keep the console card visible; no WebRTC controller exists until wake completes. */
export async function launchHomeConsole(
  card: HTMLElement, item: ConsoleItem,
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
  launch: () => Promise<void>, notice: (message: string) => void,
): Promise<void> {
  if (pending.has(card)) return;
  pending.add(card);
  const buttons = Array.from(card.querySelectorAll('button'));
  const prior = buttons.map(button => button.disabled);
  const status = document.createElement('p');
  try {
    if (item.id) {
      buttons.forEach(button => { button.disabled = true; });
      card.setAttribute('aria-busy', 'true');
      status.className = 'console-wake-status'; status.setAttribute('role', 'status');
      const spinner = document.createElement('span'); spinner.className = 'console-wake-spinner'; spinner.setAttribute('aria-hidden', 'true');
      const text=document.createElement('span');bindText(text,()=>t('waking'));status.append(spinner,text); card.append(status);
      await invoke('wake_console', {deviceId: item.id});
    }
    await launch();
  } catch { notice(t('wakeHelp')); }
  finally {
    status.remove(); card.removeAttribute('aria-busy');
    buttons.forEach((button, index) => { button.disabled = prior[index]; });
    pending.delete(card);
  }
}
