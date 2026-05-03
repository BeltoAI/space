import type { Detection, DetectionClass } from './types';

export const CLASS_BG = 0;
export const CLASS_FIRE = 1;
export const CLASS_CLOUD = 2;
export const CLASS_WATER = 3;
export const CLASS_VEGETATION = 4;
export const CLASS_TERRAIN = 5;

const CLASS_NAMES: Record<number, DetectionClass> = {
  [CLASS_FIRE]: 'fire',
  [CLASS_CLOUD]: 'cloud',
  [CLASS_WATER]: 'water',
  [CLASS_VEGETATION]: 'vegetation',
  [CLASS_TERRAIN]: 'terrain'
};

const COLORS: Record<DetectionClass, { stroke: string; fill: string; label: string }> = {
  fire:       { stroke: '#ff3b1c', fill: 'rgba(255, 60, 0, 0.18)',   label: '#fff'    },
  cloud:      { stroke: '#22d3ee', fill: 'rgba(34, 211, 238, 0.10)', label: '#0a0a0a' },
  water:      { stroke: '#fbbf24', fill: 'rgba(251, 191, 36, 0.10)', label: '#0a0a0a' },
  vegetation: { stroke: '#84cc16', fill: 'rgba(132, 204, 22, 0.08)', label: '#0a0a0a' },
  terrain:    { stroke: '#a78bfa', fill: 'rgba(167, 139, 250, 0.08)', label: '#0a0a0a' }
};

export interface ComponentResult {
  detections: Detection[];
  labels: Int32Array;
  rootByLabel: Map<number, number>;
}

export function findConnectedComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  minArea = 200
): ComponentResult {
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  let nextLabel = 1;

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = mask[i];
      if (c === CLASS_BG) continue;
      const leftIdx = x > 0 ? i - 1 : -1;
      const topIdx = y > 0 ? i - w : -1;
      const left = leftIdx >= 0 && mask[leftIdx] === c ? labels[leftIdx] : 0;
      const top = topIdx >= 0 && mask[topIdx] === c ? labels[topIdx] : 0;
      if (left && top) {
        labels[i] = Math.min(left, top);
        if (left !== top) union(left, top);
      } else if (left) {
        labels[i] = left;
      } else if (top) {
        labels[i] = top;
      } else {
        labels[i] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel++;
      }
    }
  }

  type Acc = { cls: number; x0: number; y0: number; x1: number; y1: number; area: number; root: number };
  const comps = new Map<number, Acc>();
  const rootByLabel = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] === 0) continue;
      const root = find(labels[i]);
      labels[i] = root;
      rootByLabel.set(root, root);
      let c = comps.get(root);
      if (!c) {
        c = { cls: mask[i], x0: x, y0: y, x1: x, y1: y, area: 0, root };
        comps.set(root, c);
      }
      if (x < c.x0) c.x0 = x;
      if (y < c.y0) c.y0 = y;
      if (x > c.x1) c.x1 = x;
      if (y > c.y1) c.y1 = y;
      c.area++;
    }
  }

  const detections: Detection[] = [];
  comps.forEach(c => {
    if (c.area < minArea) return;
    const name = CLASS_NAMES[c.cls];
    if (!name) return;
    detections.push({
      cls: name,
      x0: c.x0,
      y0: c.y0,
      x1: c.x1,
      y1: c.y1,
      area: c.area,
      imageW: w,
      imageH: h
    });
  });

  detections.sort((a, b) => b.area - a.area);
  return { detections, labels, rootByLabel };
}

// ============================================================
// Moore-Neighbor contour tracing (8-connected)
// ============================================================
const N8_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const N8_DY = [0, 1, 1, 1, 0, -1, -1, -1];

function isFg(labels: Int32Array, w: number, h: number, x: number, y: number, target: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  return labels[y * w + x] === target;
}

function traceContour(
  labels: Int32Array,
  w: number,
  h: number,
  startX: number,
  startY: number,
  target: number
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let cx = startX;
  let cy = startY;
  let prevDir = 6;
  const maxSteps = w * h * 4;
  let steps = 0;

  do {
    points.push({ x: cx, y: cy });
    const startSearch = (prevDir + 6) % 8;
    let found = false;
    for (let i = 0; i < 8; i++) {
      const dir = (startSearch + i) % 8;
      const nx = cx + N8_DX[dir];
      const ny = cy + N8_DY[dir];
      if (isFg(labels, w, h, nx, ny, target)) {
        cx = nx;
        cy = ny;
        prevDir = dir;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (++steps > maxSteps) break;
  } while (!(cx === startX && cy === startY) || points.length < 2);

  return points;
}

function simplifyContour(points: { x: number; y: number }[], stride: number): { x: number; y: number }[] {
  if (points.length <= stride * 2) return points;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  return out;
}

// Smooth contour points with a simple moving-average filter.
// Removes the staircase artifacts from pixel-accurate Moore-Neighbor tracing
// and produces nicer curved outlines for visual presentation.
function smoothContour(points: { x: number; y: number }[], passes = 2): { x: number; y: number }[] {
  if (points.length < 5) return points;
  let cur = points;
  for (let p = 0; p < passes; p++) {
    const next: { x: number; y: number }[] = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      // Wrap-around 5-tap average (closed contour)
      const im2 = (i - 2 + n) % n;
      const im1 = (i - 1 + n) % n;
      const ip1 = (i + 1) % n;
      const ip2 = (i + 2) % n;
      next.push({
        x: (cur[im2].x + 2 * cur[im1].x + 3 * cur[i].x + 2 * cur[ip1].x + cur[ip2].x) / 9,
        y: (cur[im2].y + 2 * cur[im1].y + 3 * cur[i].y + 2 * cur[ip1].y + cur[ip2].y) / 9
      });
    }
    cur = next;
  }
  return cur;
}

interface Contour {
  cls: DetectionClass;
  points: { x: number; y: number }[];
  area: number;
}

function findContoursForDetections(
  detections: Detection[],
  labels: Int32Array,
  w: number,
  h: number
): Contour[] {
  const out: Contour[] = [];
  for (const d of detections) {
    let target = 0;
    let startX = -1, startY = -1;
    outer: for (let y = d.y0; y <= d.y1; y++) {
      for (let x = d.x0; x <= d.x1; x++) {
        const v = labels[y * w + x];
        if (v !== 0) {
          target = v;
          startX = x;
          startY = y;
          break outer;
        }
      }
    }
    if (target === 0) continue;
    const pts = traceContour(labels, w, h, startX, startY, target);
    if (pts.length < 4) continue;
    const stride = pts.length > 800 ? 6 : pts.length > 300 ? 3 : 1;
    out.push({
      cls: d.cls,
      points: smoothContour(simplifyContour(pts, stride), 2),
      area: d.area
    });
  }
  return out;
}

// ============================================================
// Render with traced outlines
// ============================================================
interface RenderOpts {
  maxLabels?: number;
  labels?: Int32Array;
  imageW?: number;
  imageH?: number;
  excludeClasses?: DetectionClass[]; // visual filter — don't render these
  /** Show text labels on contours. Default false — colored outlines are
   *  unambiguous enough on their own and false labels are cosmetically worse
   *  than no labels. The legend chips in OutputPanel still show class summary. */
  showLabels?: boolean;
}

export async function renderDetectionOverlay(
  source: ImageData,
  _mask: Uint8Array,
  detections: Detection[],
  opts: RenderOpts = {}
): Promise<string> {
  const {
    maxLabels = 6,
    labels,
    imageW = source.width,
    imageH = source.height,
    excludeClasses = [],
    showLabels = false
  } = opts;
  const W = source.width;
  const H = source.height;

  const filtered = detections.filter(d => !excludeClasses.includes(d.cls));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(source, 0, 0);

  const contours: Contour[] = labels
    ? findContoursForDetections(filtered, labels, imageW, imageH)
    : [];

  for (const c of contours) {
    if (c.points.length < 3) continue;
    const colors = COLORS[c.cls];
    ctx.beginPath();
    ctx.moveTo(c.points[0].x + 0.5, c.points[0].y + 0.5);
    for (let i = 1; i < c.points.length; i++) {
      ctx.lineTo(c.points[i].x + 0.5, c.points[i].y + 0.5);
    }
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();
  }

  const lineWidth = Math.max(1.25, Math.round(W / 480));
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const c of contours) {
    if (c.points.length < 3) continue;
    const colors = COLORS[c.cls];
    ctx.beginPath();
    ctx.moveTo(c.points[0].x + 0.5, c.points[0].y + 0.5);
    for (let i = 1; i < c.points.length; i++) {
      ctx.lineTo(c.points[i].x + 0.5, c.points[i].y + 0.5);
    }
    ctx.closePath();
    ctx.strokeStyle = colors.stroke;
    ctx.stroke();
  }

  if (showLabels) {
    const labelFontSize = Math.max(11, Math.round(W / 70));
    ctx.font = `600 ${labelFontSize}px -apple-system, "Inter", system-ui, sans-serif`;
    ctx.textBaseline = 'top';

    const placedLabels: { x: number; y: number; w: number; h: number }[] = [];
    const labelable = filtered.slice(0, maxLabels);

    for (const d of labelable) {
      const colors = COLORS[d.cls];
      const text = d.cls.toUpperCase();
      const padX = 5;
      const padY = 3;
      const tw = ctx.measureText(text).width + padX * 2;
      const th = labelFontSize + padY * 2;

      const candidates = [
        { x: d.x0, y: d.y0 - th - 2 },
        { x: d.x0, y: d.y1 + 2 },
        { x: d.x0 + 2, y: d.y0 + 2 }
      ];
      let chosen = candidates[0];
      for (const c of candidates) {
        const fits =
          c.x >= 0 && c.x + tw <= W && c.y >= 0 && c.y + th <= H &&
          !placedLabels.some(p =>
            c.x < p.x + p.w && c.x + tw > p.x && c.y < p.y + p.h && c.y + th > p.y
          );
        if (fits) { chosen = c; break; }
      }
      placedLabels.push({ x: chosen.x, y: chosen.y, w: tw, h: th });

      roundRect(ctx, chosen.x, chosen.y, tw, th, 3);
      ctx.fillStyle = colors.stroke;
      ctx.fill();
      ctx.fillStyle = colors.label;
      ctx.fillText(text, chosen.x + padX, chosen.y + padY);
    }
  }

  return canvas.toDataURL('image/png');
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
