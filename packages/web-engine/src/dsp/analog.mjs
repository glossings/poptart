// Circuit-modeled filters: the classic analog lowpass and multimode circuits, each with the
// nonlinearity that gives it its sound.
//
// Every model is written as the circuit's own differential equations - one per capacitor - with
// each transistor pair, diode pair or amplifier stage as a saturating curve, and discretized as a
// zero-delay-feedback (topology-preserving) filter: trapezoidal integrators with the feedback
// loop solved in the same sample rather than one sample late, so the corner and the resonance
// land where the analog circuit puts them at any cutoff. The curves are handled by linearizing
// each one around where its input was a sample ago (its slope as a gain, tanh(x)/x) and solving
// the resulting linear system exactly - the "cheap" nonlinear zero-delay-feedback method from the
// virtual-analog literature, which keeps a single solve per sample and stays stable at any
// setting. Everything runs at twice the sample rate through a polyphase IIR half-band pair, which
// is what keeps a driven model's harmonics from folding back, and what makes the one-sample-old
// linearization close to the real solution.
//
// The four structures, and which models are built on each:
//   cascade   - four one-poles in a row inside a negative feedback loop: `ladder` (a transistor
//               ladder, a curve on every stage's input and output) and `ota` (transconductance
//               amplifier stages, one curve on each stage's difference, with the input partly
//               compensated so the bass survives the resonance).
//   diode     - four capacitors coupled to their neighbors through diode pairs, the top one half
//               the size of the rest: `diode`. The coupling spreads the poles, which is the
//               rubbery resonance, the slope near the corner of about 18 dB an octave, and a peak
//               that moves with the resonance.
//   sallenKey - a two-pole with positive feedback round an amplifier: `sallen` (plain resistors,
//               a diode clipper in the feedback that makes it scream) and `diodepair` (diode pairs
//               as the resistors, the input fed in at three points to pick the response).
//   stateVar  - two integrators and a damping path: `statevar` (soft amplifiers, never quite
//               oscillates), `cmos` (lopsided inverter-like amplifiers that grind) and `polar`
//               (integrators that run out of slew, hard and unstable at the top).
//
// API, one instance per channel:
//   const f = new AnalogFilter(sampleRate, ANALOG_MODELS.indexOf('diode'));
//   f.setCutoff(hz); f.setResonance(0..1); f.setDrive(1..8); f.setMorph(0..1);
//   const y = f.process(x);
// Each setter is cheap enough to call every sample (setCutoff is one tangent), and process is
// one sample in, one out. `follow(other)` copies another instance's tuning for the second
// channel of a pair; `transfer(hz)` is the small-signal response, for drawing.

/** The models, in the order a song does not depend on (the device stores the name). */
export const ANALOG_MODELS = Object.freeze(['ladder', 'diode', 'sallen', 'statevar', 'cmos', 'ota', 'polar', 'diodepair']);

/** The models that take the morph control: the two-pole multimodes. */
export const ANALOG_MORPHING = Object.freeze(['sallen', 'statevar', 'cmos', 'polar', 'diodepair']);

const ANALOG_STRUCTURE = Object.freeze({
  ladder: 'cascade', ota: 'cascade', diode: 'diode',
  sallen: 'sallenKey', diodepair: 'sallenKey',
  statevar: 'stateVar', cmos: 'stateVar', polar: 'stateVar',
});

// Each structure's states, as an index the inner loop switches on.
const ANALOG_CASCADE = 0;
const ANALOG_DIODE = 1;
const ANALOG_SALLEN_KEY = 2;
const ANALOG_STATE_VAR = 3;
const ANALOG_STRUCTURE_INDEX = Object.freeze({ cascade: ANALOG_CASCADE, diode: ANALOG_DIODE, sallenKey: ANALOG_SALLEN_KEY, stateVar: ANALOG_STATE_VAR });

/**
 * Per model: where the loop starts to oscillate on its own (in the structure's own feedback
 * units), the feedback at the top of the knob, and the signal level that counts as full scale
 * inside the circuit - a smaller one saturates sooner.
 *
 * `onset` is the linear threshold: 4 for a four-pole cascade (each pole turns 45 degrees at the
 * corner), 3 for a unity-gain Sallen-Key with equal parts, about 17 for the diode ladder with
 * its half-size top capacitor (found numerically from the same equations), and 2 for a
 * state-variable, whose resonance is fed back against a fixed damping of 2. A `top` under the
 * onset is a circuit that rings but never sings on its own.
 *
 * `oversample` is the rate each runs at, in multiples of the sample rate: four for the models
 * whose curves are hard enough to fold audibly at two (measured with a driven tone above the
 * cutoff, where the folded products are left standing as everything real is filtered off).
 */
const ANALOG_SPECS = Object.freeze({
  ladder:   { onset: 4, top: 4.4, headroom: 1.2, oversample: 2 },
  ota:      { onset: 4, top: 4.4, headroom: 1.8, oversample: 4 },
  diode:    { onset: 16.977, top: 16.6, headroom: 1.0, oversample: 4 },
  sallen:   { onset: 3, top: 3.3, headroom: 1.4, oversample: 2 },
  diodepair:  { onset: 3, top: 3.35, headroom: 1.0, oversample: 2 },
  statevar: { onset: 2, top: 1.94, headroom: 1.5, oversample: 2 },
  cmos:     { onset: 2, top: 2.1, headroom: 0.7, oversample: 4 },
  polar:    { onset: 2, top: 2.2, headroom: 0.5, oversample: 4 },
});

/**
 * The diode ladder's own resonant frequency in units of its stage corner: with the top
 * capacitor at half size, the loop turns 180 degrees at 1.4132 times the corner of one stage.
 * The stages are tuned that much lower, so the peak sits on the cutoff the control says.
 */
const ANALOG_DIODE_TUNE = 1.4132;

/** How much of the bass the OTA cascade's input puts back, as a share of the feedback. */
const ANALOG_OTA_COMPENSATION = 0.5;

/** How much of the bass the diode ladder's input puts back. Some, not all: the loss is the sound. */
const ANALOG_DIODE_COMPENSATION = 0.25;

/** The coupling highpass in the diode ladder's feedback, in Hz: the resonance thins at the bottom. */
const ANALOG_DIODE_FEEDBACK_HZ = 40;

/** The Sallen-Key's feedback clipper: how hard it bites (larger clips sooner). */
const ANALOG_SALLEN_CLIP = 2;

/** The diode-pair two-pole's feedback amplifier, which runs out of room sooner than its diodes. */
const ANALOG_DIODEPAIR_CLIP = 2.5;

/**
 * How much sooner the resonance path of the two self-oscillating state-variables saturates than
 * their integrators: it holds the ring to a level where the integrators are still nearly linear,
 * so a singing filter stays near the pitch the cutoff says.
 */
const ANALOG_RING_KNEE = 2.5;

/** The lopsided amplifier of the CMOS model: its curve is centered this far off zero. */
const ANALOG_CMOS_BIAS = 0.35;

/** How much sooner the polar model's integrators run out of slew than a soft amplifier. */
const ANALOG_POLAR_KNEE = 1.5;

/** The output amplifier's swing, in internal units (where 1 is a full-scale input at unity drive). */
const ANALOG_RAIL = 5;

/** Highest cutoff any model is tuned to, as a share of the (base) sample rate. */
const ANALOG_MAX_CUTOFF = 0.45;
const ANALOG_MIN_CUTOFF_HZ = 20;

/** The output DC blocker of the CMOS model, which puts an offset on its signal by its shape. */
const ANALOG_DC_HZ = 8;

/** States smaller than this are flushed to zero, so a decaying tail never goes subnormal. */
const ANALOG_FLUSH = 1e-20;

/**
 * The saturating curve every model is built from: a rational approximation of tanh that reaches
 * exactly one at three and stays there, smooth through the knee. Rational rather than a library
 * tanh so the two engines compute the same number.
 */
export function analogClip(x) {
  if (x <= -3) return -1;
  if (x >= 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** analogClip(x) / x: the curve's secant slope, which is the gain the linearized solve uses. */
export function analogClipGain(x) {
  const ax = x < 0 ? -x : x;
  if (ax >= 3) return 1 / ax;
  const x2 = x * x;
  return (27 + x2) / (27 + 9 * x2);
}

/** analogClip's slope at x. */
function analogClipSlope(x) {
  if (x <= -3 || x >= 3) return 0;
  const x2 = x * x;
  const d = 27 + 9 * x2;
  return (9 * (9 - x2) * (9 - x2)) / (d * d);
}

/** The CMOS model's lopsided curve through zero, as a secant gain. */
function analogCmosGain(x) {
  const b = ANALOG_CMOS_BIAS;
  if (x > -1e-9 && x < 1e-9) return analogClipSlope(b) / ANALOG_CMOS_SLOPE;
  return (analogClip(x + b) - analogClip(b)) / (x * ANALOG_CMOS_SLOPE);
}

/** Its slope at rest, divided out so the small-signal gain of the stage is one. */
const ANALOG_CMOS_SLOPE = analogClipSlope(ANALOG_CMOS_BIAS);

/**
 * The polar model's integrators running out of slew: the same curve with its knee pulled in,
 * so the amplifier is linear further and then stops harder.
 */
function analogSlewGain(x) {
  return analogClipGain(x * ANALOG_POLAR_KNEE);
}

// ---- the oversampling -------------------------------------------------------------------------

/**
 * Polyphase IIR half-bands: two chains of first-order allpasses in z^-2, whose sum is a lowpass
 * at a quarter of the faster rate. Coefficients from the classic elliptic design for this
 * structure, computed once and written down so both engines use the same numbers. Only a few
 * samples of delay in the audio band, which matters here because the device's dry/wet mixes the
 * filtered signal against the input.
 *
 * The first stage (base rate to twice it) has eight coefficients and a transition of 0.04 of
 * the doubled rate: 95 dB down from 0.27 of it. The second (twice to four times) only has to
 * keep what the first stage passes, so four coefficients and a transition of 0.12 do: 77 dB
 * down where anything would fold back under the base rate's Nyquist.
 */
const ANALOG_HALFBAND_A = Object.freeze([
  0.040633460924193260, 0.15050512902267460, 0.30075705599187408, 0.46077450496145061,
  0.60952431489618830, 0.73850384111885725, 0.84922381039206607, 0.94974278370500020,
]);
const ANALOG_HALFBAND_B = Object.freeze([
  0.070765948976184462, 0.25785307851345257, 0.51316757474879282, 0.81731735441713682,
]);

/** One direction of a half-band: the even coefficients on one path, the odd on the other. */
class AnalogHalfband {
  constructor(coefficients) {
    this.c = coefficients;
    this.half = coefficients.length / 2;
    // Each section keeps its last input and output.
    this.x = new Float64Array(coefficients.length);
    this.y = new Float64Array(coefficients.length);
  }

  reset() {
    this.x.fill(0);
    this.y.fill(0);
  }

  /** Runs one path (0 even coefficients, 1 odd) one step. */
  path(input, which) {
    const c = this.c;
    const x = this.x;
    const y = this.y;
    const half = this.half;
    let v = input;
    for (let i = 0; i < half; i++) {
      const at = which * half + i;
      const out = c[2 * i + which] * (v - y[at]) + x[at];
      x[at] = v;
      y[at] = out;
      v = out;
    }
    return v;
  }
}

// ---- the filter -------------------------------------------------------------------------------

export class AnalogFilter {
  constructor(sampleRate, model = 0) {
    this.sampleRate = sampleRate;
    this.rate = sampleRate * 2;            // what the model runs at: set with the model
    this.four = false;
    this.model = -1;
    this.name = '';
    this.structure = 0;
    this.spec = ANALOG_SPECS.ladder;
    this.s = new Float64Array(4);          // the capacitors
    this.v = new Float64Array(6);          // where each curve's input was a sample ago
    this.fb = 0;                           // the diode ladder's feedback highpass
    this.fbG = 0;
    this.dcX = 0;                          // the CMOS model's output DC blocker
    this.dcY = 0;
    this.dcR = Math.max(0, 1 - (2 * Math.PI * ANALOG_DC_HZ) / sampleRate);
    this.upA = new AnalogHalfband(ANALOG_HALFBAND_A);
    this.downA = new AnalogHalfband(ANALOG_HALFBAND_A);
    this.upB = new AnalogHalfband(ANALOG_HALFBAND_B);
    this.downB = new AnalogHalfband(ANALOG_HALFBAND_B);
    this.cutoff = 1000;
    this.tuned = 1000;                     // the cutoff after the clamps, in Hz
    this.resonance = 0;
    this.drive = 1;
    this.morph = 0;
    this.wc = 0;                           // the prewarped corner, small-signal
    this.g = 0;                            // the integrator gain the model runs at
    this.k = 0;                            // the feedback (or damping) the resonance sets
    this.wl = 1;                           // lowpass, bandpass, highpass shares of the output
    this.wb = 0;
    this.wh = 0;
    this.morphs = false;
    this.setModel(model);
  }

  /** Clears every state: the capacitors, the curves' memory and the oversampler. */
  reset() {
    this.s.fill(0);
    this.v.fill(0);
    this.fb = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.upA.reset();
    this.downA.reset();
    this.upB.reset();
    this.downB.reset();
  }

  /** Switches circuit. A different circuit is a different filter, so the state goes. */
  setModel(model) {
    const m = Math.min(ANALOG_MODELS.length - 1, Math.max(0, model | 0));
    if (m === this.model) return;
    this.model = m;
    this.name = ANALOG_MODELS[m];
    this.structure = ANALOG_STRUCTURE_INDEX[ANALOG_STRUCTURE[this.name]];
    this.spec = ANALOG_SPECS[this.name];
    this.four = this.spec.oversample === 4;
    this.rate = this.sampleRate * this.spec.oversample;
    this.morphs = ANALOG_MORPHING.includes(this.name);
    const hp = Math.tan((Math.PI * ANALOG_DIODE_FEEDBACK_HZ) / this.rate);
    this.fbG = hp / (1 + hp);
    this.reset();
    this.setCutoff(this.cutoff);
    this.setResonance(this.resonance);
    this.setMorph(this.morph);
  }

  setCutoff(hz) {
    this.cutoff = hz;
    const f = Math.min(this.sampleRate * ANALOG_MAX_CUTOFF, Math.max(ANALOG_MIN_CUTOFF_HZ, hz));
    this.tuned = f;
    let wc = Math.tan((Math.PI * f) / this.rate);
    if (this.structure === ANALOG_DIODE) wc /= ANALOG_DIODE_TUNE;
    this.wc = wc;
    this.g = wc;
  }

  setResonance(resonance) {
    const r = Math.min(1, Math.max(0, resonance));
    this.resonance = r;
    this.k = this.spec.top * r;
  }

  setDrive(drive) {
    this.drive = Math.max(0, drive);
  }

  /**
   * The response of the multimodes, 0..1. The state-variable model's knob runs lowpass, notch,
   * highpass (a notch is the two summed, halfway); the others run lowpass, bandpass, highpass.
   */
  setMorph(morph) {
    const m = Math.min(1, Math.max(0, morph));
    this.morph = m;
    if (!this.morphs) {
      this.wl = 1; this.wb = 0; this.wh = 0;
    } else if (this.name === 'statevar') {
      this.wb = 0;
      this.wl = m < 0.5 ? 1 : 2 - 2 * m;
      this.wh = m < 0.5 ? 2 * m : 1;
    } else if (m < 0.5) {
      this.wl = 1 - 2 * m; this.wb = 2 * m; this.wh = 0;
    } else {
      this.wl = 0; this.wb = 2 - 2 * m; this.wh = 2 * m - 1;
    }
  }

  /** Takes another's tuning, for the second channel of a pair. */
  follow(other) {
    if (other.model !== this.model) this.setModel(other.model);
    this.cutoff = other.cutoff;
    this.tuned = other.tuned;
    this.resonance = other.resonance;
    this.drive = other.drive;
    this.morph = other.morph;
    this.wc = other.wc;
    this.g = other.g;
    this.k = other.k;
    this.wl = other.wl;
    this.wb = other.wb;
    this.wh = other.wh;
  }

  /** One sample in, one out. */
  process(input) {
    const h = this.spec.headroom;
    const x = (input * this.drive) / h;
    const a = this.upA.path(x, 0);
    const b = this.upA.path(x, 1);
    let ya;
    let yb;
    if (this.four) {
      // In time order: a's two samples at four times the rate, then b's.
      const a0 = this.upB.path(a, 0);
      const a1 = this.upB.path(a, 1);
      const b0 = this.upB.path(b, 0);
      const b1 = this.upB.path(b, 1);
      const ya0 = this._step(a0);
      const ya1 = this._step(a1);
      const yb0 = this._step(b0);
      const yb1 = this._step(b1);
      ya = 0.5 * (this.downB.path(ya1, 0) + this.downB.path(ya0, 1));
      yb = 0.5 * (this.downB.path(yb1, 0) + this.downB.path(yb0, 1));
    } else {
      ya = this._step(a);
      yb = this._step(b);
    }
    let y = 0.5 * (this.downA.path(yb, 0) + this.downA.path(ya, 1)) * h;
    if (this.name === 'cmos') {
      const out = y - this.dcX + this.dcR * this.dcY;
      this.dcX = y;
      this.dcY = out;
      y = out;
    }
    const s = this.s;
    for (let i = 0; i < 4; i++) if (s[i] > -ANALOG_FLUSH && s[i] < ANALOG_FLUSH) s[i] = 0;
    if (this.fb > -ANALOG_FLUSH && this.fb < ANALOG_FLUSH) this.fb = 0;
    return y;
  }

  /**
   * One step of the circuit at its own rate, and the output amplifier's supply rails: whatever
   * the circuit does inside, what leaves it cannot swing further than they allow.
   */
  _step(x) {
    let y;
    switch (this.structure) {
      case ANALOG_CASCADE: y = this._cascade(x); break;
      case ANALOG_DIODE: y = this._diode(x); break;
      case ANALOG_SALLEN_KEY: y = this._sallenKey(x); break;
      default: y = this._stateVar(x); break;
    }
    return ANALOG_RAIL * analogClip(y / ANALOG_RAIL);
  }

  /**
   * Four one-poles in a loop. Each stage is y' = wc (A·prev - B·y), with A and B the curves'
   * secant gains: for the transistor ladder they are the curve at each side (tanh(prev) -
   * tanh(y)), for the OTA one curve of the difference (tanh(prev - y)). So every stage is affine
   * in the one before it, the whole chain is affine in the loop's input, and the loop is solved
   * for that input in closed form.
   */
  _cascade(x) {
    const g = this.g;
    const k = this.k;
    const s = this.s;
    const v = this.v;
    const ota = this.name === 'ota';
    // y_i = m_i·y_(i-1) + c_i, and the chain's end as G·u + S.
    let G = 1;
    let S = 0;
    let m0, m1, m2, m3, c0, c1, c2, c3;
    for (let i = 0; i < 4; i++) {
      let alpha;
      let beta;
      if (ota) {
        alpha = analogClipGain(v[i] - v[i + 1]);
        beta = alpha;
      } else {
        alpha = analogClipGain(v[i]);
        beta = analogClipGain(v[i + 1]);
      }
      const d = 1 / (1 + g * beta);
      const m = d * g * alpha;
      const c = d * s[i];
      G = m * G;
      S = m * S + c;
      if (i === 0) { m0 = m; c0 = c; } else if (i === 1) { m1 = m; c1 = c; } else if (i === 2) { m2 = m; c2 = c; } else { m3 = m; c3 = c; }
    }
    let u;
    if (ota) {
      // The input stage saturates the sum of the input and the feedback; the input is scaled up
      // by part of the feedback, as these chips' application circuits do, to keep the bass.
      const w = x * (1 + ANALOG_OTA_COMPENSATION * k);
      const a0 = analogClipGain(v[5]);
      u = (a0 * (w - k * S)) / (1 + a0 * k * G);
      v[5] = w - k * (G * u + S);
    } else {
      u = (x - k * S) / (1 + k * G);
    }
    v[0] = u;
    const y1 = m0 * u + c0;
    const y2 = m1 * y1 + c1;
    const y3 = m2 * y2 + c2;
    const y4 = m3 * y3 + c3;
    s[0] = 2 * y1 - s[0];
    s[1] = 2 * y2 - s[1];
    s[2] = 2 * y3 - s[2];
    s[3] = 2 * y4 - s[3];
    v[1] = y1; v[2] = y2; v[3] = y3; v[4] = y4;
    return y4;
  }

  /**
   * The diode ladder: y1' = wc (T(u - y1) - T(y1 - y2)), the middle two the same one place up,
   * and y4' = 2 wc T(y3 - y4) for the half-size top capacitor. Tridiagonal once linearized, so it
   * is solved from the top down as y_i = alpha_i·y_(i-1) + beta_i and then the loop closed at the
   * bottom. The feedback goes through a coupling highpass on its way back.
   */
  _diode(x) {
    const g = this.g;
    const k = this.k;
    const s = this.s;
    const v = this.v;
    const e1 = analogClipGain(v[0] - v[1]);
    const e2 = analogClipGain(v[1] - v[2]);
    const e3 = analogClipGain(v[2] - v[3]);
    const e4 = analogClipGain(v[3] - v[4]);
    const g4 = 2 * g * e4;
    const a4 = g4 / (1 + g4);
    const b4 = s[3] / (1 + g4);
    const d3 = 1 + g * e3 + g * e4 - g * e4 * a4;
    const a3 = (g * e3) / d3;
    const b3 = (s[2] + g * e4 * b4) / d3;
    const d2 = 1 + g * e2 + g * e3 - g * e3 * a3;
    const a2 = (g * e2) / d2;
    const b2 = (s[1] + g * e3 * b3) / d2;
    const d1 = 1 + g * e1 + g * e2 - g * e2 * a2;
    const a1 = (g * e1) / d1;
    const b1 = (s[0] + g * e2 * b2) / d1;
    const A = a4 * a3 * a2 * a1;
    const B = a4 * (a3 * (a2 * b1 + b2) + b3) + b4;
    // The highpass in the loop is (1 - G)(y4 - its state), affine in y4 like everything else.
    const hp = 1 - this.fbG;
    const drive = x * (1 + ANALOG_DIODE_COMPENSATION * k);
    const u = (drive - k * hp * (B - this.fb)) / (1 + k * hp * A);
    const y1 = a1 * u + b1;
    const y2 = a2 * y1 + b2;
    const y3 = a3 * y2 + b3;
    const y4 = a4 * y3 + b4;
    s[0] = 2 * y1 - s[0];
    s[1] = 2 * y2 - s[1];
    s[2] = 2 * y3 - s[2];
    s[3] = 2 * y4 - s[3];
    const step = (y4 - this.fb) * this.fbG;
    this.fb = this.fb + 2 * step;
    v[0] = u; v[1] = y1; v[2] = y2; v[3] = y3; v[4] = y4;
    return y4;
  }

  /**
   * The Sallen-Key two-pole: node a between the two resistors, node b on the second capacitor,
   * the first capacitor's far end lifted by K times the output through a clipper. Fed at the
   * resistor it is a lowpass, at the first capacitor a bandpass, at the second a highpass (with
   * twice the bandpass taken back off), which is how the morph picks a response.
   *
   *   c1 = a - K·F(b) - xb,  c1' = wc (T(xl - a) - T(a - b))
   *   c2 = b - xh,           c2' = wc  T(a - b)
   *
   * For `sallen` the first T is the input stage running out of room and the second a plain
   * resistor; for `diodepair` both are diode pairs.
   */
  _sallenKey(x) {
    const g = this.g;
    const s = this.s;
    const v = this.v;
    const xl = this.wl * x;
    const xb = (this.wb - 2 * this.wh) * x;
    const xh = this.wh * x;
    const diodepair = this.name === 'diodepair';
    const e1 = analogClipGain(v[0] - v[1]);
    const e2 = diodepair ? analogClipGain(v[1] - v[2]) : 1;
    const f = analogClipGain(v[2] * (diodepair ? ANALOG_DIODEPAIR_CLIP : ANALOG_SALLEN_CLIP));
    const kf = this.k * f;
    const p = (g * e2) / (1 + g * e2);
    const q = (s[1] + xh) / (1 + g * e2);
    const a = (s[0] + g * e1 * xl + xb + (g * e2 + kf) * q) / (1 + g * e1 + g * e2 - (g * e2 + kf) * p);
    const b = p * a + q;
    s[0] = 2 * (a - kf * b - xb) - s[0];
    s[1] = 2 * (b - xh) - s[1];
    v[0] = xl; v[1] = a; v[2] = b;
    return b;
  }

  /**
   * The state-variable two-pole: hp = x - 2·bp + k·R(bp) - lp, bp' = wc T(hp), lp' = wc T(bp).
   * The resonance is a positive feedback of the band against a fixed damping of two, through a
   * curve R, so a loud band feeds itself less and the ring settles at a level of its own. T is
   * the integrators' amplifier and R the resonance path's: soft for `statevar`, lopsided for
   * `cmos`, a hard slew limit for `polar`.
   */
  _stateVar(x) {
    const g = this.g;
    const s = this.s;
    const v = this.v;
    let a1;
    let a2;
    let c;
    if (this.name === 'cmos') {
      a1 = analogCmosGain(v[0]);
      a2 = analogCmosGain(v[1]);
      c = analogCmosGain(v[1] * ANALOG_RING_KNEE);
    } else if (this.name === 'polar') {
      a1 = analogSlewGain(v[0]);
      a2 = analogSlewGain(v[1]);
      c = analogSlewGain(v[1] * ANALOG_RING_KNEE);
    } else {
      a1 = analogClipGain(v[0]);
      a2 = analogClipGain(v[1]);
      c = analogClipGain(v[1]);
    }
    const k = 2 - this.k * c;
    const hp = (x - k * s[0] - s[1] - g * a2 * s[0]) / (1 + k * g * a1 + g * g * a1 * a2);
    const bp = s[0] + g * a1 * hp;
    const lp = s[1] + g * a2 * bp;
    s[0] = 2 * bp - s[0];
    s[1] = 2 * lp - s[1];
    v[0] = hp; v[1] = bp;
    return this.wl * lp + this.wb * bp + this.wh * hp;
  }

  /**
   * The small-signal response at `hz`, complex: every curve at its slope through zero, which
   * is what the circuit does to a quiet signal. The feedback is held just under where the loop
   * starts to oscillate, since past there a magnitude response does not exist - the real filter
   * is singing at its own level, which no linear picture can show.
   */
  transfer(hz) {
    const w = Math.tan((Math.PI * Math.min(hz, this.rate * 0.4999)) / this.rate) / this.wc;
    const { onset } = this.spec;
    let den;
    let num;
    switch (this.structure) {
      case ANALOG_CASCADE: {
        const k = Math.min(this.k, onset * 0.985);
        // (1 + jw)^4 + k, and the OTA's input share on top.
        const w2 = w * w;
        den = { re: 1 - 6 * w2 + w2 * w2 + k, im: 4 * w - 4 * w2 * w };
        num = { re: this.name === 'ota' ? 1 + ANALOG_OTA_COMPENSATION * k : 1, im: 0 };
        return analogDiv(num, den);
      }
      case ANALOG_DIODE: {
        const k = Math.min(this.k, onset * 0.985);
        // From the top down, as the solver does, with each capacitor's (s + coupling).
        const sj = { re: 0, im: w };
        const a4 = analogDiv({ re: 2, im: 0 }, { re: 2, im: w });
        const a3 = analogDiv({ re: 1, im: 0 }, { re: 2 - a4.re, im: w - a4.im });
        const a2 = analogDiv({ re: 1, im: 0 }, { re: 2 - a3.re, im: w - a3.im });
        const a1 = analogDiv({ re: 1, im: 0 }, { re: 2 - a2.re, im: w - a2.im });
        const A = analogMul(analogMul(a4, a3), analogMul(a2, a1));
        // The coupling highpass, s / (s + its corner in stage-corner units).
        const corner = this.fbG / (1 - this.fbG) / this.wc;
        const hpf = analogDiv(sj, { re: corner, im: w });
        const loop = analogMul(A, hpf);
        const gain = 1 + ANALOG_DIODE_COMPENSATION * k;
        return analogDiv({ re: A.re * gain, im: A.im * gain }, { re: 1 + k * loop.re, im: k * loop.im });
      }
      case ANALOG_SALLEN_KEY: {
        const k = Math.min(this.k, onset * 0.985);
        den = { re: 1 - w * w, im: (3 - k) * w };
        num = { re: this.wl - this.wh * w * w, im: this.wb * w };
        return analogDiv(num, den);
      }
      default: {
        const k = 2 - Math.min(this.k, onset * 0.985);
        den = { re: 1 - w * w, im: k * w };
        num = { re: this.wl - this.wh * w * w, im: this.wb * w };
        return analogDiv(num, den);
      }
    }
  }
}

function analogMul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function analogDiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
