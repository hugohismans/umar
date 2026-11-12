/** Minimal canvas charts: a line plot and a histogram, both HiDPI and hover-aware. */

export const INK = {
  surface: '#141413',
  text: '#f0efec',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  blue: '#3987e5',
  orange: '#d95926',
  aqua: '#199e70',
  red: '#e66767',
};
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

export interface Series {
  label: string;
  color: string;
  y: ArrayLike<number>;
  width?: number;
  alpha?: number;
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-2) {
    const e = Math.floor(Math.log10(a));
    const m = v / Math.pow(10, e);
    return `${+m.toFixed(1)}e${e}`;
  }
  return String(+v.toPrecision(3));
}

abstract class Chart {
  protected ctx: CanvasRenderingContext2D;
  protected w = 0;
  protected h = 0;
  protected hoverX: number | null = null;
  protected hoverY: number | null = null;
  private raf = 0;

  constructor(protected canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.hoverY = e.clientY - r.top;
      this.invalidate();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.invalidate();
    });
    // no draw here: subclass fields are not initialised yet; the observer fires once on observe()
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.w > 0) this.draw();
    });
  }

  protected abstract draw(): void;

  protected tooltip(lines: { text: string; color?: string }[], x: number, y: number) {
    const c = this.ctx;
    c.font = `11px ${MONO}`;
    const pad = 6, lh = 15;
    const tw = Math.max(...lines.map((l) => c.measureText(l.text).width + (l.color ? 12 : 0)));
    const bw = tw + 2 * pad, bh = lines.length * lh + 2 * pad - 3;
    let bx = x + 10;
    if (bx + bw > this.w - 2) bx = x - 10 - bw;
    const by = Math.max(2, Math.min(this.h - bh - 2, y - bh / 2));
    c.fillStyle = 'rgba(13,13,13,0.92)';
    c.strokeStyle = INK.axis;
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(bx, by, bw, bh, 4);
    c.fill();
    c.stroke();
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    lines.forEach((l, i) => {
      const ty = by + pad + lh * i + lh / 2 - 2;
      let tx = bx + pad;
      if (l.color) {
        c.fillStyle = l.color;
        c.fillRect(tx, ty - 1, 8, 2);
        tx += 12;
      }
      c.fillStyle = INK.text;
      c.fillText(l.text, tx, ty);
    });
  }
}

export interface LinePlotOptions {
  x0: number;
  x1: number;
  xLabel?: string;
  yLabel?: string;
  /** include zero in the y range */
  zero?: boolean;
  /** hide y tick labels (qualitative plots) */
  bareY?: boolean;
  xUnit?: string;
  compact?: boolean;
}

export class LinePlot extends Chart {
  private series: Series[] = [];
  private yFixed: [number, number] | null = null;
  /** fraction of the x range actually drawn (for progressive reveals) */
  reveal = 1;
  marker: number | null = null;

  constructor(canvas: HTMLCanvasElement, private opts: LinePlotOptions) {
    super(canvas);
  }

  set(series: Series[], yRange?: [number, number]) {
    this.series = series;
    this.yFixed = yRange ?? null;
    this.invalidate();
  }

  protected draw() {
    const c = this.ctx, { w, h } = this, o = this.opts;
    c.clearRect(0, 0, w, h);
    const ml = o.bareY ? 14 : 44, mr = 10, mt = 8, mb = o.compact ? 20 : 34;
    const pw = w - ml - mr, ph = h - mt - mb;
    if (pw < 20 || ph < 20) return;

    let lo = Infinity, hi = -Infinity;
    if (this.yFixed) [lo, hi] = this.yFixed;
    else {
      for (const s of this.series) for (let i = 0; i < s.y.length; i++) {
        const v = s.y[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      const padY = (hi - lo || Math.abs(hi) || 1) * 0.08;
      hi += padY;
      if (!(o.zero && lo === 0)) lo -= padY;
    }
    const X = (v: number) => ml + ((v - o.x0) / (o.x1 - o.x0)) * pw;
    const Y = (v: number) => mt + (1 - (v - lo) / (hi - lo)) * ph;

    // grid + ticks
    c.lineWidth = 1;
    c.font = `10.5px ${MONO}`;
    c.fillStyle = INK.muted;
    c.strokeStyle = INK.grid;
    c.textBaseline = 'middle';
    c.textAlign = 'right';
    for (const t of niceTicks(lo, hi, Math.max(2, Math.floor(ph / 34)))) {
      const y = Math.round(Y(t)) + 0.5;
      c.beginPath(); c.moveTo(ml, y); c.lineTo(ml + pw, y); c.stroke();
      if (!o.bareY) c.fillText(fmt(t), ml - 6, y);
    }
    c.textAlign = 'center';
    c.textBaseline = 'top';
    for (const t of niceTicks(o.x0, o.x1, Math.max(2, Math.floor(pw / 70)))) {
      const x = Math.round(X(t)) + 0.5;
      c.beginPath(); c.moveTo(x, mt); c.lineTo(x, mt + ph); c.stroke();
      c.fillText(String(t), x, mt + ph + 5);
    }
    c.strokeStyle = INK.axis;
    c.beginPath(); c.moveTo(ml, mt + ph + 0.5); c.lineTo(ml + pw, mt + ph + 0.5); c.stroke();
    if (o.xLabel && !o.compact) {
      c.fillStyle = INK.muted;
      c.fillText(o.xLabel, ml + pw / 2, h - 13);
    }
    if (o.yLabel) {
      c.save();
      c.translate(10, mt + ph / 2);
      c.rotate(-Math.PI / 2);
      c.textBaseline = 'middle';
      c.fillStyle = INK.muted;
      c.fillText(o.yLabel, 0, 0);
      c.restore();
    }

    // series
    c.save();
    c.beginPath();
    c.rect(ml, mt, pw * this.reveal, ph);
    c.clip();
    c.lineJoin = 'round';
    for (const s of this.series) {
      const n = s.y.length;
      if (n < 2) continue;
      c.globalAlpha = s.alpha ?? 1;
      c.strokeStyle = s.color;
      c.lineWidth = s.width ?? 1.6;
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const x = ml + (i / (n - 1)) * pw, y = Y(s.y[i]);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }
    c.restore();
    c.globalAlpha = 1;

    if (this.marker != null) {
      const x = X(this.marker);
      c.strokeStyle = INK.secondary;
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, mt); c.lineTo(x, mt + ph); c.stroke();
    }

    // hover crosshair
    if (this.hoverX != null && this.hoverX >= ml && this.hoverX <= ml + pw && this.series.length) {
      const f = (this.hoverX - ml) / pw;
      const xv = o.x0 + f * (o.x1 - o.x0);
      c.strokeStyle = INK.muted;
      c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(this.hoverX, mt); c.lineTo(this.hoverX, mt + ph); c.stroke();
      c.setLineDash([]);
      const lines: { text: string; color?: string }[] = [{ text: `${Math.round(xv)} ${o.xUnit ?? ''}`.trim() }];
      for (const s of this.series) {
        const i = Math.round(f * (s.y.length - 1));
        const v = s.y[i];
        c.fillStyle = s.color;
        c.beginPath(); c.arc(this.hoverX, Y(v), 3, 0, 2 * Math.PI); c.fill();
        lines.push({ text: `${s.label}  ${fmt(v)}`, color: s.color });
      }
      this.tooltip(lines, this.hoverX, this.hoverY ?? mt + ph / 2);
    }
  }
}

export interface HistData {
  /** bin edges, length nb + 1 */
  edges: number[];
  /** retrieved fraction per bin (0..1) */
  fit: number[];
  /** ground-truth fraction per bin, or null when hidden */
  truth: number[] | null;
  /** x position of the "enlarged" threshold */
  threshold: number;
}

export class HistPlot extends Chart {
  private data: HistData | null = null;

  set(d: HistData | null) {
    this.data = d;
    this.invalidate();
  }

  protected draw() {
    const c = this.ctx, { w, h } = this;
    c.clearRect(0, 0, w, h);
    const d = this.data;
    const ml = 44, mr = 10, mt = 16, mb = 34;
    const pw = w - ml - mr, ph = h - mt - mb;
    if (!d || pw < 20 || ph < 20) return;
    const nb = d.fit.length;
    const x0 = d.edges[0], x1 = d.edges[nb];
    let hi = 0.2;
    for (let i = 0; i < nb; i++) hi = Math.max(hi, d.fit[i], d.truth ? d.truth[i] : 0);
    hi = Math.min(1, hi * 1.12);
    const X = (v: number) => ml + ((v - x0) / (x1 - x0)) * pw;
    const Y = (v: number) => mt + (1 - v / hi) * ph;

    c.font = `10.5px ${MONO}`;
    c.lineWidth = 1;
    c.strokeStyle = INK.grid;
    c.fillStyle = INK.muted;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (const t of niceTicks(0, hi, Math.max(2, Math.floor(ph / 34)))) {
      const y = Math.round(Y(t)) + 0.5;
      c.beginPath(); c.moveTo(ml, y); c.lineTo(ml + pw, y); c.stroke();
      c.fillText(`${Math.round(t * 100)}%`, ml - 6, y);
    }
    c.textAlign = 'center';
    c.textBaseline = 'top';
    for (let v = Math.ceil(x0); v <= x1; v += pw < 300 ? 2 : 1) c.fillText(String(v), X(v), mt + ph + 5);
    c.fillText('nuclear diameter (µm)', ml + pw / 2, h - 13);

    // enlarged threshold
    const tx = Math.round(X(d.threshold)) + 0.5;
    c.strokeStyle = INK.muted;
    c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(tx, mt - 4); c.lineTo(tx, mt + ph); c.stroke();
    c.setLineDash([]);
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('enlarged →', tx + 5, mt - 12);

    // retrieved distribution: bars with rounded tops, 2 px gaps
    c.fillStyle = INK.blue;
    for (let i = 0; i < nb; i++) {
      if (d.fit[i] <= 0) continue;
      const a = X(d.edges[i]) + 1, b = X(d.edges[i + 1]) - 1;
      const y = Y(d.fit[i]);
      c.beginPath();
      c.roundRect(a, y, b - a, mt + ph - y, [Math.min(4, (mt + ph - y)), Math.min(4, (mt + ph - y)), 0, 0]);
      c.fill();
    }
    // ground truth: step outline
    if (d.truth) {
      c.strokeStyle = INK.text;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(X(x0), Y(0));
      for (let i = 0; i < nb; i++) {
        c.lineTo(X(d.edges[i]), Y(d.truth[i]));
        c.lineTo(X(d.edges[i + 1]), Y(d.truth[i]));
      }
      c.lineTo(X(x1), Y(0));
      c.stroke();
    }
    c.strokeStyle = INK.axis;
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(ml, mt + ph + 0.5); c.lineTo(ml + pw, mt + ph + 0.5); c.stroke();

    if (this.hoverX != null && this.hoverX >= ml && this.hoverX <= ml + pw) {
      const i = Math.min(nb - 1, Math.floor(((this.hoverX - ml) / pw) * nb));
      c.fillStyle = 'rgba(240,239,236,0.06)';
      c.fillRect(X(d.edges[i]), mt, X(d.edges[i + 1]) - X(d.edges[i]), ph);
      const lines: { text: string; color?: string }[] = [
        { text: `${d.edges[i].toFixed(1)}–${d.edges[i + 1].toFixed(1)} µm` },
        { text: `retrieved  ${(d.fit[i] * 100).toFixed(0)}%`, color: INK.blue },
      ];
      if (d.truth) lines.push({ text: `truth      ${(d.truth[i] * 100).toFixed(0)}%`, color: INK.text });
      this.tooltip(lines, this.hoverX, this.hoverY ?? mt + ph / 2);
    }
  }
}
