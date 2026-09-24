// A feedback delay network reverb.
//
// The browser ships a convolver, which makes a very good reverb if you have an impulse response
// - and an impulse response is a file, which is somebody else's recording under somebody else's
// license, is hundreds of kilobytes, and is fixed: you cannot lengthen it, and a size control
// that resamples it changes its character with its length. For a livecoding environment where
// the decay is something you would want to pattern, an algorithmic reverb is the right shape.
//
// The design is the standard one and it is standard because it works: a short predelay, a
// diffusing chain of allpasses to smear the transient, then eight delay lines with a lossless
// feedback matrix between them, damped so the tail gets darker as it decays. The matrix is a
// Householder reflection, which is orthogonal - it redistributes energy between the lines
// without adding or removing any - so the decay is set by the damping and the feedback gain
// alone and never by an accident of the matrix.
//
// Delay lengths are coprime-ish primes. Lengths that share factors put their echoes on top of
// each other and the tail rings at that period instead of spreading out.

/** Delay-line lengths in samples at 48 kHz, scaled for other rates. Primes, spread over ~80 ms. */
const LINE_PRIMES = [1289, 1499, 1747, 1999, 2281, 2543, 2801, 3079];

/** Allpass lengths for the diffuser, also prime and much shorter. */
const ALLPASS_PRIMES = [223, 337, 457, 587];

const REFERENCE_RATE = 48000;

/**
 * Added to every value written back into the loop. A tail decays toward zero for ever, and a
 * float that gets close enough to zero is a denormal the processor handles many times slower -
 * on a thread with a deadline every three milliseconds. This is far below anything audible and
 * far above the denormal range, so the loop settles here instead.
 */
const FLOOR = 1e-20;

/** A delay line with a movable read point, sized once and never reallocated. */
export class DelayLine {
  constructor(maxSamples) {
    // A power-of-two buffer turns the wrap into a mask, which matters in a loop that runs eight
    // times per sample per channel.
    let size = 16;
    while (size < maxSamples) size *= 2;
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
    this.pos = 0;
  }

  reset() {
    this.buffer.fill(0);
    this.pos = 0;
  }

  write(v) {
    this.buffer[this.pos] = v;
    this.pos = (this.pos + 1) & this.mask;
  }

  read(delay) {
    const i = (this.pos - delay) & this.mask;
    return this.buffer[i];
  }

  /**
   * Reads at a FRACTIONAL delay, interpolating between the two samples either side.
   *
   * The modulation moves the delay lengths slowly to break up the ringing a still network
   * develops, and rounding that movement to whole samples defeats it twice over: the length
   * only ever changes in jumps, so the effect arrives as a series of small clicks rather than as
   * a drift, and at the slow rate this runs at those jumps land far enough apart to be heard
   * individually. One multiply-add per read buys a length that actually moves smoothly.
   */
  readLinear(delay) {
    const whole = Math.floor(delay);
    const frac = delay - whole;
    const a = this.buffer[(this.pos - whole) & this.mask];
    const b = this.buffer[(this.pos - whole - 1) & this.mask];
    return a + (b - a) * frac;
  }
}

/** A Schroeder allpass: passes everything at equal level but smears it in time. */
class Allpass {
  constructor(length) {
    this.line = new DelayLine(length + 4);
    this.length = length;
    this.gain = 0.6;
  }

  reset() { this.line.reset(); }

  next(x) {
    const delayed = this.line.read(this.length);
    const v = x + delayed * -this.gain;
    this.line.write(v);
    return delayed + v * this.gain;
  }
}

export class Reverb {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    const scale = sampleRate / REFERENCE_RATE;
    this.lineLengths = LINE_PRIMES.map((p) => Math.max(8, Math.round(p * scale)));
    this.lines = this.lineLengths.map((n) => new DelayLine(n + 8));
    // One diffuser per side, with the right side's lengths nudged so the two channels decorrelate
    // - a reverb whose channels are identical is a mono reverb played twice.
    this.diffuseL = ALLPASS_PRIMES.map((p) => new Allpass(Math.max(4, Math.round(p * scale))));
    this.diffuseR = ALLPASS_PRIMES.map((p) => new Allpass(Math.max(4, Math.round(p * 1.17 * scale))));

    this.feedback = new Float64Array(8);
    this.damp = new Float64Array(8);       // one-pole state per line
    this.preDelay = new DelayLine(Math.ceil(sampleRate * 0.25) + 8);
    this.preDelaySamples = 0;

    this.size = 1;
    this.decayGain = 0.8;
    this.dampCoef = 0.3;
    this.modPhase = 0;
    this.modDepth = 0;
    this.lowCutState = 0;
    this.lowCutCoef = 0;
  }

  reset() {
    for (const l of this.lines) l.reset();
    for (const a of this.diffuseL) a.reset();
    for (const a of this.diffuseR) a.reset();
    this.feedback.fill(0);
    this.damp.fill(0);
    this.preDelay.reset();
    this.lowCutState = 0;
  }

  /**
   * `decay` is the RT60 in seconds: how long the tail takes to fall by sixty decibels. Setting
   * the feedback from a real time rather than from a 0..1 knob is what makes the control mean
   * something - and what lets it stay meaningful when the size changes the delay lengths.
   */
  set({ decay, size, damping, preDelay, lowCut, modulation }) {
    if (size !== undefined) this.size = Math.min(1, Math.max(0.05, size));
    if (decay !== undefined) {
      const seconds = Math.max(0.05, decay);
      // The mean loop time of the network, which is what a round trip costs.
      const meanDelay = (this.lineLengths.reduce((a, b) => a + b, 0) / this.lineLengths.length) * this.size / this.sampleRate;
      this.decayGain = Math.min(0.9999, Math.pow(10, (-3 * meanDelay) / seconds));
    }
    if (damping !== undefined) {
      const hz = Math.min(this.sampleRate * 0.49, Math.max(200, damping));
      this.dampCoef = 1 - Math.exp((-2 * Math.PI * hz) / this.sampleRate);
    }
    if (preDelay !== undefined) {
      this.preDelaySamples = Math.min(this.preDelay.mask - 4, Math.max(0, Math.round(preDelay * this.sampleRate)));
    }
    if (lowCut !== undefined) {
      const hz = Math.min(2000, Math.max(10, lowCut));
      this.lowCutCoef = 1 - Math.exp((-2 * Math.PI * hz) / this.sampleRate);
    }
    if (modulation !== undefined) this.modDepth = Math.max(0, modulation) * 12;
  }

  /**
   * Renders one block into the outputs.
   *
   * The feedback matrix is a Householder reflection: each line gets back the sum of all of them
   * minus twice its own share. Written out as one sum and eight subtractions rather than as a
   * real matrix multiply, which is the same arithmetic and an eighth of the work.
   */
  process(inL, inR, outL, outR, count) {
    const lines = this.lines;
    const lengths = this.lineLengths;
    const fb = this.feedback;
    const damp = this.damp;
    const size = this.size;
    const g = this.decayGain;
    const dampCoef = this.dampCoef;
    const modRate = (2 * Math.PI * 0.7) / this.sampleRate;

    for (let i = 0; i < count; i++) {
      const dry = (inL[i] + inR[i]) * 0.5;
      this.preDelay.write(dry);
      let x = this.preDelaySamples > 0 ? this.preDelay.read(this.preDelaySamples) : dry;

      let l = x;
      let r = x;
      for (const a of this.diffuseL) l = a.next(l);
      for (const a of this.diffuseR) r = a.next(r);

      this.modPhase += modRate;
      if (this.modPhase > Math.PI * 2) this.modPhase -= Math.PI * 2;

      // Read every line, damp it, and sum for the matrix.
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const wobble = this.modDepth > 0 ? this.modDepth * Math.sin(this.modPhase + k) : 0;
        const want = lengths[k] * size + wobble;
        const delay = Math.min(lines[k].mask - 2, Math.max(2, want));
        let v = this.modDepth > 0 ? lines[k].readLinear(delay) : lines[k].read(Math.round(delay));
        // A one-pole in each loop: the tail loses its top as it goes round, which is what stops
        // an algorithmic reverb sounding like a metal pipe.
        damp[k] += dampCoef * (v - damp[k]);
        v = damp[k];
        fb[k] = v;
        sum += v;
      }
      const share = (2 / 8) * sum;

      for (let k = 0; k < 8; k++) {
        const routed = (fb[k] - share) * g;
        // The input goes in on alternate lines from each side, so the two channels stay apart.
        lines[k].write(routed + (k % 2 === 0 ? l : r) * 0.25 + FLOOR);
      }

      // Two different sums for the two outputs, so the result is genuinely stereo.
      let wetL = 0;
      let wetR = 0;
      for (let k = 0; k < 8; k++) {
        if (k % 2 === 0) wetL += fb[k]; else wetR += fb[k];
      }
      wetL *= 0.25;
      wetR *= 0.25;

      // A reverb with a DC or sub-bass build-up gets muddy and never stops, so the tail is
      // high-passed on the way out rather than being left to accumulate in the loop.
      const mono = (wetL + wetR) * 0.5;
      this.lowCutState += this.lowCutCoef * (mono - this.lowCutState);
      outL[i] = wetL - this.lowCutState;
      outR[i] = wetR - this.lowCutState;
    }
  }
}
