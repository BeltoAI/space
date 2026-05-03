import type { VisionScores, FrameAnalysis, SourceMode } from './types';
import { runInference, cosineSimilarity } from './model';
import {
  findConnectedComponents,
  CLASS_BG,
  CLASS_FIRE,
  CLASS_CLOUD,
  CLASS_WATER,
  CLASS_VEGETATION,
  CLASS_TERRAIN
} from './detection';
import { log } from './logs';
import { classifyScene } from './eurosat-runtime';

const MAX_DIM = 384;

type DrawSource = HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;

export function imageToImageData(img: DrawSource, maxDim = MAX_DIM): ImageData {
  const w =
    (img as HTMLImageElement).naturalWidth ||
    (img as HTMLVideoElement).videoWidth ||
    (img as HTMLCanvasElement).width;
  const h =
    (img as HTMLImageElement).naturalHeight ||
    (img as HTMLVideoElement).videoHeight ||
    (img as HTMLCanvasElement).height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Number(x.toFixed(3))));
}

// LAB color space — perceptually uniform.
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  let X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.00000;
  let Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

interface KMeansResult {
  assignments: Uint8Array;
  centroids: number[][];      // [L, a, b, R, G, B] per cluster
  clusterSizes: number[];
}

function kmeans(lab: Float32Array, rgb: Uint8ClampedArray, N: number, K: number, maxIters = 8): KMeansResult {
  const centroids: number[][] = [];
  const firstIdx = Math.floor(Math.random() * N);
  centroids.push([lab[firstIdx * 3], lab[firstIdx * 3 + 1], lab[firstIdx * 3 + 2]]);

  const sampleStride = Math.max(1, Math.floor(N / 4000));
  for (let k = 1; k < K; k++) {
    let totalDist = 0;
    const dists: number[] = [];
    const samples: number[] = [];
    for (let i = 0; i < N; i += sampleStride) {
      let minD = Infinity;
      for (const c of centroids) {
        const dL = lab[i * 3] - c[0];
        const dA = lab[i * 3 + 1] - c[1];
        const dB = lab[i * 3 + 2] - c[2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < minD) minD = d;
      }
      dists.push(minD);
      samples.push(i);
      totalDist += minD;
    }
    let r = Math.random() * totalDist;
    let chosen = samples[0];
    for (let j = 0; j < dists.length; j++) {
      r -= dists[j];
      if (r <= 0) { chosen = samples[j]; break; }
    }
    centroids.push([lab[chosen * 3], lab[chosen * 3 + 1], lab[chosen * 3 + 2]]);
  }

  const assignments = new Uint8Array(N);
  let prevTotalShift = Infinity;

  for (let iter = 0; iter < maxIters; iter++) {
    for (let i = 0; i < N; i++) {
      const lL = lab[i * 3], lA = lab[i * 3 + 1], lB = lab[i * 3 + 2];
      let bestK = 0;
      let bestD = Infinity;
      for (let k = 0; k < K; k++) {
        const c = centroids[k];
        const dL = lL - c[0];
        const dA = lA - c[1];
        const dB = lB - c[2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bestD) { bestD = d; bestK = k; }
      }
      assignments[i] = bestK;
    }
    const sums = Array.from({ length: K }, () => [0, 0, 0]);
    const counts = new Array(K).fill(0);
    for (let i = 0; i < N; i++) {
      const k = assignments[i];
      sums[k][0] += lab[i * 3];
      sums[k][1] += lab[i * 3 + 1];
      sums[k][2] += lab[i * 3 + 2];
      counts[k]++;
    }
    let totalShift = 0;
    for (let k = 0; k < K; k++) {
      if (counts[k] === 0) continue;
      const newL = sums[k][0] / counts[k];
      const newA = sums[k][1] / counts[k];
      const newB = sums[k][2] / counts[k];
      const dL = newL - centroids[k][0];
      const dA = newA - centroids[k][1];
      const dB = newB - centroids[k][2];
      totalShift += Math.sqrt(dL * dL + dA * dA + dB * dB);
      centroids[k] = [newL, newA, newB];
    }
    if (Math.abs(prevTotalShift - totalShift) < 0.5) break;
    prevTotalShift = totalShift;
  }

  const rgbSums = Array.from({ length: K }, () => [0, 0, 0]);
  const counts = new Array(K).fill(0);
  for (let i = 0; i < N; i++) {
    const k = assignments[i];
    rgbSums[k][0] += rgb[i * 4];
    rgbSums[k][1] += rgb[i * 4 + 1];
    rgbSums[k][2] += rgb[i * 4 + 2];
    counts[k]++;
  }
  const finalCentroids: number[][] = [];
  for (let k = 0; k < K; k++) {
    const n = Math.max(1, counts[k]);
    finalCentroids.push([
      centroids[k][0], centroids[k][1], centroids[k][2],
      rgbSums[k][0] / n, rgbSums[k][1] / n, rgbSums[k][2] / n
    ]);
  }

  return { assignments, centroids: finalCentroids, clusterSizes: counts };
}

// ============================================================
// Scene context — computed AFTER k-means so we can validate cluster
// classifications against the broader image. This is the key fix for
// "person holding red phone = FIRE": fire requires the scene to contain
// natural elements (vegetation/terrain/cloud), not just a red blob in a
// uniform background.
// ============================================================
interface SceneContext {
  /** % of image that is dark + neutral (sky, space, dark indoor backgrounds) */
  darkNeutralFrac: number;
  /** % that is bright (clouds, walls, highlights) */
  brightFrac: number;
  /** Mean L of all pixels */
  meanL: number;
  /** Std-dev of L — high in night satellite scenes (dark + city lights) */
  stdL: number;
  /** Histogram bimodality estimate — flag city lights / mirror selfies */
  bimodality: number;
  /** Fraction of pixels with any warm content (r > g, r > b) — low for night satellite, high for fire scenes */
  warmFrac: number;
  /** Fraction of pixels with strongly saturated green (vegetation in SWIR/false-color)
   *  — high in MODIS bands 7-2-1 imagery, near zero in indoor photos */
  saturatedGreenFrac: number;
}

function computeSceneContext(lab: Float32Array, data: Uint8ClampedArray, N: number): SceneContext {
  let sumL = 0, sumLsq = 0;
  let darkNeutral = 0, bright = 0, warm = 0, satGreen = 0;
  const lumHist = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    const L = lab[i * 3];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    sumL += L;
    sumLsq += L * L;
    if (L < 30 && Math.abs(a) < 8 && Math.abs(b) < 8) darkNeutral++;
    if (L > 75) bright++;
    const v = Math.min(255, Math.max(0, Math.round(L * 2.55)));
    lumHist[v]++;
    const idx = i * 4;
    const r = data[idx], g = data[idx + 1], bl = data[idx + 2];
    if (r > 130 && r > g && r > bl) warm++;
    // Strongly saturated green: vegetation in SWIR false-color is bright
    // & green-dominant. In bands 7-2-1, vegetation pixels look like (50, 200, 30)
    // where green wildly dominates. This fingerprints SWIR imagery and
    // distinguishes it from indoor/portrait photos which never have such
    // strong green dominance.
    if (g > 130 && g > r + 30 && g > bl + 30) satGreen++;
  }
  const meanL = sumL / N;
  const stdL = Math.sqrt(Math.max(0, sumLsq / N - meanL * meanL));

  let darkPeakC = 0, brightPeakC = 0;
  for (let v = 0; v < 80; v++) {
    if (lumHist[v] > darkPeakC) darkPeakC = lumHist[v];
  }
  for (let v = 180; v < 256; v++) {
    if (lumHist[v] > brightPeakC) brightPeakC = lumHist[v];
  }
  const minPeak = Math.min(darkPeakC, brightPeakC);
  const maxPeak = Math.max(darkPeakC, brightPeakC);
  const bimodality = maxPeak > 0 ? minPeak / maxPeak : 0;

  return {
    darkNeutralFrac: darkNeutral / N,
    brightFrac: bright / N,
    meanL,
    stdL,
    bimodality,
    warmFrac: warm / N,
    saturatedGreenFrac: satGreen / N
  };
}

// ============================================================
// Cluster → semantic class. NOW takes scene context to reject
// false positives that wreck the demo:
//
// - Red phone case in webcam: cluster is fire-colored BUT the scene has
//   high darkNeutralFrac (indoor) and low brightFrac (no sky). Fire rejected.
// - City lights at night satellite: bright spots in dark scene have high
//   bimodality. Water rule rejects (water is large coherent dark-blue regions,
//   not sparse hot points).
// - Snow/ice in storm scene: cluster has L>70 and very neutral a*b*. Looks
//   like terrain to old rule. Tighten: terrain MUST have warm a* (>2).
// ============================================================
function clusterToClass(
  L: number, a: number, b: number,
  R: number, G: number, B: number,
  ctx: SceneContext,
  sourceMode: SourceMode
): number {
  const maxC = Math.max(R, G, B);
  const minC = Math.min(R, G, B);
  const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;

  // FIRE — extra strict for webcam (where false positives are most common)
  // Fire requires:
  //   - Saturated red/orange centroid
  //   - For satellite/upload: scene must NOT be dominated by neutral indoor
  //     background (typical mirror selfie). meanL < 35 = scene is mostly dark
  //     (could be burnt ground in a fire image — allow). meanL > 50 with high
  //     darkNeutralFrac = indoor scene with red object — reject.
  //   - For webcam: NEVER trigger fire from RGB alone. Webcam fire detection
  //     would need thermal IR. Red objects in webcam are red objects, not fires.
  if (sourceMode !== 'webcam') {
    if (R > 170 && R > G + 30 && R > B + 50 && sat > 0.40 && L > 35 && L < 85) {
      // looksIndoor: bright + neutral scene with no satellite signature.
      // Bypassed for SWIR satellite scenes (high saturatedGreenFrac fingerprints
      // bands 7-2-1 imagery — vegetation lights up bright green there).
      const isSwirSatellite = ctx.saturatedGreenFrac > 0.10;
      const looksIndoor = !isSwirSatellite && ctx.meanL > 50 && ctx.brightFrac > 0.20;
      const isNightSatellite = ctx.meanL < 30 && ctx.brightFrac < 0.15 && ctx.warmFrac < 0.10;
      if (!looksIndoor && !isNightSatellite) {
        return CLASS_FIRE;
      }
    }
  }

  // CLOUD — bright + desaturated + neutral or slightly cool
  if (L > 75 && sat < 0.18 && B >= R - 8) {
    return CLASS_CLOUD;
  }

  // WATER — dark + blue dominant
  if (sourceMode !== 'webcam') {
    const isNightSatellite = ctx.meanL < 30 && ctx.brightFrac < 0.15 && ctx.warmFrac < 0.10;
    if (!isNightSatellite && L < 45 && B > R + 5 && B > G - 5 && b < -3) {
      return CLASS_WATER;
    }
  }

  // VEGETATION — green dominant. Safe across all modes (green plants exist).
  if (G > R + 5 && G > B + 8 && L > 25 && L < 75 && a < -5) {
    return CLASS_VEGETATION;
  }

  // TERRAIN — warm/desaturated land.
  // CRITICAL FIX: require positive a* (warm) AND positive b* (yellow-ish).
  // This excludes blue-white snow/ice clouds that were getting labeled terrain.
  // For webcam: relax somewhat since indoor walls/skin tones have similar stats.
  if (sourceMode === 'webcam') {
    // Webcam: don't label terrain at all. There's nothing useful about it.
    return CLASS_BG;
  }
  if (L > 35 && L < 80 && sat > 0.05 && a > 2 && b > 5 && R >= B - 5) {
    return CLASS_TERRAIN;
  }

  return CLASS_BG;
}

export interface SpectralResult {
  scores: Omit<VisionScores, 'anomaly'>;
  ms: number;
  mask: Uint8Array;
}

export function spectralAnalysis(imageData: ImageData, sourceMode: SourceMode = 'satellite'): SpectralResult {
  const t0 = performance.now();
  const { data, width: W, height: H } = imageData;
  const N = W * H;

  const lab = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    const [L, a, b] = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
    lab[i * 3] = L;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }

  // Compute scene-level context first
  const ctx = computeSceneContext(lab, data, N);

  const K = 8;
  const km = kmeans(lab, data, N, K, 8);

  // Map clusters to classes using scene context + source mode
  const clusterClass = new Uint8Array(K);
  for (let k = 0; k < K; k++) {
    const c = km.centroids[k];
    clusterClass[k] = clusterToClass(c[0], c[1], c[2], c[3], c[4], c[5], ctx, sourceMode);
  }

  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    mask[i] = clusterClass[km.assignments[i]];
  }

  // PER-PIXEL FIRE OVERRIDE — k-means clusters can dilute small fire regions
  // into terrain-colored centroids. Run a strict per-pixel hot-pixel detector
  // and force any matching pixels to FIRE class. This catches sparse fires
  // that get washed out by cluster averaging.
  // Skip for webcam mode entirely. Skip for indoor-looking scenes (high
  // meanL + high brightFrac = mid-bright photo, not a fire scene).
  if (sourceMode !== 'webcam') {
    const isSwirSatellite = ctx.saturatedGreenFrac > 0.10;
    const looksIndoor = !isSwirSatellite && ctx.meanL > 50 && ctx.brightFrac > 0.20;
    const isNightSatellite = ctx.meanL < 30 && ctx.brightFrac < 0.15 && ctx.warmFrac < 0.10;
    if (!looksIndoor && !isNightSatellite) {
      for (let i = 0; i < N; i++) {
        const idx = i * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        // Bright + warm + saturated. Real fire pixels are R=255 with G/B
        // dropping off. Threshold 0.35 catches both bright fires and
        // slightly-orange flame tones; r>g+40 and r>b+70 keeps it specific.
        if (r > 200 && r > g + 40 && r > b + 70 && sat > 0.35) {
          mask[i] = CLASS_FIRE;
        }
      }
    }
  }

  // ============================================================
  // WEBCAM FIRE DETECTION — separate, stricter path
  //
  // Real flames have something red household objects don't: an
  // incandescent white-hot CORE (R>240, G>210, B<170, L>82). A red
  // phone case or shirt is uniformly red — no white core. Even a red
  // LED has high B (cool spectrum), so it fails the B<170 check.
  //
  // We require three things together:
  //   1. Bright incandescent core pixels exist (the flame's hot center)
  //   2. Saturated warm halo pixels exist (the orange flame body)
  //   3. Both are localized — neither covers >15% of frame
  //
  // This catches:  ✓ lighter, candle, campfire, gas stove, fireplace
  // This rejects:  ✗ red phone, red shirt, tomato, sunset window, LED
  // ============================================================
  if (sourceMode === 'webcam') {
    let coreCount = 0;
    let haloCount = 0;
    for (let i = 0; i < N; i++) {
      const idx = i * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const L = lab[i * 3];
      const isCore = r > 240 && g > 210 && b < 170 && L > 82;
      if (isCore) coreCount++;
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      const isHalo = r > 200 && r > g + 50 && r > b + 90 && sat > 0.45;
      if (isHalo) haloCount++;
    }
    const coreFrac = coreCount / N;
    const haloFrac = haloCount / N;
    // Real flame: BOTH must exist, neither dominates the frame
    const hasCore = coreCount >= 4 && coreFrac < 0.10;
    const hasHalo = haloCount >= 8 && haloFrac < 0.20;
    if (hasCore && hasHalo) {
      // Confirmed flame — mark all core+halo pixels as fire
      for (let i = 0; i < N; i++) {
        const idx = i * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const L = lab[i * 3];
        const isCore = r > 240 && g > 210 && b < 170 && L > 82;
        const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        const isHalo = r > 200 && r > g + 50 && r > b + 90 && sat > 0.45;
        if (isCore || isHalo) mask[i] = CLASS_FIRE;
      }
    }
  }

  // Compute final class areas from the mask (which includes the per-pixel
  // fire override). This is critical: if we computed scores from cluster
  // sizes, the per-pixel fire pixels would be miscounted as their original
  // cluster's class.
  const classArea: Record<number, number> = {};
  for (let i = 0; i < N; i++) {
    classArea[mask[i]] = (classArea[mask[i]] ?? 0) + 1;
  }

  const fire       = clamp01(((classArea[CLASS_FIRE]       ?? 0) / N) * 4);
  const cloud      = clamp01(((classArea[CLASS_CLOUD]      ?? 0) / N) * 1.6);
  const water      = clamp01(((classArea[CLASS_WATER]      ?? 0) / N) * 1.4);
  const vegetation = clamp01(((classArea[CLASS_VEGETATION] ?? 0) / N) * 1.4);
  const terrain    = clamp01(((classArea[CLASS_TERRAIN]    ?? 0) / N) * 1.4);
  const activity   = clamp01(sobelDensity(extractLuminance(data, N), W, H) * 1.6);

  return {
    scores: { fire, cloud, water, vegetation, terrain, activity },
    ms: performance.now() - t0,
    mask
  };
}

function extractLuminance(data: Uint8ClampedArray, N: number): Float32Array {
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    lum[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }
  return lum;
}

function sobelDensity(lum: Float32Array, w: number, h: number): number {
  let edgeCount = 0, total = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const gx =
        -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] +
        lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy =
        -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] +
        lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > 60) edgeCount++;
      total++;
    }
  }
  return total > 0 ? edgeCount / total : 0;
}

export async function analyzeFrame(
  imageData: ImageData,
  prevEmbedding: Float32Array | null,
  minDetectionArea = 600,
  sourceMode: SourceMode = 'satellite'
): Promise<FrameAnalysis> {
  const spectral = spectralAnalysis(imageData, sourceMode);

  let embedding: Float32Array | null = null;
  let inferenceMs = 0;
  let anomaly = 0;

  try {
    const inf = await runInference(imageData);
    if (inf) {
      embedding = inf.embedding;
      inferenceMs = inf.ms;
      if (prevEmbedding) {
        const sim = cosineSimilarity(embedding, prevEmbedding);
        anomaly = clamp01(1 - sim);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.emit(`inference error: ${msg}`, 'warn');
  }

  const cc = findConnectedComponents(
    spectral.mask,
    imageData.width,
    imageData.height,
    minDetectionArea
  );

  // Only run scene classifier on satellite/upload — running EuroSAT on webcam
  // would predict garbage classes anyway since training was on Sentinel-2
  const sceneResult = sourceMode !== 'webcam' ? await classifyScene(imageData) : null;
  const scene = sceneResult
    ? {
        topClass: sceneResult.topClass,
        confidence: sceneResult.confidence,
        top3: sceneResult.top3.map(t => ({ cls: t.cls, prob: t.prob })),
        inferenceMs: sceneResult.inferenceMs
      }
    : null;

  return {
    scores: { ...spectral.scores, anomaly },
    embedding,
    inferenceMs,
    spectralMs: spectral.ms,
    width: imageData.width,
    height: imageData.height,
    detectionMask: spectral.mask,
    detections: cc.detections,
    detectionLabels: cc.labels,
    sourceImageData: imageData,
    scene,
    sourceMode
  };
}
