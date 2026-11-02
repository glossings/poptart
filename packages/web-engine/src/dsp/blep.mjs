// Band-limited steps, for any signal whose edges are jumps at known times.
//
// A square wave, a sample-and-hold, a pulse: all of them are flat stretches joined by jumps, and a
// jump drawn straight onto the sample grid has energy at every frequency, which folds back below
// half the sample rate as tones that are not in the sound. The fix is to draw each jump as a
// band-limited step - the integral of a windowed sinc - at its exact fractional time. Done as a
// correction: the plain jump goes in as it is, and the difference between it and the band-limited
// one (the residual) is added either side of it.
//
// The kernel is BLEP_HALF samples either side of the jump, so the output runs BLEP_HALF samples
// late: a jump is only known when the sample after it is reached, and its correction reaches back
// that far. The kernel cuts at half the sample rate with a Kaiser window, so the passband is flat
// to about 20 kHz at 48 kHz and what lies past 28 kHz, which is all that could fold back below
// 20 kHz, is about 80 dB down.
//
// The same windowed sinc reads a signal BETWEEN its samples (HistoryLine), which is what a
// sample-and-hold clocked off the sample grid needs: what it takes has to be the signal at its own
// tick, not the nearest sample, or the tick's timing error is noise of its own.
//
// Translated line for line in osc-engine/native/devices/own/dsp/blep.h.

/** Samples either side of a jump that its correction reaches. The output is this late. */
export const BLEP_HALF = 16;
/** Table points per sample, read with linear interpolation. */
const BLEP_PHASES = 128;
/** The Kaiser window's shape: about 80 dB of stopband. */
const BLEP_BETA = 7.86;

/** The zeroth-order modified Bessel function, by its series. */
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 32; k++) {
    term *= q / (k * k);
    sum += term;
  }
  return sum;
}

/**
 * The windowed sinc, and the band-limited unit step that is its running integral, from BLEP_HALF
 * samples before the jump to BLEP_HALF after, at BLEP_PHASES points a sample. Built once. The
 * plain step is taken off the step as it is read, by which side of the jump a sample is on -
 * interpolating across the jump itself would smear it.
 */
function buildTables() {
  const n = 2 * BLEP_HALF * BLEP_PHASES;
  const kernel = new Float64Array(n + 1);
  const i0 = besselI0(BLEP_BETA);
  for (let i = 0; i <= n; i++) {
    const x = i / BLEP_PHASES - BLEP_HALF;
    const r = x / BLEP_HALF;
    const w = besselI0(BLEP_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    kernel[i] = sinc * w;
  }
  // By trapezoids, scaled to end at exactly one.
  const step = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) step[i] = step[i - 1] + (kernel[i - 1] + kernel[i]) * 0.5;
  const total = step[n];
  for (let i = 0; i <= n; i++) step[i] /= total;
  return { kernel, step };
}

let TABLES = null;

/** The shared tables, built the first time anything asks for them. */
function tables() {
  if (TABLES === null) TABLES = buildTables();
  return TABLES;
}

/** The latest a jump can be placed before the sample it is pushed with. */
const BLEP_LAST = 1 - 1e-9;

/** Ring length: a power of two with room for the correction either side of the newest sample. */
const BLEP_RING = 64;
const BLEP_MASK = BLEP_RING - 1;

/**
 * A signal's band-limited output, BLEP_HALF samples late.
 *
 * Each sample, `jump(ago, height)` for every jump since the last sample - `ago` is how long
 * before this sample it happened, in samples, 0 <= ago < 1 - and then `push(value)` with the
 * plain signal's value at this sample, which returns the output for BLEP_HALF samples ago.
 */
export class BlepLine {
  constructor() {
    this.table = tables().step;
    this.ring = new Float64Array(BLEP_RING);
    this.n = 0;
  }

  reset() {
    this.ring.fill(0);
    this.n = 0;
  }

  /** A jump of `height`, `ago` samples before the sample about to be pushed. */
  jump(ago, height) {
    const table = this.table;
    const ring = this.ring;
    // A phase that lands on an edge to the last bit can put it a whole sample back, which is the
    // end of the last sample rather than the start of this one: kept just inside.
    if (!(ago < BLEP_LAST)) ago = BLEP_LAST;
    else if (!(ago > 0)) ago = 0;
    // Sample n + k is k + ago after the jump, and the table starts BLEP_HALF before it. From
    // k = 0 on, the sample is past the jump, so the plain step is there to take off.
    for (let k = -BLEP_HALF; k < BLEP_HALF; k++) {
      const x = (k + ago + BLEP_HALF) * BLEP_PHASES;
      const i = Math.floor(x);
      const a = table[i];
      const step = a + (table[i + 1] - a) * (x - i);
      ring[(this.n + k) & BLEP_MASK] += height * (k >= 0 ? step - 1 : step);
    }
  }

  /** The plain signal at this sample in; the band-limited one, BLEP_HALF samples ago, out. */
  push(value) {
    const ring = this.ring;
    ring[this.n & BLEP_MASK] += value;
    const at = (this.n - BLEP_HALF) & BLEP_MASK;
    const out = ring[at];
    ring[at] = 0;
    this.n += 1;
    return out;
  }
}

/**
 * A signal's recent past, read between its samples. `push(x)` each sample; `read(ago)` is the
 * signal BLEP_HALF + ago samples before the newest one (0 <= ago < 1), band-limited by the same
 * windowed sinc, and `at(BLEP_HALF)` the sample exactly that far back.
 */
export class HistoryLine {
  constructor() {
    this.kernel = tables().kernel;
    this.ring = new Float64Array(BLEP_RING);
    this.n = 0;
  }

  reset() {
    this.ring.fill(0);
    this.n = 0;
  }

  push(x) {
    this.ring[this.n & BLEP_MASK] = x;
    this.n += 1;
  }

  /** The sample `delay` whole samples before the newest. */
  at(delay) {
    return this.ring[(this.n - 1 - delay) & BLEP_MASK];
  }

  read(ago) {
    const kernel = this.kernel;
    const ring = this.ring;
    const newest = this.n - 1;
    let sum = 0;
    let weight = 0;
    // Sample newest - BLEP_HALF + k is -(ago + k) from the time being read.
    for (let k = -BLEP_HALF; k < BLEP_HALF; k++) {
      const x = (BLEP_HALF - ago - k) * BLEP_PHASES;
      const i = Math.floor(x);
      const a = kernel[i];
      const h = a + (kernel[i + 1 <= 2 * BLEP_HALF * BLEP_PHASES ? i + 1 : i] - a) * (x - i);
      sum += ring[(newest - BLEP_HALF + k) & BLEP_MASK] * h;
      weight += h;
    }
    return sum / weight;
  }
}
