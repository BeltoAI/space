import { log } from './logs';

export interface Sample {
  id: string;
  label: string;
  lat: number;
  lon: number;
  date: string;
  layer: string;
  caption: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'fire',
    label: 'Park Fire 2024 (CA)',
    lat: 40.0,
    lon: -121.6,
    date: '2024-07-26',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    caption: 'Park Fire, California — peak smoke plume'
  },
  {
    id: 'cloud',
    label: 'Storm system (N. Atlantic)',
    lat: 55.0,
    lon: -30.0,
    date: '2024-09-15',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    caption: 'North Atlantic dense storm clouds'
  },
  {
    id: 'water',
    label: 'Open water (Mediterranean)',
    lat: 36.0,
    lon: 17.0,
    date: '2024-07-10',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    caption: 'Central Mediterranean Sea, clear sky'
  },
  {
    id: 'terrain',
    label: 'Clear terrain (Sahara)',
    lat: 23.0,
    lon: 12.0,
    date: '2024-06-15',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    caption: 'Central Sahara, cloud-free desert'
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

export async function getSampleTile(
  id: string
): Promise<{ url: string; rawBytes: number; sample: Sample }> {
  const sample = SAMPLES.find(s => s.id === id);
  if (!sample) throw new Error(`unknown sample: ${id}`);

  const cached = cache.get(id);
  if (cached) return { ...cached, sample };

  const z = 6;
  const { x, y } = lonLatToTileXY(sample.lon, sample.lat, z);
  await log.streamed(`fetching sample: ${sample.label}`, 'info', 30);

  const dateAttempts = [
    sample.date,
    shiftDate(sample.date, -1),
    shiftDate(sample.date, -2),
    shiftDate(sample.date, 1),
    shiftDate(sample.date, 2)
  ];

  let blob: Blob | null = null;
  for (const d of dateAttempts) {
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${sample.layer}/default/${d}/250m/${z}/${y}/${x}.jpg`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      blob = await res.blob();
      break;
    } catch {}
  }
  if (!blob) throw new Error(`GIBS tile unavailable for ${sample.label}`);

  const url = URL.createObjectURL(blob);
  await log.streamed(`tile fetched: ${(blob.size / 1024).toFixed(1)} KB`, 'ok', 30);

  const result = { url, rawBytes: blob.size };
  cache.set(id, result);
  return { ...result, sample };
}
