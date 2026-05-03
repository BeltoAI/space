import type { VisionScores, RuleResult, SceneInfo, SourceMode } from './types';

export interface RuleContext {
  scores: VisionScores;
  scene?: SceneInfo | null;
  degradedNetwork: boolean;
  sourceMode: SourceMode;
}

function waterProb(scene: SceneInfo): number {
  let p = 0;
  for (const t of scene.top3) {
    if (t.cls === 'River' || t.cls === 'SeaLake') p += t.prob;
  }
  return p;
}

function developedProb(scene: SceneInfo): number {
  let p = 0;
  for (const t of scene.top3) {
    if (t.cls === 'Residential' || t.cls === 'Industrial' || t.cls === 'Highway') p += t.prob;
  }
  return p;
}

export function evaluate(ctx: RuleContext): RuleResult {
  const { scores, scene, degradedNetwork, sourceMode } = ctx;
  let result: RuleResult;

  // ============================================================
  // WEBCAM MODE — completely separate decision track.
  // Routes based on CNN anomaly signal (real-time edge inference) PLUS
  // strict fire detection (incandescent core + saturated halo + localized).
  // The vision pipeline already gates webcam fire on co-occurrence of
  // bright-core + warm-halo, so any nonzero fire score here is a confirmed
  // flame, not a red object false-positive.
  // ============================================================
  if (sourceMode === 'webcam') {
    if (scores.fire >= 0.005) {
      result = {
        rule: 'PRIORITY_FIRE',
        priority: 'CRITICAL',
        decision: 'COMPRESSED_DOWNLINK',
        reason: `incandescent fire signature detected on webcam feed (fire=${scores.fire.toFixed(3)})`,
        action: 'DOWNLINK NOW · alert fire response'
      };
    } else if (scores.anomaly >= 0.35) {
      result = {
        rule: 'EDGE_ANOMALY',
        priority: 'HIGH',
        decision: 'COMPRESSED_DOWNLINK',
        reason: `frame-to-frame change detected (anomaly=${scores.anomaly.toFixed(2)})`,
        action: 'COMPRESSED DOWNLINK · scene change'
      };
    } else if (scores.activity >= 0.20) {
      result = {
        rule: 'EDGE_ACTIVE',
        priority: 'LOW',
        decision: 'EVENT_DOWNLINK',
        reason: `edge node active · CNN inference + change detection running locally`,
        action: 'EDGE PROCESSING · routine telemetry'
      };
    } else {
      result = {
        rule: 'EDGE_IDLE',
        priority: 'LOW',
        decision: 'DISCARD_ONBOARD',
        reason: `edge node idle · no scene change detected`,
        action: 'DISCARD · no event'
      };
    }
    if (degradedNetwork && result.priority !== 'CRITICAL') {
      return {
        rule: 'DEGRADED_NETWORK_OVERRIDE',
        priority: 'LOW',
        decision: 'DISCARD_ONBOARD',
        reason: `degraded network mode suppresses non-critical (origin: ${result.rule})`,
        action: 'DISCARD · suppressed in degraded mode'
      };
    }
    return result;
  }

  // ============================================================
  // SATELLITE / UPLOAD MODE — full mission rule engine
  // ============================================================
  if (scores.fire >= 0.025) {
    result = {
      rule: 'PRIORITY_FIRE',
      priority: 'CRITICAL',
      decision: 'PRIORITY_DOWNLINK',
      reason: `hot pixel signature detected (fire=${scores.fire.toFixed(2)})`,
      action: 'DOWNLINK NOW · alert fire response'
    };
  }
  else if (scores.anomaly >= 0.50) {
    result = {
      rule: 'ANOMALY_REPORT',
      priority: 'HIGH',
      decision: 'COMPRESSED_DOWNLINK',
      reason: `scene anomaly vs previous frame (anomaly=${scores.anomaly.toFixed(2)})`,
      action: 'COMPRESSED DOWNLINK · flag for review'
    };
  }
  else if (scene && scene.confidence >= 0.45) {
    const w = waterProb(scene);
    const d = developedProb(scene);

    if (w >= 0.60) {
      result = {
        rule: 'WATER_BODY',
        priority: 'HIGH',
        decision: 'COMPRESSED_DOWNLINK',
        reason: `classifier: ${scene.topClass} (conf=${scene.confidence.toFixed(2)}, water=${w.toFixed(2)})`,
        action: 'COMPRESSED DOWNLINK · notify hydro response'
      };
    } else if (d >= 0.60) {
      result = {
        rule: 'DEVELOPED_AREA',
        priority: 'WARNING',
        decision: 'EVENT_DOWNLINK',
        reason: `classifier: ${scene.topClass} (conf=${scene.confidence.toFixed(2)})`,
        action: 'EVENT DOWNLINK · catalog developed scene'
      };
    } else {
      result = {
        rule: 'NATURAL_BASELINE',
        priority: 'LOW',
        decision: 'DISCARD_ONBOARD',
        reason: `classifier: ${scene.topClass} (conf=${scene.confidence.toFixed(2)}) · baseline scene`,
        action: 'DISCARD · routine vegetation/baseline'
      };
    }
  }
  // CLOUD_DISCARD comes BEFORE FLOOD_WATCH — many cloud-heavy scenes have
  // small dark patches that get misread as water otherwise.
  else if (scores.cloud >= 0.45 && scores.fire < 0.05) {
    result = {
      rule: 'CLOUD_DISCARD',
      priority: 'LOW',
      decision: 'DISCARD_ONBOARD',
      reason: `scene occluded by cloud (cloud=${scores.cloud.toFixed(2)})`,
      action: 'DISCARD · cloud-occluded'
    };
  }
  else if (scores.water >= 0.55) {
    // Large coherent water region — could be ocean, large lake, or flooding event
    result = {
      rule: 'WATER_BODY',
      priority: 'HIGH',
      decision: 'COMPRESSED_DOWNLINK',
      reason: `large water signature (water=${scores.water.toFixed(2)})`,
      action: 'COMPRESSED DOWNLINK · catalog water body'
    };
  } else {
    result = {
      rule: 'LOW_VALUE',
      priority: 'LOW',
      decision: 'DISCARD_ONBOARD',
      reason: scene
        ? `low-confidence classification (top=${scene.topClass} ${scene.confidence.toFixed(2)})`
        : 'no mission-relevant signal detected',
      action: 'DISCARD · no signal'
    };
  }

  if (degradedNetwork && result.priority !== 'CRITICAL') {
    return {
      rule: 'DEGRADED_NETWORK_OVERRIDE',
      priority: 'LOW',
      decision: 'DISCARD_ONBOARD',
      reason: `degraded network mode suppresses non-critical (origin: ${result.rule})`,
      action: 'DISCARD · suppressed in degraded mode'
    };
  }

  return result;
}

export function priorityRank(s: VisionScores): number {
  return Math.max(s.fire * 12, s.water * 7, s.anomaly * 6, s.activity * 3) - s.cloud * 2;
}
