/// <reference lib="webworker" />
/**
 * Physics worker: builds the Mie tables, simulates acquisitions, runs the
 * inversion and the raster scan. Nothing here touches the DOM.
 */
import { buildDictionary, fitSpectrum, type Dictionary } from './physics/fit';
import {
  COLLECTION_HALF_ANGLE_DEG, COLLECTION_NODES, GRID_DICT, GRID_DYSPLASTIC, GRID_NORMAL, N_LAMBDA,
  buildTable, gaussian, gridDiameter, gridIndex, makeCollection, measure, mulberry32, sphereSpectrum,
} from './physics/lss';
import type { Acquisition, Request, Response, TissueMsg } from './protocol';
import { FIELD_H, FIELD_W } from './tissue';

/** Probe spot: Gaussian sensitivity profile, 1/e² intensity radius = 2σ. */
export const PROBE_SIGMA_UM = 13;
const PROBE_CUT = 2.5;
/** Nominal number of nuclei seen by the probe on normal tissue (sets the background level). */
const N_REF = 7;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: Response, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

const coll = makeCollection(COLLECTION_HALF_ANGLE_DEG, COLLECTION_NODES);
let tableN: Float32Array, tableD: Float32Array;
let dict: Dictionary;
let sRef = 1;
let tissue: TissueMsg | null = null;
// spatial hash of nuclei
const CELL = 40;
const GW = Math.ceil(FIELD_W / CELL), GH = Math.ceil(FIELD_H / CELL);
let buckets: Int32Array[] = [];
let scanId = -1;

function init() {
  const t0 = performance.now();
  const total = GRID_NORMAL.n + GRID_DYSPLASTIC.n + GRID_DICT.n;
  let done = 0;
  const tick = () => {
    done++;
    if (done % 8 === 0 || done === total) post({ type: 'progress', done, total });
  };
  tableN = buildTable(GRID_NORMAL, coll, tick);
  tableD = buildTable(GRID_DYSPLASTIC, coll, tick);
  const dictT = buildTable(GRID_DICT, coll, tick);
  const dictD = new Float32Array(GRID_DICT.n);
  for (let k = 0; k < GRID_DICT.n; k++) dictD[k] = gridDiameter(GRID_DICT, k);
  dict = buildDictionary(dictD, dictT, N_LAMBDA);
  // reference level: N_REF typical normal nuclei
  const r = gridIndex(GRID_NORMAL, 5.5) * N_LAMBDA;
  let mean = 0;
  for (let i = 0; i < N_LAMBDA; i++) mean += tableN[r + i] / N_LAMBDA;
  sRef = N_REF * mean;
  post({ type: 'ready', dictD: dictD.slice(), ms: performance.now() - t0, spheres: total });
}

function setTissue(t: TissueMsg) {
  tissue = t;
  const lists: number[][] = Array.from({ length: GW * GH }, () => []);
  for (let i = 0; i < t.x.length; i++) {
    lists[Math.min(GH - 1, Math.floor(t.y[i] / CELL)) * GW + Math.min(GW - 1, Math.floor(t.x[i] / CELL))].push(i);
  }
  buckets = lists.map((l) => Int32Array.from(l));
}

const S = new Float64Array(N_LAMBDA);

/** Noiseless single-scattering spectrum at a probe position; optionally records the nuclei involved. */
function probeSignal(px: number, py: number, truthD?: number[], truthW?: number[]) {
  S.fill(0);
  if (!tissue) return;
  const cut = PROBE_CUT * PROBE_SIGMA_UM;
  const i0 = Math.max(0, Math.floor((px - cut) / CELL)), i1 = Math.min(GW - 1, Math.floor((px + cut) / CELL));
  const j0 = Math.max(0, Math.floor((py - cut) / CELL)), j1 = Math.min(GH - 1, Math.floor((py + cut) / CELL));
  const inv = 1 / (2 * PROBE_SIGMA_UM * PROBE_SIGMA_UM);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const b = buckets[j * GW + i];
      for (let q = 0; q < b.length; q++) {
        const n = b[q];
        const dx = tissue.x[n] - px, dy = tissue.y[n] - py;
        const r2 = dx * dx + dy * dy;
        if (r2 > cut * cut) continue;
        const w = Math.exp(-r2 * inv);
        const T = tissue.kind[n] ? tableD : tableN;
        const o = tissue.row[n] * N_LAMBDA;
        for (let k = 0; k < N_LAMBDA; k++) S[k] += w * T[o + k];
        truthD?.push(tissue.d[n]);
        truthW?.push(w);
      }
    }
  }
}

function acquire(photons: number, seed: number, truthD: number[], truthW: number[]): Acquisition {
  const meas = measure(S, sRef, photons, mulberry32(seed));
  const fit = fitSpectrum(dict, meas.delta, meas.sigma);
  const delta = new Float32Array(N_LAMBDA), model = new Float32Array(N_LAMBDA);
  for (let i = 0; i < N_LAMBDA; i++) {
    delta[i] = meas.delta[i] / sRef;
    model[i] = fit.model[i] / sRef;
  }
  return {
    ipar: meas.ipar, iperp: meas.iperp, delta, model,
    sigma: meas.sigma / sRef,
    c: fit.c, count: fit.count, meanD: fit.meanD, sdD: fit.sdD, enlarged: fit.enlarged, snr: fit.snr,
    truthD: Float32Array.from(truthD), truthW: Float32Array.from(truthW),
  };
}

async function scan(id: number, nx: number, ny: number, photons: number, seed: number) {
  scanId = id;
  const t0 = performance.now();
  const rng = mulberry32(seed);
  for (let j = 0; j < ny; j++) {
    const meanD = new Float32Array(nx), enlarged = new Float32Array(nx), count = new Float32Array(nx);
    for (let i = 0; i < nx; i++) {
      probeSignal(((i + 0.5) * FIELD_W) / nx, ((j + 0.5) * FIELD_H) / ny);
      const meas = measure(S, sRef, photons, rng);
      const fit = fitSpectrum(dict, meas.delta, meas.sigma);
      meanD[i] = fit.meanD;
      enlarged[i] = fit.enlarged;
      count[i] = fit.count;
    }
    post({ type: 'scanRow', id, row: j, meanD, enlarged, count });
    // yield so that probe requests and cancellation get through
    await new Promise((r) => setTimeout(r, 0));
    if (scanId !== id) return;
  }
  post({ type: 'scanDone', id, ms: performance.now() - t0 });
}

const tmp = new Float32Array(N_LAMBDA);

ctx.onmessage = (e: MessageEvent<Request>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init();
      break;
    case 'tissue':
      scanId = -1;
      setTissue(msg);
      break;
    case 'probe': {
      const td: number[] = [], tw: number[] = [];
      probeSignal(msg.x, msg.y, td, tw);
      post({ type: 'probe', id: msg.id, ...acquire(msg.photons, msg.seed, td, tw) });
      break;
    }
    case 'scan':
      void scan(msg.id, msg.nx, msg.ny, msg.photons, msg.seed);
      break;
    case 'cancelScan':
      scanId = -1;
      break;
    case 'bench': {
      // exact Mie for every nucleus: no table, any index
      const rng = mulberry32(msg.seed);
      const td: number[] = [], tw: number[] = [];
      S.fill(0);
      for (let j = 0; j < msg.n; j++) {
        // first nucleus sits exactly at the mean so that a single nucleus follows the slider
        const z = j === 0 ? 0 : gaussian(rng);
        const d = Math.max(1, Math.min(18, msg.mean + msg.sd * z));
        sphereSpectrum(d, msg.m, coll, tmp);
        for (let k = 0; k < N_LAMBDA; k++) S[k] += tmp[k];
        td.push(d);
        tw.push(1);
      }
      post({ type: 'bench', id: msg.id, ...acquire(msg.photons, msg.seed ^ 0x9e3779b9, td, tw) });
      break;
    }
    case 'sphere': {
      const spectrum = sphereSpectrum(msg.d, msg.m, coll);
      post({ type: 'sphere', id: msg.id, d: msg.d, m: msg.m, spectrum });
      break;
    }
  }
};
