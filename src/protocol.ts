/** Messages exchanged between the UI thread and the physics worker. */

export interface TissueMsg {
  type: 'tissue';
  x: Float32Array;
  y: Float32Array;
  kind: Uint8Array;
  row: Uint16Array;
  d: Float32Array;
}

export type Request =
  | { type: 'init' }
  | TissueMsg
  | { type: 'probe'; id: number; x: number; y: number; photons: number; seed: number }
  | { type: 'scan'; id: number; nx: number; ny: number; photons: number; seed: number }
  | { type: 'cancelScan' }
  | { type: 'bench'; id: number; mean: number; sd: number; n: number; m: number; photons: number; seed: number }
  | { type: 'sphere'; id: number; d: number; m: number };

/** One acquisition + its inversion. Spectra are in units of the reference signal. */
export interface Acquisition {
  ipar: Float32Array;
  iperp: Float32Array;
  delta: Float32Array;
  model: Float32Array;
  /** noise σ of ΔI per channel (reference units) */
  sigma: number;
  /** retrieved number of nuclei per dictionary diameter */
  c: Float32Array;
  count: number;
  meanD: number;
  sdD: number;
  enlarged: number;
  snr: number;
  /** ground truth: diameters (µm) and probe weights of the nuclei that contributed */
  truthD: Float32Array;
  truthW: Float32Array;
}

export type Response =
  | { type: 'progress'; done: number; total: number }
  | { type: 'ready'; dictD: Float32Array; ms: number; spheres: number }
  | ({ type: 'probe'; id: number } & Acquisition)
  | ({ type: 'bench'; id: number } & Acquisition)
  | { type: 'scanRow'; id: number; row: number; meanD: Float32Array; enlarged: Float32Array; count: Float32Array }
  | { type: 'scanDone'; id: number; ms: number }
  | { type: 'sphere'; id: number; d: number; m: number; spectrum: Float32Array };
