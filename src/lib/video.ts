import type { FrameAnalysis } from './types';
import { analyzeFrame, imageToImageData } from './vision';
import { evaluate, priorityRank } from './rules';
import { log } from './logs';

export interface VideoSamplingResult {
  frames: FrameAnalysis[];
  bestFrame: FrameAnalysis;
  bestImageData: ImageData;
  durationS: number;
  framesProcessed: number;
}

// FIX: extract frames SERIALLY. Previous bug created all seek promises in parallel,
// which set video.currentTime 30× concurrently — all reads ended up at the last
// timestamp, returning identical frames.
async function extractFramesSerial(video: HTMLVideoElement, samples: number[]): Promise<ImageData[]> {
  const frames: ImageData[] = [];
  for (const t of samples) {
    await seekVideo(video, t);
    // Wait one paint cycle so the decoded frame is actually drawn
    await new Promise<void>(r => requestAnimationFrame(() => r()));
    frames.push(imageToImageData(video));
  }
  return frames;
}

export async function processVideoFile(
  videoUrl: string,
  opts: { sampleHz: number; degradedNetwork: boolean; maxFrames?: number }
): Promise<VideoSamplingResult> {
  const video = document.createElement('video');
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';

  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('video load failed')), { once: true });
  });

  const duration = video.duration;
  const interval = 1 / opts.sampleHz;
  const maxFrames = opts.maxFrames ?? 12; // cap so 30s+ videos don't take forever
  const samples: number[] = [];
  for (let t = 0; t < duration && samples.length < maxFrames; t += interval) samples.push(t);

  await log.streamed(
    `video: ${video.videoWidth}x${video.videoHeight} ${duration.toFixed(1)}s | extracting ${samples.length} frames`,
    'info',
    30
  );

  const imgs = await extractFramesSerial(video, samples);
  await log.streamed(`${imgs.length} frames extracted`, 'ok', 30);

  return runSequence(
    imgs,
    opts.degradedNetwork,
    duration,
    (i) => `frame@${samples[i].toFixed(1)}s`
  );
}

export async function processFrameSequence(
  frames: ImageData[],
  opts: { degradedNetwork: boolean; labels?: string[] }
): Promise<VideoSamplingResult> {
  return runSequence(
    frames,
    opts.degradedNetwork,
    frames.length,
    (i, len) => opts.labels?.[i] ?? `frame ${i + 1}/${len}`
  );
}

async function runSequence(
  frames: ImageData[],
  degradedNetwork: boolean,
  durationS: number,
  labelFn: (i: number, len: number) => string
): Promise<VideoSamplingResult> {
  const results: FrameAnalysis[] = [];
  let bestFrame: FrameAnalysis | null = null;
  let bestImageData: ImageData | null = null;
  let bestRank = -Infinity;
  let prevEmbedding: Float32Array | null = null;

  for (let i = 0; i < frames.length; i++) {
    const id = frames[i];
    const fa = await analyzeFrame(id, prevEmbedding, 400, 'satellite');
    results.push(fa);
    prevEmbedding = fa.embedding;

    const rule = evaluate({ scores: fa.scores, scene: fa.scene, degradedNetwork, sourceMode: 'satellite' });
    const rank = priorityRank(fa.scores);

    await log.streamed(
      `${labelFn(i, frames.length)} | f=${fa.scores.fire.toFixed(2)} cl=${fa.scores.cloud.toFixed(2)} w=${fa.scores.water.toFixed(2)} v=${fa.scores.vegetation.toFixed(2)} an=${fa.scores.anomaly.toFixed(2)} | dets=${fa.detections.length} | ${rule.rule}`,
      rule.priority === 'CRITICAL' ? 'critical' : rule.priority === 'HIGH' ? 'warn' : 'info',
      30
    );

    if (rank > bestRank) {
      bestRank = rank;
      bestFrame = fa;
      bestImageData = id;
    }
  }

  return {
    frames: results,
    bestFrame: bestFrame!,
    bestImageData: bestImageData!,
    durationS,
    framesProcessed: results.length
  };
}

function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onSeeked = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      reject(new Error('seek failed'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onErr);
    // Timeout fallback
    setTimeout(() => onSeeked(), 2000);
    video.currentTime = Math.min(t, Math.max(0, video.duration - 0.01));
  });
}

// Real GIBS time-lapse (same tile, multiple consecutive days)
export interface TimelapseConfig {
  lat: number;
  lon: number;
  startDate: string;
  days: number;
  layer: string;
  label: string;
}

export const TIMELAPSE_PRESET: TimelapseConfig = {
  lat: 40.0,
  lon: -121.6,
  startDate: '2024-07-28',
  days: 6,
  layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
  label: 'Park Fire (6 days)'
};

function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const tilesX = 2 * Math.pow(2, z);
  const tilesY = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * tilesX);
  const y = Math.floor(((90 - lat) / 180) * tilesY);
  return {
    x: Math.max(0, Math.min(tilesX - 1, x)),
    y: Math.max(0, Math.min(tilesY - 1, y))
  };
}

function shiftDate(d: string, days: number): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function fetchTileAsImageData(url: string): Promise<ImageData | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('decode failed'));
      im.src = objUrl;
    });
    return imageToImageData(img);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

export async function fetchGibsTimelapse(
  cfg: TimelapseConfig = TIMELAPSE_PRESET
): Promise<{ frames: ImageData[]; labels: string[]; rawBytes: number }> {
  const z = 6;
  const { x, y } = lonLatToTileXY(cfg.lon, cfg.lat, z);
  await log.streamed(`timelapse: ${cfg.label} | ${cfg.days} consecutive daily MODIS tiles`, 'info', 30);

  const dates: string[] = [];
  for (let i = cfg.days - 1; i >= 0; i--) dates.push(shiftDate(cfg.startDate, -i));

  const frames: ImageData[] = [];
  const labels: string[] = [];
  let rawBytes = 0;

  for (const d of dates) {
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${cfg.layer}/default/${d}/250m/${z}/${y}/${x}.jpg`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        await log.streamed(`tile ${d}: HTTP ${res.status}, skipping`, 'warn', 30);
        continue;
      }
      const blob = await res.blob();
      rawBytes += blob.size;
      const fr = await fetchTileAsImageData(url);
      if (!fr) continue;
      frames.push(fr);
      labels.push(`day ${labels.length + 1} (${d})`);
    } catch {}
  }

  if (frames.length === 0) throw new Error('no GIBS tiles fetched for timelapse');
  await log.streamed(`timelapse ready: ${frames.length} real satellite frames`, 'ok', 30);

  return { frames, labels, rawBytes };
}
