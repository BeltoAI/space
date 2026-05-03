import type { DownlinkPayload, VisionScores, RuleResult, Telemetry, Detection, SceneInfo } from './types';

const VERSION = '0.20.0';

export function buildTelemetry(): Telemetry {
  const now = new Date();
  const orbitMin = (now.getTime() / 1000 / 60) % 96;
  const lat = 60 * Math.sin((orbitMin / 96) * 2 * Math.PI);
  const lon = ((now.getTime() / 1000 / 60) % 360) - 180;
  const next = new Date(now.getTime() + 47 * 60 * 1000);
  return {
    sat_id: 'BELTO-01',
    norad_id: 99001,
    timestamp_utc: now.toISOString(),
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
    altitude_km: 547,
    sensor: 'BELTO-MSI-1',
    ground_station: 'KSAT-SVALBARD',
    next_downlink_window_utc: next.toISOString(),
    frame_id: `F-${now.getTime().toString(36).toUpperCase()}`
  };
}

export function buildPayload(args: {
  rule: RuleResult;
  scores: VisionScores;
  detections: Detection[];
  inferenceMs: number;
  spectralMs: number;
  rawBytes: number;
  thumbnailB64?: string;
  scene?: SceneInfo | null;
}): DownlinkPayload {
  const { rule, scores, detections, inferenceMs, spectralMs, rawBytes, thumbnailB64, scene } = args;
  const telemetry = buildTelemetry();
  const includeThumb =
    rule.decision === 'PRIORITY_DOWNLINK' || rule.decision === 'COMPRESSED_DOWNLINK';

  const payload: DownlinkPayload = {
    belto_version: VERSION,
    telemetry,
    decision: rule.decision,
    priority: rule.priority,
    rule_fired: rule.rule,
    reason: rule.reason,
    action: rule.action,
    vision_scores: scores,
    scene: scene ?? null,
    detections: detections.slice(0, 20).map(d => ({
      cls: d.cls,
      bbox: [d.x0, d.y0, d.x1, d.y1],
      area: d.area
    })),
    inference_ms: Math.round(inferenceMs * 100) / 100,
    spectral_ms: Math.round(spectralMs * 100) / 100,
    raw_bytes: rawBytes,
    payload_bytes: 0,
    compression_ratio: 0
  };

  if (includeThumb && thumbnailB64) {
    payload.thumbnail_b64 = thumbnailB64;
  }

  return payload;
}

export function buildReport(payload: DownlinkPayload): string {
  const s = payload.vision_scores;
  const dets = payload.detections
    .map(d => `- ${d.cls.toUpperCase()}: bbox=(${d.bbox.join(', ')}), area=${d.area} px`)
    .join('\n') || '- (none)';
  const sceneSection = payload.scene
    ? `## Scene Classification (EuroSAT ResNet-18)

**Top class:** ${payload.scene.topClass} (confidence ${payload.scene.confidence.toFixed(3)})

| Class | Probability |
|-------|-------------|
${payload.scene.top3.map(t => `| ${t.cls} | ${t.prob.toFixed(3)} |`).join('\n')}

`
    : '';
  return `# BELTO Edge Intelligence Report

**Frame:** \`${payload.telemetry.frame_id}\`
**Satellite:** ${payload.telemetry.sat_id} (NORAD ${payload.telemetry.norad_id})
**Sensor:** ${payload.telemetry.sensor}
**Position:** ${payload.telemetry.lat}°, ${payload.telemetry.lon}° @ ${payload.telemetry.altitude_km} km
**Timestamp:** ${payload.telemetry.timestamp_utc}

## Action

**${payload.action}**

- Priority: \`${payload.priority}\`
- Decision: \`${payload.decision}\`
- Rule fired: \`${payload.rule_fired}\`
- Reason: ${payload.reason}

${sceneSection}## Detections

${dets}

## Vision Scores

| Signal | Score |
|--------|-------|
| Fire | ${s.fire.toFixed(3)} |
| Cloud | ${s.cloud.toFixed(3)} |
| Water | ${s.water.toFixed(3)} |
| Vegetation | ${s.vegetation.toFixed(3)} |
| Terrain | ${s.terrain.toFixed(3)} |
| Activity | ${s.activity.toFixed(3)} |
| Anomaly | ${s.anomaly.toFixed(3)} |

## Edge Compute

- Inference: ${payload.inference_ms} ms
- Spectral analysis: ${payload.spectral_ms} ms
- Raw input: ${formatBytes(payload.raw_bytes)}
- Downlink payload: ${formatBytes(payload.payload_bytes)}
- Bandwidth saved: ${(payload.compression_ratio * 100).toFixed(2)}%

## Downlink

Ground station: ${payload.telemetry.ground_station}
Next contact: ${payload.telemetry.next_downlink_window_utc}
`;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}
