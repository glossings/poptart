// Oversampling for the waveshapers.
//
// A waveshaper generates harmonics that were not in its input - that is what it is for - and
// the ones it generates above half the sample rate have nowhere to go but back down into the
// audible range, as inharmonic tones that move the wrong way when the pitch changes. It is the
// single thing that makes cheap distortion sound cheap, and it gets worse exactly where people
// turn the knob: hard clipping a bright sound.
//
// Running the curve at two or four times the rate does not remove those harmonics, it moves the
// ceiling up so that most of them land below it and can be filtered off on the way back down.
// It is not free and it is not perfect, which is why it is a control rather than always-on: at
// 1x this whole file is bypassed.

/**
 * A windowed-sinc half-band lowpass, cutting at a quarter of the oversampled rate - which is
 * exactly the Nyquist rate of the signal underneath. Thirty-two taps is enough for about 80 dB
 * of rejection, well under the noise floor of anything this will be used on.
 */
function halfBandTaps(length = 32) {
  const taps = new Float64Array(length);
  const middle = (length - 1) / 2;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const n = i - middle;
    // sinc at a cutoff of a quarter of the sample rate
    const sinc = n === 0 ? 0.5 : Math.sin(Math.PI * 0.5 * n) / (Math.PI * n);
    // Blackman window - the stopband matters more here than the transition width
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (length - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < length; i++) taps[i] /= sum;
  return taps;
}

const TAPS = halfBandTaps(32);

/**
 * One 2x stage: `up` writes two samples for every one in, `down` reads two and returns one.
 *
 * Both directions run as POLYPHASE branches - the filter split into its even and odd taps - so
 * neither pays for multiplying by the zeros that zero-stuffing would otherwise insert. The two
 * directions keep separate delay lines because they are separate filters in the signal path,
 * one before the curve and one after it.
 */
export class Stage2x {
  constructor() {
    const half = TAPS.length / 2;
    this.even = new Float64Array(half);
    this.odd = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      // Gain of two on the way up, to make back what zero-stuffing halves.
      this.even[k] = TAPS[2 * k] * 2;
      this.odd[k] = TAPS[2 * k + 1] * 2;
    }
    this.upLine = new Float64Array(half);
    this.downEven = new Float64Array(half);
    this.downOdd = new Float64Array(half);
  }

  reset() {
    this.upLine.fill(0);
    this.downEven.fill(0);
    this.downOdd.fill(0);
  }

  /** Writes `count * 2` samples into `out` from `count` samples of `input`. */
  up(input, out, count) {
    const line = this.upLine;
    const half = line.length;
    const even = this.even;
    const odd = this.odd;
    for (let i = 0; i < count; i++) {
      // Shift in. The lines are short enough that moving them beats the arithmetic of a ring
      // buffer's wrapped indexing in the inner loop.
      for (let k = half - 1; k > 0; k--) line[k] = line[k - 1];
      line[0] = input[i];
      let a = 0;
      let b = 0;
      for (let k = 0; k < half; k++) {
        a += even[k] * line[k];
        b += odd[k] * line[k];
      }
      out[i * 2] = a;
      out[i * 2 + 1] = b;
    }
  }

  /** Reads `count * 2` samples from `input` and writes `count` samples into `out`. */
  down(input, out, count) {
    const lineE = this.downEven;
    const lineO = this.downOdd;
    const half = lineE.length;
    const even = this.even;
    const odd = this.odd;
    for (let i = 0; i < count; i++) {
      for (let k = half - 1; k > 0; k--) { lineE[k] = lineE[k - 1]; lineO[k] = lineO[k - 1]; }
      lineE[0] = input[i * 2];
      lineO[0] = input[i * 2 + 1];
      let acc = 0;
      for (let k = 0; k < half; k++) acc += even[k] * lineE[k] + odd[k] * lineO[k];
      // The gain of two belongs to the upsampler only; undo it here.
      out[i] = acc * 0.5;
    }
  }
}

/**
 * A 1x, 2x or 4x oversampled section. At 1x it calls the curve straight through and allocates
 * nothing, which is what keeps the cheap setting actually cheap.
 */
export class Oversampler {
  constructor(maxBlock = 256) {
    this.maxBlock = maxBlock;
    this.stageA = new Stage2x();
    this.stageB = new Stage2x();
    this.bufA = new Float64Array(maxBlock * 2);
    this.bufB = new Float64Array(maxBlock * 4);
    this.factor = 1;
  }

  reset() {
    this.stageA.reset();
    this.stageB.reset();
  }

  setFactor(factor) {
    const f = factor >= 4 ? 4 : factor >= 2 ? 2 : 1;
    if (f !== this.factor) {
      this.factor = f;
      this.reset();
    }
    return this.factor;
  }

  ensure(count) {
    if (this.bufA.length < count * 2) this.bufA = new Float64Array(count * 2);
    if (this.bufB.length < count * 4) this.bufB = new Float64Array(count * 4);
  }

  /**
   * Runs `fn` over the block at the chosen rate. `fn(value, index)` gets each oversampled
   * sample; the index is into the ORIGINAL block, so a per-sample parameter can still be read
   * without being resampled itself.
   */
  process(input, output, count, fn) {
    if (this.factor === 1) {
      for (let i = 0; i < count; i++) output[i] = fn(input[i], i);
      return;
    }
    this.ensure(count);
    const a = this.bufA;
    this.stageA.up(input, a, count);
    if (this.factor === 2) {
      for (let i = 0; i < count * 2; i++) a[i] = fn(a[i], i >> 1);
      this.stageA.down(a, output, count);
      return;
    }
    const b = this.bufB;
    this.stageB.up(a, b, count * 2);
    for (let i = 0; i < count * 4; i++) b[i] = fn(b[i], i >> 2);
    this.stageB.down(b, a, count * 2);
    this.stageA.down(a, output, count);
  }
}
