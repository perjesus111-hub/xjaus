import {it,expect,vi,afterEach} from 'vitest';
import {GamePlayback} from './playback';
afterEach(()=>vi.unstubAllGlobals());
it('routes audio source through one gain destination, mutes element and tears down graph',()=>{
 class Stream {tracks:MediaStreamTrack[]=[];getTracks(){return this.tracks;}addTrack(t:MediaStreamTrack){this.tracks.push(t);}removeTrack(t:MediaStreamTrack){this.tracks=this.tracks.filter(x=>x!==t);}}
 vi.stubGlobal('MediaStream',Stream);const source={connect:vi.fn(),disconnect:vi.fn()},gain={gain:{value:0},connect:vi.fn(),disconnect:vi.fn()},close=vi.fn(async()=>{}),resume=vi.fn(async()=>{}),destination={};
 vi.stubGlobal('AudioContext',class {state='suspended';destination=destination;createMediaStreamSource=vi.fn(()=>source);createGain=()=>gain;resume=resume;close=close;});
 const video={srcObject:null,muted:false,defaultMuted:false,volume:1,removeAttribute:()=>{},play:vi.fn(async()=>{}),pause:vi.fn()};const gestures=new EventTarget();
 const p=new GamePlayback(video as unknown as HTMLVideoElement,gestures,1.5);p.addTrack({kind:'audio'} as MediaStreamTrack);p.addTrack({kind:'video'} as MediaStreamTrack);
 expect(source.connect).toHaveBeenCalledOnce();expect(source.connect).toHaveBeenCalledWith(gain);expect(gain.connect).toHaveBeenCalledWith(destination);expect(gain.gain.value).toBe(1.5);expect(video.muted).toBe(true);
 gestures.dispatchEvent(new Event('keydown'));expect(video.muted).toBe(true);expect(resume).toHaveBeenCalled();p.close();expect(source.disconnect).toHaveBeenCalledOnce();expect(gain.disconnect).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();expect(video.srcObject).toBeNull();
});
