import { log } from './logs';

const EONET_URL =
  'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=20&limit=30&category=wildfires,volcanoes,severeStorms,floods';

interface EonetEvent {
  id: string;
  title: string;
  categories: { id: string; title: string }[];
  geometry: { date: string; type: string; coordinates: number | number[] | number[][] }[];
}

export interface LiveTile {
  imageUrl: string;
  blobUrl: string;
  eventTitle: string;
  eventCategory: string;
  lat: number;
  lon: number;
  date: string;
  rawBytes: number;
  sourceLabel: string;
}

function pickLatestPoint(geom: EonetEvent['geometry']): { lat: number; lon: number; date: string } | null {
  for (let i = geom.length - 1; i >= 0; i--) {
    const g = geom[i];
    if (g.type === 'Point' && Array.isArray(g.coordinates) && typeof g.coordinates[0] === 'number') {
      const [lon, lat] = g.coordinates as number[];
      return { lat, lon, date: g.date.slice(0, 10) };
    }
  }
  return null;
}

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

// ============================================================
// EONET-based live tile
// ============================================================
export async function fetchEonetLiveTile(): Promise<LiveTile> {
  log.emit('querying NASA EONET for recent natural events…', 'info');
  const r = await fetch(EONET_URL);
  if (!r.ok) throw new Error(`EONET HTTP ${r.status}`);
  const data = await r.json();
  const events: EonetEvent[] = data.events || [];

  const wildfires = events.filter(e => e.categories.some(c => c.id === 'wildfires'));
  const candidates = wildfires.length > 0 ? wildfires : events;
  if (candidates.length === 0) throw new Error('no recent events available');

  let chosen: EonetEvent | null = null;
  let point: { lat: number; lon: number; date: string } | null = null;
  for (const ev of candidates) {
    const p = pickLatestPoint(ev.geometry);
    if (p) {
      chosen = ev;
      point = p;
      break;
    }
  }
  if (!chosen || !point) throw new Error('no point geometry found in events');

  log.emit(`event: ${chosen.title}`, 'ok');
  log.emit(`location: ${point.lat.toFixed(2)}°, ${point.lon.toFixed(2)}° · ${point.date}`, 'info');

  const z = 6;
  const { x, y } = lonLatToTileXY(point.lon, point.lat, z);
  const layer = 'MODIS_Terra_CorrectedReflectance_TrueColor';
  const dates = [point.date, shiftDate(point.date, -1), shiftDate(point.date, -2)];

  let blob: Blob | null = null;
  let usedDate = point.date;
  let usedUrl = '';
  for (const d of dates) {
    const tileUrl = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layer}/default/${d}/250m/${z}/${y}/${x}.jpg`;
    try {
      const res = await fetch(tileUrl);
      if (!res.ok) continue;
      blob = await res.blob();
      usedDate = d;
      usedUrl = tileUrl;
      break;
    } catch {}
  }
  if (!blob) throw new Error('no GIBS tile available for recent dates');

  const blobUrl = URL.createObjectURL(blob);
  log.emit(`tile fetched: ${(blob.size / 1024).toFixed(1)} KB · MODIS Terra ${usedDate}`, 'ok');

  return {
    imageUrl: usedUrl,
    blobUrl,
    eventTitle: chosen.title,
    eventCategory: chosen.categories[0]?.title || 'unknown',
    lat: point.lat,
    lon: point.lon,
    date: usedDate,
    rawBytes: blob.size,
    sourceLabel: `MODIS Terra · ${usedDate} · ${chosen.title}`
  };
}

// ============================================================
// REAL-TIME GOES via NOAA STAR CDN (stable URLs, no timestamp computation)
// ============================================================
interface GoesSource {
  url: string;
  label: string;
  cadence: string;
}

const GOES_SOURCES: GoesSource[] = [
  {
    url: 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/GEOCOLOR/1250x750.jpg',
    label: 'GOES-19 CONUS GeoColor',
    cadence: '5 min'
  },
  {
    url: 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR/1808x1808.jpg',
    label: 'GOES-19 Full Disk GeoColor',
    cadence: '10 min'
  },
  {
    url: 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/FD/GEOCOLOR/1808x1808.jpg',
    label: 'GOES-18 Full Disk (West Pacific)',
    cadence: '10 min'
  }
];

export async function fetchGoesRealtime(opts: { silent?: boolean } = {}): Promise<LiveTile> {
  const { silent } = opts;
  if (!silent) log.emit('fetching real-time GOES feed via NOAA STAR CDN…', 'info');

  let lastError = '';
  for (const src of GOES_SOURCES) {
    if (!silent) log.emit(`source: ${src.label} (${src.cadence} refresh)`, 'info');
    try {
      // Cache-bust to prevent browser from serving stale image when streaming
      const bustUrl = `${src.url}?_t=${Date.now()}`;
      const res = await fetch(bustUrl, { cache: 'no-store' });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const blob = await res.blob();
      if (blob.size < 5_000) {
        lastError = `tiny response (${blob.size} B)`;
        continue;
      }
      const blobUrl = URL.createObjectURL(blob);
      const lastModified = res.headers.get('last-modified') || `unknown-${Date.now()}`;
      if (!silent) {
        log.emit(`tile fetched: ${(blob.size / 1024).toFixed(1)} KB · last-modified: ${lastModified}`, 'ok');
      }
      return {
        imageUrl: src.url,
        blobUrl,
        eventTitle: src.label,
        eventCategory: 'real-time',
        lat: 0,
        lon: 0,
        date: lastModified,
        rawBytes: blob.size,
        sourceLabel: `${src.label} · ${lastModified}`
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  throw new Error(`real-time GOES unavailable: ${lastError}`);
}
