/**
 * Inversion of a polarized LSS spectrum: least-squares fit against a table of
 * precomputed Mie spectra.
 *
 *   ΔI(λ)  ≈  Σ_k c_k · T_k(λ)  +  smooth baseline,     c_k ≥ 0
 *
 * T_k is the Mie spectrum of one nucleus of diameter d_k; c_k is the number of
 * such nuclei under the probe. The slowly varying part (a cubic polynomial in
 * λ) is projected out of both the data and the table: the size information
 * lives in the fringes, whose frequency in 1/λ is 2·n·d.
 *
 * The non-negative least-squares problem is solved greedily (matching pursuit,
 * the "CLEAN" of radio astronomy): repeatedly pick the table spectrum whose
 * single-component least-squares fit to the residual is best, and subtract a
 * fraction of it. The loop stops at the photon-noise floor, so noise is never
 * turned into nuclei.
 */

export interface Dictionary {
  /** diameters of the table rows, µm */
  d: Float32Array;
  /** detrended, unit-norm spectra, row-major [K × M] */
  A: Float64Array;
  /** norm of each detrended table spectrum (signal of one nucleus) */
  norm: Float64Array;
  /** Gram matrix AᵀA, row-major [K × K] */
  G: Float64Array;
  /** orthonormal polynomial basis, row-major [P × M] */
  Q: Float64Array;
  K: number;
  M: number;
  P: number;
}

export interface FitResult {
  /** number of nuclei per table diameter, length K */
  c: Float32Array;
  /** fitted spectrum (model + baseline), length M */
  model: Float32Array;
  /** total number of nuclei found, Σ c_k */
  count: number;
  /** number-weighted mean diameter, µm (NaN if nothing was detected) */
  meanD: number;
  /** number-weighted standard deviation, µm */
  sdD: number;
  /** fraction of detected nuclei larger than ENLARGED_UM */
  enlarged: number;
  /** residual norm / detrended data norm (0 = perfect fit) */
  misfit: number;
  /** strongest single-nucleus fringe amplitude in units of the noise σ */
  snr: number;
}

/** Nuclei above this diameter count as "enlarged" (the group's papers use ~10 µm). */
export const ENLARGED_UM = 8.5;

const POLY_DEGREE = 3;
const LOOP_GAIN = 0.7;
const MAX_ITER = 300;
/** Stop when the best remaining component is below this many noise σ … */
const NOISE_STOP = 3;
/** … or below this fraction of the first (strongest) component. */
const DYNAMIC_STOP = 0.06;
/** Nothing is reported unless the strongest component exceeds this many σ. */
const DETECTION_SNR = 4.5;

/** Orthonormal polynomials (degree 0..deg) on M equispaced samples (modified Gram–Schmidt). */
export function polyBasis(M: number, deg: number): Float64Array {
  const P = deg + 1;
  const Q = new Float64Array(P * M);
  for (let p = 0; p < P; p++) {
    for (let i = 0; i < M; i++) Q[p * M + i] = Math.pow((2 * i) / (M - 1) - 1, p);
    for (let q = 0; q < p; q++) {
      let dot = 0;
      for (let i = 0; i < M; i++) dot += Q[p * M + i] * Q[q * M + i];
      for (let i = 0; i < M; i++) Q[p * M + i] -= dot * Q[q * M + i];
    }
    let nrm = 0;
    for (let i = 0; i < M; i++) nrm += Q[p * M + i] ** 2;
    nrm = Math.sqrt(nrm);
    for (let i = 0; i < M; i++) Q[p * M + i] /= nrm;
  }
  return Q;
}

/** out = v − Q Qᵀ v ; returns the polynomial coefficients Qᵀ v. */
function detrend(v: ArrayLike<number>, Q: Float64Array, P: number, M: number, out: Float64Array, off = 0): Float64Array {
  const coef = new Float64Array(P);
  for (let p = 0; p < P; p++) {
    let dot = 0;
    for (let i = 0; i < M; i++) dot += v[i] * Q[p * M + i];
    coef[p] = dot;
  }
  for (let i = 0; i < M; i++) {
    let s = v[i];
    for (let p = 0; p < P; p++) s -= coef[p] * Q[p * M + i];
    out[off + i] = s;
  }
  return coef;
}

/**
 * @param d  table diameters (µm)
 * @param T  table spectra, row-major [K × M]
 */
export function buildDictionary(d: Float32Array, T: Float32Array, M: number): Dictionary {
  const K = d.length;
  const P = POLY_DEGREE + 1;
  const Q = polyBasis(M, POLY_DEGREE);
  const A = new Float64Array(K * M);
  const norm = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    detrend(T.subarray(k * M, (k + 1) * M), Q, P, M, A, k * M);
    let n = 0;
    for (let i = 0; i < M; i++) n += A[k * M + i] ** 2;
    n = Math.sqrt(n);
    norm[k] = n;
    for (let i = 0; i < M; i++) A[k * M + i] /= n;
  }
  const G = new Float64Array(K * K);
  for (let a = 0; a < K; a++) {
    for (let b = a; b < K; b++) {
      let s = 0;
      const oa = a * M, ob = b * M;
      for (let i = 0; i < M; i++) s += A[oa + i] * A[ob + i];
      G[a * K + b] = s;
      G[b * K + a] = s;
    }
  }
  return { d, A, norm, G, Q, K, M, P };
}

/**
 * Fit one measured ΔI spectrum.
 * @param y      ΔI(λ), same units as the dictionary table
 * @param sigma  1-σ noise per spectral channel (same units); 0 for noiseless data
 */
export function fitSpectrum(dict: Dictionary, y: ArrayLike<number>, sigma: number): FitResult {
  const { K, M, P, A, G, Q, d, norm } = dict;
  const yd = new Float64Array(M);
  const coef = detrend(y, Q, P, M, yd);
  let ynorm = 0;
  for (let i = 0; i < M; i++) ynorm += yd[i] * yd[i];

  // r_k = <a_k, residual>: amplitude of the best single-component fit for each row.
  const r = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    let s = 0;
    const o = k * M;
    for (let i = 0; i < M; i++) s += A[o + i] * yd[i];
    r[k] = s;
  }

  const amp = new Float64Array(K);
  let first = 0;
  for (let it = 0; it < MAX_ITER; it++) {
    let kb = -1, vb = 0;
    for (let k = 0; k < K; k++) if (r[k] > vb) { vb = r[k]; kb = k; }
    if (kb < 0) break;
    if (it === 0) {
      first = vb;
      if (vb < DETECTION_SNR * sigma) break;
    }
    if (vb < NOISE_STOP * sigma || vb < DYNAMIC_STOP * first) break;
    const g = LOOP_GAIN * vb;
    amp[kb] += g;
    const o = kb * K;
    for (let k = 0; k < K; k++) r[k] -= g * G[o + k];
  }

  const c = new Float32Array(K);
  const model = new Float32Array(M);
  const md = new Float64Array(M);
  let count = 0, s1 = 0, s2 = 0, big = 0;
  for (let k = 0; k < K; k++) {
    if (amp[k] <= 0) continue;
    const o = k * M;
    for (let i = 0; i < M; i++) md[i] += amp[k] * A[o + i];
    const ck = amp[k] / norm[k];
    c[k] = ck;
    count += ck;
    s1 += ck * d[k];
    s2 += ck * d[k] * d[k];
    if (d[k] > ENLARGED_UM) big += ck;
  }
  let res = 0;
  for (let i = 0; i < M; i++) {
    res += (yd[i] - md[i]) ** 2;
    let base = 0;
    for (let p = 0; p < P; p++) base += coef[p] * Q[p * M + i];
    model[i] = md[i] + base;
  }
  const meanD = count > 0 ? s1 / count : NaN;
  return {
    c,
    model,
    count,
    meanD,
    sdD: count > 0 ? Math.sqrt(Math.max(0, s2 / count - meanD * meanD)) : NaN,
    enlarged: count > 0 ? big / count : NaN,
    misfit: ynorm > 0 ? Math.sqrt(res / ynorm) : 0,
    snr: sigma > 0 ? first / sigma : Infinity,
  };
}
