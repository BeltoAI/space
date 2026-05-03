import { log } from './logs';

export interface Sample {
  id: string;
  label: string;
  caption: string;
  /** Either a GIBS satellite tile or a bundled local asset */
  kind: 'gibs' | 'local';
  /** GIBS-only fields */
  lat?: number;
  lon?: number;
  z?: number;
  date?: string;
  layer?: string;
  /** Local-only field — path under /public */
  url?: string;
}

// ============================================================
// CURATED DEMO SAMPLES
//
// Mix of two source types:
//   1. GIBS satellite tiles — real MODIS Terra imagery, fetched at runtime
//   2. Local bundled assets — guaranteed-dramatic illustrations bundled in
//      the build, no fetch dependency
//
// The wildfire sample uses a bundled illustration so the demo can ALWAYS
// show a clear, unambiguous fire — the YC viewer instantly sees "fire"
// without satellite acquisition gambling.
// ============================================================
export const SAMPLES: Sample[] = [
  {
    id: 'wildfire',
    kind: 'local',
    label: 'Wildfire — forest fire (USFS)',
    caption: 'Active flame front engulfing pine forest',
    url: '/samples/wildfire.jpg'
  },
  {
    id: 'storm',
    kind: 'gibs',
    label: 'Hurricane Helene — Florida landfall',
    caption: 'Cat-4 hurricane spiral · 2024-09-26',
    lat: 28.0,
    lon: -83.0,
    z: 5,
    date: '2024-09-26',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor'
  },
  {
    id: 'storm-atlantic',
    kind: 'gibs',
    label: 'Storm system — North Atlantic',
    caption: 'Dense cloud cover over open ocean',
    lat: 50.0,
    lon: -30.0,
    z: 5,
    date: '2024-10-10',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor'
  },
  {
    id: 'desert',
    kind: 'gibs',
    label: 'Sahara — clear desert',
    caption: 'Cloud-free arid terrain · low value scene',
    lat: 23.0,
    lon: 12.0,
    z: 5,
    date: '2024-06-15',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor'
  }
];

const cache = new Map<string, { url: string; rawBytes: number }>();

function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const tilesX = 2 * Math.pow(2, z);
  const tilesY = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * tilesX);
  const y = Math.floor(((90 - lat) / 180) * tilesY);
  return {
    x: Math.max(0, Math.min(tilesX - 1, x)),
    y: Math.max(0, Math.min(tilesY - 1, y))
  };
}

function shiftDate(d: string, days: number): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function fetchLocalSample(sample: Sample): Promise<{ url: string; rawBytes: number }> {
  const url = sample.url!;
  await log.streamed(`fetching sample: ${sample.label}`, 'info', 30);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`local sample missing: ${url}`);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  await log.streamed(
    `loaded bundled asset: ${(blob.size / 1024).toFixed(1)} KB · ${url}`,
    'ok',
    30
  );
  return { url: objUrl, rawBytes: blob.size };
}

async function fetchGibsSample(sample: Sample): Promise<{ url: string; rawBytes: number }> {
  const { x, y } = lonLatToTileXY(sample.lon!, sample.lat!, sample.z!);
  await log.streamed(`fetching sample: ${sample.label}`, 'info', 30);

  const dateAttempts = [
    sample.date!,
    shiftDate(sample.date!, -1),
    shiftDate(sample.date!, 1),
    shiftDate(sample.date!, -2),
    shiftDate(sample.date!, 2)
  ];

  let blob: Blob | null = null;
  let usedDate = sample.date!;
  for (const d of dateAttempts) {
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${sample.layer}/default/${d}/250m/${sample.z}/${y}/${x}.jpg`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const b = await res.blob();
      if (b.size < 4000) continue;
      blob = b;
      usedDate = d;
      break;
    } catch {}
  }
  if (!blob) throw new Error(`GIBS tile unavailable for ${sample.label}`);

  const url = URL.createObjectURL(blob);
  await log.streamed(
    `tile fetched: ${(blob.size / 1024).toFixed(1)} KB · ${usedDate}`,
    'ok',
    30
  );
  return { url, rawBytes: blob.size };
}

export async function getSampleTile(
  id: string
): Promise<{ url: string; rawBytes: number; sample: Sample }> {
  const sample = SAMPLES.find(s => s.id === id);
  if (!sample) throw new Error(`unknown sample: ${id}`);

  const cached = cache.get(id);
  if (cached) return { ...cached, sample };

  const result = sample.kind === 'local'
    ? await fetchLocalSample(sample)
    : await fetchGibsSample(sample);

  cache.set(id, result);
  return { ...result, sample };
}
