/**
 * Procedural epithelium: a few thousand cells seen en face, with a hidden
 * dysplastic region whose nuclei are enlarged, pleomorphic and crowded.
 */
import { GRID_DYSPLASTIC, GRID_NORMAL, gaussian, gridDiameter, gridIndex, mulberry32 } from './physics/lss';

export const FIELD_W = 800; // µm
export const FIELD_H = 600; // µm

export const NORMAL_MEAN_UM = 5.5;
export const NORMAL_SD_UM = 0.45;
export const DYSPLASTIC_MEAN_UM = 10;
export const DYSPLASTIC_SD_UM = 1.3;

export interface Lesion {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rot: number;
  /** boundary modulation harmonics: [amplitude, phase] for k = 2, 3, 5 */
  harm: [number, number][];
}

export interface Tissue {
  seed: number;
  n: number;
  x: Float32Array;
  y: Float32Array;
  /** nuclear diameter, µm (on the Mie table grid) */
  d: Float32Array;
  /** 0 = normal, 1 = dysplastic */
  kind: Uint8Array;
  /** row of the nucleus in its Mie table */
  row: Uint16Array;
  lesions: Lesion[];
}

const HARMONICS = [2, 3, 5];

/** 1 at the lesion centre, 0 on its boundary, negative outside. */
export function lesionDepth(l: Lesion, x: number, y: number): number {
  const dx = x - l.cx, dy = y - l.cy;
  const c = Math.cos(l.rot), s = Math.sin(l.rot);
  const u = (dx * c + dy * s) / l.rx;
  const v = (-dx * s + dy * c) / l.ry;
  const rho = Math.hypot(u, v);
  const th = Math.atan2(v, u);
  let edge = 1;
  for (let i = 0; i < HARMONICS.length; i++) edge += l.harm[i][0] * Math.cos(HARMONICS[i] * th + l.harm[i][1]);
  return 1 - rho / edge;
}

/** Probability that a cell at (x, y) is dysplastic. */
export function dysplasiaProbability(lesions: Lesion[], x: number, y: number): number {
  let p = 0;
  for (const l of lesions) {
    const t = Math.max(0, Math.min(1, lesionDepth(l, x, y) / 0.3));
    p = Math.max(p, 0.92 * t * t * (3 - 2 * t));
  }
  return p;
}

/** Closed polygon tracing a lesion boundary (for the "reveal" overlay). */
export function lesionOutline(l: Lesion, nPts = 96): [number, number][] {
  const pts: [number, number][] = [];
  const c = Math.cos(l.rot), s = Math.sin(l.rot);
  for (let i = 0; i < nPts; i++) {
    const th = (2 * Math.PI * i) / nPts;
    let edge = 1;
    for (let k = 0; k < HARMONICS.length; k++) edge += l.harm[k][0] * Math.cos(HARMONICS[k] * th + l.harm[k][1]);
    const u = edge * Math.cos(th) * l.rx, v = edge * Math.sin(th) * l.ry;
    pts.push([l.cx + u * c - v * s, l.cy + u * s + v * c]);
  }
  return pts;
}

export function generateTissue(seed: number): Tissue {
  const rng = mulberry32(seed);
  const lesions: Lesion[] = [];
  const makeLesion = (rMin: number, rMax: number): Lesion => {
    const r = rMin + (rMax - rMin) * rng();
    const aspect = 0.65 + 0.5 * rng();
    const margin = r * 1.15 + 20;
    return {
      cx: margin + (FIELD_W - 2 * margin) * rng(),
      cy: margin + (FIELD_H - 2 * margin) * rng(),
      rx: r,
      ry: r * aspect,
      rot: Math.PI * rng(),
      harm: [
        [0.16 * rng(), 2 * Math.PI * rng()],
        [0.12 * rng(), 2 * Math.PI * rng()],
        [0.07 * rng(), 2 * Math.PI * rng()],
      ],
    };
  };
  lesions.push(makeLesion(95, 140));
  if (rng() < 0.35) {
    // occasional small satellite focus, away from the main lesion
    for (let tries = 0; tries < 20; tries++) {
      const s = makeLesion(40, 60);
      if (Math.hypot(s.cx - lesions[0].cx, s.cy - lesions[0].cy) > lesions[0].rx + s.rx + 80) {
        lesions.push(s);
        break;
      }
    }
  }

  // Poisson-disk sampling (Bridson) with a locally smaller spacing in the lesion.
  const spacing = (x: number, y: number) => 10.5 - 1.1 * dysplasiaProbability(lesions, x, y);
  const R_MIN = 9.4;
  const cell = R_MIN / Math.SQRT2;
  const gw = Math.ceil(FIELD_W / cell), gh = Math.ceil(FIELD_H / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const px: number[] = [], py: number[] = [];
  const active: number[] = [];
  const tryAdd = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= FIELD_W || y >= FIELD_H) return false;
    const r = spacing(x, y);
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let j = Math.max(0, gy - 2); j <= Math.min(gh - 1, gy + 2); j++) {
      for (let i = Math.max(0, gx - 2); i <= Math.min(gw - 1, gx + 2); i++) {
        const q = grid[j * gw + i];
        if (q >= 0 && Math.hypot(px[q] - x, py[q] - y) < r) return false;
      }
    }
    grid[gy * gw + gx] = px.length;
    active.push(px.length);
    px.push(x);
    py.push(y);
    return true;
  };
  tryAdd(FIELD_W * rng(), FIELD_H * rng());
  while (active.length) {
    const ai = Math.floor(rng() * active.length);
    const p = active[ai];
    const r = spacing(px[p], py[p]);
    let placed = false;
    for (let k = 0; k < 24; k++) {
      const a = 2 * Math.PI * rng();
      const rr = r * (1 + 0.6 * rng());
      if (tryAdd(px[p] + rr * Math.cos(a), py[p] + rr * Math.sin(a))) { placed = true; break; }
    }
    if (!placed) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }

  const n = px.length;
  const t: Tissue = {
    seed, n,
    x: Float32Array.from(px),
    y: Float32Array.from(py),
    d: new Float32Array(n),
    kind: new Uint8Array(n),
    row: new Uint16Array(n),
    lesions,
  };
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  for (let i = 0; i < n; i++) {
    const dys = rng() < dysplasiaProbability(lesions, px[i], py[i]);
    const g = gaussian(rng);
    if (dys) {
      const row = gridIndex(GRID_DYSPLASTIC, clamp(DYSPLASTIC_MEAN_UM + DYSPLASTIC_SD_UM * g, 7.2, 14));
      t.kind[i] = 1;
      t.row[i] = row;
      t.d[i] = gridDiameter(GRID_DYSPLASTIC, row);
    } else {
      const row = gridIndex(GRID_NORMAL, clamp(NORMAL_MEAN_UM + NORMAL_SD_UM * g, 4.2, 7.4));
      t.row[i] = row;
      t.d[i] = gridDiameter(GRID_NORMAL, row);
    }
  }
  return t;
}
