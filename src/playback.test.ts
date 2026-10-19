import { afterEach, expect, it, vi } from 'vitest';
import { GamePlayback } from './playback';
afterEach(()=>vi.unstubAllGlobals());
class Stream {
  tracks: MediaStreamTrack[]=[];
  getTracks(){return this.tracks;}
  addTrack(t: MediaStreamTrack){this.tracks.push(t);}
  removeTrack(t: MediaStreamTrack){this.tracks=this.tracks.filter(x=>x!==t);}
}
it('uses one unmuted volume-one output for separate audio/video track events', async()=>{
  vi.stubGlobal('MediaStream',Stream);
  const video = Object.assign(new EventTarget(),{muted:true,defaultMuted:true,volume:0,srcObject:null,removeAttribute:vi.fn(),play:vi.fn(async()=>{}),pause:vi.fn()});
  const gestures = new EventTarget();
  const playback = new GamePlayback(video as unknown as HTMLVideoElement,gestures);
  const audio={kind:'audio',enabled:false} as MediaStreamTrack;
  const picture={kind:'video',enabled:true} as MediaStreamTrack;
  playback.addTrack(audio); playback.addTrack(picture); playback.addTrack(audio);
  expect((video.srcObject as unknown as Stream).getTracks()).toEqual([audio,picture]);
  expect(video.muted).toBe(false); expect(video.defaultMuted).toBe(false); expect(video.volume).toBe(1);
  expect(audio.enabled).toBe(true); expect(video.removeAttribute).toHaveBeenCalledWith('muted');
  video.play.mockClear(); gestures.dispatchEvent(new Event('pointerdown')); expect(video.play).toHaveBeenCalledOnce();
  playback.close(); expect(video.srcObject).toBeNull();
  video.play.mockClear(); gestures.dispatchEvent(new Event('pointerdown')); expect(video.play).not.toHaveBeenCalled();
});
it('stops tracks, resets the media element and never detaches a newer playback',()=>{
 vi.stubGlobal('MediaStream',Stream);
 const video={srcObject:null,removeAttribute:()=>{},play:vi.fn(async()=>{}),pause:vi.fn(),load:vi.fn()};
 const gestures=new EventTarget(),old=new GamePlayback(video as unknown as HTMLVideoElement,gestures);
 const track={kind:'video',stop:vi.fn()} as unknown as MediaStreamTrack;old.addTrack(track);
 const next=new GamePlayback(video as unknown as HTMLVideoElement,gestures);const nextStream=video.srcObject;
 old.close();expect(track.stop).toHaveBeenCalledOnce();expect(video.srcObject).toBe(nextStream);expect(video.pause).not.toHaveBeenCalled();
 const audio={kind:'audio',stop:vi.fn()} as unknown as MediaStreamTrack;next.addTrack(audio);next.close();next.close();
 expect(audio.stop).toHaveBeenCalledOnce();expect(video.srcObject).toBeNull();expect(video.load).toHaveBeenCalledOnce();expect(video.pause).toHaveBeenCalledOnce();
 const late={kind:'video',stop:vi.fn()} as unknown as MediaStreamTrack;next.addTrack(late);expect(late.stop).toHaveBeenCalledOnce();
});
it('contains autoplay rejection and retries on keyboard gesture',async()=>{
  vi.stubGlobal('MediaStream',Stream);
  const video={removeAttribute:()=>{},play:vi.fn().mockRejectedValue(new Error('blocked')),pause:()=>{},srcObject:null} as unknown as HTMLVideoElement;
  const gestures=new EventTarget(); const playback=new GamePlayback(video,gestures);
  playback.addTrack({kind:'audio',enabled:false} as MediaStreamTrack);
  await new Promise(r=>setTimeout(r,0));
  gestures.dispatchEvent(new Event('keydown'));
  await new Promise(r=>setTimeout(r,0));
  expect(video.play).toHaveBeenCalledTimes(2); playback.close();
});
