/** Real local-gamepad haptic probe: plays one short dual-rumble on the pad
 *  connected to this machine. Independent from the stream rumble channel. */
export type RumbleActuator = {
  playEffect?: (type: GamepadHapticEffectType, parameters: GamepadEffectParameters) => Promise<unknown>;
  pulse?: (intensity: number, duration: number) => Promise<unknown>;
};

type PadWithHaptics = Gamepad & { hapticActuators?: RumbleActuator[] };

export async function testVibration(getPads: () => (Gamepad | null)[]): Promise<'ok' | 'unavailable' | 'error'> {
  const pad = getPads().find((candidate): candidate is PadWithHaptics => candidate?.connected === true);
  const actuator: RumbleActuator | undefined = pad?.vibrationActuator ?? pad?.hapticActuators?.[0];
  if (!actuator || (!actuator.playEffect && !actuator.pulse)) return 'unavailable';
  try {
    if (actuator.playEffect) {
      await actuator.playEffect('dual-rumble', { startDelay: 0, duration: 400, strongMagnitude: 1, weakMagnitude: 0.6 });
    } else {
      await actuator.pulse!(1, 400);
    }
    return 'ok';
  } catch {
    return 'error';
  }
}
