/** Main screen: tissue view, probe, spectrum/analysis panels, raster scan. */
import { latest, type Physics } from '../client';
import { mulberry32 } from '../physics/lss';
import type { Acquisition } from '../protocol';
import { FIELD_H, FIELD_W, generateTissue, lesionOutline, type Tissue } from '../tissue';
import { Panels, panelsMarkup } from '../ui/panels';
import { INK } from '../ui/plot';

const PROBE_RADIUS_UM = 26; // 2σ of the probe profile
const SCAN_NX = 64, SCAN_NY = 48;
const MAP_LO_UM = 5.5, MAP_HI_UM = 9.5;
const IMG_SCALE = 2; // offscreen px per µm

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const C_BLUE = hex(INK.blue), C_MID = hex('#77766f'), C_RED = hex(INK.red);

/** Diverging map: blue (normal) – neutral grey – red (enlarged). */
function mapColor(meanD: number): [number, number, number, number] {
  if (!(meanD > 0)) return [16, 16, 16, 150];
  const t = Math.max(0, Math.min(1, (meanD - MAP_LO_UM) / (MAP_HI_UM - MAP_LO_UM)));
  const [a, b, u] = t < 0.5 ? [C_BLUE, C_MID, t * 2] : [C_MID, C_RED, t * 2 - 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, 255];
}

export class Microscope {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private panels: Panels;
  private tissue!: Tissue;
  private whiteLight = document.createElement('canvas');
  private stained = document.createElement('canvas');
  private mapCanvas = document.createElement('canvas');
  private mapCtx: CanvasRenderingContext2D;
  private mapRows: (Float32Array | null)[] = [];
  private rowsShown = 0;
  private scanning = false;
  private scanId = -1;
  private hasMap = false;
  private showMap = true;
  private reveal = false;
  private probe = { x: FIELD_W * 0.5, y: FIELD_H * 0.5 };
  private photons = 1e6;
  private acqSeed = 1;
  private cssW = 0;
  private raf = 0;
  private requestProbe: (p: { x: number; y: number }) => void;
  private el: Record<string, HTMLElement> = {};

  constructor(root: HTMLElement, private physics: Physics, dictD: Float32Array) {
    root.innerHTML = `
    <div class="scope">
      <div class="tissue-col">
        <div class="tissue-wrap">
          <canvas class="tissue" tabindex="0" aria-label="Tissue under white light. Drag, or use the arrow keys, to move the probe."></canvas>
          <div class="hud hud-tl" data-el="mode">White light</div>
          <div class="hud hud-br" data-el="pos"></div>
          <div class="hud hud-hint" data-el="hint">Drag the probe across the tissue</div>
        </div>
        <div class="controls">
          <button class="btn primary" data-el="scan">Scan</button>
          <button class="btn" data-el="new">New sample</button>
          <label class="check"><input type="checkbox" data-el="reveal" /><span>Reveal histology</span></label>
          <label class="check" data-el="mapwrap" hidden><input type="checkbox" data-el="map" checked /><span>Show map</span></label>
        </div>
        <div class="controls">
          <label class="slider">
            <span>Exposure</span>
            <input type="range" min="2.5" max="8" step="0.25" value="6" data-el="photons" aria-label="Detected photons per spectral channel (log scale)" />
            <output data-el="photons-out"></output>
          </label>
        </div>
        <div class="colorbar" data-el="colorbar">
          <span class="mono">${MAP_LO_UM}</span>
          <i></i>
          <span class="mono">${MAP_HI_UM} µm</span>
          <span class="cb-label">mean nuclear diameter</span>
          <span class="cb-none"><b></b>no fringes</span>
        </div>
        <p class="status" data-el="status" role="status" aria-live="polite"></p>
      </div>
      <div class="panels-col">${panelsMarkup()}</div>
    </div>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.canvas = root.querySelector('canvas.tissue')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.mapCanvas.width = SCAN_NX;
    this.mapCanvas.height = SCAN_NY;
    this.mapCtx = this.mapCanvas.getContext('2d')!;
    this.panels = new Panels(root.querySelector('.panels-col')!);
    this.panels.setDictionary(dictD);

    this.requestProbe = latest(
      (p: { x: number; y: number }) =>
        physics.request({ type: 'probe', id: physics.id(), x: p.x, y: p.y, photons: this.photons, seed: this.acqSeed++ }, 'probe'),
      (res) => this.panels.update(res as Acquisition),
    );

    physics.on((m) => {
      if (m.type === 'scanRow' && m.id === this.scanId) this.mapRows[m.row] = m.meanD;
      else if (m.type === 'scanDone' && m.id === this.scanId) {
        this.el.status.textContent =
          `${(SCAN_NX * SCAN_NY).toLocaleString('en-US')} spectra acquired and fitted in ${(m.ms / 1000).toFixed(1)} s of compute.`;
      }
    });

    this.bind();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.newSample(Math.floor(Math.random() * 1e9));
    this.updatePhotons();
  }

  private bind() {
    const c = this.canvas;
    const toField = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      this.moveProbe(((e.clientX - r.left) / r.width) * FIELD_W, ((e.clientY - r.top) / r.height) * FIELD_H);
    };
    let down = false;
    c.addEventListener('pointerdown', (e) => {
      down = true;
      c.setPointerCapture(e.pointerId);
      toField(e);
      this.el.hint.classList.add('gone');
    });
    c.addEventListener('pointermove', (e) => {
      if (down || e.pointerType === 'mouse') toField(e);
    });
    const up = () => (down = false);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      if (d[e.key]) {
        e.preventDefault();
        this.moveProbe(this.probe.x + d[e.key][0], this.probe.y + d[e.key][1]);
      }
    });
    this.el.scan.addEventListener('click', () => (this.scanning ? this.cancelScan() : this.startScan()));
    this.el.new.addEventListener('click', () => this.newSample(Math.floor(Math.random() * 1e9)));
    this.el.reveal.addEventListener('change', () => {
      this.reveal = (this.el.reveal as HTMLInputElement).checked;
      this.panels.setTruthVisible(this.reveal);
      this.el.mode.textContent = this.reveal ? 'Stained section (ground truth)' : 'White light';
      this.invalidate();
    });
    this.el.map.addEventListener('change', () => {
      this.showMap = (this.el.map as HTMLInputElement).checked;
      this.invalidate();
    });
    this.el.photons.addEventListener('input', () => {
      this.updatePhotons();
      this.requestProbe(this.probe);
    });
  }

  private updatePhotons() {
    const e = parseFloat((this.el.photons as HTMLInputElement).value);
    this.photons = Math.pow(10, e);
    const mant = Math.pow(10, e - Math.floor(e));
    this.el['photons-out'].innerHTML =
      `${mant < 1.05 ? '' : mant.toFixed(1) + '×'}10<sup>${Math.floor(e)}</sup> photons / channel`;
  }

  private moveProbe(x: number, y: number) {
    this.probe.x = Math.max(0, Math.min(FIELD_W, x));
    this.probe.y = Math.max(0, Math.min(FIELD_H, y));
    this.el.pos.textContent = `x ${this.probe.x.toFixed(0)} µm · y ${this.probe.y.toFixed(0)} µm`;
    this.requestProbe(this.probe);
    this.invalidate();
  }

  newSample(seed: number) {
    this.cancelScan();
    this.tissue = generateTissue(seed);
    const t = this.tissue;
    this.physics.send({ type: 'tissue', x: t.x, y: t.y, kind: t.kind, row: t.row, d: t.d });
    this.hasMap = false;
    this.mapRows = [];
    this.rowsShown = 0;
    this.mapCtx.clearRect(0, 0, SCAN_NX, SCAN_NY);
    this.el.mapwrap.hidden = true;
    this.el.colorbar.classList.remove('on');
    this.el.status.textContent = `${t.n.toLocaleString('en-US')} cells · ${FIELD_W} × ${FIELD_H} µm. Somewhere in this field, nuclei are enlarged.`;
    this.renderImages();
    this.moveProbe(this.probe.x, this.probe.y);
  }

  /* ---------------- scan ---------------- */

  private startScan() {
    this.cancelScan();
    this.scanning = true;
    this.hasMap = true;
    this.showMap = true;
    (this.el.map as HTMLInputElement).checked = true;
    this.el.mapwrap.hidden = false;
    this.el.colorbar.classList.add('on');
    this.mapRows = new Array(SCAN_NY).fill(null);
    this.rowsShown = 0;
    this.mapCtx.clearRect(0, 0, SCAN_NX, SCAN_NY);
    this.el.scan.textContent = 'Stop';
    this.el.status.textContent = 'Scanning: one spectrum and one fit per pixel…';
    this.scanId = this.physics.id();
    this.physics.send({ type: 'scan', id: this.scanId, nx: SCAN_NX, ny: SCAN_NY, photons: this.photons, seed: this.acqSeed++ });
    let last = performance.now(), acc = 0;
    const tick = (now: number) => {
      if (!this.scanning) return;
      // reveal at most ~16 rows per second so the map can be watched as it builds
      acc += ((now - last) / 1000) * 16;
      last = now;
      while (acc >= 1 && this.rowsShown < SCAN_NY && this.mapRows[this.rowsShown]) {
        this.paintRow(this.rowsShown++);
        acc -= 1;
      }
      if (acc > 1) acc = 1;
      this.draw();
      if (this.rowsShown >= SCAN_NY) {
        this.scanning = false;
        this.el.scan.textContent = 'Scan again';
        this.draw();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private cancelScan() {
    if (this.scanning) {
      this.physics.send({ type: 'cancelScan' });
      this.el.status.textContent = 'Scan stopped.';
    }
    this.scanning = false;
    this.scanId = -1;
    if (this.el.scan) this.el.scan.textContent = this.hasMap ? 'Scan again' : 'Scan';
    this.invalidate();
  }

  private paintRow(j: number) {
    const row = this.mapRows[j]!;
    const img = this.mapCtx.createImageData(SCAN_NX, 1);
    for (let i = 0; i < SCAN_NX; i++) {
      const [r, g, b, a] = mapColor(row[i]);
      img.data.set([r, g, b, a], i * 4);
    }
    this.mapCtx.putImageData(img, 0, j);
  }

  /* ---------------- rendering ---------------- */

  private renderImages() {
    const t = this.tissue;
    const W = FIELD_W * IMG_SCALE, H = FIELD_H * IMG_SCALE;
    const rng = mulberry32(t.seed ^ 0x5bd1e995);
    const noiseLayer = (ctx: CanvasRenderingContext2D, nx: number, ny: number, alpha: number) => {
      const n = document.createElement('canvas');
      n.width = nx; n.height = ny;
      const nc = n.getContext('2d')!;
      const img = nc.createImageData(nx, ny);
      for (let i = 0; i < nx * ny; i++) {
        const v = 255 * rng();
        img.data.set([v, v, v, 255], i * 4);
      }
      nc.putImageData(img, 0, 0);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'soft-light';
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(n, 0, 0, W, H);
      ctx.restore();
    };

    // White light: unresolved, low-contrast mucosa. Cell positions add a faint
    // zero-mean grain; nuclear size leaves no trace, as in a real endoscope.
    {
      const c = this.whiteLight;
      c.width = W; c.height = H;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#c9a79f');
      grad.addColorStop(1, '#bd978f');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      noiseLayer(g, 5, 4, 0.5);
      noiseLayer(g, 20, 15, 0.3);
      noiseLayer(g, 100, 75, 0.14);
      for (let i = 0; i < t.n; i++) {
        const x = t.x[i] * IMG_SCALE, y = t.y[i] * IMG_SCALE, r = 5.2 * IMG_SCALE;
        const light = rng() < 0.5;
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, light ? 'rgba(255,240,235,0.07)' : 'rgba(90,40,40,0.07)');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg;
        g.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
      const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(20,5,5,0.35)');
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
    }
    // Stained section: what a pathologist would see after biopsy.
    {
      const c = this.stained;
      c.width = W; c.height = H;
      const g = c.getContext('2d')!;
      g.fillStyle = '#e9c3d0';
      g.fillRect(0, 0, W, H);
      noiseLayer(g, 20, 15, 0.25);
      noiseLayer(g, 160, 120, 0.2);
      for (let i = 0; i < t.n; i++) {
        g.fillStyle = t.kind[i] ? 'rgba(58,30,104,0.9)' : 'rgba(92,60,140,0.8)';
        g.beginPath();
        g.arc(t.x[i] * IMG_SCALE, t.y[i] * IMG_SCALE, (t.d[i] / 2) * IMG_SCALE, 0, 2 * Math.PI);
        g.fill();
      }
    }
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.cssW = r.width;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.draw();
  }

  private invalidate() {
    if (this.raf || this.scanning) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw() {
    const g = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
    if (!this.cssW) return;
    const s = cw / FIELD_W; // device px per µm
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.reveal ? this.stained : this.whiteLight, 0, 0, cw, ch);

    if (this.hasMap && this.showMap) {
      const rows = this.rowsShown;
      g.save();
      g.beginPath();
      g.rect(0, 0, cw, (rows / SCAN_NY) * ch);
      g.clip();
      g.globalAlpha = this.reveal ? 0.5 : 0.86;
      g.drawImage(this.mapCanvas, 0, 0, cw, ch);
      g.restore();
      if (this.scanning) {
        const y = (rows / SCAN_NY) * ch;
        const lg = g.createLinearGradient(0, y - 24 * s, 0, y);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(1, 'rgba(255,255,255,0.35)');
        g.fillStyle = lg;
        g.fillRect(0, y - 24 * s, cw, 24 * s);
        g.fillStyle = '#fff';
        g.fillRect(0, y - 1, cw, 2);
      }
    }

    if (this.reveal) {
      g.lineWidth = Math.max(1.5, 1.2 * s);
      g.setLineDash([6 * s, 5 * s]);
      g.strokeStyle = 'rgba(20,20,20,0.85)';
      for (const l of this.tissue.lesions) {
        g.beginPath();
        lesionOutline(l).forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
        g.closePath();
        g.stroke();
      }
      g.setLineDash([]);
    }

    // probe
    const px = this.probe.x * s, py = this.probe.y * s, pr = PROBE_RADIUS_UM * s;
    const dpr = cw / this.cssW;
    g.lineWidth = 3.5 * dpr;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.beginPath(); g.arc(px, py, pr, 0, 2 * Math.PI); g.stroke();
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = '#ffffff';
    g.beginPath(); g.arc(px, py, pr, 0, 2 * Math.PI); g.stroke();
    g.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.moveTo(px + dx * pr * 0.72, py + dy * pr * 0.72);
      g.lineTo(px + dx * pr * 1.28, py + dy * pr * 1.28);
    }
    g.stroke();
  }
}
