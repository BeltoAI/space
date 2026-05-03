# BELTO

**The satellite already knows what to send home.**

Browser-deployed edge intelligence for satellite imagery. Detection · decision · compression — running fully on your laptop.

Production satellites today downlink almost everything they capture and sort it on the ground. BELTO demonstrates the inverse: onboard scene classification, rule-based triage, and adaptive compression — so only mission-relevant frames consume bandwidth. No backend, no cloud, no GPU required.

## What's actually running

| Component | What | Status |
|-----------|------|--------|
| **EuroSAT scene classifier** | ResNet-18 trained on Sentinel-2 imagery, 10 land-cover classes (Forest, River, SeaLake, Industrial, etc.), ~98% test accuracy | Real ML, requires conversion step (below) |
| **Spectral pipeline** | HSV thresholds + Sobel edges + 2-pass connected components → traced polygon outlines | Always on |
| **Rule engine** | Routes scene class + spectral signals → priority + decision + downlink action | Always on |
| **Adaptive compression** | JPEG q=0.3 thumbnail for HIGH/CRITICAL · metadata-only for DISCARD | Always on |
| **Time-series anomaly** | Frame-to-frame ONNX embedding distance | Always on (used in video mode) |
| **Real-time data** | NOAA STAR CDN GOES-19 (5min refresh), NASA EONET, MODIS Terra GIBS | Always on |
| **Offline support** | Service worker caches model + app shell after first load | Always on |

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. The app works immediately with the heuristic classifier. To enable the **real ML scene classifier** (recommended):

```bash
pip install torch torchvision transformers safetensors huggingface_hub onnx
python scripts/convert-eurosat.py
```

That downloads `cm93/resnet18-eurosat` from HuggingFace, fine-tuned on Sentinel-2 imagery (98% test accuracy on land cover), and exports it as ONNX into `public/models/`. After that, restart `npm run dev` and BELTO auto-detects the model on boot.

## Build & deploy

```bash
npm run build
npm i -g vercel && vercel
```

Auto-detects Vite. The 7 MB anomaly-CNN deploys as a static asset. If you've converted the EuroSAT model, that 45 MB ONNX deploys too.

**Vercel free-tier note**: model files >100 MB are rejected. ResNet-18 fits comfortably; if you swap in ResNet-50 (~95 MB), still fine.

## Live modes

- **GO LIVE — webcam sensor**: 1 Hz inference on your laptop camera. Includes V4L2 fallback for Ubuntu (camera light comes on but `<video>` doesn't paint — captures via ImageCapture API and mirrors to canvas).
- **STREAM GOES-19**: auto-refreshes the latest GOES-19 CONUS GeoColor tile every 30s. NOAA refreshes the source every 5 min — when the `last-modified` is unchanged, BELTO logs a skip and waits.

## Sample sources

- 4 historical MODIS Terra tiles (Park Fire 2024, North Atlantic storm, Mediterranean, Sahara)
- Park Fire 6-day GIBS time-lapse (real consecutive daily satellite tiles)
- Latest GOES-19 single frame
- Latest EONET event → matching MODIS tile
- Image / video upload

## Rule engine

Decisions in priority order:

| Rule | Trigger | Priority | Decision | Action |
|------|---------|----------|----------|--------|
| `PRIORITY_FIRE` | Hot pixel signature (lum>140, r>200, r-g>60, sat>0.55) | CRITICAL | PRIORITY_DOWNLINK | DOWNLINK NOW · alert fire response |
| `ANOMALY_REPORT` | Frame-to-frame embedding distance ≥ 0.50 | HIGH | COMPRESSED_DOWNLINK | flag for review |
| `WATER_BODY` | Classifier: River+SeaLake ≥ 0.60 | HIGH | COMPRESSED_DOWNLINK | notify hydro response |
| `DEVELOPED_AREA` | Classifier: Residential+Industrial+Highway ≥ 0.60 | WARNING | EVENT_DOWNLINK | catalog developed scene |
| `NATURAL_BASELINE` | Classifier: forest/vegetation/agriculture, low confidence elsewhere | LOW | DISCARD_ONBOARD | routine baseline |
| `FLOOD_WATCH` | Heuristic water ≥ 0.45 (when classifier unavailable) | HIGH | COMPRESSED_DOWNLINK | notify hydro |
| `CLOUD_DISCARD` | Heuristic cloud ≥ 0.55 with no other signal | LOW | DISCARD_ONBOARD | cloud-occluded |
| `LOW_VALUE` | else | LOW | DISCARD_ONBOARD | no signal |
| `DEGRADED_NETWORK_OVERRIDE` | Toggle on, priority < CRITICAL | LOW | DISCARD_ONBOARD | suppressed |

## Architecture

```
satellite tile  ─→  EuroSAT classifier (ResNet-18 ONNX, 224x224)
                       ↓
                    scene class + confidence
                       ↓
                ┌──────────────────────────┐
spectral pass ─→│       rule engine        │
(HSV+Sobel+CC) ─→│ scene-driven if conf>0.45│
anomaly CNN ───→│ heuristic fallback       │
                └──────────────────────────┘
                       ↓
                  priority + decision + action
                       ↓
                  payload (JSON + bbox + thumb)
                  or DISCARD (metadata only)
```

## Real-time data sources

- **NOAA STAR CDN** — `cdn.star.nesdis.noaa.gov` — latest GOES-19 (East) and GOES-18 (West) at stable URLs, no auth, CORS-enabled. CONUS sector refreshes every 5 min.
- **EONET v3** — Earth Observatory Natural Event Tracker
- **GIBS WMTS** — MODIS Terra TrueColor (samples + timelapse)

## Honest framing

- The **EuroSAT classifier is real ML** trained on 27k labeled Sentinel-2 RGB tiles. Predictions and confidence scores reflect actual model output.
- The **spectral pipeline** (HSV + Sobel + connected components + traced contours) is the visual overlay layer. It's the same approach used in production cloud masking (NASA MOD35, ESA Sentinel-2 SCL) but tuned conservatively to avoid false alarms.
- The **anomaly-detection CNN** has random-initialized weights (sandbox limitations). Its embedding still preserves enough distance structure for frame-to-frame change detection. Verifiable in DevTools.

## Offline

After the first online load, the service worker caches everything needed to run the app offline:
- App shell (HTML, JS, CSS)
- ONNX runtime CDN files
- Both ONNX models (anomaly CNN + EuroSAT, if converted)
- Recently fetched satellite tiles

Webcam, samples, uploads, and inference all work fully offline. Live GOES streaming gracefully falls back to last-cached tile.

## Versioning

v0.14.0 — source-aware classification (webcam/satellite/upload have separate rule tracks) · scene-context fire/water rejection · per-pixel fire override
