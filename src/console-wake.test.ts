import {i18n} from './i18n';
i18n.setPreference('es');
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { launchHomeConsole } from './console-wake';
describe('Remote Play wake before WebRTC', () => {
  it('shows waking immediately and waits for backend before launching', async () => {
    const events: string[] = [];
    let ready!: () => void;
    const request = vi.fn(() => new Promise<void>(resolve => { ready = resolve; }));
    const card = document.createElement('article');
    const pending = launchHomeConsole(card, {id:'sg', powerState:'ConnectedStandby'}, request, async () => { events.push('webrtc'); }, () => {});
    expect(card.textContent).toContain('Encendiendo consola');
    expect(events).toEqual([]);
    expect(request).toHaveBeenCalledWith('wake_console', {deviceId:'sg'});
    ready(); await pending;
    expect(events).toEqual(['webrtc']);
    expect(card.getAttribute('aria-busy')).toBeNull();
  });
  it('does not create a peer or expose raw wake errors on failure', async () => {
    const launch = vi.fn(); const notice = vi.fn();
    await launchHomeConsole(document.createElement('article'), {id:'sg',powerState:'Standby'}, async () => {throw Error('WNSError secret');}, launch, notice);
    expect(launch).not.toHaveBeenCalled();
    expect(notice.mock.calls[0][0]).toContain('45 segundos');
    expect(notice.mock.calls[0][0]).not.toContain('secret');
  });
});
