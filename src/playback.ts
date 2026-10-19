/** One audible output: Web Audio gain when available, media-element fallback otherwise. */
export class GamePlayback {
  private readonly stream = new MediaStream();
  private closed = false;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private readonly resume = () => {
    if (this.closed) return;
    this.video.muted = !!this.context;
    this.video.defaultMuted = false;
    this.video.removeAttribute('muted');
    if(this.context) { this.video.muted=true; void this.context.resume().catch(()=>{}); }
    this.video.volume = 1;
    void this.video.play().catch(() => { /* Next trusted gesture retries playback. */ });
  };
  constructor(private video: HTMLVideoElement, private gestures: EventTarget, private audioGain = 1) {
    this.video.srcObject = this.stream;
    gestures.addEventListener('pointerdown', this.resume);
    gestures.addEventListener('keydown', this.resume);
  }
  addTrack(track: MediaStreamTrack): void {
    if (this.closed) { track.stop?.(); return; }
    track.enabled = true;
    if (!this.stream.getTracks().includes(track)) {
      for (const old of this.stream.getTracks()) if (old.kind === track.kind) { old.stop?.(); this.stream.removeTrack(old); }
      this.stream.addTrack(track);
    }
    if(track.kind === 'audio' && !this.context && typeof AudioContext !== 'undefined') {
      try {
        this.context = new AudioContext();
        this.source = this.context.createMediaStreamSource(this.stream);
        this.gain = this.context.createGain();
        this.gain.gain.value = Math.max(1, Math.min(1.5, Number.isFinite(this.audioGain) ? this.audioGain : 1));
        this.source.connect(this.gain); this.gain.connect(this.context.destination);
      } catch {
        this.source?.disconnect(); this.gain?.disconnect();
        void this.context?.close().catch(()=>{}); this.context=undefined;this.source=undefined;this.gain=undefined;
      }
    }
    this.resume();
  }
  close(): void {
    if(this.closed)return;
    this.closed = true;
    this.source?.disconnect();this.gain?.disconnect();
    void this.context?.close().catch(()=>{});
    this.context=undefined;this.source=undefined;this.gain=undefined;
    this.gestures.removeEventListener('pointerdown', this.resume);
    this.gestures.removeEventListener('keydown', this.resume);
    for (const track of this.stream.getTracks()) { track.stop?.(); this.stream.removeTrack(track); }
    // A delayed close from another attempt must never detach the new stream.
    if(this.video.srcObject===this.stream){
      this.video.pause();this.video.srcObject=null;this.video.load?.();
    }
  }
}
