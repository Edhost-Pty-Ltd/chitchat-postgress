#!/usr/bin/env node
/**
 * Generates the decorative face-mesh template used by <FaceMeshScan />.
 *
 *   node scripts/generate-face-mesh.mjs
 *
 * Output: src/data/faceMeshTemplate.ts (checked in, so the app does no
 * geometry work at runtime).
 *
 * IMPORTANT: this is a STYLISED TEMPLATE, not tracked landmarks. The face SDK
 * exposes no landmark data, so the mesh is drawn from a fixed, deterministic
 * layout: 468 points (the same count MediaPipe's FaceMesh uses) triangulated
 * with a Delaunay pass, plus 10 iris points. It never claims to follow the
 * user's real face.
 *
 * Pass --preview=<file.svg> to also write a standalone SVG for eyeballing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../src/data/faceMeshTemplate.ts');
const previewArg = process.argv.find((a) => a.startsWith('--preview='));

const TARGET_POINTS = 468;
const CX = 50;
const CY = 64;
const RX = 37;
const RY = 50;

// ── Deterministic PRNG ───────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(468478);

const smooth = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ── Face outline (0 = top, clockwise), resampled evenly by arc length ────────
function outlineAt(t) {
  const n = 2.25;
  const u = Math.sin(t);
  const v = -Math.cos(t);
  let x = RX * Math.sign(u) * Math.abs(u) ** (2 / n);
  const y = RY * Math.sign(v) * Math.abs(v) ** (2 / n);
  const yn = y / RY;
  if (yn > 0) x *= 1 - 0.36 * smooth(yn) ** 1.5; // taper to the chin
  else x *= 1 - 0.07 * smooth(-yn); // slightly narrower brow line
  return [CX + x, CY + y];
}

function resample(fn, count, samples = 1440) {
  const dense = [];
  for (let i = 0; i <= samples; i += 1) dense.push(fn((i / samples) * Math.PI * 2));
  const cum = [0];
  for (let i = 1; i < dense.length; i += 1) cum.push(cum[i - 1] + dist(dense[i], dense[i - 1]));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (k / count) * total;
    while (j < cum.length - 2 && cum[j + 1] < target) j += 1;
    const span = cum[j + 1] - cum[j] || 1;
    const f = (target - cum[j]) / span;
    out.push([
      dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f,
      dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f,
    ]);
  }
  return out;
}

const outline = resample(outlineAt, 40);
const innerRing = outline
  .filter((_, i) => i % 5 !== 0)
  .map(([x, y]) => [CX + (x - CX) * 0.8, CY + (y - CY) * 0.82]);

// ── Features ─────────────────────────────────────────────────────────────────
function eyeRing(cx, cy, a, up, low, n, side) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const th = (i / n) * Math.PI * 2;
    const s = Math.sin(th);
    const x = cx + a * Math.cos(th);
    let y = cy + (s < 0 ? up : low) * s;
    y += (x - cx) * 0.1 * side; // outer corner sits a little higher
    pts.push([x, y]);
  }
  return pts;
}
const scaleAbout = (pts, c, k) => pts.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]);

const EYE_L = [35.5, 58];
const EYE_R = [64.5, 58];
const eyeLOuter = eyeRing(EYE_L[0], EYE_L[1], 8.4, 3.6, 2.7, 14, 1);
const eyeROuter = eyeRing(EYE_R[0], EYE_R[1], 8.4, 3.6, 2.7, 14, -1);
const eyeLInner = scaleAbout(eyeLOuter, EYE_L, 0.5).filter((_, i) => i % 2 === 0);
const eyeRInner = scaleAbout(eyeROuter, EYE_R, 0.5).filter((_, i) => i % 2 === 0);

function browRows(side) {
  const upper = [];
  const lower = [];
  for (let i = 0; i < 6; i += 1) {
    const s = i / 5;
    const x = 47 - 23 * s;
    const y = 50.2 - 4.6 * Math.sin(Math.PI * s) + s * 1.2;
    const px = side === 1 ? x : 100 - x;
    upper.push([px, y - 1.7]);
    lower.push([px, y + 1.7]);
  }
  return { upper, lower };
}
const browL = browRows(1);
const browR = browRows(-1);

const nose = [
  [50, 53], [50, 59], [50, 65], [50, 71], [50, 77], [50, 82.6],
  [46.8, 60], [53.2, 60], [45.6, 67], [54.4, 67], [44.6, 74], [55.4, 74],
  [42.4, 81], [57.6, 81], [41.4, 78.2], [58.6, 78.2],
  [45.6, 85.6], [54.4, 85.6], [48, 87], [52, 87], [50, 88.4],
];

function lipRing(a, up, low, n) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const th = (i / n) * Math.PI * 2;
    const s = Math.sin(th);
    const bow = s < 0 ? 1 + 0.16 * Math.cos(2 * th) : 1;
    pts.push([50 + a * Math.cos(th), 96.6 + (s < 0 ? up * bow : low) * s]);
  }
  return pts;
}
const lipsOuter = lipRing(13.6, 4.4, 5.8, 20);
const lipsInner = lipRing(11.4, 0.9, 1.3, 12);

const chin = [[50, 108.5], [43.5, 106.5], [56.5, 106.5], [50, 112]];

const irisL = [EYE_L, ...[0, 1, 2, 3].map((i) => [EYE_L[0] + 2.7 * Math.cos((i * Math.PI) / 2), EYE_L[1] + 2.7 * Math.sin((i * Math.PI) / 2)])];
const irisR = [EYE_R, ...[0, 1, 2, 3].map((i) => [EYE_R[0] + 2.7 * Math.cos((i * Math.PI) / 2), EYE_R[1] + 2.7 * Math.sin((i * Math.PI) / 2)])];

// ── Point set ────────────────────────────────────────────────────────────────
const featurePts = [
  ...eyeLOuter, ...eyeROuter, ...eyeLInner, ...eyeRInner,
  ...browL.upper, ...browL.lower, ...browR.upper, ...browR.lower,
  ...nose, ...lipsOuter, ...lipsInner, ...chin,
];
const points = [...outline, ...innerRing, ...featurePts];

function inPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToPoly(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

// Fill the remaining skin with density-weighted best-candidate (Mitchell)
// sampling: each new point is the candidate farthest from its neighbours,
// relative to a local spacing that is tight around the eyes / nose / mouth and
// looser over forehead and cheeks. Always terminates at TARGET_POINTS.
const spacingAt = (p) => {
  let dFeat = Infinity;
  for (const q of featurePts) dFeat = Math.min(dFeat, dist(p, q));
  return Math.min(5.2, 2.2 + 0.13 * dFeat);
};
let attempts = 0;
while (points.length < TARGET_POINTS) {
  let best = null;
  let bestScore = -1;
  for (let c = 0; c < 48; c += 1) {
    attempts += 1;
    const p = [8 + rand() * 84, 10 + rand() * 108];
    if (!inPoly(p, outline) || distToPoly(p, outline) < 5.4) continue;
    if (inPoly(p, eyeLOuter) || inPoly(p, eyeROuter) || inPoly(p, lipsOuter)) continue;
    let nearest = Infinity;
    for (const q of points) nearest = Math.min(nearest, dist(p, q));
    const score = nearest / spacingAt(p);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best) points.push(best);
  if (attempts > 2_000_000) throw new Error('could not place all mesh points');
}

// ── Bowyer–Watson Delaunay ───────────────────────────────────────────────────
function delaunay(pts) {
  const n = pts.length;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const dm = Math.max(maxX - minX, maxY - minY) * 30;
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const all = [...pts, [mx - dm, my - dm], [mx, my + dm], [mx + dm, my - dm]];
  let tris = [[n, n + 1, n + 2]];
  const inCircle = (t, px, py) => {
    const [ax, ay] = all[t[0]]; const [bx, by] = all[t[1]]; const [cx, cy] = all[t[2]];
    const adx = ax - px; const ady = ay - py; const bdx = bx - px; const bdy = by - py; const cdx = cx - px; const cdy = cy - py;
    const det = (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy)
      - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady)
      + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
    const orient = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return orient > 0 ? det > 0 : det < 0;
  };
  for (let i = 0; i < n; i += 1) {
    const [px, py] = all[i];
    const bad = new Set();
    for (const t of tris) if (inCircle(t, px, py)) bad.add(t);
    const edgeCount = new Map();
    for (const t of bad) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    tris = tris.filter((t) => !bad.has(t));
    for (const [k, c] of edgeCount) {
      if (c !== 1) continue;
      const [a, b] = k.split(',').map(Number);
      tris.push([a, b, i]);
    }
  }
  return tris.filter((t) => t[0] < n && t[1] < n && t[2] < n);
}

const MAX_EDGE = 13.5;
const triangles = delaunay(points).filter((t) => {
  const [a, b, c] = t.map((i) => points[i]);
  const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
  if (!inPoly(centroid, outline)) return false;
  return Math.max(dist(a, b), dist(b, c), dist(c, a)) <= MAX_EDGE;
});

const edgeSet = new Set();
for (const [a, b, c] of triangles) {
  for (const [p, q] of [[a, b], [b, c], [c, a]]) edgeSet.add(p < q ? `${p},${q}` : `${q},${p}`);
}
const edges = [...edgeSet].map((k) => k.split(',').map(Number));

// ── Serialise to SVG path strings ────────────────────────────────────────────
const f = (v) => (Math.round(v * 10) / 10).toString();
const move = ([x, y]) => `M${f(x)} ${f(y)}`;
const line = ([x, y]) => `L${f(x)} ${f(y)}`;
const closed = (pts) => `${move(pts[0])}${pts.slice(1).map(line).join('')}Z`;
const open = (pts) => `${move(pts[0])}${pts.slice(1).map(line).join('')}`;

const edgePath = edges.map(([a, b]) => `${move(points[a])}${line(points[b])}`).join('');
const dotPath = [...points, ...irisL, ...irisR].map(([x, y]) => `M${f(x)} ${f(y)}h0`).join('');
const contourPath = [
  closed(outline),
  closed(eyeLOuter), closed(eyeROuter),
  open(browL.upper), open(browL.lower), open(browR.upper), open(browR.lower),
  closed(lipsOuter), closed(lipsInner),
  open([nose[0], nose[1], nose[2], nose[3], nose[4], nose[5]]),
].join('');
const irisCircle = (c) => {
  const [x, y] = c;
  return `M${f(x - 2.7)} ${f(y)}a2.7 2.7 0 1 0 5.4 0a2.7 2.7 0 1 0 -5.4 0`;
};
const irisPath = irisCircle(EYE_L) + irisCircle(EYE_R);
const silhouettePath = closed(outline);

const ts = `// GENERATED by scripts/generate-face-mesh.mjs — do not edit by hand.
//
// Stylised face-mesh TEMPLATE for <FaceMeshScan />. This is decoration: it does
// not follow the user's real face (the face SDK exposes no landmarks).
// ${points.length} mesh points + ${irisL.length + irisR.length} iris points, ${edges.length} edges.

export const FACE_MESH_VIEWBOX = '0 0 100 130';
export const FACE_MESH_POINT_COUNT = ${points.length};
export const FACE_MESH_IRIS_POINT_COUNT = ${irisL.length + irisR.length};
export const FACE_MESH_REFINED_POINT_COUNT = FACE_MESH_POINT_COUNT + FACE_MESH_IRIS_POINT_COUNT;
export const FACE_MESH_EDGE_COUNT = ${edges.length};
/** Triangulated surface (thin lines). */
export const FACE_MESH_EDGE_PATH = '${edgePath}';
/** Face oval, eyes, brows, lips, nose bridge (accent lines). */
export const FACE_MESH_CONTOUR_PATH = '${contourPath}';
/** Iris rings. */
export const FACE_MESH_IRIS_PATH = '${irisPath}';
/** Landmark dots (zero-length round-capped segments). */
export const FACE_MESH_DOT_PATH = '${dotPath}';
/** Filled head silhouette used behind the mesh when no photo is shown. */
export const FACE_MESH_SILHOUETTE_PATH = '${silhouettePath}';
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, ts);
console.log(`wrote ${OUT}: ${points.length}+10 points, ${edges.length} edges, ${triangles.length} triangles (${attempts} attempts)`);

if (previewArg) {
  const file = previewArg.split('=')[1];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-17 -2 134 134" width="1000" height="1000">
<rect x="-17" y="-2" width="134" height="134" fill="#050B16"/>
<path d="${silhouettePath}" fill="rgba(56,189,248,0.07)"/>
<path d="${edgePath}" stroke="#38BDF8" stroke-opacity="0.55" stroke-width="0.28" fill="none"/>
<path d="${contourPath}" stroke="#7DD3FC" stroke-width="0.6" fill="none" stroke-linejoin="round"/>
<path d="${irisPath}" stroke="#E0F2FE" stroke-width="0.5" fill="none"/>
<path d="${dotPath}" stroke="#E0F2FE" stroke-width="0.9" stroke-linecap="round" fill="none"/>
</svg>`;
  writeFileSync(file, svg);
  console.log(`preview: ${file}`);
}
