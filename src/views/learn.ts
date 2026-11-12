/**
 * Learn mode: four animated steps on why a bigger nucleus makes the
 * backscattering spectrum oscillate faster. Steps 3 and 4 plot exact Mie
 * spectra; the two-echo picture is the explanation, not the computation.
 */
import type { Physics } from '../client';
import { N_LAMBDA, N_MEDIUM } from '../physics/lss';
import { INK, LinePlot } from '../ui/plot';

const M_REL = 1.04;
const N_NUC = N_MEDIUM * M_REL;
const SANS = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

/** Approximate sRGB colour of a wavelength (nm); near-IR shown as deep red. */
export function wavelengthColor(nm: number): string {
  let r = 0, g = 0, b = 0;
  if (nm < 440) { r = (440 - nm) / 60; b = 1; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = (510 - nm) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = (645 - nm) / 65; }
  else r = 1;
  const f = nm < 420 ? 0.45 + (0.55 * (nm - 380)) / 40 : nm > 700 ? Math.max(0.35, 1 - (0.65 * (nm - 700)) / 100) : 1;
  const ch = (v: number) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, v)) * f, 0.8));
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}

interface Step {
  title: string;
  body: string;
  /** extra controls / readouts under the stage */
  extra?: string;
  plot?: boolean;
  enter?: () => void;
  frame: (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void;
}

export class Learn {
  private step = 0;
  private active = false;
  private stage: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private plot: LinePlot;
  private t0 = 0;
  private w = 0;
  private h = 0;
  private lambda = 550; // nm, step 2
  private lambdaAuto = true;
  private d4 = 5.5; // µm, step 4
  private growing = false;
  private spectra = new Map<number, Float32Array>();
  private pending = new Set<number>();
  private steps: Step[];
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private root: HTMLElement, private physics: Physics) {
    this.steps = this.buildSteps();
    root.innerHTML = `
    <div class="learn">
      <div class="learn-text">
        <p class="eyebrow">Learn · <span data-el="n"></span> of 4</p>
        <h1 data-el="title"></h1>
        <div class="learn-body" data-el="body"></div>
        <div class="learn-nav">
          <button class="btn" data-el="prev">Back</button>
          <div class="dots" data-el="dots"></div>
          <button class="btn primary" data-el="next">Next</button>
        </div>
      </div>
      <div class="learn-visual">
        <canvas class="stage" aria-hidden="true"></canvas>
        <div class="learn-extra" data-el="extra"></div>
        <canvas class="plot learn-plot" data-el="plot" aria-label="Mie backscattering spectrum"></canvas>
      </div>
    </div>`;
    this.stage = root.querySelector('canvas.stage')!;
    this.g = this.stage.getContext('2d')!;
    this.plot = new LinePlot(this.q('plot') as HTMLCanvasElement, {
      x0: 400, x1: 800, xLabel: 'wavelength (nm)', xUnit: 'nm', zero: true, bareY: true, yLabel: 'backscattered intensity',
    });
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.q('prev').addEventListener('click', () => this.go(this.step - 1));
    this.q('next').addEventListener('click', () => {
      if (this.step === 3) location.hash = '#/microscope';
      else this.go(this.step + 1);
    });
    this.q('dots').innerHTML = this.steps.map((_, i) => `<button aria-label="Step ${i + 1}" data-i="${i}"></button>`).join('');
    this.q('dots').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.go(+b.dataset.i!)));
    physics.on((m) => {
      if (m.type !== 'sphere') return;
      const key = Math.round(m.d * 100);
      this.spectra.set(key, m.spectrum);
      this.pending.delete(key);
      if (this.spectra.size > 400) this.spectra.delete(this.spectra.keys().next().value!);
      this.updatePlot();
    });
    this.go(0);
  }

  private q(k: string): HTMLElement {
    return this.root.querySelector(`[data-el="${k}"]`)!;
  }

  setActive(on: boolean) {
    this.active = on;
    if (on) {
      this.resize();
      requestAnimationFrame((t) => this.loop(t));
    }
  }

  private spectrum(d: number): Float32Array | undefined {
    const key = Math.round(d * 100);
    const s = this.spectra.get(key);
    if (!s && !this.pending.has(key) && this.pending.size < 2) {
      this.pending.add(key);
      this.physics.send({ type: 'sphere', id: this.physics.id(), d: key / 100, m: M_REL });
    }
    return s;
  }

  private go(i: number) {
    this.step = Math.max(0, Math.min(3, i));
    const s = this.steps[this.step];
    this.q('n').textContent = String(this.step + 1);
    this.q('title').textContent = s.title;
    this.q('body').innerHTML = s.body;
    this.q('extra').innerHTML = s.extra ?? '';
    (this.q('plot') as HTMLElement).style.display = s.plot ? '' : 'none';
    this.root.querySelector('.learn-visual')!.classList.toggle('with-plot', !!s.plot);
    (this.q('prev') as HTMLButtonElement).disabled = this.step === 0;
    this.q('next').textContent = this.step === 3 ? 'Try it on tissue' : 'Next';
    this.q('dots').querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === this.step));
    this.t0 = performance.now();
    this.growing = false;
    s.enter?.();
    this.resize();
    this.updatePlot();
  }

  private resize() {
    const r = this.stage.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = r.width;
    this.h = r.height;
    this.stage.width = Math.round(r.width * dpr);
    this.stage.height = Math.round(r.height * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(performance.now());
  }

  private loop(t: number) {
    if (!this.active) return;
    this.draw(t);
    requestAnimationFrame((tt) => this.loop(tt));
  }

  private draw(t: number) {
    if (!this.w) return;
    this.g.clearRect(0, 0, this.w, this.h);
    // with reduced motion, hold a representative still frame
    const time = this.reduced ? 2.4 : (t - this.t0) / 1000;
    this.steps[this.step].frame(this.g, this.w, this.h, time);
  }

  private fringeCount(s: ArrayLike<number>): number {
    let mean = 0;
    for (let i = 0; i < s.length; i++) mean += s[i] / s.length;
    let c = 0;
    for (let i = 1; i < s.length; i++) if ((s[i - 1] - mean) * (s[i] - mean) < 0) c++;
    return c / 2;
  }

  private updatePlot() {
    if (this.step === 2) {
      const s = this.spectrum(5.5);
      if (s) this.plot.set([{ label: 'd = 5.5 µm', color: INK.blue, y: s, width: 1.8 }]);
    } else if (this.step === 3) {
      const ref = this.spectrum(5.5);
      const cur = this.spectrum(this.d4);
      const series = [];
      let top = 0;
      if (ref) {
        series.push({ label: '5.5 µm', color: INK.muted, y: ref, width: 1.2, alpha: 0.7 });
      }
      if (cur) {
        series.push({ label: `${this.d4.toFixed(1)} µm`, color: INK.blue, y: cur, width: 1.8 });
        for (let i = 0; i < N_LAMBDA; i++) top = Math.max(top, cur[i]);
        const el = this.root.querySelector('[data-r="count"]');
        if (el) el.textContent = this.fringeCount(cur).toFixed(0);
      }
      if (series.length) this.plot.set(series, top ? [0, top * 1.08] : undefined);
      const pred = this.root.querySelector('[data-r="pred"]');
      if (pred) pred.textContent = (2 * N_NUC * this.d4 * (1 / 0.4 - 1 / 0.8)).toFixed(1);
      const dv = this.root.querySelector('[data-r="d"]');
      if (dv) dv.textContent = `${this.d4.toFixed(1)} µm`;
    }
  }

  /* ------------------------------------------------------------------ */

  private buildSteps(): Step[] {
    const label = (g: CanvasRenderingContext2D, text: string, x: number, y: number, color = INK.secondary, align: CanvasTextAlign = 'left', mono = false) => {
      g.font = `${mono ? '11.5px ' + MONO : '12.5px ' + SANS}`;
      g.fillStyle = color;
      g.textAlign = align;
      g.textBaseline = 'middle';
      g.fillText(text, x, y);
    };
    const nucleus = (g: CanvasRenderingContext2D, cx: number, cy: number, R: number) => {
      const rg = g.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
      rg.addColorStop(0, 'rgba(144,133,233,0.20)');
      rg.addColorStop(1, 'rgba(144,133,233,0.07)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.fill();
      g.strokeStyle = 'rgba(144,133,233,0.75)';
      g.lineWidth = 1.5;
      g.stroke();
    };

    /* 1 — a nucleus is a faint sphere */
    const s1: Step = {
      title: 'A nucleus is a faint lens',
      body: `
        <p>To light, a cell nucleus is a sphere of slightly denser material: its refractive index is only about
        <b>4% higher</b> than the cytoplasm around it (relative index m ≈ 1.04).</p>
        <p>Almost all the light goes straight through, merely delayed. Each surface sends back a tiny echo,
        about <b class="mono">((m−1)/(m+1))² ≈ 0.04%</b> of the light. That faint echo is the entire signal.</p>
        <p class="note">The wavefront delay is exaggerated in the drawing.</p>`,
      frame: (g, w, h, t) => {
        const cx = w * 0.56, cy = h * 0.5, R = Math.min(h * 0.3, w * 0.2);
        const L = Math.max(26, w / 16);
        // incoming plane wavefronts, delayed inside the sphere
        g.lineWidth = 1.4;
        const off = (t * 34) % L;
        for (let x0 = -L + off; x0 < w + R; x0 += L) {
          g.strokeStyle = 'rgba(240,239,236,0.32)';
          g.beginPath();
          for (let y = 0; y <= h; y += 3) {
            let x = x0;
            const dy = y - cy;
            if (Math.abs(dy) < R) {
              const half = Math.sqrt(R * R - dy * dy);
              const travelled = Math.max(0, Math.min(2 * half, x0 - (cx - half)));
              x = x0 - 0.2 * travelled;
            }
            if (y === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        }
        nucleus(g, cx, cy, R);
        // echoes from the two poles
        for (const [px, phase, col] of [[cx - R, 0, INK.blue], [cx + R, 0.5, INK.orange]] as const) {
          for (let k = 0; k < 3; k++) {
            const u = ((t * 0.32 + phase + k / 3) % 1);
            const rr = u * w * 0.5;
            g.strokeStyle = col;
            g.globalAlpha = 0.75 * (1 - u);
            g.lineWidth = 1.6;
            g.beginPath();
            g.arc(px, cy, rr, Math.PI * 0.72, Math.PI * 1.28);
            g.stroke();
          }
        }
        g.globalAlpha = 1;
        label(g, 'white light →', 12, 18, INK.secondary);
        label(g, 'nucleus', cx, cy, 'rgba(190,182,245,0.95)', 'center');
        label(g, '← echoes', 12, h - 16, INK.secondary);
      },
    };

    /* 2 — two echoes */
    const d2 = 5.5;
    const s2: Step = {
      title: 'Two echoes, one detector',
      body: `
        <p>The echo from the <b style="color:${INK.blue}">front surface</b> and the echo from the
        <b style="color:${INK.orange}">back surface</b> reach the detector together. The second one has crossed the
        nucleus twice: it travelled an extra optical path <b class="mono">2·n·d</b>.</p>
        <p>If that extra path is a whole number of wavelengths, crests meet crests and the detector sees
        <b>bright</b>. Half a wavelength more and they cancel: <b>dark</b>.</p>
        <p>Drag the wavelength and watch the sum.</p>
        <p class="note">The exact Mie spectrum peaks precisely where 2·n·d/λ is a whole number: the half-wave
        flip on reflection at the front surface is offset by the half-wave the back echo picks up passing through its focus.</p>`,
      extra: `
        <label class="slider wide">
          <span>Wavelength</span>
          <input type="range" min="400" max="800" step="1" value="550" data-r="lam" aria-label="Wavelength in nanometres" />
          <output data-r="lamout"></output>
        </label>`,
      enter: () => {
        this.lambdaAuto = true;
        const inp = this.root.querySelector<HTMLInputElement>('[data-r="lam"]')!;
        inp.addEventListener('input', () => {
          this.lambdaAuto = false;
          this.lambda = +inp.value;
        });
      },
      frame: (g, w, h, t) => {
        if (this.lambdaAuto && !this.reduced) {
          this.lambda = 560 + 60 * Math.sin(t * 0.5);
          const inp = this.root.querySelector<HTMLInputElement>('[data-r="lam"]');
          if (inp) inp.value = String(Math.round(this.lambda));
        }
        const lam = this.lambda;
        const col = wavelengthColor(lam);
        const out = this.root.querySelector('[data-r="lamout"]');
        const turns = (2 * N_NUC * d2) / (lam / 1000);
        if (out) out.textContent = `${Math.round(lam)} nm · extra path = ${turns.toFixed(2)} wavelengths`;
        // top: geometry
        const top = h * 0.44;
        const R = Math.min(top * 0.36, w * 0.13);
        const cx = w * 0.7, cy = top * 0.52;
        nucleus(g, cx, cy, R);
        g.lineWidth = 2;
        g.strokeStyle = col;
        g.beginPath(); g.moveTo(16, cy - 9); g.lineTo(cx - R, cy - 9); g.stroke();
        g.globalAlpha = 0.5;
        g.beginPath(); g.moveTo(cx - R, cy - 9); g.lineTo(cx + R, cy - 9); g.stroke();
        g.globalAlpha = 1;
        g.strokeStyle = INK.blue;
        g.beginPath(); g.moveTo(cx - R - 2, cy + 3); g.lineTo(16, cy + 3); g.stroke();
        g.strokeStyle = INK.orange;
        g.beginPath(); g.moveTo(cx + R - 2, cy + 15); g.lineTo(16, cy + 15); g.stroke();
        for (const [yy, c] of [[cy + 3, INK.blue], [cy + 15, INK.orange]] as const) {
          g.fillStyle = c;
          g.beginPath(); g.moveTo(14, yy); g.lineTo(23, yy - 4.5); g.lineTo(23, yy + 4.5); g.fill();
        }
        label(g, 'in', 18, cy - 22, INK.secondary);
        label(g, 'front echo', cx - R - 10, cy + 29, INK.secondary, 'right');
        label(g, `d = ${d2} µm`, cx, cy - R - 12, INK.secondary, 'center', true);
        // bottom: the two waves and their sum
        const phi = 2 * Math.PI * turns;
        const x0 = 16, x1 = w - 16;
        const rows = [
          { y: top + (h - top) * 0.17, c: INK.blue, f: (u: number) => Math.cos(u), name: 'front' },
          { y: top + (h - top) * 0.45, c: INK.orange, f: (u: number) => Math.cos(u + phi), name: 'back' },
          { y: top + (h - top) * 0.78, c: INK.text, f: (u: number) => Math.cos(u) + Math.cos(u + phi), name: 'sum' },
        ];
        const amp = (h - top) * 0.085;
        const kx = (2 * Math.PI) / Math.max(46, w / 9);
        for (const r of rows) {
          g.strokeStyle = INK.grid;
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(x0, r.y); g.lineTo(x1, r.y); g.stroke();
          g.strokeStyle = r.c;
          g.lineWidth = r.name === 'sum' ? 2.2 : 1.6;
          g.beginPath();
          for (let x = x0; x <= x1; x += 2) {
            const y = r.y - amp * r.f(kx * x + t * 3.2);
            if (x === x0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
          label(g, r.name, x0, r.y - amp * (r.name === 'sum' ? 2 : 1) - 9, INK.muted, 'left', true);
        }
        const I = (1 + Math.cos(phi)) / 2;
        label(g, I > 0.85 ? 'in step: bright' : I < 0.15 ? 'out of step: dark' : 'partly in step', x1, Math.min(h - 10, rows[2].y + amp * 2 + 12), INK.text, 'right');
      },
    };

    /* 3 — sweeping the colour */
    const s3: Step = {
      title: 'Sweep the colour, get fringes',
      body: `
        <p>A spectrometer looks at every wavelength at once. The extra path <span class="mono">2·n·d</span> is fixed, but
        the number of wavelengths that fit in it is not: from red to blue the back echo slips steadily against the
        front one, and the detector goes bright, dark, bright…</p>
        <p>The dial shows the back echo's phase turning. The curve is the <b>exact Mie spectrum</b> of a 5.5&nbsp;µm
        nucleus: about <b>20 fringes</b> between 400 and 800&nbsp;nm.</p>
        <p class="note">Fringes are evenly spaced in 1/λ, so they bunch up towards the blue.</p>`,
      plot: true,
      frame: (g, w, h, t) => {
        const period = 14;
        const u = this.reduced ? 1 : Math.min(1, (t % (period + 2)) / period);
        const lam = 800 - 400 * u;
        this.plot.reveal = 1;
        this.plot.marker = lam;
        this.plot.invalidate();
        // spectral strip
        const sx0 = 16, sx1 = w - 16, sy = h - 30;
        for (let x = sx0; x < sx1; x++) {
          g.fillStyle = wavelengthColor(400 + (400 * (x - sx0)) / (sx1 - sx0));
          g.fillRect(x, sy, 1.5, 10);
        }
        const mx = sx0 + ((lam - 400) / 400) * (sx1 - sx0);
        g.fillStyle = INK.text;
        g.beginPath(); g.moveTo(mx, sy - 3); g.lineTo(mx - 5, sy - 11); g.lineTo(mx + 5, sy - 11); g.fill();
        // phasor dial
        const R = Math.min(h * 0.3, w * 0.16), cx = w * 0.26, cy = (sy - 14) / 2 + 4;
        g.strokeStyle = INK.axis;
        g.lineWidth = 1;
        g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.stroke();
        const turns = (2 * N_NUC * 5.5) / (lam / 1000);
        const phi = 2 * Math.PI * turns;
        const arrow = (ax: number, ay: number, bx: number, by: number, c: string, lw = 2) => {
          g.strokeStyle = c; g.fillStyle = c; g.lineWidth = lw;
          g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
          const a = Math.atan2(by - ay, bx - ax);
          g.beginPath();
          g.moveTo(bx, by);
          g.lineTo(bx - 8 * Math.cos(a - 0.4), by - 8 * Math.sin(a - 0.4));
          g.lineTo(bx - 8 * Math.cos(a + 0.4), by - 8 * Math.sin(a + 0.4));
          g.fill();
        };
        const half = R * 0.5;
        const fx = cx + half, fy = cy;
        const bx = fx + half * Math.cos(phi), by = fy - half * Math.sin(phi);
        arrow(cx, cy, fx, fy, INK.blue);
        arrow(fx, fy, bx, by, INK.orange);
        arrow(cx, cy, bx, by, INK.text, 2.4);
        // readouts
        const tx = w * 0.5;
        label(g, `λ = ${Math.round(lam)} nm`, tx, cy - 30, INK.text, 'left', true);
        label(g, `extra path = ${turns.toFixed(1)} λ`, tx, cy - 10, INK.secondary, 'left', true);
        const startTurns = (2 * N_NUC * 5.5) / 0.8;
        label(g, `turns since 800 nm: ${(turns - startTurns).toFixed(1)}`, tx, cy + 10, INK.secondary, 'left', true);
        label(g, 'white arrow = what the detector sees', tx, cy + 34, INK.muted, 'left');
      },
    };

    /* 4 — bigger nucleus, faster fringes */
    const s4: Step = {
      title: 'Bigger nucleus, faster fringes',
      body: `
        <p>Double the diameter and the extra path doubles: the back echo slips twice as fast as the colour changes.
        The number of fringes between 400 and 800&nbsp;nm is simply</p>
        <p class="eq">N ≈ 2·n·d·(1/400&nbsp;nm − 1/800&nbsp;nm) ≈ 3.5 × d[µm]</p>
        <p>A normal 5.5&nbsp;µm nucleus gives about 20 fringes; an enlarged 10&nbsp;µm nucleus about 35.
        <b>Counting fringes measures the nucleus</b>, with no stain and without ever resolving it.</p>
        <p>Tissue holds many nuclei under the probe, so the real spectrum is a sum of such combs. Scatter untangles
        it by least-squares fitting against a table of Mie spectra.</p>`,
      extra: `
        <div class="grow">
          <label class="slider wide">
            <span>Diameter</span>
            <input type="range" min="4" max="14" step="0.1" value="5.5" data-r="dslider" aria-label="Nuclear diameter in micrometres" />
            <output data-r="d"></output>
          </label>
          <button class="btn" data-r="grow">Grow the nucleus</button>
        </div>
        <dl class="facts row">
          <div><dt>Fringes counted on the Mie spectrum</dt><dd data-r="count">–</dd></div>
          <div><dt>Predicted, 2·n·d·Δ(1/λ)</dt><dd data-r="pred">–</dd></div>
        </dl>`,
      plot: true,
      enter: () => {
        this.d4 = 5.5;
        const inp = this.root.querySelector<HTMLInputElement>('[data-r="dslider"]')!;
        inp.addEventListener('input', () => {
          this.growing = false;
          this.d4 = +inp.value;
          this.updatePlot();
        });
        this.root.querySelector('[data-r="grow"]')!.addEventListener('click', () => {
          this.d4 = 4;
          this.growing = true;
        });
        this.plot.marker = null;
        this.plot.reveal = 1;
      },
      frame: (g, w, h) => {
        if (this.growing) {
          this.d4 = Math.min(13, this.d4 + 0.02);
          if (this.d4 >= 13) this.growing = false;
          const inp = this.root.querySelector<HTMLInputElement>('[data-r="dslider"]');
          if (inp) inp.value = this.d4.toFixed(1);
          this.updatePlot();
        } else if (!this.spectra.has(Math.round(this.d4 * 100))) this.updatePlot();
        // nuclei to scale
        const scale = Math.min((h - 44) / 14, (w * 0.42) / 14);
        const cy = h * 0.47;
        const ax = w * 0.27, bx = w * 0.7;
        g.setLineDash([4, 4]);
        g.strokeStyle = INK.muted;
        g.lineWidth = 1.2;
        g.beginPath(); g.arc(ax, cy, (5.5 / 2) * scale, 0, 2 * Math.PI); g.stroke();
        g.setLineDash([]);
        nucleus(g, bx, cy, (this.d4 / 2) * scale);
        label(g, 'normal, 5.5 µm', ax, h - 16, INK.muted, 'center');
        label(g, `this nucleus, ${this.d4.toFixed(1)} µm`, bx, h - 16, INK.secondary, 'center');
        // scale bar
        g.strokeStyle = INK.secondary;
        g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(14, 20); g.lineTo(14 + 5 * scale, 20); g.stroke();
        label(g, '5 µm', 14, 32, INK.muted, 'left', true);
      },
    };
    return [s1, s2, s3, s4];
  }
}
