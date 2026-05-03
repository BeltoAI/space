import * as ort from 'onnxruntime-web';
import { log } from './logs';
import type { RuntimeInfo } from './types';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/';
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

// Model is bundled in /public/models/. Always loaded same-origin — no CORS,
// no HuggingFace gating, no postinstall script.
const MODEL_URL = '/models/belto-cnn.onnx';
const MODEL_NAME = 'belto-cnn';

let session: ort.InferenceSession | null = null;
let runtimeInfo: RuntimeInfo = {
  provider: 'unavailable',
  modelLoaded: false,
  modelName: MODEL_NAME,
  modelSizeMB: 0
};
let initPromise: Promise<RuntimeInfo> | null = null;

export function getRuntime(): RuntimeInfo {
  return runtimeInfo;
}

export function getSession(): ort.InferenceSession | null {
  return session;
}

async function detectWebGPU(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export function initRuntime(): Promise<RuntimeInfo> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await log.streamed('edge node initializing', 'info', 30);
    await log.streamed(
      `platform: browser | ${navigator.userAgent.split(/[)(]/).pop()?.trim() || 'unknown'}`,
      'info',
      30
    );

    const hasWebGPU = await detectWebGPU();
    await log.streamed(`webgpu adapter: ${hasWebGPU ? 'available' : 'unavailable'}`, hasWebGPU ? 'ok' : 'info', 30);

    await log.streamed(`fetching bundled model: ${MODEL_URL}`, 'info', 30);
    const t0 = performance.now();
    const res = await fetch(MODEL_URL);
    if (!res.ok) {
      await log.streamed(`model fetch failed: HTTP ${res.status} — running in spectral-only mode`, 'critical', 30);
      runtimeInfo = { provider: 'unavailable', modelLoaded: false, modelName: MODEL_NAME, modelSizeMB: 0 };
      return runtimeInfo;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 10_000) {
      await log.streamed(`model file too small (${buf.byteLength} bytes) — likely missing`, 'critical', 30);
      runtimeInfo = { provider: 'unavailable', modelLoaded: false, modelName: MODEL_NAME, modelSizeMB: 0 };
      return runtimeInfo;
    }
    const sizeMB = Math.round((buf.byteLength / 1024 / 1024) * 100) / 100;
    await log.streamed(`model loaded: ${sizeMB} MB in ${Math.round(performance.now() - t0)} ms`, 'ok', 30);

    let chosen: 'webgpu' | 'wasm' = 'wasm';
    try {
      const t1 = performance.now();
      const providers = hasWebGPU ? (['webgpu', 'wasm'] as const) : (['wasm'] as const);
      session = await ort.InferenceSession.create(buf, {
        executionProviders: providers as unknown as string[],
        graphOptimizationLevel: 'all'
      });
      chosen = hasWebGPU ? 'webgpu' : 'wasm';
      await log.streamed(`inference session created: provider=${chosen} in ${Math.round(performance.now() - t1)} ms`, 'ok', 30);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log.streamed(`webgpu session failed, retrying wasm: ${msg}`, 'warn', 30);
      session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      chosen = 'wasm';
      await log.streamed('inference session created: provider=wasm', 'ok', 30);
    }

    runtimeInfo = { provider: chosen, modelLoaded: true, modelName: MODEL_NAME, modelSizeMB: sizeMB };
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    await log.streamed(
      `runtime ready: ${chosen} | input=${inputName}[1,3,224,224] output=${outputName}[1,256]`,
      'ok',
      30
    );
    return runtimeInfo;
  })();
  return initPromise;
}
