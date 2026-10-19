import { bindVideoReadyOverlay } from "./ui-state";
import { expect, it, vi } from "vitest";
import { normalizeRemoteIceCandidate, requestVideoKeyframe, KEYFRAME_REQUEST, XboxWebRtcController } from "./webrtc";

it("hides the waiting overlay on metadata as well as playing", () => {
  for (const event of ["loadedmetadata", "playing"]) {
    const video = new EventTarget();
    const overlay = {hidden:false};
    bindVideoReadyOverlay(video, overlay);
    video.dispatchEvent(new Event(event));
    expect(overlay.hidden).toBe(true);
  }
});

it("offers receive-only audio and video for game playback without microphone", async () => {
  const peer: any = {
    addTransceiver: vi.fn(() => ({})),
    createOffer: vi.fn(async () => ({type:"offer", sdp:"v=0\r\n"})),
    setLocalDescription: vi.fn(async () => undefined),
  };
  await XboxWebRtcController.prototype.createOffer.call({peer, options:{codec:"auto", audio:"default"}} as any);
  expect(peer.addTransceiver.mock.calls).toEqual([["audio", {direction:"recvonly"}], ["video", {direction:"recvonly"}]]);
});

it("normalizes Xbox end-of-candidates instead of passing invalid ICE to Chromium", () => {
  expect(normalizeRemoteIceCandidate({candidate:"a=end-of-candidates", sdpMid:"0", sdpMLineIndex:"0"})).toEqual({candidate:"", sdpMid:"0", sdpMLineIndex:0});
  expect(normalizeRemoteIceCandidate({candidate:"candidate:example", sdpMid:"video", sdpMLineIndex:1})).toEqual({candidate:"candidate:example", sdpMid:"video", sdpMLineIndex:1});
});
it("sends a JSON text keyframe immediately when control is open", async () => {
  const sendControl = vi.fn();
  await requestVideoKeyframe({channels: {control: {readyState: "open"}} as any, sendControl});
  expect(sendControl).toHaveBeenCalledWith(JSON.stringify(KEYFRAME_REQUEST));
});
it("does not block negotiation while control is connecting, sends once on open", async () => {
  const control = new EventTarget() as EventTarget & {readyState: string};
  control.readyState = "connecting";
  const sendControl = vi.fn();
  const result = await Promise.race([requestVideoKeyframe({channels: {control} as any, sendControl}).then(()=>"done"), new Promise(r=>setTimeout(()=>r("blocked"),20))]);
  expect(result).toBe("done");
  expect(sendControl).not.toHaveBeenCalled();
  control.readyState = "open";
  control.dispatchEvent(new Event("open"));
  expect(sendControl).toHaveBeenCalledExactlyOnceWith(JSON.stringify(KEYFRAME_REQUEST));
});
it("reports only allowlisted RTC states and video counters", async () => {
  const peer: any = {iceConnectionState:"checking", connectionState:"connecting", signalingState:"stable", getStats: async()=>new Map([["v", {type:"inbound-rtp", kind:"video", framesDecoded:0, bytesReceived:0, candidate:"SECRET", address:"SECRET"}]])};
  const result = await (XboxWebRtcController.prototype as any).diagnostics.call({peer, channels:{control:{readyState:"connecting"}}});
  expect(result).toEqual({ice:"checking", connection:"connecting", signaling:"stable", control:"connecting", video:[{framesDecoded:0, bytesReceived:0, packetsReceived:0, framesReceived:0, keyFramesDecoded:0}]});
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("catches video play rejection instead of an unhandled rejection", async () => {
  const peer: any = {};
  vi.stubGlobal("MediaStream", class { tracks: any[] = []; getTracks(){return this.tracks;} addTrack(t: any){this.tracks.push(t);} removeTrack(t: any){this.tracks=this.tracks.filter(x=>x!==t);} });
  const video: any = {removeAttribute:vi.fn(), play: vi.fn().mockRejectedValue(new Error("blocked"))};
  XboxWebRtcController.prototype.attachVideoElement.call({peer} as any, video);
  peer.ontrack({streams: [{}], track: {kind:"video"}});
  await new Promise(r=>setTimeout(r,0));
  expect(video.play).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
