// A biquad, with the cookbook coefficients every equalizer band is made of.
//
// The one formula lives here for two readers: the DSP that filters, and the figure that draws
// what the DSP does. The equalizer's picture is the summed magnitude of its bands computed from
// these same coefficients, so the curve on the panel cannot disagree with the sound.

/** The responses a band can take, in panel order. The index is what a descriptor's enum stores. */
export const BIQUAD_TYPES = Object.freeze([
  'peak', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass',
]);

/**
 * Coefficients for one response at `hz`, with `gainDb` (read by the peak and shelf types) and
 * `q`. Written into `out` (six numbers: b0 b1 b2 a1 a2, normalized by a0, plus a0 for the
 * figure) so the hot path allocates nothing.
 */
export function biquadCoefficients(type, hz, gainDb, q, sampleRate, out) {
  const f = Math.min(sampleRate * 0.49, Math.max(1, hz));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const Q = Math.max(0.05, q);
  const alpha = sinw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (BIQUAD_TYPES[type] ?? 'peak') {
    case 'lowpass':
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cosw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cosw; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosw + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
      b2 = A * ((A + 1) - (A - 1) * cosw - s);
      a0 = (A + 1) + (A - 1) * cosw + s;
      a1 = -2 * ((A - 1) + (A + 1) * cosw);
      a2 = (A + 1) + (A - 1) * cosw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosw + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      b2 = A * ((A + 1) + (A - 1) * cosw - s);
      a0 = (A + 1) - (A - 1) * cosw + s;
      a1 = 2 * ((A - 1) - (A + 1) * cosw);
      a2 = (A + 1) - (A - 1) * cosw - s;
      break;
    }
    default: // peak
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A;
  }
  out[0] = b0 / a0; out[1] = b1 / a0; out[2] = b2 / a0; out[3] = a1 / a0; out[4] = a2 / a0;
  return out;
}

/** The magnitude of a biquad at `hz`, from its normalized coefficients. */
export function biquadMagnitude(c, hz, sampleRate) {
  const w = (2 * Math.PI * hz) / sampleRate;
  const cos1 = Math.cos(w);
  const cos2 = Math.cos(2 * w);
  const sin1 = Math.sin(w);
  const sin2 = Math.sin(2 * w);
  const nRe = c[0] + c[1] * cos1 + c[2] * cos2;
  const nIm = -(c[1] * sin1 + c[2] * sin2);
  const dRe = 1 + c[3] * cos1 + c[4] * cos2;
  const dIm = -(c[3] * sin1 + c[4] * sin2);
  return Math.hypot(nRe, nIm) / Math.max(1e-12, Math.hypot(dRe, dIm));
}

/** One biquad section, transposed direct form II, for one channel. */
export class Biquad {
  constructor() {
    this.c = new Float64Array(5);
    this.c[0] = 1;
    // Where the coefficients are HEADING, and how far through the glide they are. A filter that
    // jumped straight to a new set on every block is the zipper noise that turns up wherever a
    // frequency is swept - see glideTo.
    this.target = new Float64Array(5);
    this.target[0] = 1;
    this.steps = 0;
    this.z1 = 0;
    this.z2 = 0;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }

  /** Jumps the coefficients, with no glide: a fresh filter, or one whose settings never move. */
  set(type, hz, gainDb, q, sampleRate) {
    biquadCoefficients(type, hz, gainDb, q, sampleRate, this.c);
    this.target.set(this.c);
    this.steps = 0;
  }

  /**
   * Aims the coefficients at a new setting, to be reached over `steps` samples.
   *
   * THIS IS WHAT STOPS A SWEPT FILTER ZIPPERING. Recomputing the coefficients once a block and
   * using them for all of it steps the response a hundred and fifty times a second, which is
   * heard as a buzz riding the sweep - and recomputing them per sample costs a handful of
   * transcendentals per sample per band, which for a four-band equalizer is not affordable. So
   * the coefficients are computed once a block and WALKED there across it, which is inaudible
   * and costs five additions a sample.
   *
   * Interpolating coefficients rather than frequencies is safe here because every step is a
   * small one: these filters are being dragged by a hand or an envelope, not teleported, and a
   * block is under three milliseconds of travel.
   */
  glideTo(type, hz, gainDb, q, sampleRate, steps) {
    biquadCoefficients(type, hz, gainDb, q, sampleRate, this.target);
    this.steps = Math.max(0, steps | 0);
    if (this.steps === 0) this.c.set(this.target);
  }

  /** Takes another section's coefficients and its glide, for the other channel of a pair. */
  follow(other) {
    this.c.set(other.c);
    this.target.set(other.target);
    this.steps = other.steps;
  }

  next(x) {
    const c = this.c;
    if (this.steps > 0) {
      const k = 1 / this.steps;
      for (let i = 0; i < 5; i++) c[i] += (this.target[i] - c[i]) * k;
      this.steps -= 1;
    }
    const y = c[0] * x + this.z1;
    this.z1 = c[1] * x - c[3] * y + this.z2;
    this.z2 = c[2] * x - c[4] * y;
    return y;
  }
}

/**
 * A Linkwitz-Riley crossover of fourth order: two Butterworth biquads in cascade each way, so
 * the low and high halves sum back to flat. Used wherever a signal is split into bands.
 */
export class Crossover {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.lo = [new Biquad(), new Biquad()];
    this.hi = [new Biquad(), new Biquad()];
    this.setFrequency(1000);
  }

  setFrequency(hz, steps = 0) {
    const q = Math.SQRT1_2;
    const lowpass = BIQUAD_TYPES.indexOf('lowpass');
    const highpass = BIQUAD_TYPES.indexOf('highpass');
    for (const b of this.lo) b.glideTo(lowpass, hz, 0, q, this.sampleRate, steps);
    for (const b of this.hi) b.glideTo(highpass, hz, 0, q, this.sampleRate, steps);
  }

  follow(other) {
    for (let i = 0; i < 2; i++) { this.lo[i].follow(other.lo[i]); this.hi[i].follow(other.hi[i]); }
  }

  reset() {
    for (const b of this.lo) b.reset();
    for (const b of this.hi) b.reset();
  }

  /** Splits one sample; the two parts are written to `out[0]` (low) and `out[1]` (high). */
  split(x, out) {
    out[0] = this.lo[1].next(this.lo[0].next(x));
    out[1] = this.hi[1].next(this.hi[0].next(x));
  }
}
