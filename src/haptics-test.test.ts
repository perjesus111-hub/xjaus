import { describe, expect, it, vi } from 'vitest';
import { testVibration } from './haptics-test';

function pad(actuator: unknown): Gamepad {
  return { index: 0, connected: true, vibrationActuator: actuator } as unknown as Gamepad;
}

describe('haptics test', () => {
  it('plays a real dual-rumble effect on the local pad', async () => {
    const playEffect = vi.fn(async () => {});
    const result = await testVibration(() => [pad({ playEffect })]);
    expect(result).toBe('ok');
    expect(playEffect).toHaveBeenCalledWith('dual-rumble', expect.objectContaining({ duration: 400, strongMagnitude: 1 }));
  });

  it('falls back to pulse() on legacy actuators and reports unavailable without one', async () => {
    const pulse = vi.fn(async () => {});
    expect(await testVibration(() => [pad({ pulse })])).toBe('ok');
    expect(pulse).toHaveBeenCalledWith(1, 400);
    expect(await testVibration(() => [pad({})])).toBe('unavailable');
    expect(await testVibration(() => [null])).toBe('unavailable');
  });

  it('reports error when the actuator rejects', async () => {
    const playEffect = vi.fn(async () => { throw new Error('denied'); });
    expect(await testVibration(() => [pad({ playEffect })])).toBe('error');
  });
});
