// A metallic source: six square waves at inharmonic frequencies, summed.
//
// Squares at ratios no small whole numbers relate give a dense cluster of odd harmonics that never
// line up into a pitch, which is the raw tone of an analog hi-hat or cymbal. Two of them alone
// are a cowbell. Each square's edges are drawn band-limited (see blep.mjs), so the cluster stays
// clean however high it is tuned; the output is BLEP_HALF samples late.
//
// Translated line for line in osc-engine/native/devices/own/dsp/metal.h.

import { BlepLine } from './blep.mjs';

/** The six frequencies, in hertz, at middle C. */
export const METAL_HZ = Object.freeze([205.3, 304.4, 369.6, 522.7, 540, 800]);
export const METAL_COUNT = 6;
/**
 * The fold's sine, in half-turns across the full swing: not a whole number, so the swing's ends
 * do not fold back onto zero.
 */
const METAL_FOLD_TURNS = 1.37;

/**
 * The fold, from straight (0) to its full shape (1): a sine fold, which crosses odd numbers of
 * squares, plus a square law, which crosses them in pairs - a pair of squares times each other is
 * the ring-modulated tone of two oscillators gated against each other.
 */
export function metalFold(x, warp) {
  return x + warp * (Math.sin(METAL_FOLD_TURNS * Math.PI * x) + x * x - x);
}

export class MetalSource {
  /**
   * `hz`: the six frequencies the source plays at a ratio of one. `width`: how much of each cycle
   * is high. Half is a square with odd harmonics only; a little off half adds the even ones.
   */
  constructor(sampleRate, hz = METAL_HZ, width = 0.5) {
    this.sampleRate = sampleRate;
    this.hz = Float64Array.from(hz);
    this.width = width;
    this.phase = new Float64Array(METAL_COUNT);
    this.line = new BlepLine();
    // A sample's edges, for the folded sum: when, and by how much the plain sum moved.
    this.edgeAgo = new Float64Array(3 * METAL_COUNT);
    this.edgeStep = new Float64Array(3 * METAL_COUNT);
  }

  reset() {
    this.phase.fill(0);
    this.line.reset();
  }

  /**
   * The next sample: every square at `ratio` times its frequency, each at its level in `levels`
   * (one per square, its peak). A square past half the sample rate is left out.
   */
  next(ratio, levels) {
    const line = this.line;
    let value = 0;
    for (let k = 0; k < METAL_COUNT; k++) {
      const dt = (this.hz[k] * ratio) / this.sampleRate;
      const level = levels[k];
      if (dt >= 0.5 || dt <= 0) continue;
      const w = this.width;
      const from = this.phase[k];
      let t = from + dt;
      // The fall partway through the cycle, then the rise at the wrap, each at its exact time.
      if (from < w && t >= w) line.jump((t - w) / dt, -2 * level);
      if (t >= 1) {
        t -= 1;
        line.jump(t / dt, 2 * level);
        if (t >= w) line.jump((t - w) / dt, -2 * level);
      }
      this.phase[k] = t;
      value += t < w ? level : -level;
    }
    return line.push(value);
  }

  /**
   * As next(), with the sum folded by `warp` (metalFold) before it is drawn. Folding the cluster
   * crosses its squares into each other - sums and differences of their frequencies, a denser,
   * clangier metal - and the folded sum is still flat between edges, so it is drawn exactly as
   * band-limited: every edge is a jump of the FOLDED sum, taken in the order the edges fall.
   */
  nextFolded(ratio, levels, warp) {
    if (!(warp > 0)) return this.next(ratio, levels);
    const line = this.line;
    const ago = this.edgeAgo;
    const step = this.edgeStep;
    const w = this.width;
    let before = 0;
    let value = 0;
    let n = 0;
    for (let k = 0; k < METAL_COUNT; k++) {
      const dt = (this.hz[k] * ratio) / this.sampleRate;
      const level = levels[k];
      if (dt >= 0.5 || dt <= 0) continue;
      const from = this.phase[k];
      before += from < w ? level : -level;
      let t = from + dt;
      if (from < w && t >= w) { ago[n] = (t - w) / dt; step[n] = -2 * level; n++; }
      if (t >= 1) {
        t -= 1;
        ago[n] = t / dt; step[n] = 2 * level; n++;
        if (t >= w) { ago[n] = (t - w) / dt; step[n] = -2 * level; n++; }
      }
      this.phase[k] = t;
      value += t < w ? level : -level;
    }
    // Earliest first: the furthest back.
    for (let i = 1; i < n; i++) {
      const a = ago[i];
      const d = step[i];
      let j = i - 1;
      while (j >= 0 && ago[j] < a) { ago[j + 1] = ago[j]; step[j + 1] = step[j]; j--; }
      ago[j + 1] = a;
      step[j + 1] = d;
    }
    let sum = before;
    let folded = metalFold(sum, warp);
    for (let i = 0; i < n; i++) {
      sum += step[i];
      const next = metalFold(sum, warp);
      line.jump(ago[i], next - folded);
      folded = next;
    }
    return line.push(metalFold(value, warp));
  }
}
