import { describe, expect, it } from 'vitest';
import {
  GRID_DICT, N_LAMBDA, N_MEDIUM, buildTable, gaussLegendre, gaussian, gridDiameter, lambdaNm,
  makeCollection, measure, mulberry32, polarizedBackscatter, sphereSpectrum,
} from './lss';
import { ENLARGED_UM, buildDictionary, fitSpectrum } from './fit';
import { mie } from './mie';
import { generateTissue } from '../tissue';

const coll = makeCollection(2.5, 6);

describe('collection-cone kernel', () => {
  it('Gauss–Legendre integrates polynomials exactly', () => {
    const q = gaussLegendre(6, 0, 2);
    let s = 0;
    for (let i = 0; i < 6; i++) s += q.w[i] * q.x[i] ** 9;
    expect(s).toBeCloseTo(2 ** 10 / 10, 9);
  });

  it('tends to |S1(180°)|²/k² × solid angle for a vanishing cone', () => {
    const d = 6, lam = 0.55, m = 1.04;
    const tiny = makeCollection(0.02, 3);
    const k = (2 * Math.PI * N_MEDIUM) / lam;
    const x = (k * d) / 2;
    const dOmega = 2 * Math.PI * (1 - Math.cos((0.02 * Math.PI) / 180));
    const expected = (mie(x, m).qback * x * x) / 4 / (k * k) * dOmega;
    expect(polarizedBackscatter(d, lam, m, tiny) / expected).toBeCloseTo(1, 3);
  });

  it('quadrature over the cone is converged', () => {
    const fine = makeCollection(2.5, 24);
    for (const [d, lam] of [[5.5, 0.4], [10, 0.4], [14.3, 0.4], [10, 0.8]]) {
      const a = polarizedBackscatter(d, lam, 1.05, coll);
      const b = polarizedBackscatter(d, lam, 1.05, fine);
      expect(Math.abs(a - b) / b).toBeLessThan(1e-3);
    }
  });

  it('fringe count across 400–800 nm is 2·n_nucleus·d·Δ(1/λ)', () => {
    for (const d of [5.5, 10]) {
      const m = 1.045;
      const s = sphereSpectrum(d, m, coll);
      let mean = 0;
      for (const v of s) mean += v / N_LAMBDA;
      let crossings = 0;
      for (let i = 1; i < N_LAMBDA; i++) if ((s[i - 1] - mean) * (s[i] - mean) < 0) crossings++;
      const predicted = 2 * N_MEDIUM * m * d * (1 / 0.4 - 1 / 0.8);
      expect(Math.abs(crossings / 2 - predicted)).toBeLessThan(1.5);
    }
  });
});

describe('inversion against the Mie table', () => {
  const d = new Float32Array(GRID_DICT.n);
  for (let k = 0; k < GRID_DICT.n; k++) d[k] = gridDiameter(GRID_DICT, k);
  const dict = buildDictionary(d, buildTable(GRID_DICT, coll), N_LAMBDA);

  /** Spectrum of nuclei drawn off the table grid, at an index the table does not use. */
  function sample(mean: number, sd: number, n: number, m: number, seed: number) {
    const rng = mulberry32(seed);
    const S = new Float64Array(N_LAMBDA);
    const tmp = new Float32Array(N_LAMBDA);
    const sizes: number[] = [];
    for (let j = 0; j < n; j++) {
      const dd = mean + sd * gaussian(rng);
      sizes.push(dd);
      sphereSpectrum(dd, m, coll, tmp);
      for (let i = 0; i < N_LAMBDA; i++) S[i] += tmp[i];
    }
    return { S, trueMean: sizes.reduce((a, b) => a + b) / n, rng };
  }
  const sRef = 8 * 1.4e-5;

  it('recovers the size of a single nucleus to better than 0.1 µm', () => {
    for (const dd of [4.63, 6.18, 9.77, 12.41]) {
      const f = fitSpectrum(dict, sphereSpectrum(dd, 1.04, coll), 0);
      expect(Math.abs(f.meanD - dd)).toBeLessThan(0.1);
    }
  });

  it('normal population: mean within 0.3 µm, almost no enlarged nuclei', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { S, trueMean, rng } = sample(5.5, 0.45, 8, 1.04, seed);
      const meas = measure(S, sRef, 1e6, rng);
      const f = fitSpectrum(dict, meas.delta, meas.sigma);
      expect(Math.abs(f.meanD - trueMean)).toBeLessThan(0.3);
      expect(f.enlarged).toBeLessThan(0.1);
    }
  });

  it('dysplastic population: mean within 0.6 µm, mostly enlarged', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { S, trueMean, rng } = sample(10, 1.3, 8, 1.05, seed + 100);
      const meas = measure(S, sRef, 1e6, rng);
      const f = fitSpectrum(dict, meas.delta, meas.sigma);
      expect(Math.abs(f.meanD - trueMean)).toBeLessThan(0.6);
      expect(f.enlarged).toBeGreaterThan(0.7);
    }
  });

  it('pure photon noise is not turned into nuclei', () => {
    const rng = mulberry32(42);
    for (let t = 0; t < 20; t++) {
      const meas = measure(new Float64Array(N_LAMBDA), sRef, 1e5, rng);
      expect(fitSpectrum(dict, meas.delta, meas.sigma).count).toBe(0);
    }
  });

  it('measurement: ΔI is unbiased and σ matches the shot noise', () => {
    const S = new Float64Array(N_LAMBDA).fill(sRef);
    const meas = measure(S, sRef, 1e5, mulberry32(7));
    let mean = 0, v = 0;
    for (let i = 0; i < N_LAMBDA; i++) mean += meas.delta[i] / N_LAMBDA;
    for (let i = 0; i < N_LAMBDA; i++) v += (meas.delta[i] - mean) ** 2 / N_LAMBDA;
    expect(Math.abs(mean - sRef) / sRef).toBeLessThan(0.05);
    expect(Math.sqrt(v) / meas.sigma).toBeGreaterThan(0.8);
    expect(Math.sqrt(v) / meas.sigma).toBeLessThan(1.2);
    expect(lambdaNm(0)).toBe(400);
  });
});

describe('tissue generator', () => {
  it('is deterministic, has a few thousand cells and a minority of enlarged nuclei', () => {
    const a = generateTissue(123), b = generateTissue(123);
    expect(a.n).toBe(b.n);
    expect(Array.from(a.d.slice(0, 50))).toEqual(Array.from(b.d.slice(0, 50)));
    expect(a.n).toBeGreaterThan(2500);
    expect(a.n).toBeLessThan(8000);
    let big = 0;
    for (let i = 0; i < a.n; i++) if (a.d[i] > ENLARGED_UM) big++;
    expect(big / a.n).toBeGreaterThan(0.02);
    expect(big / a.n).toBeLessThan(0.3);
  });
});
