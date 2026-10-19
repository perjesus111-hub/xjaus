import { LocalizedError } from './i18n';
import { provisionWithFreshAuth } from "./stream-auth";
import { invokeBackend as invoke } from "./backend";
import { XboxGamepadInput } from "./gamepad";
import { GamePlayback } from "./playback";

export type XboxChannelSet = {
  input: RTCDataChannel;
  chat: RTCDataChannel;
  control: RTCDataChannel;
  message: RTCDataChannel;
};

const OPUS_PARAMS = [
  ["stereo", "1"],
  ["sprop-stereo", "1"],
  ["maxaveragebitrate", "510000"],
  ["cbr", "1"],
  ["useinbandfec", "1"],
] as const;

function splitLines(sdp: string): { lines: string[]; newline: string; hasTrailingNewline: boolean } {
  const newline = sdp.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = sdp.endsWith(newline);
  return { lines: sdp.split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1), newline, hasTrailingNewline };
}

function joinLines(lines: string[], newline: string, trailing: boolean): string {
  const output = lines.join(newline);
  return trailing ? `${output}${newline}` : output;
}

/** Keeps existing Opus fmtp values and overwrites only fidelity-related values. */
export function mungeAudioSdp(sdp: string): string {
  const { lines, newline, hasTrailingNewline } = splitLines(sdp);
  const opusPayloads = new Set(
    lines
      .map((line) => /^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?$/i.exec(line)?.[1])
      .filter((payload): payload is string => Boolean(payload)),
  );
  if (opusPayloads.size === 0) return sdp;

  const handled = new Set<string>();
  const output = lines.map((line) => {
    const match = /^a=fmtp:(\d+)\s+(.+)$/i.exec(line);
    if (!match || !opusPayloads.has(match[1])) return line;
    handled.add(match[1]);
    const parameters = new Map(
      match[2].split(";").map((part) => {
        const [key, value = ""] = part.trim().split("=", 2);
        return [key.toLowerCase(), value];
      }),
    );
    for (const [key, value] of OPUS_PARAMS) parameters.set(key, value);
    return `a=fmtp:${match[1]} ${[...parameters.entries()].map(([key, value]) => `${key}=${value}`).join(";")}`;
  });

  for (const payload of opusPayloads) {
    if (!handled.has(payload)) output.push(`a=fmtp:${payload} ${OPUS_PARAMS.map(([key, value]) => `${key}=${value}`).join(";")}`);
  }
  return joinLines(output, newline, hasTrailingNewline);
}

/** Prioritizes H.264 High Profile identifiers without removing supported fallbacks. */
export function prioritizeH264Sdp(sdp: string): string {
  const { lines, newline, hasTrailingNewline } = splitLines(sdp);
  const h264 = new Set(lines.map((line) => /^a=rtpmap:(\d+)\s+H264\/90000$/i.exec(line)?.[1]).filter((p): p is string => Boolean(p)));
  if (h264.size === 0) return sdp;
  const highProfile = new Set(
    lines
      .map((line) => /^a=fmtp:(\d+)\s+(.+)$/i.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match && h264.has(match[1])))
      .filter((match) => /profile-level-id=(?:4d002a|64002a)/i.test(match[2]))
      .map((match) => match[1]),
  );

  const output = lines.map((line) => {
    if (!line.startsWith("m=video ")) return line;
    const parts = line.split(" ");
    const header = parts.slice(0, 3);
    const payloads = parts.slice(3);
    const preferred = payloads.filter((payload) => highProfile.has(payload));
    const otherH264 = payloads.filter((payload) => h264.has(payload) && !highProfile.has(payload));
    const remaining = payloads.filter((payload) => !h264.has(payload));
    return [...header, ...preferred, ...otherH264, ...remaining].join(" ");
  });
  return joinLines(output, newline, hasTrailingNewline);
}

/** Reorders only negotiated payloads, keeping each RTX adjacent to its apt. */
export function prioritizeVideoCodecSdp(sdp: string, codec: string): string {
  if (!['h264','hevc'].includes(codec)) return sdp;
  const {lines, newline, hasTrailingNewline} = splitLines(sdp);
  const output: string[] = [];
  for (let start = 0; start < lines.length;) {
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('m=')) end++;
    const section = lines.slice(start, end);
    if (section[0].startsWith('m=video ')) {
      const parts = section[0].split(' '), offered = parts.slice(3);
      const names = new Map<string,string>(), apt = new Map<string,string>();
      for (const line of section) {
        const rtp = /^a=rtpmap:(\d+)\s+(\w+)\//i.exec(line);
        if (rtp) names.set(rtp[1], rtp[2].toLowerCase());
        const fmt = /^a=fmtp:(\d+)\s+.*?\bapt=(\d+)/i.exec(line);
        if (fmt) apt.set(fmt[1], fmt[2]);
      }
      const preferred = offered.filter(pt => codec === 'hevc' ? ['h265','hevc'].includes(names.get(pt) ?? '') : names.get(pt) === 'h264');
      if (codec === 'h264') {
        const high = new Set(section.flatMap(line => {
          const match = /^a=fmtp:(\d+)\s+.*profile-level-id=(?:4d|64)[0-9a-f]{4}/i.exec(line);
          return match ? [match[1]] : [];
        }));
        preferred.sort((a,b) => Number(high.has(b))-Number(high.has(a)));
      }
      if (preferred.length) {
        const order: string[] = [];
        const add = (pt: string) => { if (!order.includes(pt)) order.push(pt); };
        for (const pt of [...preferred, ...offered.filter(pt => !apt.has(pt))]) {
          add(pt);
          for (const rtx of offered) if (apt.get(rtx) === pt) add(rtx);
        }
        offered.forEach(add);
        section[0] = [...parts.slice(0,3), ...order].join(' ');
      }
    }
    output.push(...section); start = end;
  }
  return joinLines(output, newline, hasTrailingNewline);
}

/** Receive bandwidth advertised in the local SDP, never receiver.setParameters. */
export function setVideoBitrate(sdp: string, kbps: number): string {
  if (!Number.isInteger(kbps) || kbps < 15000 || kbps > 45000) throw new RangeError('Invalid video bitrate');
  const {lines, newline, hasTrailingNewline} = splitLines(sdp);
  const output: string[] = [];
  let video = false, inserted = false;
  const insert = () => { output.push(`b=AS:${kbps}`, `b=TIAS:${kbps * 1000}`); inserted = true; };
  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (video && !inserted) insert();
      video = line.startsWith('m=video '); inserted = false;
    }
    if (video && /^b=(AS|TIAS):/.test(line)) continue;
    if (video && !inserted && !/^(m=|i=|c=)/.test(line)) insert();
    output.push(line);
  }
  if (video && !inserted) insert();
  return joinLines(output, newline, hasTrailingNewline);
}

export function createXboxDataChannels(peer: RTCPeerConnection): XboxChannelSet {
  const input = peer.createDataChannel("input", { ordered: true, protocol: "1.0" });
  input.binaryType = "arraybuffer";
  return {
    input,
    chat: peer.createDataChannel("chat", { protocol: "chatV1" }),
    control: peer.createDataChannel("control", { protocol: "controlV1" }),
    message: peer.createDataChannel("message", { protocol: "messageV1" }),
  };
}

export function prioritizeH264CodecPreferences(transceiver: RTCRtpTransceiver): boolean {
  if (typeof RTCRtpSender === "undefined" || typeof RTCRtpSender.getCapabilities !== "function" || typeof transceiver.setCodecPreferences !== "function") return false;
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs;
  if (!codecs) return false;
  const rank = (codec: { mimeType: string; sdpFmtpLine?: string }) => {
    if (codec.mimeType.toLowerCase() !== "video/h264") return 3;
    const profile = codec.sdpFmtpLine?.match(/profile-level-id=([0-9a-f]+)/i)?.[1]?.toLowerCase();
    return profile === "4d002a" || profile === "64002a" ? 0 : 1;
  };
  transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  return true;
}

export function initializeXboxChannels(channels: XboxChannelSet, onReady: () => void = () => {}, onRemoteEnd: () => void = () => {}): () => void {
  let acknowledged = false;
  let started = false;
  let closed = false;
  const send = (channel: RTCDataChannel, data: object | ArrayBuffer) => {
    if (channel.readyState !== "open") return;
    if (data instanceof ArrayBuffer) channel.send(data);
    else channel.send(JSON.stringify(data));
  };
  const message = (target: string, data: object) => ({
    type: "Message", content: JSON.stringify(data), id: crypto.randomUUID(), target, cv: "",
  });
  const handshake = () => send(channels.message, {
    type: "Handshake", version: "messageV1", id: crypto.randomUUID(), cv: "",
  });
  const start = () => {
    if (closed || started || !acknowledged || [channels.input, channels.control, channels.message].some(channel => channel.readyState !== "open")) return;
    started = true;
    send(channels.control, { message: "authorizationRequest", accessKey: "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E" });
    send(channels.control, { message: "gamepadChanged", gamepadIndex: 0, wasAdded: true });
    const metadata = new ArrayBuffer(15);
    const packet = new DataView(metadata);
    packet.setUint16(0, 8, true); // ClientMetadata
    packet.setFloat64(6, performance.now(), true);
    packet.setUint8(14, 2); // two touchpoints
    send(channels.input, metadata);
    send(channels.message, message("/streaming/systemUi/configuration", { version: [0, 1, 0], systemUis: [10, 19, 31, 27, 32, -41] }));
    send(channels.message, message("/streaming/properties/clientappinstallidchanged", { clientAppInstallId: crypto.randomUUID() }));
    send(channels.message, message("/streaming/characteristics/orientationchanged", { orientation: 0 }));
    send(channels.message, message("/streaming/characteristics/touchinputenabledchanged", { touchInputEnabled: false }));
    send(channels.message, message("/streaming/characteristics/clientdevicecapabilities", {}));
    onReady();
  };
  const receive = (event: MessageEvent) => {
    if(closed)return;
    let value: { type?: string; target?: string; id?: string };
    try { value = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)); }
    catch { return; }
    if (!value || typeof value !== 'object' || Array.isArray(value))return;
    if (value.type === "HandshakeAck") { acknowledged = true; start(); }
    // Audited xbox-xcloud-player a6511a645736f4988f77323284c6f0f36bf93aef:
    // src/channel/message.ts and src/channel/message/handler.ts. No guessed
    // TitleExited/SessionTerminated/StopStream aliases or channel-close signal.
    if ((value.type==='TransactionStart'||value.type==='Message') &&
        value.target==='/streaming/sessionLifetimeManagement/serverInitiatedDisconnect' &&
        typeof value.id==='string' && value.id.length>0) {
      closed=true;
      try { send(channels.message,{type:'TransactionComplete',content:JSON.stringify(''),id:value.id,cv:''}); }
      finally { onRemoteEnd(); }
    }
  };
  channels.message.addEventListener("open", handshake);
  channels.message.addEventListener("message", receive);
  for (const channel of [channels.input, channels.control]) channel.addEventListener("open", start);
  return () => {
    closed = true;
    channels.message.removeEventListener("open", handshake);
    channels.message.removeEventListener("message", receive);
    for (const channel of [channels.input, channels.control]) channel.removeEventListener("open", start);
  };
}

export const KEYFRAME_REQUEST = { message: "videoKeyframeRequested", ifrRequested: true } as const;

/** Sends the audited xCloud keyframe request once the control channel is open. */
export function requestVideoKeyframe(
  controller: Pick<XboxWebRtcController, "channels" | "sendControl">,
  signal?: AbortSignal,
): Promise<void> {
  const control = controller.channels.control;
  const send = () => {
    if (signal?.aborted || control.readyState !== "open") return;
    controller.sendControl(JSON.stringify(KEYFRAME_REQUEST));
  };
  if (control.readyState === "open") {
    send();
    return Promise.resolve();
  }
  if (control.readyState === "connecting" && !signal?.aborted) control.addEventListener("open", send, { once: true, signal });
  return Promise.resolve();
}

export function assertWebRtcAvailable(implementation: unknown = globalThis.RTCPeerConnection): void {
  if (typeof implementation !== "function") {
    throw new LocalizedError('webRtcUnsupported');
  }
}

export class XboxWebRtcController {
  private closed = false;
  onRemoteEnd?: () => void;
  readonly peer: RTCPeerConnection;
  readonly channels: XboxChannelSet;
  private playback?: GamePlayback;
  readonly gamepad: XboxGamepadInput;
  private readonly cleanupChannels: () => void;
  private readonly diagnosticListeners: (() => void)[] = [];

  async diagnostics() {
    const video: Record<string, number>[] = [];
    (await this.peer.getStats()).forEach((stat) => {
      if (stat.type === "inbound-rtp" && stat.kind === "video") video.push({
        framesDecoded: stat.framesDecoded ?? 0, bytesReceived: stat.bytesReceived ?? 0,
        packetsReceived: stat.packetsReceived ?? 0, framesReceived: stat.framesReceived ?? 0,
        keyFramesDecoded: stat.keyFramesDecoded ?? 0,
      });
    });
    return { ice: this.peer.iceConnectionState, connection: this.peer.connectionState,
      signaling: this.peer.signalingState, control: this.channels.control.readyState, video };
  }

  constructor(configuration: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] }, readonly options: { bitrateKbps?: number; codec?: string; audio?: string; audioGain?: number } = {}) {
    assertWebRtcAvailable();
    this.peer = new RTCPeerConnection(configuration);
    this.channels = createXboxDataChannels(this.peer);
    this.gamepad = new XboxGamepadInput(this.channels.input, this.channels.control);
    this.cleanupChannels = initializeXboxChannels(this.channels, () => this.gamepad.start(), () => { if(!this.closed)this.onRemoteEnd?.(); });
    const log = () => { console.info("[XJAUS RTC]", JSON.stringify({ice:this.peer.iceConnectionState,connection:this.peer.connectionState,control:this.channels.control.readyState})); };
    for (const event of ["iceconnectionstatechange", "connectionstatechange"]) {
      this.peer.addEventListener(event, log);
      this.diagnosticListeners.push(() => this.peer.removeEventListener(event, log));
    }
    for (const event of ["open", "close", "error"]) {
      this.channels.control.addEventListener(event, log);
      this.diagnosticListeners.push(() => this.channels.control.removeEventListener(event, log));
    }

  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.closed) throw new DOMException('Connection cancelled', 'AbortError');
    this.peer.addTransceiver("audio", { direction: "recvonly" });
    const video = this.peer.addTransceiver("video", { direction: "recvonly" });
    void video; // SDP ordering uses only capabilities actually present in the offer.
    const offer = await this.peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    if (this.closed) throw new DOMException('Connection cancelled', 'AbortError');
    let sdp = this.options.audio === "default" ? (offer.sdp ?? "") : mungeAudioSdp(offer.sdp ?? "");
    sdp = prioritizeVideoCodecSdp(sdp, this.options.codec ?? "auto");
    if (this.options.bitrateKbps && this.options.bitrateKbps > 0) sdp = setVideoBitrate(sdp, this.options.bitrateKbps);
    const normalized: RTCSessionDescriptionInit = { type: offer.type, sdp };
    await this.peer.setLocalDescription(normalized);
    return normalized;
  }

  /** WebKit/WebRTC capture constraints for future mic/chat capture; game output remains receive-only. */
  static pureAudioConstraints(): MediaTrackConstraints {
    return { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints;
  }

  sendControl(message: string | Uint8Array): void {
    if (this.channels.control.readyState !== "open") throw new LocalizedError('controlChannelClosed');
    if (typeof message === "string") this.channels.control.send(message);
    else this.channels.control.send(message.slice().buffer as ArrayBuffer);
  }

  attachVideoElement(video: HTMLVideoElement): void {
    this.playback?.close();
    this.playback = new GamePlayback(video, typeof window === "undefined" ? new EventTarget() : window, this.options?.audioGain ?? 1);
    this.peer.ontrack = ({ track }) => this.playback?.addTrack(track);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.diagnosticListeners.splice(0).forEach(remove => remove());
    this.cleanupChannels();
    this.gamepad.stop();
    this.playback?.close();
    this.peer.ontrack = null;
    Object.values(this.channels).forEach((channel) => channel.close());
    this.peer.close();
  }
}

export function normalizeRemoteIceCandidate(item: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | string | null }): RTCIceCandidateInit {
  return { candidate: item.candidate === "a=end-of-candidates" ? "" : item.candidate,
    sdpMid: item.sdpMid ?? null, sdpMLineIndex: item.sdpMLineIndex == null ? null : Number(item.sdpMLineIndex) };
}

export class IceCandidateBuffer {
  private readonly waiting: RTCIceCandidateInit[] = [];
  private ready = false;
  private closed = false;
  private inFlight: Promise<void> = Promise.resolve();
  constructor(private readonly send: (candidates: RTCIceCandidateInit[]) => Promise<void>) {}
  push(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.ready) { this.waiting.push(candidate); return Promise.resolve(); }
    this.inFlight = this.inFlight.catch(() => undefined).then(() => this.send([candidate]));
    return this.inFlight;
  }
  async open(): Promise<void> {
    const gathered = this.waiting.splice(0);
    if (gathered.length) this.inFlight = this.inFlight.catch(() => undefined).then(() => this.send(gathered));
    this.ready = true;
    await this.inFlight;
  }
  close(): void { this.closed = true; this.waiting.length = 0; }
}

export type ProvisionProgress = { state: string; queue?: Record<string, number> };

/**
 * The Xbox backend answers keepalive/teardown requests for an already-ended
 * session with HTTP 410 {"code":"SessionNotActive"}. That is the expected
 * server-side confirmation of a clean exit, never a user-facing error.
 */
export function isExpectedSessionEnd(error: unknown): boolean {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
  return /\b410\b/.test(text) || /\bSessionNotActive\b/.test(text);
}

import { settleRemoteStop } from './stream-stop';

export class XboxSessionCoordinator {
  private readonly abort = new AbortController();
  private stopped = false;
  private stopPromise?: Promise<void>;
  private checkActive(): void { if (this.stopped) throw new DOMException('Connection cancelled', 'AbortError'); }
  private keepaliveTimer?: number;
  private iceBuffer?: IceCandidateBuffer;
  private inFlightKeepalive?: Promise<void>;
  constructor(
    readonly controller: XboxWebRtcController,
    private readonly onIceError: (error: unknown) => void = () => {},
    private readonly onProgress?: (progress: ProvisionProgress) => void,
    private readonly attemptId?: string,
  ) {}

  /** Absorbs a keepalive failure that may resolve after stop() already ran. */
  private absorbLateFailures(promise: Promise<void>): Promise<void> {
    this.inFlightKeepalive = promise.then(
      () => { this.inFlightKeepalive = undefined; },
      (error) => {
        this.inFlightKeepalive = undefined;
        if (this.keepaliveTimer !== undefined && !isExpectedSessionEnd(error)) this.onIceError(error);
      },
    );
    return this.inFlightKeepalive;
  }

  /** F5: at most one keepalive in flight — no new ping while one (or its
   * timeout) is pending. Resolved pings always clear the slot so the next
   * tick sends again (never a single ping per session). */
  private tickKeepalive(send?: () => Promise<void>): void {
    if (this.inFlightKeepalive) return;
    const ping = send ?? (() => {
      const request = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        this.checkActive();
        const result = this.attemptId
          ? await invoke<T>(command, { ...args, attemptId: this.attemptId })
          : args ? await invoke<T>(command, args) : await invoke<T>(command);
        this.checkActive();
        return result;
      };
      return request<void>("stream_keepalive");
    });
    void this.absorbLateFailures(ping());
  }

  async negotiate(kind: "home" | "cloud", target: string, profile?: Record<string, unknown>): Promise<void> {
    const request = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      this.checkActive();
      const result = this.attemptId
        ? await invoke<T>(command, { ...args, attemptId: this.attemptId })
        : args ? await invoke<T>(command, args) : await invoke<T>(command);
      this.checkActive();
      return result;
    };
    const reportError = (error: unknown) => { if (!this.stopped && !isExpectedSessionEnd(error)) this.onIceError(error); };
    const provisioned = await provisionWithFreshAuth(request, { kind, target, profile: profile ?? null });
    if (this.onProgress) {
      this.onProgress({ state: String(provisioned?.state ?? ""), queue: provisioned?.provisioning ?? undefined });
    }

    this.iceBuffer = new IceCandidateBuffer(async (candidates) => {
      const remote = await request<Array<{ candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | string | null }>>("exchange_stream_ice", {
        candidates: candidates.map((candidate) => ({ candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex })),
      });
      console.info("[XJAUS RTC] ICE exchange", JSON.stringify({ localCount: candidates.length, remoteCount: remote.length }));
      for (const item of remote) { this.checkActive(); await this.controller.peer.addIceCandidate(normalizeRemoteIceCandidate(item)); }
    });
    this.controller.peer.onicecandidate = ({ candidate }) => {
      if (candidate && !this.stopped) void this.iceBuffer?.push(candidate.toJSON()).catch(reportError);
    };

    const offer = await this.controller.createOffer();
    this.checkActive();
    await request("submit_stream_offer", { sdp: offer.sdp ?? "" });
    const answer = await request<{ type?: RTCSdpType; sdp: string }>("poll_stream_answer");
    await this.controller.peer.setRemoteDescription({ type: answer.type ?? "answer", sdp: answer.sdp });
    this.checkActive();
    if (kind === "cloud") await requestVideoKeyframe(this.controller, this.abort.signal).catch(() => undefined);
    this.checkActive();
    const exchange = this.iceBuffer.open();
    // setRemoteDescription already installs embedded candidates. A pending ICE GET
    // must not delay the control channel or keepalive in that case.
    if (/^a=candidate:/m.test(answer.sdp)) void exchange.catch(reportError);
    else await exchange;
    this.checkActive();
    this.keepaliveTimer = window.setInterval(() => { this.tickKeepalive(() => request<void>("stream_keepalive")); }, 20_000);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.abort.abort();
    if (this.keepaliveTimer !== undefined) window.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    this.iceBuffer?.close();
    this.controller.peer.onicecandidate = null;
    try {
      this.controller.close();
    } catch { /* Backend cancellation must still run if local peer teardown fails. */ }
    // A keepalive ping can already be over the wire; its 410 SessionNotActive
    // answer is the server confirming our exit, so absorb it silently.
    this.stopPromise = settleRemoteStop(this.attemptId
      ? invoke('cancel_connection', { attemptId: this.attemptId })
      : invoke('stop_stream'));
    return this.stopPromise;
  }
}
