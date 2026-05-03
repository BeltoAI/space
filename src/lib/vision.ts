import type { VisionScores, FrameAnalysis } from './types';
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

const MAX_DIM = 384;  // Smaller working size — k-means is O(N*K*iterations)

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

// ============================================================
// LAB color space — perceptually uniform, where Euclidean distance
// roughly matches how different two colors look. Critical for clustering.
// ============================================================
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // Normalize 0-1
  let R = r / 255, G = g / 255, B = b / 255;
  // sRGB → linear
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  // RGB → XYZ (D65)
  let X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.00000;
  let Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  // XYZ → LAB
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [
    116 * fy - 16,        // L: 0..100
    500 * (fx - fy),      // a: roughly -128..+127 (green-red)
    200 * (fy - fz)       // b: roughly -128..+127 (blue-yellow)
  ];
}

// ============================================================
// K-means clustering in LAB space.
// Returns cluster assignments (per-pixel cluster ID) and centroids.
// ============================================================
interface KMeansResult {
  assignments: Uint8Array;          // pixel → cluster ID
  centroids: number[][];            // [L, a, b, R, G, B] per cluster
  clusterSizes: number[];           // pixel count per cluster
}

function kmeans(lab: Float32Array, rgb: Uint8ClampedArray, N: number, K: number, maxIters = 8): KMeansResult {
  // k-means++ initialization for stability
  const centroids: number[][] = [];
  // First centroid: random pixel
  const firstIdx = Math.floor(Math.random() * N);
  centroids.push([lab[firstIdx * 3], lab[firstIdx * 3 + 1], lab[firstIdx * 3 + 2]]);

  // Subsequent centroids: weighted by squared distance to nearest existing centroid
  // Sample subset for speed
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
    // Pick weighted random
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
    // Assignment step
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

    // Update step
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
    // Early termination if converged
    if (Math.abs(prevTotalShift - totalShift) < 0.5) break;
    prevTotalShift = totalShift;
  }

  // Compute mean RGB per cluster (for semantic mapping + viz)
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
// Map a cluster centroid to a semantic class.
// Uses LAB + mean RGB. This is a single decision per cluster (not per pixel),
// so even if the centroid is slightly off, ALL pixels in that cluster get the
// same correct label — making the segmentation visually coherent.
// ============================================================
function clusterToClass(L: number, _a: number, _b: number, R: number, G: number, B: number): number {
  const maxC = Math.max(R, G, B);
  const minC = Math.min(R, G, B);
  const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;

  // FIRE — saturated red/orange. Centroid-level test is much more reliable
  // than per-pixel because k-means groups all warm pixels together.
  if (R > 170 && R > G + 30 && R > B + 50 && sat > 0.40 && L > 35 && L < 85) {
    return CLASS_FIRE;
  }
  // CLOUD — bright + desaturated + neutral or slightly cool
  if (L > 75 && sat < 0.18 && B >= R - 8) {
    return CLASS_CLOUD;
  }
  // WATER — dark + blue dominant
  if (L < 45 && B > R + 5 && B > G - 5) {
    return CLASS_WATER;
  }
  // VEGETATION — green dominant
  if (G > R + 5 && G > B + 8 && L > 25 && L < 75) {
    return CLASS_VEGETATION;
  }
  // TERRAIN — warm/desaturated land (everything else that's not too dark/bright)
  if (L > 35 && L < 80 && sat > 0.05 && R >= B - 5) {
    return CLASS_TERRAIN;
  }
  // Reject — leave unclassified
  return CLASS_BG;
}

export interface SpectralResult {
  scores: Omit<VisionScores, 'anomaly'>;
  ms: number;
  mask: Uint8Array;
}

export function spectralAnalysis(imageData: ImageData): SpectralResult {
  const t0 = performance.now();
  const { data, width: W, height: H } = imageData;
  const N = W * H;

  // 1) Convert to LAB
  const lab = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    const [L, a, b] = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
    lab[i * 3] = L;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }

  // 2) K-means cluster in LAB. K=8 is a sweet spot — enough to separate
  // sky/cloud/water/grass/terrain/fire/shadow/etc, not so many that small
  // patches get over-segmented.
  const K = 8;
  const km = kmeans(lab, data, N, K, 8);

  // 3) Map each cluster to a semantic class based on its centroid color.
  const clusterClass = new Uint8Array(K);
  for (let k = 0; k < K; k++) {
    const c = km.centroids[k];
    clusterClass[k] = clusterToClass(c[0], c[1], c[2], c[3], c[4], c[5]);
  }

  // 4) Build per-pixel mask using cluster → class assignment.
  // This gives perfectly coherent regions because all pixels in a cluster
  // get the SAME class — the "patchy" look from per-pixel thresholding is gone.
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    mask[i] = clusterClass[km.assignments[i]];
  }

  // 5) Compute scores from cluster sizes (already counted during k-means)
  const classArea: Record<number, number> = {};
  for (let k = 0; k < K; k++) {
    const cls = clusterClass[k];
    classArea[cls] = (classArea[cls] ?? 0) + km.clusterSizes[k];
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
  minDetectionArea = 400
): Promise<FrameAnalysis> {
  const spectral = spectralAnalysis(imageData);

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

  const sceneResult = await classifyScene(imageData);
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
    scene
  };
}
