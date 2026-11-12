import { describe, expect, it } from 'vitest';
import { mie, qextAnomalousDiffraction } from './mie';

/** relative tolerance helper */
function close(actual: number, expected: number, rel: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * rel);
}

describe('Mie vs. published reference values', () => {
  // Bohren & Huffman (1983), Appendix A, sample output of BHMIE:
  // sphere radius 0.525 µm, n = 1.55, in vacuum, λ = 0.6328 µm.
  it('Bohren & Huffman Appendix A example (x = 5.2128, m = 1.55)', () => {
    const x = (2 * Math.PI * 0.525) / 0.6328;
    const r = mie(x, 1.55, 0);
    close(x, 5.2128, 1e-4);
    close(r.qsca, 3.10543, 2e-6);
    close(r.qext, 3.10543, 2e-6);
    close(r.qback, 2.92534, 2e-6);
  });

  // W. J. Wiscombe, "Mie scattering calculations: advances in technique and
  // fast, vector-speed computer codes", NCAR/TN-140+STR (1979), test cases
  // (also Wiscombe, Appl. Opt. 19, 1505 (1980)). Columns: m, x, Qext, Qsca, g.
  const wiscombe: [number, number, number, number, number, number][] = [
    // non-absorbing, m < 1 (bubble-like)
    [0.75, 0, 0.099, 7.417859e-6, 7.417859e-6, 0.001448],
    [0.75, 0, 0.101, 8.033538e-6, 8.033538e-6, 0.001507],
    [0.75, 0, 10, 2.232265, 2.232265, 0.896473],
    [0.75, 0, 1000, 1.997908, 1.997908, 0.844944],
    // non-absorbing glass-like sphere
    [1.5, 0, 10, 2.881999, 2.881999, 0.742913],
    [1.5, 0, 100, 2.094388, 2.094388, 0.818246],
    [1.5, 0, 1000, 2.013945, 2.013945, 0.827882],
    // weakly absorbing water-like sphere
    [1.33, 1e-5, 1, 0.093952, 0.093923, 0.184517],
    [1.33, 1e-5, 100, 2.101321, 2.096594, 0.868959],
    [1.33, 1e-5, 10000, 2.004089, 1.723857, 0.90784],
    // strongly absorbing
    [1.5, 1, 0.055, 0.101491, 1.131687e-5, 0.000491],
    [1.5, 1, 0.056, 0.103347, 1.216311e-5, 0.000509],
    [1.5, 1, 1, 2.336321, 0.663454, 0.192136],
    [1.5, 1, 100, 2.097502, 1.283697, 0.850252],
    [1.5, 1, 10000, 2.004368, 1.236574, 0.84631],
    // metal-like
    [10, 10, 1, 2.532993, 2.049405, -0.110664],
    [10, 10, 100, 2.071124, 1.836785, 0.556215],
    [10, 10, 10000, 2.005914, 1.795393, 0.548194],
  ];
  for (const [mRe, mIm, x, qext, qsca, g] of wiscombe) {
    it(`Wiscombe: m = ${mRe}${mIm ? ` + ${mIm}i` : ''}, x = ${x}`, () => {
      const r = mie(x, mRe, mIm);
      close(r.qext, qext, 4e-6);
      close(r.qsca, qsca, 4e-6);
      // g is tabulated to 6 decimals
      expect(Math.abs(r.g - g)).toBeLessThan(1e-6);
    });
  }
});

describe('Mie: physical limits and internal consistency', () => {
  it('Rayleigh limit: Qsca = (8/3) x^4 |(m²-1)/(m²+2)|²', () => {
    const x = 0.01, m = 1.05;
    const r = mie(x, m);
    const k = (m * m - 1) / (m * m + 2);
    close(r.qsca, (8 / 3) * x ** 4 * k * k, 1e-3);
    // Rayleigh: Qback = 1.5 Qsca, g -> 0
    close(r.qback, 1.5 * r.qsca, 1e-3);
    expect(Math.abs(r.g)).toBeLessThan(1e-4);
  });

  it('soft large sphere follows van de Hulst anomalous diffraction (nucleus regime)', () => {
    // nucleus-like: m = 1.04, d = 5..12 µm at 400-800 nm in n = 1.36 -> x ~ 25..130
    for (const x of [30, 50, 80, 130]) {
      const r = mie(x, 1.04);
      expect(Math.abs(r.qext - qextAnomalousDiffraction(x, 1.04))).toBeLessThan(0.15);
    }
  });

  it('non-absorbing sphere: Qext = Qsca', () => {
    for (const x of [0.5, 7, 42.3, 150]) {
      const r = mie(x, 1.05);
      close(r.qsca, r.qext, 1e-10);
    }
  });

  it('optical theorem: Qext = 4 Re S(0) / x²; and S1 = S2 forward, S1 = -S2 backward', () => {
    const x = 61.7, m = 1.045;
    const r = mie(x, m, 0, [1, -1]);
    close((4 / (x * x)) * r.s1re[0], r.qext, 1e-10);
    close(r.s2re[0], r.s1re[0], 1e-10);
    close(r.s2re[1], -r.s1re[1], 1e-9);
    close(r.s2im[1], -r.s1im[1], 1e-9);
    close((4 / (x * x)) * (r.s1re[1] ** 2 + r.s1im[1] ** 2), r.qback, 1e-9);
  });

  it('Qsca equals the angular integral of (|S1|²+|S2|²)/x²', () => {
    const x = 12.5, m = 1.2;
    // Gauss–Legendre would be nicer; a fine trapezoid in θ is enough here.
    const N = 20000;
    const mu = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) mu[i] = Math.cos((Math.PI * i) / N);
    const r = mie(x, m, 0, mu);
    let s = 0;
    for (let i = 0; i <= N; i++) {
      const th = (Math.PI * i) / N;
      const w = i === 0 || i === N ? 0.5 : 1;
      s += w * (r.s1re[i] ** 2 + r.s1im[i] ** 2 + r.s2re[i] ** 2 + r.s2im[i] ** 2) * Math.sin(th);
    }
    s *= Math.PI / N / (x * x);
    close(s, r.qsca, 1e-5);
  });
});
