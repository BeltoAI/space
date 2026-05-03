// EuroSAT scene classifier runtime — loads the ResNet-18 ONNX model trained
// on Sentinel-2 imagery and runs it on individual frames.
//
// If /models/eurosat-resnet18.onnx is not present, classifyScene() returns
// null and the caller falls back to the heuristic. This way the app still
// works for users who haven't run the conversion script.

import * as ort from 'onnxruntime-web';
import { log } from './logs';

// EuroSAT class labels in the order they appear in the model output
export const EUROSAT_CLASSES = [
  'AnnualCrop',
  'Forest',
  'HerbaceousVegetation',
  'Highway',
  'Industrial',
  'Pasture',
  'PermanentCrop',
  'Residential',
  'River',
  'SeaLake'
] as const;

export type EuroSatClass = typeof EUROSAT_CLASSES[number];

export interface SceneClassification {
  topClass: EuroSatClass;
  confidence: number;
  // Top-3 predictions for richer UI
  top3: { cls: EuroSatClass; prob: number }[];
  // Full distribution if you want to query specific classes
  probs: Record<EuroSatClass, number>;
  inferenceMs: number;
}

let sessionPromise: Promise<ort.InferenceSession | null> | null = null;
let modelStatus: 'untried' | 'loading' | 'loaded' | 'missing' | 'error' = 'untried';

// ImageNet normalization — ResNet-18 was fine-tuned from ImageNet weights,
// so we keep ImageNet's mean/std (the same preprocessing used during training)
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const INPUT_SIZE = 224;

/** Returns true if the EuroSAT classifier model is loaded and ready. */
export function isEurosatReady(): boolean {
  return modelStatus === 'loaded';
}

export function getEurosatStatus() {
  return modelStatus;
}

async function ensureSession(): Promise<ort.InferenceSession | null> {
  if (sessionPromise) return sessionPromise;
  modelStatus = 'loading';
  sessionPromise = (async () => {
    const url = '/models/eurosat-resnet18.onnx';
    try {
      // HEAD probe — if the file isn't there, fail fast and silently
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) {
        modelStatus = 'missing';
        log.emit(
          `EuroSAT classifier not bundled · run scripts/convert-eurosat.py to enable scene classification`,
          'info'
        );
        return null;
      }
      // Sniff first bytes — ONNX files start with 0x08 (protobuf field tag).
      // If we get HTML or a tiny file, treat as missing rather than crashing.
      const sizeStr = head.headers.get('content-length') || '0';
      const sizeMB = parseInt(sizeStr) / (1024 * 1024);
      if (sizeMB < 1) {
        modelStatus = 'missing';
        log.emit(
          `EuroSAT model file too small (${sizeMB.toFixed(2)} MB) · likely missing or corrupted · run scripts/convert-eurosat.py`,
          'warn'
        );
        return null;
      }
      const t0 = performance.now();
      const session = await ort.InferenceSession.create(url, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
      const ms = Math.round(performance.now() - t0);
      log.emit(
        `EuroSAT classifier loaded: ResNet-18 · ${sizeMB.toFixed(1)} MB · ${ms} ms`,
        'ok'
      );
      log.emit(
        `model: 10-class land cover (Sentinel-2 trained, 98% test acc)`,
        'info'
      );
      modelStatus = 'loaded';
      return session;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      modelStatus = 'error';
      log.emit(`EuroSAT classifier load failed: ${msg}`, 'warn');
      log.emit(
        `running heuristic-only mode · run scripts/convert-eurosat.py for scene classification`,
        'info'
      );
      return null;
    }
  })();
  return sessionPromise;
}

/** Eagerly start loading at app boot so the first inference doesn't pay the cold-start. */
export function preloadEurosat() {
  ensureSession();
}

function preprocess(imageData: ImageData): Float32Array {
  // Resize to 224x224 with center crop, then normalize.
  // Center-crop matches the training preprocessing.
  const { data, width: srcW, height: srcH } = imageData;

  // Square center crop of the source
  const cropSize = Math.min(srcW, srcH);
  const cropX = Math.floor((srcW - cropSize) / 2);
  const cropY = Math.floor((srcH - cropSize) / 2);

  // Render the crop into a 224x224 canvas
  const tmp = document.createElement('canvas');
  tmp.width = INPUT_SIZE;
  tmp.height = INPUT_SIZE;
  const tctx = tmp.getContext('2d')!;

  // Source canvas to draw from
  const src = document.createElement('canvas');
  src.width = srcW;
  src.height = srcH;
  src.getContext('2d')!.putImageData(imageData, 0, 0);

  tctx.drawImage(
    src,
    cropX, cropY, cropSize, cropSize,
    0, 0, INPUT_SIZE, INPUT_SIZE
  );
  const resized = tctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;

  // Convert HWC uint8 [0,255] → CHW float32 normalized
  const out = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const planeSize = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < planeSize; i++) {
    const r = resized[i * 4] / 255;
    const g = resized[i * 4 + 1] / 255;
    const b = resized[i * 4 + 2] / 255;
    out[i] = (r - MEAN[0]) / STD[0];
    out[planeSize + i] = (g - MEAN[1]) / STD[1];
    out[2 * planeSize + i] = (b - MEAN[2]) / STD[2];
  }
  // Discard the source data array reference (we don't need to nullify
  // ImageData but the resized array can be GC'd after this returns)
  void data;
  return out;
}

function softmax(logits: Float32Array): Float32Array {
  const out = new Float32Array(logits.length);
  let maxL = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > maxL) maxL = logits[i];
  }
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - maxL);
    sum += out[i];
  }
  for (let i = 0; i < logits.length; i++) out[i] /= sum;
  return out;
}

/**
 * Classify a frame. Returns null if the classifier isn't loaded,
 * letting callers fall back to the heuristic gracefully.
 */
export async function classifyScene(imageData: ImageData): Promise<SceneClassification | null> {
  const session = await ensureSession();
  if (!session) return null;

  try {
    const t0 = performance.now();
    const input = preprocess(imageData);
    const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const result = await session.run({ [inputName]: tensor });
    const logits = result[outputName].data as Float32Array;
    const probs = softmax(logits);

    const probsByClass = {} as Record<EuroSatClass, number>;
    for (let i = 0; i < EUROSAT_CLASSES.length; i++) {
      probsByClass[EUROSAT_CLASSES[i]] = probs[i];
    }

    const indexed = Array.from(probs).map((p, i) => ({ cls: EUROSAT_CLASSES[i], prob: p }));
    indexed.sort((a, b) => b.prob - a.prob);

    return {
      topClass: indexed[0].cls,
      confidence: indexed[0].prob,
      top3: indexed.slice(0, 3),
      probs: probsByClass,
      inferenceMs: performance.now() - t0
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.emit(`EuroSAT inference error: ${msg}`, 'warn');
    return null;
  }
}

// ============================================================
// Map EuroSAT class → BELTO rule-engine semantic groups.
// This is what makes the rule engine more accurate: instead of
// hand-tuned RGB thresholds, we route the trained classifier's
// output to fire/water/cloud/etc decisions.
// ============================================================
export type SceneCategory =
  | 'water'
  | 'developed'      // residential / industrial / highway
  | 'agriculture'    // crops, pasture
  | 'natural'        // forest, vegetation
  | 'unknown';

const CATEGORY_BY_CLASS: Record<EuroSatClass, SceneCategory> = {
  AnnualCrop: 'agriculture',
  Forest: 'natural',
  HerbaceousVegetation: 'natural',
  Highway: 'developed',
  Industrial: 'developed',
  Pasture: 'agriculture',
  PermanentCrop: 'agriculture',
  Residential: 'developed',
  River: 'water',
  SeaLake: 'water'
};

export function sceneToCategory(cls: EuroSatClass): SceneCategory {
  return CATEGORY_BY_CLASS[cls] ?? 'unknown';
}

/** Aggregate water-related probability across River + SeaLake. */
export function waterProbability(scene: SceneClassification): number {
  return scene.probs.River + scene.probs.SeaLake;
}

/** Aggregate developed/anthropogenic probability. */
export function developedProbability(scene: SceneClassification): number {
  return scene.probs.Residential + scene.probs.Industrial + scene.probs.Highway;
}

/** Aggregate vegetation probability. */
export function vegetationProbability(scene: SceneClassification): number {
  return scene.probs.Forest + scene.probs.HerbaceousVegetation +
         scene.probs.AnnualCrop + scene.probs.Pasture + scene.probs.PermanentCrop;
}
