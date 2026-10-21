/** Capture the current video frame to a PNG data URL for local download.
 *  Returns null when there is no frame yet, no 2D context, or the canvas
 *  would be tainted — callers must surface an honest failure, not a fake file. */
export function captureVideoFrame(
  video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>,
  canvasFactory: () => HTMLCanvasElement = () => document.createElement('canvas'),
): string | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = canvasFactory();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(video as HTMLVideoElement, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
