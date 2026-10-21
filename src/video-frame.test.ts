import { describe, expect, it } from 'vitest';
import { captureVideoFrame } from './video-frame';

function videoWith(width: number, height: number): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height } as HTMLVideoElement;
}

describe('video frame capture', () => {
  it('returns null before any frame exists', () => {
    expect(captureVideoFrame(videoWith(0, 0))).toBeNull();
  });

  it('returns null when the canvas context is unavailable', () => {
    expect(captureVideoFrame(videoWith(1280, 720), () => ({ width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement))).toBeNull();
  });

  it('draws the frame and exports a PNG data URL', () => {
    let drawn: unknown[] = [];
    const video = videoWith(1280, 720);
    const fake = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: (...args: unknown[]) => { drawn = args; } }),
      toDataURL: (type: string) => {
        expect(type).toBe('image/png');
        return 'data:image/png;base64,QUJD';
      },
    } as unknown as HTMLCanvasElement;
    const url = captureVideoFrame(video, () => fake);
    expect(url).toBe('data:image/png;base64,QUJD');
    expect(drawn[0]).toBe(video);
    expect(fake.width).toBe(1280);
    expect(fake.height).toBe(720);
  });

  it('returns null when the canvas is tainted (drawImage/toDataURL throws)', () => {
    const fake = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: () => { throw new DOMException('tainted', 'SecurityError'); } }),
      toDataURL: () => 'data:image/png;base64,',
    } as unknown as HTMLCanvasElement;
    expect(captureVideoFrame(videoWith(1280, 720), () => fake)).toBeNull();
  });
});
