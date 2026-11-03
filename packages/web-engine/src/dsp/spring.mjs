// A spring reverb tank, modeled on its sound rather than its physics.
//
// What makes a spring sound like a spring is dispersion: a click sent down the wire arrives as a
// chirp, because different frequencies take different times to cross it. Below the spring's
// transition frequency the highs arrive last, so every echo is a rising chirp that bends up into
// the transition frequency, and each trip round the tank bends it further. Above the transition
// frequency there is a much quieter series of chirps across the whole band, the lows arriving
// last.
//
// The model is the parametric one from the literature (Välimäki, Parker and Abel, "Parametric
// spring reverberation effect", JAES 2010; Parker, "Efficient dispersion generation structures
// for spring reverb emulation", EURASIP 2011): each series is a feedback loop holding a delay
// line and a long cascade of first-order allpasses. In the main series each allpass has its unit
// delay stretched to k samples, which puts its peak group delay at fs / 2k - the transition
// frequency - and mirrors the curve above it, so that loop's output is low-passed at the
// transition frequency. The second series uses plain allpasses with a negative coefficient,
// which delay the lows most. Each chirp has a small copy of itself a fifth of a trip in front of
// it, as a real tank's does where the spring meets its mount; that copy is made on the way out
// rather than in the loop, where it would cost the tail level on every trip and shorten the
// decay. The delay is moved by a slow random wander, as a hanging spring is.
//
// Past what a real tank can do: the stretch is fractional (a whole-sample delay and a first-order
// allpass for the rest), so the transition frequency glides and bends what is already in the
// springs; a negative coefficient turns the chirps over so they fall; the loop gain can be pushed
// past one, with a saturator in each loop holding the result; and a shake knocks the tank with a
// thump and a burst of noise, through the driver. Notes routed in play it: each one glides the
// transition frequency to the note's and pings the tank with the burst alone, as loud as its
// velocity.
//
// A tank has two springs here, one per side, of slightly different lengths. Everything is in
// double precision and every random number comes from a fixed generator, so the desktop's
// translation (osc-engine/native/devices/own/dsp/spring.h) can be held to it sample for sample.

/** Allpasses in the main chain and in the full-band one. */
export const LF_STAGES = 100;
export const HF_STAGES = 80;

/** The transition frequency's range, in Hz. The low end sets the longest stretch. */
export const MIN_TRANSITION = 100;
export const MAX_TRANSITION = 8000;

/** The most loop gain Feedback asks for: past one the loop's saturator is what holds it. */
export const MAX_FEEDBACK = 1.5;

/** The longest round trip the Length control asks for, in seconds. */
export const MAX_LENGTH = 0.12;

/** How much longer the right spring is than the left, and its full-band loop than its own. */
const SPRING_RATIOS = [1, 1.127];
const HF_RATIOS = [0.53, 0.61];
/** How fast each spring's delay wanders, in Hz, and the seed of its wander. */
const WANDER_HZ = [2.3, 1.7];
const SEEDS = [0x9e3779b9, 0x7f4a7c15];

/** How far in front of each chirp its small copy sits, as a share of the round trip, and its level. */
export const ECHO_AHEAD = 0.2;
export const ECHO_GAIN = 0.12;

/** The full-band series' level against the main one. */
export const HF_LEVEL = 0.035;

/** The deepest the wander moves the delay, in seconds, at Modulation 1. */
const MAX_WANDER = 0.0015;

/**
 * The wet signal's level. MEASURED: with this a sustained input at the defaults sits about six
 * decibels under the dry signal, as the Reverb's does, so the middle of Mix means something.
 */
const WET_GAIN = 0.86;

/** How long the transition frequency takes to glide to a new value, in seconds. */
const GLIDE = 0.02;

/** The most the main chain's coefficient reaches, at Chirp 1 or -1. */
const MAX_COEFFICIENT = 0.9;

/** A shake: a half-sine thump this long, under a burst of noise falling away this fast. */
const SHAKE_THUMP = 0.008;
const SHAKE_FALL = 0.012;
const SHAKE_THUMP_LEVEL = 1.4;
const SHAKE_NOISE_LEVEL = 0.9;
const SHAKE_LENGTH = 0.25;
const SHAKE_SEED = 0x2545f491;

/** Added to everything written into a loop, so a dying tail settles here and not in denormals. */
const SPRING_FLOOR = 1e-20;

/** Q of each section of an eighth-order Butterworth low-pass. */
const BUTTERWORTH_8 = [0.5097955791, 0.6013448869, 0.8999762231, 2.5629154477];

/** A delay line of doubles, with a fractional read. */
class Line {
  constructor(maxSamples) {
    let size = 16;
    while (size < maxSamples) size *= 2;
    this.buffer = new Float64Array(size);
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
    const whole = Math.floor(delay);
    const frac = delay - whole;
    const a = this.buffer[(this.pos - whole) & this.mask];
    const b = this.buffer[(this.pos - whole - 1) & this.mask];
    return a + (b - a) * frac;
  }
}

/** A cascade of identical plain first-order allpasses: (a + z^-1) / (1 + a z^-1). */
class PlainChain {
  constructor(stages) {
    this.stages = stages;
    this.state = new Float64Array(stages);
  }

  reset() { this.state.fill(0); }

  next(x, a) {
    const s = this.state;
    let v = x;
    for (let m = 0; m < this.stages; m++) {
      const old = s[m];
      const w = v - a * old;
      s[m] = w;
      v = a * w + old;
    }
    return v;
  }
}

/**
 * A cascade of identical first-order allpasses with their delay stretched to k samples, k need
 * not be whole: (a + D(z)) / (1 + a D(z)), where D is `whole` samples of delay and a first-order
 * allpass, coefficient `eta`, for the fraction between a half and one and a half samples. D is an
 * allpass, so every stage still is, and k can move while the chain is full.
 *
 * Every stage advances together: one write position, and stage m's history at m * size.
 */
export class StretchedChain {
  constructor(stages, maxStretch) {
    this.stages = stages;
    this.size = maxStretch + 3;
    this.state = new Float64Array(stages * this.size);
    this.frac = new Float64Array(stages);
    this.pos = 0;
  }

  reset() {
    this.state.fill(0);
    this.frac.fill(0);
    this.pos = 0;
  }

  next(x, a, whole, eta) {
    const s = this.state;
    const f = this.frac;
    const size = this.size;
    const pos = this.pos;
    let r0 = pos - whole;
    if (r0 < 0) r0 += size;
    let r1 = r0 - 1;
    if (r1 < 0) r1 += size;
    let v = x;
    for (let m = 0, base = 0; m < this.stages; m++, base += size) {
      const d = eta * s[base + r0] + s[base + r1] - eta * f[m];
      f[m] = d;
      const w = v - a * d;
      s[base + pos] = w;
      v = a * w + d;
    }
    this.pos = pos + 1 === size ? 0 : pos + 1;
    return v;
  }
}

/** One biquad section, transposed direct form II, with its coefficients set from outside. */
class Section {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  reset() { this.z1 = 0; this.z2 = 0; }

  lowpass(hz, q, sampleRate) {
    const w = (2 * Math.PI * hz) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  highpass(hz, q, sampleRate) {
    const w = (2 * Math.PI * hz) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** Its gain at `w` radians a sample, from the coefficients it is filtering with. */
  gain(w) {
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2;
    const ni = -this.b1 * s1 - this.b2 * s2;
    const dr = 1 + this.a1 * c1 + this.a2 * c2;
    const di = -this.a1 * s1 - this.a2 * s2;
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  next(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/**
 * How long a cascade of `stages` allpasses (a + z^-k) / (1 + a z^-k) holds `w` radians a sample,
 * in samples: its group delay, which is where in time each frequency of a chirp comes out.
 */
export function chainDelay(a, stretch, stages, w) {
  return (stages * stretch * (1 - a * a)) / (1 + 2 * a * Math.cos(w * stretch) + a * a);
}

/** The gain at `w` of the one-pole lowpass y += k (x - y), the damping in each loop. */
export function dampingGain(k, w) {
  return k / Math.sqrt(1 - 2 * (1 - k) * Math.cos(w) + (1 - k) * (1 - k));
}

/**
 * A slow random wander between -1 and 1: a new target every 1/hz seconds, eased toward with a
 * smoothstep so it never turns a corner. xorshift32, so the desktop draws the same numbers.
 */
class Wander {
  constructor(sampleRate, hz, seed) {
    this.period = Math.max(1, Math.round(sampleRate / hz));
    this.seed0 = seed >>> 0;
    this.reset();
  }

  reset() {
    this.seed = this.seed0;
    this.from = 0;
    this.to = this.random();
    this.count = 0;
  }

  random() {
    let x = this.seed;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.seed = x;
    return (x / 4294967296) * 2 - 1;
  }

  next() {
    if (this.count >= this.period) {
      this.from = this.to;
      this.to = this.random();
      this.count = 0;
    }
    const t = this.count / this.period;
    this.count++;
    return this.from + (this.to - this.from) * (t * t * (3 - 2 * t));
  }
}

/** One spring: the main chirp series and the full-band one, each a loop of its own. */
class Spring {
  constructor(sampleRate, maxStretch, index) {
    this.sampleRate = sampleRate;
    this.ratio = SPRING_RATIOS[index];
    this.hfRatio = HF_RATIOS[index];
    const longest = Math.ceil(sampleRate * (MAX_LENGTH * this.ratio + MAX_WANDER)) + 8;
    this.lfLine = new Line(longest);
    this.hfLine = new Line(longest);
    this.echoLine = new Line(Math.ceil(longest * ECHO_AHEAD) + 8);
    this.lf = new StretchedChain(LF_STAGES, maxStretch);
    this.hf = new PlainChain(HF_STAGES);
    this.wander = new Wander(sampleRate, WANDER_HZ[index], SEEDS[index]);
    this.lowpass = BUTTERWORTH_8.map(() => new Section());
    this.outLowpass = BUTTERWORTH_8.map(() => new Section());
    this.lowcut = new Section();
    this.lfDamp = 0;
    this.hfDamp = 0;
    this.lfBack = 0;
    this.hfBack = 0;
    // Set by Spring.set: the delays in samples, the loop gains and the coefficients.
    this.lfDelay = 1000;
    this.hfDelay = 500;
    this.lfGain = 0;
    this.hfGain = 0;
    this.aLf = 0.5;
    this.aHf = -0.5;
    this.dampCoef = 0.5;
    this.depth = 0;
  }

  reset() {
    this.lfLine.reset();
    this.hfLine.reset();
    this.echoLine.reset();
    this.lf.reset();
    this.hf.reset();
    this.wander.reset();
    for (const s of this.lowpass) s.reset();
    for (const s of this.outLowpass) s.reset();
    this.lowcut.reset();
    this.lfDamp = 0;
    this.hfDamp = 0;
    this.lfBack = 0;
    this.hfBack = 0;
  }

  set(c) {
    const sr = this.sampleRate;
    this.aLf = c.aLf;
    this.aHf = c.aHf;
    this.lfDelay = Math.max(4, c.length * this.ratio * sr);
    this.hfDelay = Math.max(4, c.length * this.hfRatio * sr);
    this.depth = c.depth;
    // A round trip is the delay and the chain's mean group delay, which is one sample per stage
    // per sample of stretch; the loop gain takes sixty decibels off over the decay time, unless
    // Feedback asks for more.
    const lfTrip = (this.lfDelay + c.stretch * LF_STAGES) / sr;
    const hfTrip = (this.hfDelay + HF_STAGES) / sr;
    this.lfGain = Math.max(c.feedback, Math.min(0.9995, Math.pow(10, (-3 * lfTrip) / c.decay)));
    this.hfGain = Math.max(c.feedback, Math.min(0.9995, Math.pow(10, (-3 * hfTrip) / c.decay)));
    this.dampCoef = c.dampCoef;
    // The low-pass sits at the frequency the stretch is at.
    const top = Math.min(sr * 0.45, sr / (2 * c.stretch));
    for (let s = 0; s < this.lowpass.length; s++) {
      this.lowpass[s].lowpass(top, BUTTERWORTH_8[s], sr);
      this.outLowpass[s].lowpass(top, BUTTERWORTH_8[s], sr);
    }
    this.lowcut.highpass(c.lowCut, Math.SQRT1_2, sr);
  }

  next(x, whole, eta) {
    const wobble = this.depth * this.wander.next();

    // The main series: round the delay, then the chain.
    this.lfLine.write(x + this.lfBack + SPRING_FLOOR);
    const arrived = this.lfLine.read(this.lfDelay + wobble);
    // The stretched chain mirrors its chirps above the transition frequency. The low-pass is in
    // the loop, so a mirrored chirp is cut again on every trip rather than going round with the
    // real ones.
    let lf = this.lf.next(arrived, this.aLf, whole, eta);
    for (let s = 0; s < this.lowpass.length; s++) lf = this.lowpass[s].next(lf);
    this.lfDamp += this.dampCoef * (lf - this.lfDamp);
    // The saturator holds a loop pushed past one; at the levels a decaying tail runs at it is
    // all but straight.
    this.lfBack = Math.tanh(this.lfDamp * this.lfGain);

    // The full-band series: a shorter loop, a plain chain.
    this.hfLine.write(x + this.hfBack + SPRING_FLOOR);
    const hf = this.hf.next(this.hfLine.read(this.hfDelay + wobble * 0.5), this.aHf);
    this.hfDamp += this.dampCoef * (hf - this.hfDamp);
    this.hfBack = Math.tanh(this.hfDamp * this.hfGain);

    // Once more on the way out, so the first trip is as clean above the transition as the rest.
    let low = lf;
    for (let s = 0; s < this.outLowpass.length; s++) low = this.outLowpass[s].next(low);
    // The chirps go out a fifth of a trip late, with their small copy at the time they came.
    this.echoLine.write(low);
    const main = this.echoLine.read(this.lfDelay * ECHO_AHEAD) + ECHO_GAIN * low;
    return this.lowcut.next(main + HF_LEVEL * hf);
  }
}

/** The tank: two springs fed the same mono signal through a saturating driver. */
export class SpringTank {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.maxStretch = Math.ceil(sampleRate / (2 * MIN_TRANSITION));
    this.springs = [new Spring(sampleRate, this.maxStretch, 0), new Spring(sampleRate, this.maxStretch, 1)];
    this.glide = 1 - Math.exp(-1 / (GLIDE * sampleRate));
    this.thump = Math.max(1, Math.round(SHAKE_THUMP * sampleRate));
    this.fall = SHAKE_FALL * sampleRate;
    this.shakeLength = Math.round(SHAKE_LENGTH * sampleRate);
    this.reset();
  }

  reset() {
    for (const s of this.springs) s.reset();
    this.stretch = 0; // none yet: the first set() lands on its value rather than gliding to it
    this.target = 2;
    this.shakeAt = -1;
    this.shakeLevel = 1;
    this.shakeThump = true;
    this.shakeSeed = SHAKE_SEED;
  }

  /** The stretch a transition frequency asks for, in samples. Not whole: it glides. */
  stretchFor(hz) {
    const f = Math.min(MAX_TRANSITION, Math.max(MIN_TRANSITION, hz));
    return Math.max(2, Math.min(this.maxStretch, this.sampleRate / (2 * f)));
  }

  /**
   * Sets the tank's geometry, once a block. `decay` is an RT60 in seconds, `length` the left
   * spring's round trip in seconds, `chirp` -1..1, `transition` and `damping` and `lowCut` in Hz,
   * `modulation` 0..1, `feedback` the loop gain to hold at the least, 0..MAX_FEEDBACK.
   */
  set({ decay, length, chirp, transition, modulation, damping, lowCut, feedback }) {
    const sr = this.sampleRate;
    const c = Math.min(1, Math.max(-1, chirp));
    const dampHz = Math.min(sr * 0.45, Math.max(200, damping));
    this.target = this.stretchFor(transition);
    if (this.stretch === 0) this.stretch = this.target;
    const settings = {
      stretch: this.stretch,
      aLf: MAX_COEFFICIENT * c,
      aHf: -(0.3 + 0.4 * Math.abs(c)),
      length: Math.min(MAX_LENGTH, Math.max(0.01, length)),
      decay: Math.max(0.05, decay),
      feedback: Math.min(MAX_FEEDBACK, Math.max(0, feedback)),
      depth: Math.min(1, Math.max(0, modulation)) * MAX_WANDER * sr,
      dampCoef: 1 - Math.exp((-2 * Math.PI * dampHz) / sr),
      lowCut: Math.min(sr * 0.45, Math.max(10, lowCut)),
    };
    for (const s of this.springs) s.set(settings);
  }

  /** The shake's noise: xorshift32, as the wander's. */
  shakeNoise() {
    let x = this.shakeSeed;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.shakeSeed = x;
    return (x / 4294967296) * 2 - 1;
  }

  /** Glides to a new transition frequency now, rather than at the next set(). */
  retune(hz) {
    this.target = this.stretchFor(hz);
  }

  /**
   * Knocks the tank from the next sample: the burst of noise as loud as `level`, with the thump
   * under it or not. A press of Shake has it; a note does not, so its ping is the springs' own
   * sweep up to the note rather than a thud under it.
   */
  knock(level, thump) {
    this.shakeAt = 0;
    this.shakeLevel = level;
    this.shakeThump = thump;
  }

  /** One sample into the driver; the springs' outputs, wet only. */
  next(x, drive, out) {
    let input = x;
    if (this.shakeAt >= 0) {
      const t = this.shakeAt;
      input += this.shakeLevel * SHAKE_NOISE_LEVEL * this.shakeNoise() * Math.exp(-t / this.fall);
      if (this.shakeThump && t < this.thump) input += this.shakeLevel * SHAKE_THUMP_LEVEL * Math.sin((Math.PI * t) / this.thump);
      this.shakeAt = t + 1 >= this.shakeLength ? -1 : t + 1;
    }
    // The driver saturates: at any drive a quiet input goes in at its own level and a loud one
    // is rounded off, harder the more drive there is.
    const g = Math.max(1, drive);
    const driven = Math.tanh(input * g) / g;

    // The stretch glides, and splits into whole samples and a fraction between a half and one
    // and a half, which is where a first-order allpass delays evenly.
    this.stretch += this.glide * (this.target - this.stretch);
    const whole = Math.floor(this.stretch - 0.5);
    const d = this.stretch - whole;
    const eta = (1 - d) / (1 + d);
    out[0] = this.springs[0].next(driven, whole, eta) * WET_GAIN;
    out[1] = this.springs[1].next(driven, whole, eta) * WET_GAIN;
  }
}
