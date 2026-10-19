/** Local stream shortcuts, independent of game wire encoding. */
export class StreamPadGestures {
  private guide = new Map<number, {since:number; fired:boolean}>();
  private chord = new Set<number>();
  private stats = new Set<number>();
  constructor(private menu: () => void, private telemetry: () => void) {}
  poll(pads: readonly Gamepad[], now = performance.now()): void {
    const present = new Set(pads.map(p => p.index));
    for (const index of this.guide.keys()) if (!present.has(index)) this.guide.delete(index);
    for (const set of [this.chord, this.stats]) for (const index of set) if (!present.has(index)) set.delete(index);
    const down = (p: Gamepad, i: number) => !!p.buttons[i]?.pressed || (p.buttons[i]?.value ?? 0) > .5;
    for (const p of pads) {
      const chord = down(p,8) && down(p,9), stats = down(p,10) && down(p,11);
      if (chord && !this.chord.has(p.index)) this.menu();
      if (stats && !this.stats.has(p.index)) this.telemetry();
      if (chord) this.chord.add(p.index); else this.chord.delete(p.index);
      if (stats) this.stats.add(p.index); else this.stats.delete(p.index);
      if (down(p,16) && !chord) {
        const state = this.guide.get(p.index) ?? {since:now,fired:false};
        if (!state.fired && now - state.since >= 1200) {state.fired=true;this.menu();}
        this.guide.set(p.index,state);
      } else this.guide.delete(p.index);
    }
  }
  reset(): void {this.guide.clear();this.chord.clear();this.stats.clear();}
}

/** Wire layout audited against xbox-xcloud-player Channel/Input/Packet.ts. */
export function serializeGamepads(pads: readonly Gamepad[], sequence: number, now = performance.now()): ArrayBuffer {
  const frames = pads.slice(0, 4);
  const buffer = new ArrayBuffer(15 + 23 * frames.length);
  const view = new DataView(buffer);
  view.setUint16(0, 2, true);
  view.setUint32(2, sequence, true);
  view.setFloat64(6, now, true);
  view.setUint8(14, frames.length);
  const buttonBits = [16,32,64,128,4096,8192,0,0,8,4,16384,32768,256,512,1024,2048,2];
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
  frames.forEach((pad, i) => {
    const offset = 15 + i * 23;
    view.setUint8(offset, pad.index);
    let mask = 0;
    buttonBits.forEach((bit, index) => { if ((pad.buttons[index]?.value ?? 0) > 0) mask |= bit; });
    if (pad.buttons[8]?.value && pad.buttons[9]?.value) mask |= 2;
    view.setUint16(offset + 1, mask, true);
    for (let axis=0; axis<4; axis++) view.setInt16(offset+3+axis*2, clamp((pad.axes[axis] ?? 0) * (axis % 2 ? -1 : 1), -1, 1)*32767, true);
    view.setUint16(offset+11, clamp(pad.buttons[6]?.value ?? 0, 0, 1)*65535, true);
    view.setUint16(offset+13, clamp(pad.buttons[7]?.value ?? 0, 0, 1)*65535, true);
    // PhysicalPhysicality and VirtualPhysicality remain zero, as in the reference.
  });
  return buffer;
}

export function parseRumble(buffer: ArrayBuffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 13) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 128 || view.getUint8(2) !== 0) return null;
  const magnitude = (offset: number) => Math.min(1, view.getUint8(offset)/100);
  return { index: view.getUint8(3), strongMagnitude: magnitude(4), weakMagnitude: magnitude(5),
    leftTrigger: magnitude(6), rightTrigger: magnitude(7), duration: view.getUint16(8,true),
    delay: view.getUint16(10,true), repeat: view.getUint8(12) };
}

/** One owned poller; no rAF loop survives session teardown. */
type Haptic = {
  type?: string; effects?: readonly string[]; effectTypes?: readonly string[]; supportedEffects?: readonly string[];
  playEffect?: (type: GamepadHapticEffectType, parameters: GamepadEffectParameters) => Promise<unknown>;
  reset?: () => Promise<unknown>;
  pulse?: (intensity: number, duration: number) => Promise<unknown>;
};
// Older implementations can throw synchronously or return no Promise.
function safelyHaptic(call: () => unknown, failed = () => {}): void {
  try { void Promise.resolve(call()).catch(failed); } catch { failed(); }
}
function resetHaptic(actuator: Haptic): void {
  safelyHaptic(() => actuator.reset ? actuator.reset() : actuator.pulse?.(0, 0));
}
export class XboxGamepadInput {
  private timer?: ReturnType<typeof setInterval>;
  private sequence = 0;
  readonly streamGestures = new StreamPadGestures(() => this.onMenuToggle?.(), () => this.onTelemetryToggle?.());
  onMenuToggle?: () => void;
  onTelemetryToggle?: () => void;
  onModalPoll?: (pads: readonly Gamepad[]) => void;
  private modal = false;
  private releaseLatch = false;
  setModal(value: boolean): void { this.modal=value; this.releaseLatch=true; }
  onGuidePress?: () => void;
  private guides = new Set<number>();
  private registered = new Set<number>([0]); // Control.start in the audited client always adds slot 0.
  private repeats = new Map<number, ReturnType<typeof setTimeout>>();
  private actuators = new Map<number, Haptic>();
  readonly stats = { packets: 0, aPressedPackets: 0, lastSequence: 0, connected: 0, rumblePackets: 0, hapticErrors: 0, hapticUnavailable: 0 };
  constructor(private input: RTCDataChannel, private control: RTCDataChannel,
    private getPads: () => (Gamepad | null)[] = () => [...navigator.getGamepads()]) {}
  start(): void {
    if (this.timer !== undefined) return;
    this.input.binaryType = 'arraybuffer';
    this.control.binaryType = 'arraybuffer';
    this.input.addEventListener('message', this.onRumble);
    this.control.addEventListener('message', this.onRumble);
    this.input.addEventListener('close', this.onClose);
    this.control.addEventListener('close', this.onClose);
    this.timer = setInterval(() => this.poll(), 1000/60);
    this.poll();
  }
  poll(): void {
    const pads = this.getPads().filter((pad): pad is Gamepad => !!pad?.connected && pad.mapping === 'standard' && pad.index < 4);
    this.streamGestures.poll(pads);
    if (this.modal) this.onModalPoll?.(pads);
    if (!this.modal && this.releaseLatch && pads.every(p => p.buttons.every(b => !b.pressed && b.value <= .1) && p.axes.every(a => Math.abs(a) < .2))) this.releaseLatch=false;
    const guides=new Set(pads.filter(pad=>pad.buttons[16]?.pressed || pad.buttons[16]?.value>0).map(pad=>pad.index));
    if([...guides].some(index=>!this.guides.has(index)))this.onGuidePress?.();
    this.guides=guides;
    if (this.input.readyState !== 'open' || this.control.readyState !== 'open' || this.input.bufferedAmount > 65536) return;
    const present = new Set(pads.map(p => p.index));
    for (const [index, actuator] of this.actuators) if (!present.has(index)) {
      const timer = this.repeats.get(index); if (timer !== undefined) clearTimeout(timer);
      this.repeats.delete(index);
      resetHaptic(actuator);
      this.actuators.delete(index);
    }
    for (const index of this.registered) if (index !== 0 && !present.has(index)) {
      this.control.send(JSON.stringify({ message:'gamepadChanged', gamepadIndex:index, wasAdded:false }));
      this.registered.delete(index);
      const timer = this.repeats.get(index); if (timer !== undefined) clearTimeout(timer);
      this.repeats.delete(index);
    }
    for (const pad of pads) if (!this.registered.has(pad.index)) {
      this.control.send(JSON.stringify({message:'gamepadChanged', gamepadIndex:pad.index, wasAdded:true}));
      this.registered.add(pad.index);
    }
    this.stats.connected = pads.length;
    // Keep slot zero neutral after disconnection to release held buttons.
    if (!present.has(0)) pads.unshift({ index:0, axes:[], buttons:[] } as unknown as Gamepad);
    const wirePads = this.modal || this.releaseLatch ? pads.map(p => ({index:p.index,axes:[],buttons:[]} as unknown as Gamepad)) : pads;
    this.input.send(serializeGamepads(wirePads, ++this.sequence));
    this.stats.packets++;
    this.stats.lastSequence = this.sequence >>> 0;
    if (pads.some(p=>p.buttons[0]?.value > 0)) this.stats.aPressedPackets++;
  }
  private onClose = () => this.stop();
  private onRumble = (event: MessageEvent) => {
    const rumble = parseRumble(event.data);
    if (!rumble) return;
    this.stats.rumblePackets++;
    const pad = this.getPads().find(p => p?.index === rumble.index && p.connected);
    const actuator: Haptic | undefined = pad?.vibrationActuator ??
      (pad as unknown as {hapticActuators?: Haptic[]})?.hapticActuators?.[0];
    if (!actuator || (!actuator.playEffect && !actuator.pulse)) { this.stats.hapticUnavailable++; return; }
    this.actuators.set(rumble.index, actuator);
    const old = this.repeats.get(rumble.index); if (old !== undefined) clearTimeout(old);
    this.repeats.delete(rumble.index);
    if (rumble.duration === 0 || !(rumble.strongMagnitude || rumble.weakMagnitude || rumble.leftTrigger || rumble.rightTrigger)) {
      resetHaptic(actuator);
      return;
    }
    let remaining = rumble.repeat;
    const play = () => {
      const trigger = (actuator.supportedEffects ?? actuator.effectTypes ?? actuator.effects)?.includes('trigger-rumble') || actuator.type === 'trigger-rumble';
      const effect = trigger ? 'trigger-rumble' : 'dual-rumble';
      const added = trigger ? 0 : Math.min(rumble.weakMagnitude < .6 ? (.6-rumble.weakMagnitude)/2 : 0, (rumble.leftTrigger+rumble.rightTrigger)/4);
      const parameters = { startDelay:0, duration:rumble.duration,
        strongMagnitude:rumble.strongMagnitude, weakMagnitude:Math.min(1,rumble.weakMagnitude+added),
        leftTrigger: trigger ? rumble.leftTrigger : 0, rightTrigger:trigger ? rumble.rightTrigger : 0 } as GamepadEffectParameters;
      safelyHaptic(() => actuator.playEffect ? actuator.playEffect(effect, parameters) :
        actuator.pulse?.(Math.max(parameters.strongMagnitude ?? 0, parameters.weakMagnitude ?? 0), rumble.duration),
        () => {
          this.stats.hapticErrors++;
          // An advertised effect can still reject on a particular device/browser.
          if (trigger && this.actuators.get(rumble.index) === actuator) safelyHaptic(
            () => actuator.playEffect?.('dual-rumble', {...parameters,leftTrigger:0,rightTrigger:0}),
            () => { this.stats.hapticErrors++; });
        });
      if (remaining-- > 0) this.repeats.set(rumble.index, setTimeout(play, rumble.duration+rumble.delay));
      else this.repeats.delete(rumble.index);
    };
    play();
  };
  stop(): void {
    this.guides.clear();
    this.streamGestures.reset();
    this.modal=false; this.releaseLatch=false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const timer of this.repeats.values()) clearTimeout(timer);
    this.repeats.clear();
    for (const actuator of this.actuators.values()) resetHaptic(actuator);
    this.actuators.clear();
    this.input.removeEventListener('message', this.onRumble);
    this.control.removeEventListener('message', this.onRumble);
    this.input.removeEventListener('close', this.onClose);
    this.control.removeEventListener('close', this.onClose);
  }
}
