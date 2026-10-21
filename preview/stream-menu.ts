// Component style preview (dev-only, not part of the app build): mounts the real
// stream menu over an abstract backdrop so its premium look can be reviewed and
// captured without a live stream. Actions are no-ops with honest feedback.
import { mountStreamMenu } from '../src/stream-menu';

const parent = document.createElement('section');
parent.className = 'player-screen';
parent.style.cssText = 'position:fixed;inset:0;display:block;';
document.body.append(parent);

let toggles = 0;
const menu = mountStreamMenu(parent, {
  setModal: () => {},
  toggleTelemetry: () => { toggles++; },
  disconnect: async () => {},
  exit: async () => {},
  screenshot: () => { document.title = 'screenshot-preview'; },
  vibration: async () => { document.title = 'vibration-preview'; },
});
menu.toggle();
(window as unknown as { menuPreview: unknown }).menuPreview = menu;
