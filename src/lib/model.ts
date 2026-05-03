import * as ort from 'onnxruntime-web';
import { getSession } from './runtime';

const SIZE = 224;

export async function runInference(
  imageData: ImageData
): Promise<{ embedding: Float32Array; ms: number } | null> {
  const session = getSession();
  if (!session) return null;

  const t0 = performance.now();
  const tensor = preprocessToTensor(imageData);
  const inputName = session.inputNames[0];
  const feeds: Record<string, ort.Tensor> = { [inputName]: tensor };
  const results = await session.run(feeds);
  const outputName = session.outputNames[0];
  const output = results[outputName];
  const embedding = output.data as Float32Array;
  return { embedding, ms: performance.now() - t0 };
}

function preprocessToTensor(imageData: ImageData): ort.Tensor {
  // Resize to 224x224 via canvas
  const dst = document.createElement('canvas');
  dst.width = SIZE;
  dst.height = SIZE;
  const dctx = dst.getContext('2d', { willReadFrequently: true })!;

  const src = document.createElement('canvas');
  src.width = imageData.width;
  src.height = imageData.height;
  src.getContext('2d')!.putImageData(imageData, 0, 0);
  dctx.drawImage(src, 0, 0, SIZE, SIZE);

  const resized = dctx.getImageData(0, 0, SIZE, SIZE);
  const data = resized.data;

  // CHW float32, MobileNetV2 normalization: (x/255 - 0.5)/0.5 = x/127.5 - 1
  const out = new Float32Array(3 * SIZE * SIZE);
  const planeSize = SIZE * SIZE;
  for (let i = 0; i < planeSize; i++) {
    const idx = i * 4;
    out[i] = data[idx] / 127.5 - 1;
    out[planeSize + i] = data[idx + 1] / 127.5 - 1;
    out[planeSize * 2 + i] = data[idx + 2] / 127.5 - 1;
  }

  return new ort.Tensor('float32', out, [1, 3, SIZE, SIZE]);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
