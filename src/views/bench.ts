/** Bench: a handful of ideal nuclei, exact Mie computed live, sliders for everything. */
import { latest, type Physics } from '../client';
import { N_MEDIUM } from '../physics/lss';
import type { Acquisition } from '../protocol';
import { Panels, panelsMarkup } from '../ui/panels';

interface Params {
  mean: number;
  sd: number;
  n: number;
  m: number;
  logPhotons: number;
}

const PRESETS: Record<string, Params> = {
  single: { mean: 6, sd: 0, n: 1, m: 1.04, logPhotons: 7 },
  normal: { mean: 5.5, sd: 0.45, n: 8, m: 1.04, logPhotons: 6 },
  dysplastic: { mean: 10, sd: 1.3, n: 8, m: 1.05, logPhotons: 6 },
};

export class Bench {
  private p: Params = { ...PRESETS.single };
  private panels: Panels;
  private run: (p: Params) => void;
  private seed = 20010;

  constructor(private root: HTMLElement, physics: Physics, dictD: Float32Array) {
    const slider = (key: keyof Params, label: string, min: number, max: number, step: number) => `
      <label class="slider tall">
        <span>${label}</span>
        <input type="range" min="${min}" max="${max}" step="${step}" data-key="${key}" />
        <output data-out="${key}"></output>
      </label>`;
    root.innerHTML = `
    <div class="scope">
      <div class="tissue-col bench-col">
        <div class="bench-intro">
          <h1>Bench</h1>
          <p>A few ideal nuclei in the beam, no tissue. Every change recomputes exact Mie scattering for each nucleus,
          then runs the same acquisition and the same fit as the microscope.</p>
        </div>
        <div class="presets" role="group" aria-label="Presets">
          <button class="btn" data-preset="single">Single nucleus</button>
          <button class="btn" data-preset="normal">Normal epithelium</button>
          <button class="btn" data-preset="dysplastic">Dysplasia</button>
        </div>
        <div class="sliders">
          ${slider('mean', 'Nuclear diameter', 4, 14, 0.05)}
          ${slider('sd', 'Size spread (s.d.)', 0, 2, 0.05)}
          ${slider('n', 'Nuclei in the beam', 1, 30, 1)}
          ${slider('m', 'Relative index m', 1.02, 1.08, 0.002)}
          ${slider('logPhotons', 'Exposure', 2.5, 8, 0.25)}
        </div>
        <div class="controls">
          <button class="btn" data-el="redraw">Draw new nuclei</button>
        </div>
        <dl class="facts">
          <div><dt>Size parameter x at 400 / 800 nm</dt><dd data-fact="x"></dd></div>
          <div><dt>Fringes expected, 2·n·d·Δ(1/λ)</dt><dd data-fact="fringes"></dd></div>
          <div><dt>Index assumed by the fit</dt><dd>m = 1.045</dd></div>
        </dl>
      </div>
      <div class="panels-col">${panelsMarkup()}</div>
    </div>`;
    this.panels = new Panels(root.querySelector('.panels-col')!);
    this.panels.setDictionary(dictD);
    this.panels.setTruthVisible(true);

    this.run = latest(
      (p: Params) =>
        physics.request(
          { type: 'bench', id: physics.id(), mean: p.mean, sd: p.sd, n: p.n, m: p.m, photons: Math.pow(10, p.logPhotons), seed: this.seed },
          'bench',
        ),
      (res) => this.panels.update(res as Acquisition),
    );

    root.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => {
      inp.addEventListener('input', () => {
        (this.p[inp.dataset.key as keyof Params] as number) = parseFloat(inp.value);
        this.refresh();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        this.p = { ...PRESETS[b.dataset.preset!] };
        this.refresh();
      }),
    );
    root.querySelector('[data-el="redraw"]')!.addEventListener('click', () => {
      this.seed = Math.floor(Math.random() * 1e9);
      this.refresh();
    });
    this.refresh();
  }

  private refresh() {
    const p = this.p;
    const out = (k: string, v: string) => (this.root.querySelector(`[data-out="${k}"]`)!.innerHTML = v);
    this.root.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => {
      inp.value = String(p[inp.dataset.key as keyof Params]);
    });
    out('mean', `${p.mean.toFixed(2)} µm`);
    out('sd', `${p.sd.toFixed(2)} µm`);
    out('n', String(p.n));
    out('m', p.m.toFixed(3));
    const e = p.logPhotons, mant = Math.pow(10, e - Math.floor(e));
    out('logPhotons', `${mant < 1.05 ? '' : mant.toFixed(1) + '×'}10<sup>${Math.floor(e)}</sup> photons / channel`);
    const fact = (k: string, v: string) => (this.root.querySelector(`[data-fact="${k}"]`)!.textContent = v);
    const x = (lam: number) => (Math.PI * p.mean * N_MEDIUM) / lam;
    fact('x', `${x(0.4).toFixed(0)} / ${x(0.8).toFixed(0)}`);
    fact('fringes', (2 * N_MEDIUM * p.m * p.mean * (1 / 0.4 - 1 / 0.8)).toFixed(1));
    this.run({ ...p });
  }
}
