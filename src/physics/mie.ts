/**
 * Lorenz–Mie scattering by a homogeneous sphere.
 *
 * TypeScript port of BHMIE (Bohren & Huffman, "Absorption and Scattering of
 * Light by Small Particles", Wiley 1983, Appendix A), with the usual
 * refinements of B. T. Draine's revision (asymmetry parameter, safer NMX).
 *
 * Conventions (Bohren & Huffman):
 *   x  = 2π a n_medium / λ_vacuum      size parameter (a = radius)
 *   m  = n_sphere / n_medium           relative refractive index (complex,
 *                                      positive imaginary part = absorption)
 *   S1, S2                             amplitude functions; the scattered
 *                                      irradiance for unit incident irradiance
 *                                      is |S|² / (k r)² with k = 2π n_medium/λ
 *   Qext, Qsca, Qback                  efficiencies (cross-section / πa²);
 *                                      Qback = 4 |S1(180°)|² / x²
 *   g                                  asymmetry parameter <cos θ>
 */

export interface MieResult {
  qext: number;
  qsca: number;
  qabs: number;
  qback: number;
  g: number;
  /** Amplitude functions at the requested angles (same order as `mu`). */
  s1re: Float64Array;
  s1im: Float64Array;
  s2re: Float64Array;
  s2im: Float64Array;
}

// Scratch buffers for the logarithmic derivative D_n(mx); grown on demand.
let dRe = new Float64Array(512);
let dIm = new Float64Array(512);

/**
 * @param x    size parameter (> 0)
 * @param mRe  real part of the relative refractive index
 * @param mIm  imaginary part (>= 0 for an absorbing sphere)
 * @param mu   cosines of the scattering angles at which S1, S2 are wanted
 * @param out  optional result object to reuse (avoids allocations in hot loops)
 */
export function mie(
  x: number,
  mRe: number,
  mIm = 0,
  mu: ArrayLike<number> = [],
  out?: MieResult,
): MieResult {
  if (!(x > 0)) throw new RangeError('mie: size parameter must be > 0');
  const nang = mu.length;
  const res: MieResult =
    out && out.s1re.length === nang
      ? out
      : {
          qext: 0, qsca: 0, qabs: 0, qback: 0, g: 0,
          s1re: new Float64Array(nang), s1im: new Float64Array(nang),
          s2re: new Float64Array(nang), s2im: new Float64Array(nang),
        };
  const { s1re, s1im, s2re, s2im } = res;
  s1re.fill(0); s1im.fill(0); s2re.fill(0); s2im.fill(0);

  // y = m x
  const yRe = mRe * x;
  const yIm = mIm * x;
  const yMod = Math.hypot(yRe, yIm);

  // Series terminated after NSTOP terms (Wiscombe's criterion as used in BHMIE).
  const nstop = Math.floor(x + 4 * Math.cbrt(x) + 2);
  // D_n is started well above both NSTOP and |mx|: the downward recurrence only
  // converges once n exceeds |mx| by a few |mx|^(1/3) (original BHMIE starts at
  // max(NSTOP, |mx|) + 15, which costs ~1e-4 accuracy for x >~ 100).
  const nmx = Math.floor(Math.max(nstop, yMod + 4.05 * Math.cbrt(yMod) + 2)) + 16;
  if (dRe.length < nmx + 1) {
    dRe = new Float64Array(nmx + 64);
    dIm = new Float64Array(nmx + 64);
  }

  // Logarithmic derivative D_n(y) by downward recurrence from D_nmx = 0:
  //   D_{n-1} = n/y - 1 / (D_n + n/y)
  const y2 = yRe * yRe + yIm * yIm;
  const iyRe = yRe / y2; // 1/y
  const iyIm = -yIm / y2;
  dRe[nmx] = 0;
  dIm[nmx] = 0;
  for (let n = nmx; n >= 1; n--) {
    const aRe = n * iyRe;
    const aIm = n * iyIm;
    const bRe = dRe[n] + aRe;
    const bIm = dIm[n] + aIm;
    const b2 = bRe * bRe + bIm * bIm;
    dRe[n - 1] = aRe - bRe / b2;
    dIm[n - 1] = aIm + bIm / b2;
  }

  // 1/m
  const m2 = mRe * mRe + mIm * mIm;
  const imRe = mRe / m2;
  const imIm = -mIm / m2;

  // Riccati–Bessel functions by upward recurrence.
  let psi0 = Math.cos(x);
  let psi1 = Math.sin(x);
  let chi0 = -Math.sin(x);
  let chi1 = Math.cos(x);

  // Angular functions pi_n, tau_n.
  const pi0 = new Float64Array(nang);
  const pi1 = new Float64Array(nang).fill(1);

  let sumSca = 0;
  let sumExt = 0;
  let sumG = 0;
  let backRe = 0; // Σ (2n+1)(-1)^n (a_n - b_n)
  let backIm = 0;
  let anRe = 0, anIm = 0, bnRe = 0, bnIm = 0;
  let an1Re = 0, an1Im = 0, bn1Re = 0, bn1Im = 0;
  let sign = 1;

  for (let n = 1; n <= nstop; n++) {
    const psi = ((2 * n - 1) / x) * psi1 - psi0;
    const chi = ((2 * n - 1) / x) * chi1 - chi0;
    // xi = psi - i chi ; xi1 = psi1 - i chi1
    const nx = n / x;

    // a_n = ((D/m + n/x) psi - psi1) / ((D/m + n/x) xi - xi1)
    let tRe = dRe[n] * imRe - dIm[n] * imIm + nx;
    let tIm = dRe[n] * imIm + dIm[n] * imRe;
    let numRe = tRe * psi - psi1;
    let numIm = tIm * psi;
    let denRe = tRe * psi + tIm * chi - psi1;
    let denIm = tIm * psi - tRe * chi + chi1;
    let den2 = denRe * denRe + denIm * denIm;
    an1Re = anRe; an1Im = anIm;
    anRe = (numRe * denRe + numIm * denIm) / den2;
    anIm = (numIm * denRe - numRe * denIm) / den2;

    // b_n = ((m D + n/x) psi - psi1) / ((m D + n/x) xi - xi1)
    tRe = dRe[n] * mRe - dIm[n] * mIm + nx;
    tIm = dRe[n] * mIm + dIm[n] * mRe;
    numRe = tRe * psi - psi1;
    numIm = tIm * psi;
    denRe = tRe * psi + tIm * chi - psi1;
    denIm = tIm * psi - tRe * chi + chi1;
    den2 = denRe * denRe + denIm * denIm;
    bn1Re = bnRe; bn1Im = bnIm;
    bnRe = (numRe * denRe + numIm * denIm) / den2;
    bnIm = (numIm * denRe - numRe * denIm) / den2;

    const tn = 2 * n + 1;
    const fn = tn / (n * (n + 1));
    sumSca += tn * (anRe * anRe + anIm * anIm + bnRe * bnRe + bnIm * bnIm);
    sumExt += tn * (anRe + bnRe);
    sumG += fn * (anRe * bnRe + anIm * bnIm);
    if (n > 1) {
      sumG += (((n - 1) * (n + 1)) / n) *
        (an1Re * anRe + an1Im * anIm + bn1Re * bnRe + bn1Im * bnIm);
    }
    sign = -sign;
    backRe += sign * tn * (anRe - bnRe);
    backIm += sign * tn * (anIm - bnIm);

    for (let j = 0; j < nang; j++) {
      const p = pi1[j];
      const tau = n * mu[j] * p - (n + 1) * pi0[j];
      s1re[j] += fn * (anRe * p + bnRe * tau);
      s1im[j] += fn * (anIm * p + bnIm * tau);
      s2re[j] += fn * (anRe * tau + bnRe * p);
      s2im[j] += fn * (anIm * tau + bnIm * p);
      // pi_{n+1}
      pi1[j] = ((2 * n + 1) * mu[j] * p - (n + 1) * pi0[j]) / n;
      pi0[j] = p;
    }

    psi0 = psi1; psi1 = psi;
    chi0 = chi1; chi1 = chi;
  }

  const x2 = x * x;
  res.qsca = (2 / x2) * sumSca;
  res.qext = (2 / x2) * sumExt;
  res.qabs = res.qext - res.qsca;
  res.qback = (backRe * backRe + backIm * backIm) / x2;
  res.g = (4 / (x2 * res.qsca)) * sumG;
  return res;
}

/** van de Hulst anomalous-diffraction extinction efficiency (real m, |m-1| << 1, x >> 1). */
export function qextAnomalousDiffraction(x: number, m: number): number {
  const rho = 2 * x * (m - 1);
  return 2 - (4 / rho) * Math.sin(rho) + (4 / (rho * rho)) * (1 - Math.cos(rho));
}
