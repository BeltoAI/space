import type { VisionScores, RuleResult, SceneInfo } from './types';

export interface RuleContext {
  scores: VisionScores;
  scene?: SceneInfo | null;
  degradedNetwork: boolean;
}

// Aggregate scene-level water probability (River + SeaLake)
function waterProb(scene: SceneInfo): number {
  let p = 0;
  for (const t of scene.top3) {
    if (t.cls === 'River' || t.cls === 'SeaLake') p += t.prob;
  }
  return p;
}

// Aggregate developed/anthropogenic
function developedProb(scene: SceneInfo): number {
  let p = 0;
  for (const t of scene.top3) {
    if (t.cls === 'Residential' || t.cls === 'Industrial' || t.cls === 'Highway') p += t.prob;
  }
  return p;
}

export function evaluate(ctx: RuleContext): RuleResult {
  const { scores, scene, degradedNetwork } = ctx;
  let result: RuleResult;

  // FIRE — strict spectral signature; same as before. Scene classifier
  // doesn't have a "fire" class, so we keep the spectral check.
  if (scores.fire >= 0.06) {
    result = {
      rule: 'PRIORITY_FIRE',
      priority: 'CRITICAL',
      decision: 'PRIORITY_DOWNLINK',
      reason: `hot pixel signature detected (fire=${scores.fire.toFixed(2)})`,
      action: 'DOWNLINK NOW · alert fire response'
    };
  }
  // ANOMALY (video mode)
  else if (scores.anomaly >= 0.50) {
    result = {
      rule: 'ANOMALY_REPORT',
      priority: 'HIGH',
      decision: 'COMPRESSED_DOWNLINK',
      reason: `scene anomaly vs previous frame (anomaly=${scores.anomaly.toFixed(2)})`,
      action: 'COMPRESSED DOWNLINK · flag for review'
    };
  }
  // SCENE-DRIVEN routing — when classifier is loaded, prefer it over RGB heuristics
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
      // Forest, vegetation, agriculture etc. — natural baseline, low value
      result = {
        rule: 'NATURAL_BASELINE',
        priority: 'LOW',
        decision: 'DISCARD_ONBOARD',
        reason: `classifier: ${scene.topClass} (conf=${scene.confidence.toFixed(2)}) · baseline scene`,
        action: 'DISCARD · routine vegetation/baseline'
      };
    }
  }
  // FALLBACK — when classifier not loaded or low-confidence, use heuristic scores
  else if (scores.water >= 0.45) {
    result = {
      rule: 'FLOOD_WATCH',
      priority: 'HIGH',
      decision: 'COMPRESSED_DOWNLINK',
      reason: `large water signature (water=${scores.water.toFixed(2)})`,
      action: 'COMPRESSED DOWNLINK · notify hydro response'
    };
  } else if (
    scores.cloud >= 0.55 &&
    scores.fire < 0.05 &&
    scores.water < 0.20 &&
    scores.vegetation < 0.15
  ) {
    result = {
      rule: 'CLOUD_DISCARD',
      priority: 'LOW',
      decision: 'DISCARD_ONBOARD',
      reason: `scene occluded by cloud (cloud=${scores.cloud.toFixed(2)})`,
      action: 'DISCARD · cloud-occluded'
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
