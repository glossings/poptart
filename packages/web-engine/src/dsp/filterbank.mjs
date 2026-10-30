// The filter bank under Filterbank and Resonator: many band-passes side by side, each with its own level
// every sample, and the moving picture those levels are read from.
//
// THE PICTURE. A row of cells, one per band (Resonator: one per note of its scale), holds a level
// each, and the cells are driven by one control, Shape - any signal: an lfo, noise, a drawn curve,
// a MIDI knob, audio patched onto it. How a signal that moves in TIME becomes a shape across the
// SPECTRUM is the mode:
//
//   scroll   The cells remember Shape's recent past and cell k shows what Shape was k steps ago,
//            so whatever Shape does travels up the bank. `Scroll` is how many cells a second it
//            travels; a negative speed runs it down instead. The past is kept as one snapshot per
//            cell crossed (not every sample), and read between snapshots, so a slow scroll needs
//            no more memory than a fast one.
//   ripple   A damped wave equation runs across the cells. Shape holds the cell at `Where` (a
//            point between two cells holds both, in proportion), and what it does there spreads
//            outwards as ripples that bounce off both ends - the ends reflect - cross and die
//            away. `Wave speed` is cells per second, `Damping` how much of a ripple is lost as it
//            travels. Held still, Shape settles the whole bank at its own level.
//
// STABILITY. The wave is the explicit scheme u' = u + λ(u - u_prev) + C²·(left + right - 2u),
// where λ = e^(-damping) per step and C (the Courant number) is the cells a ripple crosses in one
// step. Its von Neumann condition is C² ≤ (1 + λ)/2, which λ ≥ 0 makes C ≤ 1/√2 sufficient at
// every damping. C is wave speed / sample rate, so a speed that would break it is run in as many
// sub-steps per sample as it takes to bring C under 1/√2: stable at every setting and every rate.
//
// STEREO. One control, Stereo, moves the right side's picture towards the left's mirror image: at
// 0 the two sides are one picture, at 1 the right side scrolls the other way, or (ripple) is its
// own wave, struck at the mirror of Where. Between, the right side reads the past from part way
// between the two, or is struck part way between the two points.
//
// THE BANDS. A band is a two-pole band-pass (the trapezoidal state-variable filter, so its tuning
// can be anything up to Nyquist) whose INPUT is scaled by its level: a band turned down mid-ring
// rings out rather than clicking off, and a stepped level needs no smoothing. Each band is scaled
// so that a bank of them, every level at 1, passes pink noise at about the level it came in: a
// band given a share `dln` of the spectrum (in natural-log units) and a damping k = 1/Q passes
// pink power in proportion to k·(its peak gain)², so it is scaled by sqrt(2/π · dln · k).
//
// LEVELS. On top of Shape, a band's level is multiplied by a list of levels a pattern hands in:
// one cycle of the pattern, laid across the bank low to high - band k of n reads the step under
// (k + 0.5) / n, a rest reads 0. The list arrives as [start, end, value] triples (the cycle's
// steps), in an option slot of its own control, the way a drawn curve does (see the engines'
// list path); with none, every band is at 1.
//
// Translated line for line into osc-engine/native/devices/own/dsp/filterbank.h, and held to it
// by native-device-parity.test.mjs through devices/filterbank.mjs and devices/resonator.mjs.

/** The modes, as the controls name them. */
export const BANK_MODES = Object.freeze(['scroll', 'ripple']);

/** The ends of the audible range, which a scale is laid across. */
export const AUDIBLE_LOW = 20;
export const AUDIBLE_HIGH = 20000;

const TWO_OVER_PI = 2 / Math.PI;

const clamp01 = (x) => (x < 0 ? 0 : (x > 1 ? 1 : x));

/**
 * Arrays of doubles that grow and keep what they held. The native side grows its arrays off the
 * audio thread; what it keeps is the same, which is what the parity test needs.
 */
export class Store {
  constructor(names) {
    this.cap = 0;
    this.names = names;
    for (const n of names) this[n] = new Float64Array(0);
  }

  ensure(n) {
    if (n <= this.cap) return;
    for (const name of this.names) {
      const next = new Float64Array(n);
      next.set(this[name]);
      this[name] = next;
    }
    this.cap = n;
  }
}

/**
 * The value of a list of levels at `pos` (0..1 across the bank): the last [start, end, value]
 * triple that covers it, 0 where none does, and 1 everywhere when there is no list.
 */
export function listLevel(table, pos) {
  if (!table) return 1;
  let v = 0;
  for (let t = 0; t + 2 < table.length; t += 3) {
    if (pos >= table[t] && pos < table[t + 1]) v = table[t + 2];
  }
  return v;
}

/** A pitch, as a fractional MIDI note, in hertz. */
export function pitchHz(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** The moving picture: one level per cell for each side, every sample. */
export class ShapeField {
  constructor() {
    // hist holds n + 1 snapshots (scroll); u/p/x the wave now, a step ago and the next step,
    // per side (ripple); lvL/lvR what each cell reads this sample.
    this.cells = new Store(['hist', 'uL', 'pL', 'xL', 'uR', 'pR', 'xR', 'lvL', 'lvR']);
    this.n = 0;
    this.phase = 0;
    this.mode = 0;
    this.adv = 0;
    this.reverse = false;
    this.stereo = 0;
    this.whereL = 0;
    this.whereR = 0;
    this.sub = 1;
    this.c2 = 0;
    this.lambda = 1;
    this.primed = false;
  }

  reset() {
    const c = this.cells;
    for (const name of c.names) c[name].fill(0);
    this.phase = 0;
    this.primed = false;
  }

  /** Room for n cells (and the n + 1 snapshots a scroll keeps). */
  ensure(n) { this.cells.ensure(n + 1); }

  /**
   * The settings for a block. `scroll` is cells per second, `speed` too; `where` and `stereo` are
   * 0..1 and `damping` the share of a ripple lost per cell it crosses, 0..1.
   */
  setup(n, sampleRate, mode, scroll, where, speed, damping, stereo) {
    this.n = n;
    this.mode = mode;
    this.adv = Math.abs(scroll) / sampleRate;
    this.reverse = scroll < 0;
    this.stereo = clamp01(stereo);
    this.whereL = clamp01(where);
    this.whereR = this.whereL + this.stereo * ((1 - this.whereL) - this.whereL);
    const raw = Math.max(0, speed) / sampleRate;
    this.sub = Math.max(1, Math.ceil(raw * Math.SQRT2));
    const c = raw / this.sub;
    this.c2 = c * c;
    // A ripple crosses 1/c steps per cell; over them its speed is kept by λ^(1/c) = (1 - damping)².
    this.lambda = Math.pow(1 - clamp01(damping), 2 * c);
  }

  /** One sample: Shape's value now in, every cell's level out (cells.lvL / cells.lvR). */
  tick(shape) {
    const n = this.n;
    if (n <= 0) return;
    const c = this.cells;
    if (!this.primed) {
      // A device that has only just started has a past of Shape's first value, not of silence:
      // a bank held at one level is at that level from its first sample.
      for (let k = 0; k <= n; k++) {
        c.hist[k] = shape;
        c.uL[k] = shape; c.pL[k] = shape; c.uR[k] = shape; c.pR[k] = shape;
      }
      this.primed = true;
    }
    if (this.mode === 1) {
      for (let s = 0; s < this.sub; s++) {
        this.stepSide(c.uL, c.pL, c.xL, this.whereL, shape);
        if (this.stereo > 0) this.stepSide(c.uR, c.pR, c.xR, this.whereR, shape);
      }
      for (let k = 0; k < n; k++) {
        c.lvL[k] = clamp01(c.uL[k]);
        if (this.stereo > 0) {
          c.lvR[k] = clamp01(c.uR[k]);
        } else {
          // One wave for both sides, and the right side's ready to part from it where it is.
          c.uR[k] = c.uL[k];
          c.pR[k] = c.pL[k];
          c.lvR[k] = c.lvL[k];
        }
      }
      return;
    }
    const hist = c.hist;
    this.phase += this.adv;
    while (this.phase >= 1) {
      this.phase -= 1;
      for (let j = n; j > 0; j--) hist[j] = hist[j - 1];
      hist[0] = shape;
    }
    const last = n - 1;
    for (let k = 0; k < n; k++) {
      const fwd = this.reverse ? last - k : k;
      const back = last - fwd;
      c.lvL[k] = clamp01(this.ageValue(shape, fwd));
      c.lvR[k] = clamp01(this.ageValue(shape, fwd + this.stereo * (back - fwd)));
    }
  }

  /** What Shape was `age` cells ago: now, the snapshots, and straight lines between them. */
  ageValue(shape, age) {
    const ph = this.phase;
    const hist = this.cells.hist;
    if (age <= ph) return ph > 0 ? shape + (hist[0] - shape) * (age / ph) : shape;
    const x = age - ph;
    const j = Math.floor(x);
    const f = x - j;
    const a = hist[j];
    return a + (hist[j + 1] - a) * f;
  }

  /** One step of one side's wave, struck at `where` by `drive`. The ends reflect. */
  stepSide(u, p, nx, where, drive) {
    const n = this.n;
    const last = n - 1;
    const lam = this.lambda;
    const c2 = this.c2;
    for (let k = 0; k < n; k++) {
      const left = k > 0 ? u[k - 1] : (n > 1 ? u[1] : u[0]);
      const right = k < last ? u[k + 1] : (n > 1 ? u[last - 1] : u[last]);
      const uk = u[k];
      nx[k] = uk + lam * (uk - p[k]) + c2 * (left + right - 2 * uk);
    }
    const at = where * last;
    const j = Math.floor(at);
    const f = at - j;
    nx[j] += (1 - f) * (drive - nx[j]);
    if (j < last) nx[j + 1] += f * (drive - nx[j + 1]);
    for (let k = 0; k < n; k++) {
      p[k] = u[k];
      u[k] = nx[k];
    }
  }

  /** A cell's level at a fractional cell `x` (0..n-1), or 1 with no cells. */
  levelAt(lv, x) {
    const n = this.n;
    if (n <= 0) return 1;
    const j = Math.floor(x);
    const f = x - j;
    if (f === 0 || j >= n - 1) return lv[j < n ? j : n - 1];
    return lv[j] + (lv[j + 1] - lv[j]) * f;
  }

  /** Whether the wave has gone somewhere a number cannot follow. */
  playable() {
    const c = this.cells;
    let s = this.phase;
    for (let k = 0; k < this.n; k++) s += c.uL[k] + c.uR[k] + c.hist[k];
    return Number.isFinite(s);
  }
}

/**
 * The bands: a tuning and a level each, and a stereo band-pass apiece.
 *
 * `x` is the cell a band reads its level from, `amp` what multiplies it (the list, a tilt, a
 * note's velocity), `gL`/`gR` the band's output scale on each side, and `on` whether it is below
 * Nyquist - a band at or past it cannot be tuned there, and plays nothing.
 */
export class BandBank {
  constructor() {
    this.bands = new Store(['a1', 'a2', 'a3', 'gL', 'gR', 'x', 'amp', 'on',
      'ic1L', 'ic2L', 'ic1R', 'ic2R', 'note', 'vel', 'held', 'hz']);
    this.count = 0;
  }

  reset() {
    const b = this.bands;
    for (const name of ['ic1L', 'ic2L', 'ic1R', 'ic2R']) b[name].fill(0);
  }

  ensure(n) { this.bands.ensure(n); }

  /**
   * Band `i` tuned to `freq` with damping `k` (1/Q), given a share `dln` of the spectrum, panned
   * by `pan` (-1..1: unity in the middle, +3 dB at either side).
   */
  tune(i, freq, k, dln, pan, sampleRate) {
    const b = this.bands;
    b.hz[i] = freq;
    if (!(freq > 0 && freq < sampleRate * 0.5)) {
      b.on[i] = 0;
      return;
    }
    const g = Math.tan((Math.PI * freq) / sampleRate);
    b.a1[i] = 1 / (1 + g * (g + k));
    b.a2[i] = g * b.a1[i];
    b.a3[i] = g * b.a2[i];
    const norm = Math.sqrt(TWO_OVER_PI * dln * k);
    const angle = ((pan + 1) * Math.PI) / 4;
    b.gL[i] = norm * Math.SQRT2 * Math.cos(angle);
    b.gR[i] = norm * Math.SQRT2 * Math.sin(angle);
    b.on[i] = 1;
  }

  /**
   * One sample through every band: `xl`/`xr` in, the sum of the bands out on `out[0]`/`out[1]`.
   * Each band's level is the field's cell at its `x`, times its `amp`.
   */
  run(field, xl, xr, out) {
    const b = this.bands;
    const lvL = field.cells.lvL;
    const lvR = field.cells.lvR;
    let yl = 0;
    let yr = 0;
    for (let i = 0; i < this.count; i++) {
      if (b.on[i] === 0) continue;
      const levL = field.levelAt(lvL, b.x[i]) * b.amp[i];
      const levR = field.levelAt(lvR, b.x[i]) * b.amp[i];
      const a1 = b.a1[i];
      const a2 = b.a2[i];
      const a3 = b.a3[i];
      let ic1 = b.ic1L[i];
      let ic2 = b.ic2L[i];
      let v3 = xl * levL - ic2;
      let v1 = a1 * ic1 + a2 * v3;
      let v2 = ic2 + a2 * ic1 + a3 * v3;
      b.ic1L[i] = 2 * v1 - ic1;
      b.ic2L[i] = 2 * v2 - ic2;
      yl += v1 * b.gL[i];
      ic1 = b.ic1R[i];
      ic2 = b.ic2R[i];
      v3 = xr * levR - ic2;
      v1 = a1 * ic1 + a2 * v3;
      v2 = ic2 + a2 * ic1 + a3 * v3;
      b.ic1R[i] = 2 * v1 - ic1;
      b.ic2R[i] = 2 * v2 - ic2;
      yr += v1 * b.gR[i];
    }
    out[0] = yl;
    out[1] = yr;
  }

  /**
   * What the bands are doing, for the device window's picture: each sounding band's frequency and
   * the level it is being fed at, both sides averaged - Shape's picture times the band's own `amp`.
   */
  report(field) {
    const b = this.bands;
    const hz = [];
    const level = [];
    for (let i = 0; i < this.count; i++) {
      if (b.on[i] === 0) continue;
      hz.push(b.hz[i]);
      level.push(((field.levelAt(field.cells.lvL, b.x[i]) + field.levelAt(field.cells.lvR, b.x[i])) / 2) * b.amp[i]);
    }
    return { hz, level };
  }

  playable() {
    const b = this.bands;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += b.ic1L[i] + b.ic2L[i] + b.ic1R[i] + b.ic2R[i];
    return Number.isFinite(s);
  }
}
