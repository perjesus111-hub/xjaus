import { describe, expect, it, vi } from "vitest";
import {
  createXboxDataChannels,
  assertWebRtcAvailable,
  initializeXboxChannels,
  mungeAudioSdp,
  prioritizeH264Sdp,
  IceCandidateBuffer,
  XboxSessionCoordinator,
  isExpectedSessionEnd,
} from "./webrtc";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_command:string) => undefined as unknown) }));
vi.mock("./backend", () => ({ invokeBackend: invoke }));

describe("ICE signaling order", () => {
  it("sends all gathered candidates in one Xbox ICE exchange after SDP answer", async () => {
    const sent: string[][] = [];
    const buffer = new IceCandidateBuffer(async (candidates) => { sent.push(candidates.map((item) => item.candidate ?? "")); });
    buffer.push({ candidate: "first" });
    buffer.push({ candidate: "second" });
    expect(sent).toEqual([]);
    await buffer.open();
    expect(sent).toEqual([["first", "second"]]);
    await buffer.push({ candidate: "third" });
    expect(sent).toEqual([["first", "second"], ["third"]]);
  });
});

describe("WebRTC availability", () => {
  it("reports an actionable error instead of ReferenceError when WebKit disables WebRTC", () => {
    expect(() => assertWebRtcAvailable(undefined)).toThrow(/WebKitGTK 2\.54.*deshabilita WebRTC/i);
  });
});

describe("mungeAudioSdp", () => {
  it("adds high-fidelity Opus parameters without removing existing fmtp parameters", () => {
    const source = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10;useinbandfec=0",
      "",
    ].join("\r\n");

    const output = mungeAudioSdp(source);
    expect(output).toContain("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;cbr=1");
  });

  it("does not modify SDP with no Opus payload", () => {
    const source = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n";
    expect(mungeAudioSdp(source)).toBe(source);
  });
});

describe("prioritizeH264Sdp", () => {
  it("moves H264 High Profile payloads to the front of the video m-line", () => {
    const source = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 102 127",
      "a=rtpmap:96 VP8/90000",
      "a=rtpmap:102 H264/90000",
      "a=fmtp:102 profile-level-id=4d002a;packetization-mode=1",
      "a=rtpmap:127 H264/90000",
      "a=fmtp:127 profile-level-id=42e01f;packetization-mode=1",
      "",
    ].join("\r\n");

    expect(prioritizeH264Sdp(source)).toContain("m=video 9 UDP/TLS/RTP/SAVPF 102 127 96");
  });
});

describe("Xbox protocol handshake", () => {
  it("starts input/control after message HandshakeAck", () => {
    const sent: Record<string, string[]> = { input: [], control: [], message: [], chat: [] };
    const listeners: Record<string, Record<string, (event?: any) => void>> = {};
    const channels = Object.fromEntries(["input", "control", "message", "chat"].map((name) => {
      listeners[name] = {};
      return [name, {
        readyState: "open",
        send: (value: string) => sent[name].push(value),
        addEventListener: (event: string, fn: (value?: any) => void) => { listeners[name][event] = fn; },
      }];
    })) as any;
    initializeXboxChannels(channels);
    listeners.message.open();
    expect(JSON.parse(sent.message[0]).type).toBe("Handshake");
    listeners.message.message({ data: JSON.stringify({ type: "HandshakeAck" }) });
    expect(JSON.parse(sent.control[0]).message).toBe("authorizationRequest");
    expect(sent.input[0]).toBeInstanceOf(ArrayBuffer);
  });
});

describe("createXboxDataChannels", () => {
  it("opens the four audited Xbox channels with their exact protocols", () => {
    const createDataChannel = vi.fn((label: string, options: RTCDataChannelInit) => ({ label, options }));
    const connection = { createDataChannel } as unknown as RTCPeerConnection;

    const channels = createXboxDataChannels(connection);

    expect(createDataChannel).toHaveBeenCalledTimes(4);
    expect(createDataChannel).toHaveBeenNthCalledWith(1, "input", { ordered: true, protocol: "1.0" });
    expect(createDataChannel).toHaveBeenNthCalledWith(2, "chat", { protocol: "chatV1" });
    expect(createDataChannel).toHaveBeenNthCalledWith(3, "control", { protocol: "controlV1" });
    expect(createDataChannel).toHaveBeenNthCalledWith(4, "message", { protocol: "messageV1" });
    expect(channels.input.label).toBe("input");
  });
});

describe("clean session teardown", () => {
  it("treats keepalive 410 SessionNotActive as an expected end, without surfacing an error", () => {
    expect(isExpectedSessionEnd("Xbox streaming keepalive HTTP 410: {\"code\":\"SessionNotActive\",\"message\":\"Session no longer active\"}")).toBe(true);
    expect(isExpectedSessionEnd("HTTP 410 Gone SessionNotActive")).toBe(true);
    expect(isExpectedSessionEnd("HTTP 503")).toBe(false);
  });

  it("stop() swallows late keepalive rejections and always closes the peer connection", async () => {
    const stopCalls: string[] = [];
    const peer = { close: () => { stopCalls.push("peer.close"); }, onicecandidate: null } as unknown as RTCDataChannel;
    const controller = { peer, gamepad: {}, createOffer: async () => ({ sdp: "offer" }), attachVideoElement() {}, close() { peer.close(); }, options: undefined } as any;
    const seen: unknown[] = [];
    const coordinator = new XboxSessionCoordinator(controller, (error: unknown) => seen.push(error));
    const late = Promise.reject(new Error("Xbox streaming keepalive HTTP 410: SessionNotActive"));
    await coordinator["absorbLateFailures"](late);
    expect(seen).toEqual([]);
    await coordinator.stop();
    expect(stopCalls).toEqual(["peer.close"]);
  });

  it("keeps at most one keepalive in flight: a slow ping blocks later ticks until it settles", async () => {
    // F5/Hallazgo5: tres ticks con el primer ping sin resolver deben dejar UNA
    // solicitud en cola, no tres. Sin el guard, cada tick apilaba otra.
    let ticks = 0;
    const pending: Array<() => void> = [];
    invoke.mockImplementation(async (command: string) => {
      if (command === "stream_keepalive") {
        ticks += 1;
        return new Promise<void>((resolve) => pending.push(resolve));
      }
      if (command === "provision_stream") return {};
      if (command === "poll_stream_answer") return { type: "answer", sdp: "v=0\r\n" };
      if (command === "exchange_stream_ice") return [];
      return [];
    });
    vi.stubGlobal("window", globalThis);
    const control = Object.assign(new EventTarget(), { readyState: "open" });
    const controller = {
      channels: { control }, sendControl: () => {},
      createOffer: async () => ({ sdp: "fixture-offer" }), close: () => {},
      peer: { setRemoteDescription: async () => {}, addIceCandidate: async () => {}, onicecandidate: null },
    } as any;
    const coordinator = new XboxSessionCoordinator(controller, () => {});
    await coordinator.negotiate("home", "fixture");
    const tick = (coordinator as any)["tickKeepalive"].bind(coordinator);
    tick();
    tick();
    tick();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(ticks).toBe(1);
    pending.forEach((resolve) => resolve());
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    // El guard no debe convertir el keepalive en un único ping por sesión:
    // resuelto el primero, el siguiente tick vuelve a enviar.
    tick();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(ticks).toBe(2);
    pending.forEach((resolve) => resolve());
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await coordinator.stop();
    vi.unstubAllGlobals();
  });
});
