// The two filters the wavetable synth offers, and the one-pole used as a tone control.
//
// A state-variable filter for the clean modes and a four-pole ladder for the dirty one. Both
// are written per-sample and allocation-free, and both take their cutoff as a frequency in Hz
// so an envelope or an LFO can move it at audio rate without a lookup table in between.
//
// Both are the topology-preserving form rather than the textbook one, and for the same reason:
// the naive forms' cutoff drifts from where it was asked for as it approaches a quarter of the
// sample rate, so a filter envelope sweeping to the top of its range either sounds wrong or
// stops being a filter. The ladder used to be the naive cascade, and above five kilohertz its
// corner sat well above the number on the knob with the slope collapsed under it.

/**
 * Every response the filter offers, in panel order.
 *
 * SLOPES ARE SEPARATE ENTRIES rather than a second knob. A slope only means anything on the
 * pass modes - a notch has no slope, a comb has no slope - so a knob for it would be a control
 * that does nothing most of the time, and picking "lowpass 24" says in one gesture what a mode
 * plus a slope says in two. `lowpass`, `highpass` and `bandpass` keep their old names and their
 * old sound, which is twelve decibels an octave; the numbered ones are the other slopes.
 *
 * The four past the ladder are the responses that are not a slope at all. Each is an ordinary
 * textbook structure - a comb is a delay summed with itself, an allpass cascade is what every
 * phaser is built from, a formant bank is three bandpasses at the resonances of a vowel - and
 * they are here because a filter with only the four classical shapes is the one part of this
 * synth with nothing to discover in it.
 *
 * A song stores an enum by its LABEL (see valueToArg), so this list can be reordered without
 * changing what anything plays.
 */
export const FILTER_MODES = Object.freeze([
  'lowpass 6', 'lowpass', 'lowpass 24',
  'highpass 6', 'highpass', 'highpass 24',
  'bandpass', 'bandpass 24',
  'notch', 'peak',
  'ladder',
  'comb', 'allpass', 'formant',
]);

/** What each mode is made of, which is what MultiFilter switches on. */
const MODE = Object.freeze(Object.fromEntries(FILTER_MODES.map((name, i) => [name, i])));

/** The modes built from two state-variable sections in series rather than one. */
const CASCADED = new Set([
  FILTER_MODES.indexOf('lowpass 24'),
  FILTER_MODES.indexOf('highpass 24'),
  FILTER_MODES.indexOf('bandpass 24'),
]);

/** The five vowels the formant mode sweeps through, as the first three resonances of each. */
const FORMANTS = Object.freeze([
  [270, 2290, 3010],   // ee
  [530, 1840, 2480],   // eh
  [730, 1090, 2440],   // ah
  [570, 840, 2410],    // oh
  [300, 870, 2240],    // oo
]);

const MIN_CUTOFF_HZ = 20;

/**
 * The four shapes the state-variable core itself offers, which is NOT the device's mode list:
 * `Svf#next` switches on these and MultiFilter maps the device's modes onto them. Two lists
 * because the core has four responses and the device offers fourteen, and conflating them made
 * a reordering of the panel's list silently change which filter ran.
 */
export const SVF_MODES = Object.freeze(['lowpass', 'highpass', 'bandpass', 'notch']);

/**
 * A topology-preserving state-variable filter: lowpass, highpass, bandpass and notch off the
 * same two integrators, so switching mode costs nothing and never re-tunes the filter.
 */
export class Svf {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.ic1 = 0;
    this.ic2 = 0;
    this.g = 0;
    this.k = 2;
    this.a1 = 0;
    this.a2 = 0;
    this.a3 = 0;
    this.setCutoff(1000, 0);
  }

  reset() {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  /**
   * `resonance` is 0..1, mapped so that 1 is just short of self-oscillation. The cutoff is
   * clamped below Nyquist because the prewarp's tangent goes to infinity there, and a filter
   * asked for an impossible cutoff should sit at the top of its range rather than produce NaN.
   */
  setCutoff(hz, resonance) {
    const nyquist = this.sampleRate * 0.5;
    const f = Math.min(nyquist * 0.99, Math.max(MIN_CUTOFF_HZ, hz));
    const g = Math.tan((Math.PI * f) / this.sampleRate);
    const k = 2 - 1.98 * Math.min(1, Math.max(0, resonance));
    this.g = g;
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /**
   * Takes another filter's tuning. A stereo voice retunes its left filter per sample and has the
   * right one follow, so the pair costs one tangent per sample rather than two.
   */
  follow(other) {
    this.g = other.g;
    this.k = other.k;
    this.a1 = other.a1;
    this.a2 = other.a2;
    this.a3 = other.a3;
  }

  /** One sample, in the given mode (an index into FILTER_MODES). */
  next(input, mode) {
    const v3 = input - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    switch (mode) {
      case 1: return input - this.k * v1 - v2;          // highpass
      case 2: return v1;                                 // bandpass
      case 3: return input - this.k * v1;                // notch
      default: return v2;                                // lowpass
    }
  }
}

/** A cheap, well-behaved saturator for the ladder's feedback path. */
const softClip = (x) => {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
};

/**
 * A four-pole ladder lowpass with a saturated feedback path: the mode that is supposed to
 * color the sound rather than get out of its way. Resonance drives it into the nonlinearity,
 * which is where the character is.
 *
 * Four one-pole stages in the topology-preserving form, with the feedback solved at the loop's
 * input rather than taken one sample late: what the stages would put out with no new input is
 * known from their states, so the input the loop actually sees is found in closed form and the
 * saturation is applied to that. The result is a ladder whose resonance peak lands on the
 * number the cutoff says, at any cutoff the synth can ask for.
 *
 * It is a ladder, so at the corner it sits twelve decibels down where the clean lowpass sits
 * six: four poles at one frequency, as the circuit has. That is not a calibration error and the
 * descriptor says so.
 */
export class Ladder {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.s = new Float64Array(4);
    this.G = 0;
    this.G4 = 0;
    this.k = 0;
    this.drive = 1;
    this.setCutoff(1000, 0);
  }

  reset() {
    this.s.fill(0);
  }

  setCutoff(hz, resonance) {
    const nyquist = this.sampleRate * 0.5;
    const f = Math.min(nyquist * 0.49, Math.max(MIN_CUTOFF_HZ, hz));
    const g = Math.tan((Math.PI * f) / this.sampleRate);
    const G = g / (1 + g);
    this.G = G;
    this.G4 = G * G * G * G;
    // Four is where the linear loop self-oscillates; the top of the knob stops just short of it,
    // and the saturation keeps what happens near there bounded.
    this.k = 4 * Math.min(1, Math.max(0, resonance)) * 0.98;
  }

  /** Takes another ladder's tuning and drive, for the same reason Svf#follow exists. */
  follow(other) {
    this.G = other.G;
    this.G4 = other.G4;
    this.k = other.k;
    this.drive = other.drive;
  }

  next(input) {
    const G = this.G;
    const s = this.s;
    // What the four stages would output right now with nothing new at the input.
    const settled = (1 - G) * (G * G * G * s[0] + G * G * s[1] + G * s[2] + s[3]);
    const u = softClip((input * this.drive - this.k * settled) / (1 + this.k * this.G4));
    let x = u;
    for (let i = 0; i < 4; i++) {
      const v = (x - s[i]) * G;
      const y = v + s[i];
      s[i] = y + v;
      x = y;
    }
    return x;
  }
}

/**
 * A one-pole lowpass, used where a filter is a tone control rather than an instrument: the
 * distortion unit's tone knob, the smoothing on a control that would otherwise step.
 */
export class OnePole {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.a = 1;
    this.target = 1;
    this.steps = 0;
    this.z = 0;
    this.setCutoff(20000);
  }

  reset() {
    this.z = 0;
  }

  /** The coefficient for a corner, without touching the filter. */
  _coefficient(hz) {
    const nyquist = this.sampleRate * 0.5;
    const f = Math.min(nyquist * 0.99, Math.max(1, hz));
    return 1 - Math.exp((-2 * Math.PI * f) / this.sampleRate);
  }

  /** Jumps to a corner. For a filter being built, or one whose corner never moves. */
  setCutoff(hz) {
    this.a = this._coefficient(hz);
    this.target = this.a;
    this.steps = 0;
  }

  /**
   * Aims at a corner, reached over `steps` samples. A tone control is usually set and left, but
   * a tone control INSIDE A FEEDBACK PATH - a delay's, a distortion's - is heard on every
   * repeat, and a corner that jumps once a block is a buzz riding the sweep.
   */
  glideTo(hz, steps) {
    this.target = this._coefficient(hz);
    this.steps = Math.max(0, steps | 0);
    if (this.steps === 0) this.a = this.target;
  }

  next(input) {
    if (this.steps > 0) {
      this.a += (this.target - this.a) / this.steps;
      this.steps -= 1;
    }
    this.z += this.a * (input - this.z);
    return this.z;
  }
}

/**
 * A DC blocker. A waveshaper fed an asymmetric drive puts an offset on its output, and an
 * offset costs headroom on every later stage without being audible itself - so distortion modes
 * that bias the signal on purpose run their output through one of these.
 */
export class DcBlocker {
  constructor(sampleRate, cutoffHz = 20) {
    // The pole has to be placed in radians per sample, not cycles: leaving out the 2*pi puts
    // the corner at about 3 Hz instead of 20, and an offset then takes a quarter of a second to
    // settle rather than a few milliseconds.
    this.r = Math.max(0, 1 - (2 * Math.PI * cutoffHz) / sampleRate);
    this.x1 = 0;
    this.y1 = 0;
  }

  reset() {
    this.x1 = 0;
    this.y1 = 0;
  }

  next(input) {
    const y = input - this.x1 + this.r * this.y1;
    this.x1 = input;
    this.y1 = y;
    return y;
  }
}

/** One first-order allpass: unity gain, a phase turn that sweeps with the coefficient. */
class Allpass1 {
  constructor() { this.a = 0; this.x1 = 0; this.y1 = 0; }
  reset() { this.x1 = 0; this.y1 = 0; }
  next(x) {
    const y = this.a * (x + this.y1) - this.x1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** How long the comb mode's delay line is, in seconds: the lowest note it can be tuned to. */
const COMB_MAX_SEC = 0.05;

/** How many allpass sections the allpass mode runs. Four is two notches, which is the sound. */
const ALLPASS_STAGES = 4;

/**
 * Every filter response behind one interface, so a device switching mode does not switch code.
 *
 * The four classical shapes and their slopes come off a state-variable core; the ladder is its
 * own thing; the rest are each a small structure of their own, held here and idle until the
 * mode picks them. That is the tradeoff this class makes deliberately: a few hundred bytes of
 * state per channel that is mostly asleep, against one filter that can be any of these without
 * the device knowing which. Everything is tuned per sample, exactly as the core is, so a
 * swept cutoff on the comb or the formant bank is as smooth as a swept lowpass.
 */
export class MultiFilter {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Two state-variable sections: the first is 12 dB, the pair in series is 24.
    this.svf = [new Svf(sampleRate), new Svf(sampleRate)];
    this.ladder = new Ladder(sampleRate);
    this.one = 0;                       // the one-pole's state, for the 6 dB slopes
    this.oneA = 0;
    this.apFb = 0;                      // what the allpass chain last put out, for its feedback
    this.comb = new Float32Array(Math.ceil(COMB_MAX_SEC * sampleRate) + 4);
    this.combAt = 0;
    this.combLen = 100;
    this.combFb = 0;
    this.allpass = Array.from({ length: ALLPASS_STAGES }, () => new Allpass1());
    this.apGain = 0;
    // Three bandpasses for the formant mode, and the mix that picks the vowel.
    this.formant = [new Svf(sampleRate), new Svf(sampleRate), new Svf(sampleRate)];
    this.formantGain = new Float64Array(3);
  }

  reset() {
    for (const f of this.svf) f.reset();
    this.ladder.reset();
    this.one = 0;
    this.apFb = 0;
    this.comb.fill(0);
    this.combAt = 0;
    for (const a of this.allpass) a.reset();
    for (const f of this.formant) f.reset();
  }

  set drive(value) { this.ladder.drive = value; }

  /** Tunes whichever structure the mode uses. Cheap for the ones it does not. */
  setCutoff(hz, resonance, mode) {
    const nyquist = this.sampleRate * 0.5;
    const f = Math.min(nyquist * 0.49, Math.max(MIN_CUTOFF_HZ, hz));
    switch (mode) {
      case MODE.ladder:
        this.ladder.setCutoff(f, resonance);
        return;
      case MODE['lowpass 6']:
      case MODE['highpass 6']:
        this.oneA = 1 - Math.exp((-2 * Math.PI * f) / this.sampleRate);
        return;
      case MODE.comb: {
        // The cutoff IS the comb's pitch: the delay is one period of it, so the teeth land on
        // that note and its harmonics. Resonance is the feedback, which is what makes it ring.
        this.combLen = Math.min(this.comb.length - 2, Math.max(2, this.sampleRate / f));
        this.combFb = Math.min(0.98, Math.max(0, resonance)) * 0.98;
        return;
      }
      case MODE.allpass: {
        // The coefficient every section turns on. One expression rather than a tangent per
        // stage: they are all tuned to the same corner, which is what makes the notches move
        // together.
        const t = Math.tan((Math.PI * f) / this.sampleRate);
        const a = (t - 1) / (t + 1);
        for (const stage of this.allpass) stage.a = a;
        // Feedback round the chain deepens the notches. Kept well under one: an allpass cascade
        // has unity gain, so anything near it rings without ever running out of energy.
        this.apGain = Math.min(1, Math.max(0, resonance)) * 0.7;
        return;
      }
      case MODE.formant: {
        // The cutoff sweeps THROUGH the vowels rather than moving one of them: the five are laid
        // out across the range and the two either side of the position are blended.
        const at = (Math.log(f / MIN_CUTOFF_HZ) / Math.log((nyquist * 0.49) / MIN_CUTOFF_HZ)) * (FORMANTS.length - 1);
        const lo = Math.min(FORMANTS.length - 1, Math.max(0, Math.floor(at)));
        const hi = Math.min(FORMANTS.length - 1, lo + 1);
        const mix = at - lo;
        // Narrower as the resonance goes up, which is what makes a vowel read as a vowel.
        const q = 0.35 + 0.6 * Math.min(1, Math.max(0, resonance));
        for (let i = 0; i < 3; i++) {
          const center = FORMANTS[lo][i] + (FORMANTS[hi][i] - FORMANTS[lo][i]) * mix;
          this.formant[i].setCutoff(center, q);
          // The higher resonances are quieter in a real vowel, or the bank sounds like a whistle.
          this.formantGain[i] = i === 0 ? 1 : i === 1 ? 0.5 : 0.25;
        }
        return;
      }
      default: {
        this.svf[0].setCutoff(f, resonance);
        // THE SECOND SECTION OF A CASCADE TAKES NO RESONANCE.
        //
        // Two resonant sections in series multiply their peaks: at the top of the knob each one
        // lifts the corner by a factor of fifty, and the pair by two and a half thousand, which
        // is not a filter with a lot of resonance - it is a filter that destroys the track. One
        // resonant section and one flat one is the usual four-pole arrangement, and it keeps the
        // slope while the peak stays a peak.
        if (CASCADED.has(mode)) this.svf[1].setCutoff(f, 0);
        return;
      }
    }
  }

  /** Takes another's tuning, for the other channel of a stereo pair. */
  follow(other) {
    this.svf[0].follow(other.svf[0]);
    this.svf[1].follow(other.svf[1]);
    this.ladder.follow(other.ladder);
    this.oneA = other.oneA;
    this.combLen = other.combLen;
    this.combFb = other.combFb;
    for (let i = 0; i < ALLPASS_STAGES; i++) this.allpass[i].a = other.allpass[i].a;
    this.apGain = other.apGain;
    for (let i = 0; i < 3; i++) {
      this.formant[i].follow(other.formant[i]);
      this.formantGain[i] = other.formantGain[i];
    }
  }

  /** Reads the comb line `len` samples back, interpolated, so a swept pitch glides. */
  _combRead(len) {
    const n = this.comb.length;
    const at = this.combAt - len;
    const wrapped = at - Math.floor(at / n) * n;
    const i = Math.floor(wrapped);
    const frac = wrapped - i;
    const a = this.comb[i];
    const b = this.comb[(i + 1) % n];
    return a + (b - a) * frac;
  }

  next(x, mode) {
    switch (mode) {
      case MODE.ladder:
        return this.ladder.next(x);
      case MODE['lowpass 6']:
        this.one += this.oneA * (x - this.one);
        return this.one;
      case MODE['highpass 6']:
        this.one += this.oneA * (x - this.one);
        return x - this.one;
      case MODE['lowpass 24']:
        return this.svf[1].next(this.svf[0].next(x, 0), 0);
      case MODE['highpass 24']:
        return this.svf[1].next(this.svf[0].next(x, 1), 1);
      case MODE['bandpass 24']:
        // Normalized at each stage - see the note on the bandpass below.
        return this.svf[1].next(this.svf[0].next(x, 2) * this.svf[0].k, 2) * this.svf[1].k;
      case MODE.peak: {
        // The bandpass added back to the signal: a resonant lift at the cutoff that leaves
        // everything either side of it alone. The resonance is the SIZE of the lift here rather
        // than its sharpness, which is what a peak control means everywhere else.
        const band = this.svf[0].next(x, 2) * this.svf[0].k;
        return x + band * (2 - this.svf[0].k) * 4;
      }
      case MODE.comb: {
        const read = this._combRead(this.combLen);
        const write = x + read * this.combFb;
        this.comb[this.combAt] = Number.isFinite(write) ? write : 0;
        this.combAt = (this.combAt + 1) % this.comb.length;
        // Summed rather than replaced: a comb is the sound of a signal against a copy of itself.
        return (x + read) * 0.5;
      }
      case MODE.allpass: {
        let y = x + this.apFb * (this.apGain ?? 0);
        for (const stage of this.allpass) y = stage.next(y);
        this.apFb = Number.isFinite(y) ? y : 0;
        // The phase-turned copy against the original, which is where the notches come from.
        return (x + y) * 0.5;
      }
      case MODE.formant: {
        let y = 0;
        for (let i = 0; i < 3; i++) y += this.formant[i].next(x, 2) * this.formantGain[i];
        return y * 1.4;
      }
      case MODE.highpass:
        return this.svf[0].next(x, 1);
      case MODE.bandpass:
        // NORMALIZED: the state-variable core's bandpass output is the textbook one, whose gain
        // at the center is one over the damping - so turning the resonance up made the band
        // thirty decibels louder as well as narrower, which is a volume control nobody asked
        // for and a clipped track at the top of the knob. Multiplying by the damping puts the
        // center at unity at every setting, and the resonance does the one thing it says.
        return this.svf[0].next(x, 2) * this.svf[0].k;
      case MODE.notch:
        return this.svf[0].next(x, 3);
      default:
        return this.svf[0].next(x, 0);
    }
  }
}
