export type Priority = 'CRITICAL' | 'HIGH' | 'WARNING' | 'LOW';

export type Decision =
  | 'PRIORITY_DOWNLINK'
  | 'COMPRESSED_DOWNLINK'
  | 'EVENT_DOWNLINK'
  | 'DISCARD_ONBOARD';

// What we can reliably distinguish from RGB true-color imagery.
// Smoke is intentionally absent — it is not separable from terrain in RGB.
export type DetectionClass = 'fire' | 'cloud' | 'water' | 'vegetation' | 'terrain';

export interface Detection {
  cls: DetectionClass;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  imageW: number;
  imageH: number;
}

export interface VisionScores {
  fire: number;
  cloud: number;
  water: number;
  vegetation: number;
  terrain: number;
  activity: number;
  anomaly: number;
}

// What kind of input we're processing. The classifier behaves differently for
// each — webcam frames don't trigger satellite-mission rules like FLOOD_WATCH.
export type SourceMode = 'satellite' | 'webcam' | 'upload';

export interface FrameAnalysis {
  scores: VisionScores;
  embedding: Float32Array | null;
  inferenceMs: number;
  spectralMs: number;
  width: number;
  height: number;
  detectionMask: Uint8Array;
  detectionLabels: Int32Array;
  detections: Detection[];
  sourceImageData: ImageData;
  scene?: SceneInfo | null;
  sourceMode: SourceMode;
}

export interface SceneInfo {
  topClass: string;
  confidence: number;
  top3: { cls: string; prob: number }[];
  inferenceMs: number;
}

export interface RuleResult {
  rule: string;
  priority: Priority;
  decision: Decision;
  reason: string;
  action: string;
}

export interface Telemetry {
  sat_id: string;
  norad_id: number;
  timestamp_utc: string;
  lat: number;
  lon: number;
  altitude_km: number;
  sensor: string;
  ground_station: string;
  next_downlink_window_utc: string;
  frame_id: string;
}

export interface DownlinkPayload {
  belto_version: string;
  telemetry: Telemetry;
  decision: Decision;
  priority: Priority;
  rule_fired: string;
  reason: string;
  action: string;
  vision_scores: VisionScores;
  scene?: SceneInfo | null;
  detections: { cls: DetectionClass; bbox: [number, number, number, number]; area: number }[];
  inference_ms: number;
  spectral_ms: number;
  raw_bytes: number;
  payload_bytes: number;
  compression_ratio: number;
  thumbnail_b64?: string;
}

export interface ProcessingResult {
  rule: RuleResult;
  scores: VisionScores;
  detections: Detection[];
  inferenceMs: number;
  spectralMs: number;
  rawBytes: number;
  payloadBytes: number;
  payload: DownlinkPayload;
  reportMd: string;
  thumbnailDataUrl?: string;
  detectionOverlayUrl?: string;
  framesProcessed: number;
  scene?: SceneInfo | null;
  sourceMode: SourceMode;
}

export interface RuntimeInfo {
  provider: 'webgpu' | 'wasm' | 'unavailable';
  modelLoaded: boolean;
  modelName: string;
  modelSizeMB: number;
}

export interface SessionMetrics {
  framesProcessed: number;
  criticalEvents: number;
  discarded: number;
  rawBytesAvoided: number;
  totalProcessingMs: number;
}
