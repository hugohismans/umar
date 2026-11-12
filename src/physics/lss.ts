/**
 * Light-scattering-spectroscopy forward model.
 *
 * Polarization-gated single backscattering by epithelial nuclei, modelled as
 * homogeneous spheres (Backman et al., IEEE JSTQE 5, 1019 (1999); Gurjar et
 * al., Nat. Med. 7, 1245 (2001)):
 *
 *   I_par(λ)  = S(λ) + B(λ)/2      (co-polarized: single scattering + half
 *   I_perp(λ) =        B(λ)/2       of the depolarized diffuse background)
 *   ΔI(λ) = I_par - I_perp = S(λ)
 *
 * S(λ) is the incoherent sum over the nuclei under the probe of the Mie
 * "polarized residual" cross-section integrated over the collection cone.
 */
import { mie, type MieResult } from './mie';

/** Refractive index of the medium surrounding the nuclei (cytoplasm). */
export const N_MEDIUM = 1.36;

/** Spectrometer sampling: 400–800 nm. */
export const LAMBDA_MIN_NM = 400;
export const LAMBDA_MAX_NM = 800;
export const LAMBDA_STEP_NM = 1;
export const N_LAMBDA = Math.round((LAMBDA_MAX_NM - LAMBDA_MIN_NM) / LAMBDA_STEP_NM) + 1;
export const lambdaNm = (i: number) => LAMBDA_MIN_NM + i * LAMBDA_STEP_NM;

/** Gauss–Legendre nodes and weights on [a, b]. */
export function gaussLegendre(n: number, a: number, b: number): { x: Float64Array; w: Float64Array } {
  const x = new Float64Array(n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 1;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = z;
      for (let k = 2; k <= n; k++) {
        const p = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
        p0 = p1; p1 = p;
      }
      dp = (n * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x[i] = (a + b) / 2 + ((b - a) / 2) * z;
    w[i] = ((b - a) / 2) * (2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
}

/** Collection geometry: a cone of given half-angle centred on exact backscattering. */
export interface Collection {
  halfAngleDeg: number;
  /** cos θ at the quadrature nodes */
  mu: Float64Array;
  /** quadrature weights including sin θ dθ · 2π (solid angle) */
  w: Float64Array;
  scratch: MieResult;
}

export function makeCollection(halfAngleDeg: number, nNodes: number): Collection {
  const half = (halfAngleDeg * Math.PI) / 180;
  const q = gaussLegendre(nNodes, Math.PI - half, Math.PI);
  const mu = new Float64Array(nNodes);
  const w = new Float64Array(nNodes);
  for (let j = 0; j < nNodes; j++) {
    mu[j] = Math.cos(q.x[j]);
    w[j] = q.w[j] * Math.sin(q.x[j]) * 2 * Math.PI;
  }
  return {
    halfAngleDeg, mu, w,
    scratch: {
      qext: 0, qsca: 0, qabs: 0, qback: 0, g: 0,
      s1re: new Float64Array(nNodes), s1im: new Float64Array(nNodes),
      s2re: new Float64Array(nNodes), s2im: new Float64Array(nNodes),
    },
  };
}

/** Default instrument: 2.5° half-angle collection (in the medium). */
export const COLLECTION_HALF_ANGLE_DEG = 2.5;
export const COLLECTION_NODES = 6;

/**
 * Polarized residual cross-section (µm²) of one sphere:
 * power in (I_par − I_perp) scattered into the collection cone per unit
 * incident irradiance, for linearly polarized illumination and azimuthally
 * symmetric collection around the backward direction.
 *
 * With E_s = S2 cosφ θ̂ − S1 sinφ φ̂ and analyzers along the incident (x) and
 * crossed (y) directions, the azimuthal average gives
 *
 *   I_par − I_perp = (1/k²) [ ¼(|S1|² + cos²θ |S2|²) + ½ cosθ Re(S1 S2*) ]
 *
 * which reduces to |S1(180°)|²/k² at exact backscattering (S1 = −S2 there).
 *
 * @param dUm       sphere diameter, µm
 * @param lambdaUm  vacuum wavelength, µm
 * @param m         relative refractive index n_nucleus / n_medium
 */
export function polarizedBackscatter(dUm: number, lambdaUm: number, m: number, c: Collection): number {
  const k = (2 * Math.PI * N_MEDIUM) / lambdaUm;
  const r = mie((k * dUm) / 2, m, 0, c.mu, c.scratch);
  let s = 0;
  for (let j = 0; j < c.mu.length; j++) {
    const cth = c.mu[j];
    const a = r.s1re[j] * r.s1re[j] + r.s1im[j] * r.s1im[j];
    const b = r.s2re[j] * r.s2re[j] + r.s2im[j] * r.s2im[j];
    const re = r.s1re[j] * r.s2re[j] + r.s1im[j] * r.s2im[j];
    s += c.w[j] * (0.25 * (a + cth * cth * b) + 0.5 * cth * re);
  }
  return s / (k * k);
}

/** Spectrum (µm² per sphere) of a single diameter on the spectrometer grid. */
export function sphereSpectrum(dUm: number, m: number, c: Collection, out?: Float32Array): Float32Array {
  const o = out ?? new Float32Array(N_LAMBDA);
  for (let i = 0; i < N_LAMBDA; i++) o[i] = polarizedBackscatter(dUm, lambdaNm(i) * 1e-3, m, c);
  return o;
}

/* ------------------------------------------------------------------ */
/* Precomputed tables                                                  */
/* ------------------------------------------------------------------ */

/** A regular grid of sphere diameters at one relative refractive index. */
export interface SizeGrid {
  d0: number;
  step: number;
  n: number;
  m: number;
}

/** Normal epithelial nuclei. */
export const GRID_NORMAL: SizeGrid = { d0: 3.5, step: 0.02, n: 206, m: 1.04 };
/** Dysplastic nuclei: enlarged and hyperchromatic (denser chromatin, higher index). */
export const GRID_DYSPLASTIC: SizeGrid = { d0: 6.9, step: 0.02, n: 371, m: 1.05 };
/** Table used by the inversion: one nominal index, coarser diameter grid. */
export const GRID_DICT: SizeGrid = { d0: 4.0, step: 0.05, n: 211, m: 1.045 };

export const gridDiameter = (g: SizeGrid, i: number) => g.d0 + i * g.step;
export const gridIndex = (g: SizeGrid, d: number) =>
  Math.max(0, Math.min(g.n - 1, Math.round((d - g.d0) / g.step)));

/** Mie spectra for every diameter of a grid, row-major [n × N_LAMBDA], µm². */
export function buildTable(g: SizeGrid, c: Collection, onRow?: (row: number) => void): Float32Array {
  const T = new Float32Array(g.n * N_LAMBDA);
  for (let k = 0; k < g.n; k++) {
    sphereSpectrum(gridDiameter(g, k), g.m, c, T.subarray(k * N_LAMBDA, (k + 1) * N_LAMBDA));
    onRow?.(k);
  }
  return T;
}

/* ------------------------------------------------------------------ */
/* Measurement model                                                   */
/* ------------------------------------------------------------------ */

/** Ratio of diffuse background to single-scattering signal for a reference normal site. */
export const BACKGROUND_RATIO = 25;

/**
 * Spectral shape of the diffuse (multiply scattered, depolarized) background,
 * normalised to ~1. Smooth rise towards the red, with hemoglobin-like
 * absorption dips (Soret band and the two Q bands). Illustrative only: its
 * exact shape is irrelevant because polarization gating subtracts it.
 */
export function backgroundShape(lambdaNmValue: number): number {
  const g = (c: number, s: number) => Math.exp(-0.5 * ((lambdaNmValue - c) / s) ** 2);
  const u = (lambdaNmValue - 400) / 400;
  const scatter = 0.62 + 0.55 * Math.pow(u, 0.8);
  const absorb = 1.1 * g(415, 16) + 0.3 * g(542, 13) + 0.33 * g(577, 10);
  return scatter * Math.exp(-absorb);
}

export interface Measurement {
  /** detected photon counts, co- and cross-polarized */
  ipar: Float32Array;
  iperp: Float32Array;
  /** ΔI = I_par − I_perp converted back to table units (µm²) */
  delta: Float32Array;
  /** mean 1-σ photon noise of ΔI per channel, table units */
  sigma: number;
}

/** Standard normal deviate from a uniform generator. */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u < 1e-12) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Turn a noiseless single-scattering spectrum S(λ) (µm²) into a measurement.
 *
 * @param S          Σ over nuclei of their Mie spectra
 * @param sRef       reference signal level (µm²) setting the background scale
 * @param photons    detected background photons per spectral channel
 *                   (I_par + I_perp, at shape = 1); sets the shot noise
 */
export function measure(S: ArrayLike<number>, sRef: number, photons: number, rng: () => number): Measurement {
  const ipar = new Float32Array(N_LAMBDA);
  const iperp = new Float32Array(N_LAMBDA);
  const delta = new Float32Array(N_LAMBDA);
  const B0 = BACKGROUND_RATIO * sRef;
  const phi = photons / B0; // photons per µm² of cross-section
  let varSum = 0;
  for (let i = 0; i < N_LAMBDA; i++) {
    const half = 0.5 * B0 * backgroundShape(lambdaNm(i)) * phi;
    const meanPar = S[i] * phi + half;
    // Poisson statistics; counts are large, so the normal approximation is exact enough.
    const nPar = Math.max(0, meanPar + Math.sqrt(meanPar) * gaussian(rng));
    const nPerp = Math.max(0, half + Math.sqrt(half) * gaussian(rng));
    ipar[i] = nPar;
    iperp[i] = nPerp;
    delta[i] = (nPar - nPerp) / phi;
    varSum += meanPar + half;
  }
  return { ipar, iperp, delta, sigma: Math.sqrt(varSum / N_LAMBDA) / phi };
}

/** Small, fast seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
