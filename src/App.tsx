import { useEffect, useRef, useState } from 'react';
import Header from './components/Header';
import InputPanel from './components/InputPanel';
import LogPanel from './components/LogPanel';
import OutputPanel from './components/OutputPanel';
import { initRuntime, getRuntime } from './lib/runtime';
import { preloadEurosat } from './lib/eurosat-runtime';
import { log } from './lib/logs';
import { analyzeFrame, imageToImageData } from './lib/vision';
import { evaluate } from './lib/rules';
import { compressFrame, downscaleImageData, utf8ByteLength } from './lib/compression';
import { buildPayload, buildReport, formatBytes } from './lib/reports';
import {
  processVideoFile,
  processFrameSequence,
  fetchGibsTimelapse,
  TIMELAPSE_PRESET
} from './lib/video';
import { fetchEonetLiveTile, fetchGoesRealtime } from './lib/live';
import { getSampleTile } from './lib/samples';
import { renderDetectionOverlay } from './lib/detection';
import {
  startWebcamStream,
  stopWebcamStream,
  captureWebcamFrame,
  paintToCanvas
} from './lib/webcam';
import type { ProcessingResult, RuntimeInfo } from './lib/types';

const STREAM_INTERVAL_MS = 30_000;
const WEBCAM_INTERVAL_MS = 1000;

export default function App() {
  const [, setRuntime] = useState<RuntimeInfo>(getRuntime());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [webcamActive, setWebcamActive] = useState(false);
  const [streamActive, setStreamActive] = useState(false);
  const [liveTag, setLiveTag] = useState<string | null>(null);

  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const webcamPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const webcamLoopRef = useRef<number | null>(null);
  const webcamFrameCount = useRef(0);
  const webcamProcessingRef = useRef(false);

  const streamLoopRef = useRef<number | null>(null);
  const streamFrameCount = useRef(0);
  const streamLastModified = useRef<string>('');
  const streamSkipCount = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const r = await initRuntime();
        setRuntime(r);
        preloadEurosat();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.emit(`runtime init failed: ${msg}`, 'critical');
      }
    })();
    return () => {
      stopWebcam();
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function processImageData(
    id: ImageData,
    rawBytes: number,
    sourceLabel: string,
    silent = false
  ) {
    const t0 = performance.now();
    const fa = await analyzeFrame(id, null);

    const rule = evaluate({ scores: fa.scores, scene: fa.scene, degradedNetwork: false });

    const detectionOverlayUrl = await renderDetectionOverlay(
      fa.sourceImageData,
      fa.detectionMask,
      fa.detections,
      { maxLabels: 6, labels: fa.detectionLabels, imageW: fa.width, imageH: fa.height }
    );

    const includesThumb =
      rule.decision === 'PRIORITY_DOWNLINK' || rule.decision === 'COMPRESSED_DOWNLINK';
    let thumbnailDataUrl: string | undefined;
    if (includesThumb) {
      const small = downscaleImageData(id, 256);
      const compressed = await compressFrame(small, 0.3);
      thumbnailDataUrl = compressed.dataUrl;
    }

    const payload = buildPayload({
      rule,
      scores: fa.scores,
      detections: fa.detections,
      inferenceMs: fa.inferenceMs,
      spectralMs: fa.spectralMs,
      rawBytes,
      thumbnailB64: thumbnailDataUrl?.split(',')[1],
      scene: fa.scene
    });
    const json = JSON.stringify(payload);
    const payloadBytes = utf8ByteLength(json);
    payload.payload_bytes = payloadBytes;
    payload.compression_ratio = rawBytes > 0 ? 1 - payloadBytes / rawBytes : 0;
    const reportMd = buildReport(payload);
    const totalMs = performance.now() - t0;

    if (!silent) {
      log.emit(`${sourceLabel}`, 'info');
      log.emit(
        `cnn ${fa.inferenceMs.toFixed(0)}ms · spectral ${fa.spectralMs.toFixed(0)}ms · ${fa.detections.length} regions`,
        'info'
      );
      if (fa.scene) {
        log.emit(
          `scene: ${fa.scene.topClass} (conf ${fa.scene.confidence.toFixed(2)}, ${fa.scene.inferenceMs.toFixed(0)}ms)`,
          'info'
        );
      }
      log.emit(
        `${rule.rule} → ${rule.action}`,
        rule.priority === 'CRITICAL' ? 'critical' : rule.priority === 'HIGH' ? 'warn' : 'info'
      );
      log.emit(
        `${formatBytes(payloadBytes)} payload · ${(payload.compression_ratio * 100).toFixed(1)}% saved · ${Math.round(totalMs)}ms`,
        'ok'
      );
    }

    setResult({
      rule,
      scores: fa.scores,
      detections: fa.detections,
      inferenceMs: fa.inferenceMs,
      spectralMs: fa.spectralMs,
      rawBytes,
      payloadBytes,
      payload,
      reportMd,
      thumbnailDataUrl,
      detectionOverlayUrl,
      framesProcessed: 1,
      scene: fa.scene
    });

    return rule;
  }

  async function processFromUrl(
    url: string,
    forceRawBytes: number | undefined,
    sourceLabel: string,
    silent = false
  ) {
    const img = await loadImage(url);
    const rawBytes = forceRawBytes ?? (await estimateBytes(url));
    if (!silent) {
      log.emit(`raw input: ${img.naturalWidth}x${img.naturalHeight} · ${formatBytes(rawBytes)}`, 'info');
    }
    const id = imageToImageData(img);
    await processImageData(id, rawBytes, sourceLabel, silent);
  }

  async function processVideoUrl(url: string, isTimelapse: boolean) {
    setResult(null);
    const t0 = performance.now();
    let videoResult;
    let rawBytes: number;

    if (isTimelapse) {
      const tl = await fetchGibsTimelapse(TIMELAPSE_PRESET);
      rawBytes = tl.rawBytes;
      videoResult = await processFrameSequence(tl.frames, {
        degradedNetwork: false,
        labels: tl.labels
      });
    } else {
      rawBytes = await estimateBytes(url);
      log.emit(`raw input: ${formatBytes(rawBytes)}`, 'info');
      videoResult = await processVideoFile(url, { sampleHz: 1, degradedNetwork: false, maxFrames: 12 });
    }

    const best = videoResult.bestFrame;
    const rule = evaluate({ scores: best.scores, scene: best.scene, degradedNetwork: false });
    log.emit(
      `best of ${videoResult.framesProcessed} frames: ${rule.action}`,
      rule.priority === 'CRITICAL' ? 'critical' : 'info'
    );

    const detectionOverlayUrl = await renderDetectionOverlay(
      best.sourceImageData,
      best.detectionMask,
      best.detections,
      { maxLabels: 6, labels: best.detectionLabels, imageW: best.width, imageH: best.height }
    );

    const includesThumb =
      rule.decision === 'PRIORITY_DOWNLINK' || rule.decision === 'COMPRESSED_DOWNLINK';
    let thumbnailDataUrl: string | undefined;
    if (includesThumb && videoResult.bestImageData) {
      const small = downscaleImageData(videoResult.bestImageData, 256);
      const compressed = await compressFrame(small, 0.3);
      thumbnailDataUrl = compressed.dataUrl;
    }

    const payload = buildPayload({
      rule,
      scores: best.scores,
      detections: best.detections,
      inferenceMs: best.inferenceMs,
      spectralMs: best.spectralMs,
      rawBytes,
      thumbnailB64: thumbnailDataUrl?.split(',')[1],
      scene: best.scene
    });
    const json = JSON.stringify(payload);
    const payloadBytes = utf8ByteLength(json);
    payload.payload_bytes = payloadBytes;
    payload.compression_ratio = rawBytes > 0 ? 1 - payloadBytes / rawBytes : 0;
    const reportMd = buildReport(payload);
    const totalMs = performance.now() - t0;

    log.emit(
      `${formatBytes(payloadBytes)} payload · ${(payload.compression_ratio * 100).toFixed(1)}% saved · ${Math.round(totalMs)}ms`,
      'ok'
    );

    setResult({
      rule,
      scores: best.scores,
      detections: best.detections,
      inferenceMs: best.inferenceMs,
      spectralMs: best.spectralMs,
      rawBytes,
      payloadBytes,
      payload,
      reportMd,
      thumbnailDataUrl,
      detectionOverlayUrl,
      framesProcessed: videoResult.framesProcessed,
      scene: best.scene
    });
  }

  async function startWebcam() {
    if (streamActive) stopStream();
    try {
      log.emit('starting webcam · requesting permission…', 'info');
      const stream = await startWebcamStream();
      webcamStreamRef.current = stream;
      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = stream;
        try {
          await webcamVideoRef.current.play();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.emit(`autoplay note: ${msg}`, 'warn');
        }
      }
      setWebcamActive(true);
      webcamFrameCount.current = 0;
      setLiveTag('LIVE WEBCAM');
      log.emit('webcam live · 1 Hz inference', 'ok');

      const tick = async () => {
        if (webcamProcessingRef.current) return;
        webcamProcessingRef.current = true;
        try {
          const id = await captureWebcamFrame(
            webcamVideoRef.current!,
            webcamStreamRef.current
          );
          if (id) {
            // Mirror the captured frame to the visible canvas so the user
            // always sees what BELTO is processing — even on Linux where
            // the <video> element can be black on V4L2 backends.
            if (webcamPreviewCanvasRef.current) {
              paintToCanvas(webcamPreviewCanvasRef.current, id);
            }
            webcamFrameCount.current++;
            const rawBytes = id.width * id.height * 3;
            await processImageData(id, rawBytes, `webcam #${webcamFrameCount.current}`, true);
            setLiveTag(`LIVE WEBCAM · frame ${webcamFrameCount.current}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.emit(`webcam tick error: ${msg}`, 'warn');
        } finally {
          webcamProcessingRef.current = false;
        }
      };
      setTimeout(tick, 600);
      webcamLoopRef.current = window.setInterval(tick, WEBCAM_INTERVAL_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.emit(`webcam unavailable: ${msg}`, 'critical');
      setWebcamActive(false);
      setLiveTag(null);
    }
  }

  function stopWebcam() {
    if (webcamLoopRef.current) {
      clearInterval(webcamLoopRef.current);
      webcamLoopRef.current = null;
    }
    stopWebcamStream(webcamStreamRef.current);
    webcamStreamRef.current = null;
    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }
    if (webcamActive) log.emit('webcam stopped', 'info');
    setWebcamActive(false);
    setLiveTag(null);
  }

  async function startStream() {
    if (webcamActive) stopWebcam();
    setStreamActive(true);
    streamFrameCount.current = 0;
    streamLastModified.current = '';
    streamSkipCount.current = 0;
    setLiveTag('STREAMING GOES');
    log.emit('GOES stream live · poll every 30s · NOAA refreshes every 5 min', 'ok');

    const tick = async () => {
      try {
        const tile = await fetchGoesRealtime({ silent: true });
        if (tile.date && tile.date === streamLastModified.current) {
          streamSkipCount.current++;
          if (streamSkipCount.current === 1 || streamSkipCount.current % 5 === 0) {
            log.emit(
              `tile unchanged (${tile.date}) · ${streamSkipCount.current} skip${streamSkipCount.current > 1 ? 's' : ''} · waiting for next refresh`,
              'info'
            );
          }
          setLiveTag(`STREAMING · awaiting new frame (${streamSkipCount.current})`);
          return;
        }
        streamLastModified.current = tile.date;
        streamSkipCount.current = 0;
        streamFrameCount.current++;
        log.emit(`new GOES frame · ${tile.date}`, 'ok');
        await processFromUrl(
          tile.blobUrl,
          tile.rawBytes,
          `GOES #${streamFrameCount.current} · ${tile.date}`,
          false
        );
        setLiveTag(`STREAMING · frame ${streamFrameCount.current}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.emit(`stream error: ${msg}`, 'warn');
      }
    };
    await tick();
    streamLoopRef.current = window.setInterval(tick, STREAM_INTERVAL_MS);
  }

  function stopStream() {
    if (streamLoopRef.current) {
      clearInterval(streamLoopRef.current);
      streamLoopRef.current = null;
    }
    if (streamActive) log.emit('GOES stream stopped', 'info');
    setStreamActive(false);
    setLiveTag(null);
  }

  function wrap<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
    return async (...args: T) => {
      if (busy) return;
      if (webcamActive) stopWebcam();
      if (streamActive) stopStream();
      setBusy(true);
      try {
        await fn(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.emit(`error: ${msg}`, 'critical');
      } finally {
        setBusy(false);
      }
    };
  }

  const handleSample = wrap(async (id: string) => {
    const tile = await getSampleTile(id);
    await processFromUrl(tile.url, tile.rawBytes, tile.sample.label);
  });

  const handleUploadImage = wrap(async (url: string) => {
    await processFromUrl(url, undefined, 'uploaded image');
  });

  const handleVideo = wrap(async (url: string, isTimelapse: boolean) => {
    await processVideoUrl(url, isTimelapse);
  });

  const handleLiveTile = wrap(async () => {
    const tile = await fetchEonetLiveTile();
    await processFromUrl(tile.blobUrl, tile.rawBytes, tile.sourceLabel);
  });

  const handleGoesOnce = wrap(async () => {
    const tile = await fetchGoesRealtime();
    await processFromUrl(tile.blobUrl, tile.rawBytes, tile.sourceLabel);
  });

  function onWebcamToggle() {
    if (webcamActive) stopWebcam();
    else startWebcam();
  }
  function onStreamToggle() {
    if (streamActive) stopStream();
    else startStream();
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header liveBadge={liveTag} />
      <main className="flex-1 grid grid-cols-12 gap-4 p-4 min-h-0">
        <div className="col-span-3 min-h-0">
          <InputPanel
            busy={busy}
            webcamActive={webcamActive}
            streamActive={streamActive}
            webcamVideoRef={webcamVideoRef}
            webcamPreviewCanvasRef={webcamPreviewCanvasRef}
            onWebcamToggle={onWebcamToggle}
            onStreamToggle={onStreamToggle}
            onGoesOnce={handleGoesOnce}
            onLiveTile={handleLiveTile}
            onSample={handleSample}
            onTimelapse={() => handleVideo('', true)}
            onUploadImage={handleUploadImage}
            onUploadVideo={url => handleVideo(url, false)}
          />
        </div>
        <div className="col-span-4 min-h-0">
          <LogPanel />
        </div>
        <div className="col-span-5 min-h-0">
          <OutputPanel result={result} busy={busy} liveTag={liveTag} />
        </div>
      </main>
    </div>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

async function estimateBytes(url: string): Promise<number> {
  try {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const r = await fetch(url);
      const b = await r.blob();
      return b.size;
    }
    const r = await fetch(url, { method: 'HEAD' });
    const len = r.headers.get('content-length');
    if (len) return parseInt(len, 10);
    const r2 = await fetch(url);
    const b = await r2.blob();
    return b.size;
  } catch {
    return 0;
  }
}
