// Webcam capture with V4L2-compatibility fallback.
// On some Linux/Ubuntu setups the <video> element doesn't paint the stream even
// though frames are being captured. We use the captured ImageData itself to
// render a preview canvas, so the user always sees what BELTO is processing.

export async function startWebcamStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia not supported');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      facingMode: 'environment'
    },
    audio: false
  });
  return stream;
}

export function stopWebcamStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

// Capture a frame to ImageData. Tries the <video> element directly first,
// then falls back to ImageCapture API for Linux backends where <video> is black.
export async function captureWebcamFrame(
  video: HTMLVideoElement,
  stream: MediaStream | null
): Promise<ImageData | null> {
  // Path 1: <video> element with size data
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0);
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (!isAllBlack(id)) return id;
  }
  // Path 2: ImageCapture from track (Ubuntu fallback)
  if (stream) {
    const track = stream.getVideoTracks()[0];
    if (track && 'ImageCapture' in window) {
      try {
        const ImageCaptureCtor = (window as unknown as {
          ImageCapture: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> };
        }).ImageCapture;
        const imageCapture = new ImageCaptureCtor(track);
        const bitmap = await imageCapture.grabFrame();
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        // fall through
      }
    }
  }
  return null;
}

// Render an ImageData to a canvas (used to mirror live frames into the UI
// even when the <video> element won't render on this platform).
export function paintToCanvas(canvas: HTMLCanvasElement, id: ImageData) {
  if (canvas.width !== id.width) canvas.width = id.width;
  if (canvas.height !== id.height) canvas.height = id.height;
  canvas.getContext('2d')!.putImageData(id, 0, 0);
}

function isAllBlack(id: ImageData): boolean {
  // Sample 1000 random pixels; if all are < 8 in luminance, treat as blank
  const { data } = id;
  const samples = 1000;
  let dark = 0;
  for (let i = 0; i < samples; i++) {
    const idx = Math.floor(Math.random() * (data.length / 4)) * 4;
    const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    if (lum < 8) dark++;
  }
  return dark / samples > 0.95;
}
