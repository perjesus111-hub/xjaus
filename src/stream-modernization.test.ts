import {it,expect,vi} from 'vitest';
import {setVideoBitrate, prioritizeVideoCodecSdp, XboxWebRtcController} from './webrtc';
const sdp=['v=0','m=audio 9 RTP/SAVPF 111','b=AS:500','a=rtpmap:111 opus/48000/2','m=video 9 RTP/SAVPF 96 97 100 101 102 103','c=IN IP4 0.0.0.0','b=AS:1000','b=TIAS:1000000','a=rtpmap:96 VP8/90000','a=rtpmap:97 rtx/90000','a=fmtp:97 apt=96','a=rtpmap:100 H265/90000','a=rtpmap:101 rtx/90000','a=fmtp:101 apt=100','a=rtpmap:102 H264/90000','a=rtpmap:103 rtx/90000','a=fmtp:103 apt=102',''].join('\r\n');
it('sets bounded receive bandwidth once after connection and keeps audio intact',()=>{
 const result=setVideoBitrate(setVideoBitrate(sdp,30000),45000);
 expect(result).toContain('m=audio 9 RTP/SAVPF 111\r\nb=AS:500');
 expect(result).toContain('c=IN IP4 0.0.0.0\r\nb=AS:45000\r\nb=TIAS:45000000');
 expect(result).not.toContain('b=AS:1000');expect(result).not.toContain('b=AS:30000');
 expect(()=>setVideoBitrate(sdp,999999)).toThrow();
});
it('prioritizes only offered codecs together with associated RTX; auto is unchanged',()=>{
 expect(prioritizeVideoCodecSdp(sdp,'hevc')).toContain('m=video 9 RTP/SAVPF 100 101 96 97 102 103');
 expect(prioritizeVideoCodecSdp(sdp,'h264')).toContain('m=video 9 RTP/SAVPF 102 103 96 97 100 101');
 expect(prioritizeVideoCodecSdp(sdp,'auto')).toBe(sdp);
 const absent=sdp.replace('H265','AV1');expect(prioritizeVideoCodecSdp(absent,'hevc')).toBe(absent);
});

it('actual offer installs the receive bandwidth and existing HEVC/RTX order before signaling',async()=>{
 const peer={addTransceiver:vi.fn(()=>({})),createOffer:vi.fn(async()=>({type:'offer' as const,sdp})),setLocalDescription:vi.fn(async()=>{})};
 const offer=await XboxWebRtcController.prototype.createOffer.call({peer,options:{codec:'hevc',audio:'default',bitrateKbps:30000}} as unknown as XboxWebRtcController);
 expect(offer.sdp).toContain('m=video 9 RTP/SAVPF 100 101 96 97 102 103');expect(offer.sdp).toContain('b=TIAS:30000000');expect(peer.setLocalDescription).toHaveBeenCalledWith(offer);
});

it('H264 preference keeps High Profile before baseline together with its RTX',()=>{
 const source=['m=video 9 RTP/SAVPF 96 97 98 99','a=rtpmap:96 H264/90000','a=fmtp:96 profile-level-id=42e01f','a=rtpmap:97 rtx/90000','a=fmtp:97 apt=96','a=rtpmap:98 H264/90000','a=fmtp:98 profile-level-id=64002a','a=rtpmap:99 rtx/90000','a=fmtp:99 apt=98',''].join('\r\n');
 expect(prioritizeVideoCodecSdp(source,'h264')).toContain('m=video 9 RTP/SAVPF 98 99 96 97');
});
