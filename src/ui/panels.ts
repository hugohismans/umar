/** Spectrum + analysis panels, shared by the Microscope and Bench views. */
import { ENLARGED_UM } from '../physics/fit';
import { LAMBDA_MAX_NM, LAMBDA_MIN_NM } from '../physics/lss';
import type { Acquisition } from '../protocol';
import { HistPlot, INK, LinePlot } from './plot';

const HIST_LO = 4, HIST_HI = 14.5, HIST_STEP = 0.5;

export class Panels {
  private delta: LinePlot;
  private raw: LinePlot;
  private hist: HistPlot;
  private last: Acquisition | null = null;
  private dictD: Float32Array | null = null;
  showTruth = false;

  constructor(private root: HTMLElement) {
    const q = <T extends Element>(s: string) => root.querySelector(s) as T;
    this.delta = new LinePlot(q('[data-plot="delta"]'), {
      x0: LAMBDA_MIN_NM, x1: LAMBDA_MAX_NM, xLabel: 'wavelength (nm)', xUnit: 'nm', zero: true,
    });
    this.raw = new LinePlot(q('[data-plot="raw"]'), {
      x0: LAMBDA_MIN_NM, x1: LAMBDA_MAX_NM, xUnit: 'nm', zero: true, compact: true,
    });
    this.hist = new HistPlot(q('[data-plot="hist"]'));
  }

  setDictionary(d: Float32Array) {
    this.dictD = d;
  }

  setTruthVisible(v: boolean) {
    this.showTruth = v;
    this.root.classList.toggle('show-truth', v);
    if (this.last) this.update(this.last);
  }

  update(a: Acquisition) {
    this.last = a;
    this.delta.set([
      { label: 'ΔI measured', color: INK.blue, y: a.delta, width: 1.4 },
      { label: 'Mie fit', color: INK.orange, y: a.model, width: 1.6 },
    ]);
    this.raw.set([
      { label: 'I∥', color: INK.secondary, y: a.ipar, width: 1.3 },
      { label: 'I⊥', color: INK.muted, y: a.iperp, width: 1.3 },
    ]);

    const nb = Math.round((HIST_HI - HIST_LO) / HIST_STEP);
    const edges = Array.from({ length: nb + 1 }, (_, i) => HIST_LO + i * HIST_STEP);
    const bin = (d: number) => Math.max(0, Math.min(nb - 1, Math.floor((d - HIST_LO) / HIST_STEP + 1e-6)));
    const fit = new Array<number>(nb).fill(0);
    if (this.dictD && a.count > 0) {
      for (let k = 0; k < a.c.length; k++) if (a.c[k] > 0) fit[bin(this.dictD[k])] += a.c[k] / a.count;
    }
    let truth: number[] | null = null;
    let tw = 0, tm = 0, tBig = 0;
    for (let i = 0; i < a.truthD.length; i++) {
      tw += a.truthW[i];
      tm += a.truthW[i] * a.truthD[i];
      if (a.truthD[i] > ENLARGED_UM) tBig += a.truthW[i];
    }
    if (this.showTruth && tw > 0) {
      truth = new Array<number>(nb).fill(0);
      for (let i = 0; i < a.truthD.length; i++) truth[bin(a.truthD[i])] += a.truthW[i] / tw;
    }
    this.hist.set({ edges, fit, truth, threshold: ENLARGED_UM });

    const set = (k: string, v: string) => {
      const el = this.root.querySelector(`[data-stat="${k}"]`);
      if (el) el.textContent = v;
    };
    const found = a.count > 0;
    set('mean', found ? a.meanD.toFixed(1) : '–');
    set('sd', found ? a.sdD.toFixed(1) : '–');
    set('enlarged', found ? `${Math.round(a.enlarged * 100)}` : '–');
    set('count', found ? a.count.toFixed(0) : '0');
    set('truth-mean', tw > 0 ? (tm / tw).toFixed(1) : '–');
    set('truth-enlarged', tw > 0 ? `${Math.round((tBig / tw) * 100)}` : '–');
    set('truth-count', tw > 0 ? tw.toFixed(0) : '0');
    const verdict = this.root.querySelector('[data-stat="verdict"]') as HTMLElement | null;
    if (verdict) {
      const state = !found ? 'none' : a.enlarged >= 0.3 ? 'enlarged' : a.enlarged >= 0.1 ? 'mixed' : 'normal';
      verdict.dataset.state = state;
      verdict.textContent = {
        none: 'No fringes above the noise',
        normal: 'Normal-sized nuclei',
        mixed: 'Some enlarged nuclei',
        enlarged: 'Enlarged nuclei',
      }[state];
    }
  }
}

/** Markup of the two panels (identical in both views). */
export function panelsMarkup(): string {
  return `
  <section class="panel">
    <header class="panel-head">
      <h2>Spectrum</h2>
      <div class="legend">
        <span><i style="background:${INK.blue}"></i>ΔI = I∥ − I⊥</span>
        <span><i style="background:${INK.orange}"></i>Mie fit</span>
      </div>
    </header>
    <canvas class="plot plot-delta" data-plot="delta" aria-label="Polarization-gated backscattering spectrum and its Mie fit"></canvas>
    <div class="subhead">
      <span>Raw detector counts (photons / channel)</span>
      <div class="legend">
        <span><i style="background:${INK.secondary}"></i>I∥</span>
        <span><i style="background:${INK.muted}"></i>I⊥</span>
      </div>
    </div>
    <canvas class="plot plot-raw" data-plot="raw" aria-label="Raw co- and cross-polarized spectra"></canvas>
  </section>
  <section class="panel">
    <header class="panel-head">
      <h2>Analysis</h2>
      <div class="legend">
        <span><i class="sq" style="background:${INK.blue}"></i>retrieved</span>
        <span class="truth-only"><i class="ln" style="background:${INK.text}"></i>ground truth</span>
      </div>
    </header>
    <p class="verdict" data-stat="verdict" data-state="none">–</p>
    <canvas class="plot plot-hist" data-plot="hist" aria-label="Retrieved nuclear size distribution"></canvas>
    <dl class="stats">
      <div><dt>Mean diameter</dt><dd><b data-stat="mean">–</b> µm<small class="truth-only">truth <span data-stat="truth-mean">–</span></small></dd></div>
      <div><dt>Spread (s.d.)</dt><dd><b data-stat="sd">–</b> µm</dd></div>
      <div><dt>Enlarged (&gt; ${ENLARGED_UM} µm)</dt><dd><b data-stat="enlarged">–</b> %<small class="truth-only">truth <span data-stat="truth-enlarged">–</span></small></dd></div>
      <div><dt>Nuclei resolved</dt><dd><b data-stat="count">–</b><small class="truth-only">truth <span data-stat="truth-count">–</span></small></dd></div>
    </dl>
  </section>`;
}
