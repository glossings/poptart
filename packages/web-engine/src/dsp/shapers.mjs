// Waveshapers - the curves behind the one Distort device.
//
// One device with a mode switch rather than eleven devices, because they all want the same
// things around them: drive into the curve, bias to push it off center, a tone control after
// it, a dry/wet and an output trim. Splitting them up would be eleven copies of that plumbing
// and eleven names to remember, and it would make A/B-ing two curves an edit rather than a knob.
//
// Every curve is a PURE function of one sample, which is what lets the device oversample: the
// same curve at four times the rate, and the harmonics it makes above the original Nyquist rate
// are filtered off rather than folded back down.

const clamp1 = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);

/**
 * Triangle wavefolding: past full scale the signal turns round instead of clipping.
 *
 * A triangle of period 4 that is the IDENTITY on -1..1 - fold(0.5) has to be 0.5, not -0.5, or
 * the mode inverts everything it is given at low drive and the "fold" is really a phase flip.
 */
function foldTriangle(x) {
  let p = (x + 1) * 0.25;
  p -= Math.floor(p);
  return 1 - Math.abs(p * 4 - 2);
}

// ---------------------------------------------------------------------------------------------
// The curves.
//
// The first nine are the ones Distort shipped with in 0.2.0, in the same order; the rest are
// appended after them, since an index is what a saved song holds. Most of them take a CHARACTER, 0..1, read from one knob the device
// shares across all of them: the asymmetry of asym, the number of steps in stairs, which harmonic
// cheby adds, and so on. One knob rather than one per curve so that whatever drives it - an lfo,
// an automation lane - goes on driving it when the curve changes. At 0.5 every curve that had a
// fixed version of it sounds as it did.
//
// A curve earns a place by changing the sound of ANY signal put through it - a chord through a
// reverb as much as a clean mono line. Curves that only showed on particular material (an
// octave divider, slew limiting, hysteresis, a level-gated fuzz, crossover, a power curve that
// was soft with a harder knee) were tried and taken out for sounding like soft on most of it.
//
// Past the named modes, a mode is a curve somebody DREW (see the descriptor's `takes: 'shape'`):
// a table the engine sampled from breakpoints, read here from -1 to 1 on both axes.
// ---------------------------------------------------------------------------------------------

export const SHAPER_MODES = Object.freeze([
  'soft', 'hard', 'fold', 'sine', 'asym', 'tube', 'diode', 'westcoast', 'cheby',
  'rectify', 'stairs', 'harmonics', 'wrap', 'bitflip', 'chaos',
]);

export const SHAPER_INDEX = Object.freeze(
  SHAPER_MODES.reduce((acc, name, i) => { acc[name] = i; return acc; }, Object.create(null)),
);

/** Every mode is played sample by sample in order, so all of them can be oversampled. */
export const IS_CURVE = Object.freeze(SHAPER_MODES.map(() => true));

/** The curves the Character knob does something to; on the rest it is hidden and ignored. */
export const TAKES_CHARACTER = Object.freeze(SHAPER_MODES.filter((name) => !['hard', 'fold', 'sine'].includes(name)));

/**
 * Which modes put an offset on their output by their own shape. Version 2 blocks DC on every
 * curve anyway; this says which ones would need it.
 */
export const ASYMMETRIC = Object.freeze(SHAPER_MODES.map((name) =>
  ['asym', 'tube', 'diode', 'rectify', 'harmonics', 'bitflip', 'chaos'].includes(name)));

/** Which harmonic cheby adds at a character: the 2nd at 0.5, the 8th at 1. */
export const chebyHarmonic = (c) => 1 + Math.round(7 * Math.pow(Math.min(1, Math.max(0, c)), 2.5));

/**
 * The whole-number setting a character picks on the curves where it moves in steps - cheby's
 * harmonic, bitflip's mask - or null where it moves smoothly. A change in it is
 * a change of curve, and the device crossfades it like one rather than cutting over mid-wave.
 */
export function characterStep(mode, c) {
  const k = Math.min(1, Math.max(0, Number.isFinite(c) ? c : 0.5));
  if (mode === SHAPER_INDEX.cheby) return chebyHarmonic(k);
  if (mode === SHAPER_INDEX.bitflip) return Math.round(k * 126);
  return null;
}

/** Chebyshev polynomial T_n at t, for t in -1..1. */
function chebyshev(n, t) {
  let a = 1;
  let b = t;
  if (n === 0) return a;
  for (let k = 2; k <= n; k++) { const c = 2 * t * b - a; a = b; b = c; }
  return b;
}

/** A drawn transfer curve at v: the table spans -1..1 in and 0..1 (meaning -1..1) out. */
function drawnCurve(table, v) {
  const n = table.length;
  const p = ((clamp1(v) + 1) / 2) * (n - 1);
  const i = Math.floor(p);
  const a = table[i];
  const b = table[Math.min(n - 1, i + 1)];
  return clamp1((a + (b - a) * (p - i)) * 2 - 1);
}

/** A soft clip with a knee as hard as `p`: 2 is close to tanh, 8 nearly a straight cut. */
const knee = (v, p) => v / Math.pow(1 + Math.pow(Math.abs(v), p), 1 / p);

/** How many stairs a side the staircase has, at full scale. The drive sets how many are crossed. */
const STAIRS = 4;

/**
 * One sample through one curve.
 *
 * `drive` is a linear gain (the device converts its dB knob before calling), `bias` shifts the
 * input before shaping, `character` is the shared 0..1 knob (see the section note), and `table`
 * is the drawn curve for a mode past the named ones.
 */
export function shape(x, mode, drive, bias, character = 0.5, table = null) {
  const c = Math.min(1, Math.max(0, Number.isFinite(character) ? character : 0.5));
  const v = x * drive + bias;
  switch (mode) {
    // The workhorse, with a knee as soft or as hard as the character asks: tanh at 0.5, a gentle
    // rational curve at 0, nearly a straight cut at 1.
    case SHAPER_INDEX.soft:
      return c <= 0.5
        ? v / (1 + Math.abs(v)) + (Math.tanh(v) - v / (1 + Math.abs(v))) * (c * 2)
        : Math.tanh(v) + (knee(v, 8) - Math.tanh(v)) * ((c - 0.5) * 2);

    // A straight cut. Everything above full scale becomes full scale: the harshest curve here,
    // and the most useful on drums.
    case SHAPER_INDEX.hard: return clamp1(v);

    // Past full scale the signal turns round and comes back; more drive walks it up and down
    // through the fold again and again, which is where the metallic sound comes from.
    case SHAPER_INDEX.fold: return foldTriangle(v);

    // A sine as the transfer curve: smooth folding, gentler at the first fold than the triangle.
    case SHAPER_INDEX.sine: return Math.sin(v * Math.PI * 0.5);

    // Soft clipping squashed harder one way than the other: symmetric at 0, the negative half
    // nearly flattened at 1 - which walks from odd harmonics towards a half-wave's even ones.
    case SHAPER_INDEX.asym:
      return v >= 0 ? Math.tanh(v) : Math.tanh(v * (1 - 0.8 * c)) * (1 - 0.4 * c);

    // A valve-ish curve: a long shoulder one way and a harder knee the other, more lopsided as
    // the character rises.
    case SHAPER_INDEX.tube:
      return v >= 0 ? 1 - Math.exp(-v) : -1 + Math.exp(v * (1 - 0.6 * c));

    // One silicon diode one way and a stack the other: nearly straight up to the knee and then a
    // hard bend onto a ceiling. The character sets how much lower the positive ceiling sits.
    case SHAPER_INDEX.diode: {
      const ceiling = v >= 0 ? 1 - 0.76 * c : 1;
      return v / Math.pow(1 + Math.pow(Math.abs(v) / ceiling, 6), 1 / 6);
    }

    // Two folds in series; the character is the gain between them, 1 to 2.
    case SHAPER_INDEX.westcoast: {
      const g = 1 + c;
      return foldTriangle(foldTriangle(v * g) * g + bias * 0.5);
    }

    // One chosen harmonic: the second at 0.5, up to the eighth at 1 (the curve is steep so the
    // musical low ones get most of the travel). Less its value at silence, which is -1, 0 or +1 by
    // harmonic: left in, turning the knob across harmonics jumped the output by that much, and a
    // DC blocker passes a jump straight through - a pop on every step, heard even on silence.
    case SHAPER_INDEX.cheby: {
      const n = chebyHarmonic(c);
      return Math.cos(n * Math.acos(clamp1(v))) - Math.cos(n * Math.PI / 2);
    }

    // Rectification, from none through a half-wave (0.5, every even harmonic) to a full-wave (1,
    // a sine comes out an octave up).
    case SHAPER_INDEX.rectify: {
      const u = Math.tanh(v);
      if (u >= 0) return u;
      return c <= 0.5 ? u * (1 - 2 * c) : -u * (2 * c - 1);
    }

    // A staircase, four stairs a side (the drive sets how many a signal crosses). The character
    // is the shape of each stair: smooth sine stairs at 0, rounded treads with no jumps at all;
    // hard stairs at 0.5, flat treads and square edges; diagonal at 1, every stair sloped and a
    // jump at each edge, so nothing is flat and a quiet signal still passes. (Smooth stairs as the
    // default rounded off so much that at ordinary drive it came out close to hard clipping.)
    case SHAPER_INDEX.stairs: {
      const t = clamp1(v) * STAIRS;
      const hard = Math.round(t);
      const diagonal = hard + (t - hard) * 0.5;
      const smooth = t - Math.sin(2 * Math.PI * t) / (2 * Math.PI);
      const y = c <= 0.5 ? smooth + (hard - smooth) * (c * 2) : hard + (diagonal - hard) * ((c - 0.5) * 2);
      return y / STAIRS;
    }

    // A blend of Chebyshev harmonics that the drive walks through, one more per six decibels, the
    // second to the eighth. The character tilts them: dark at 0, each 1/k at 0.5, all equal at 1.
    // Each is taken less its value at silence, so the blend adds overtones and not an offset - an
    // offset the level correction counted as loudness and the DC blocker then took away, which is
    // what made this mode sound quiet at every drive.
    case SHAPER_INDEX.harmonics: {
      const t = clamp1(x + bias);
      const reach = Math.log2(Math.max(1, drive));
      const tilt = 2 - 2 * c;
      let y = t;
      let norm = 1;
      for (let k = 2; k <= 8; k++) {
        const w = Math.min(1, Math.max(0, reach - (k - 2))) / Math.pow(k, tilt);
        if (w === 0) break;
        y += w * (chebyshev(k, t) - chebyshev(k, 0));
        // An even term less its value at silence swings twice as far - it counts double.
        norm += k % 2 === 0 ? 2 * w : w;
      }
      return y / norm;
    }

    // Integer overflow: past full scale the signal comes back in from the other side, the way a
    // digital sum wraps - a tear, not a fold. The character is how hard the tear is: at 1 it is a
    // sheer drop, the harshest sound here; lower, the drop is a steep slope that starts earlier,
    // and at 0 it is a slope as long as the rise - a fold, at half scale. Below the tear the signal is
    // untouched, so the drive decides how often it wraps and the character what the wrap sounds
    // like - where a shrinking wrap range, as it first was, was only a second drive knob.
    case SHAPER_INDEX.wrap: {
      const edge = 0.5 - 0.49 * c; // how much of each side the return takes, 0.5 to 0.01
      const m = ((((v + 1) % 2) + 2) % 2) - 1; // the plain wrap, into -1..1
      const top = 1 - edge;
      if (m >= -top && m <= top) return m;
      // On the return: from the top of the rise at 1 - edge, down to the bottom of the next one.
      const along = m > 0 ? m - top : m + 2 - top;
      return top - along * (top / edge);
    }

    // The signal's magnitude as seven bits, exclusive-ored with a mask the character sets - but
    // only below its own top bit, so each level is scrambled within its own octave of loudness:
    // quiet stays quiet, loud stays loud, and in between the levels are rearranged into a broken,
    // digital buzz no analog circuit makes. 0 is plain 8-bit. (Flipping the whole word turned
    // silence, which sits at the middle of it, into full scale.)
    case SHAPER_INDEX.bitflip: {
      const m = Math.round(Math.abs(clamp1(v)) * 127);
      if (m === 0) return 0;
      const below = (1 << (31 - Math.clz32(m))) - 1;
      // Over 126, not 127: at 0.5 that is 63, every bit below the top one, where 64 was above all
      // of them and changed nothing.
      const mask = Math.round(c * 126) & below;
      return Math.sign(v) * ((m ^ mask) / 127);
    }

    // The logistic map, iterated: the saturated signal is the seed and the character the growth
    // rate, 3 to 4. Low, it doubles and quadruples the waveform's turns; past about 0.57 the map
    // is chaotic, and every input level lands somewhere unrelated to its neighbor's.
    case SHAPER_INDEX.chaos: {
      const r = 3 + c;
      let u = (Math.tanh(v) + 1) / 2;
      for (let k = 0; k < 4; k++) u = r * u * (1 - u);
      return u * 2 - 1;
    }

    default:
      return table ? drawnCurve(table, v) : clamp1(v);
  }
}

/**
 * How much a curve at this setting changes the level, measured rather than derived: the curve is
 * probed with a sine and the ratio of what went in to what came out is the correction, clamped
 * because a fold can land on a zero crossing for a whole probe and ask for hundreds. Measured on the part
 * you hear: the probe's average is taken off first, since the device blocks it.
 */
export function autoGainFor(mode, drive, bias, character, table = null) {
  // 256 points a cycle, not version 1's 64: a curve that throws a few sharp spikes a cycle (chaos,
  // wrap) is measured by where the probe lands, and too coarse a probe missed most of them.
  const PROBES = 256;
  const amplitude = 0.5;
  const ys = [];
  for (let i = 0; i < PROBES; i++) ys.push(shape(Math.sin((i / PROBES) * Math.PI * 2) * amplitude, mode, drive, bias, character, table));
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const out = Math.sqrt(ys.reduce((a, y) => a + (y - mean) * (y - mean), 0) / ys.length);
  const inRms = amplitude / Math.SQRT2;
  if (!(out > 1e-6)) return 1;
  return Math.min(8, Math.max(0.05, inRms / out));
}

/**
 * The harmonics a curve makes of a half-scale sine, in decibels against that sine, second to
 * eighth. Against the INPUT, not the output's own fundamental: a curve that all but cancels the
 * fundamental (a full-wave rectifier, a flat drawn curve) would otherwise read every harmonic as
 * enormous. Transfer curves that look alike can sound quite different, and most of the difference
 * is here: an even harmonic is a lean in the curve a few pixels wide, and a bar a third of the
 * picture tall.
 */
export function harmonicsOf(mode, drive, bias, character, table = null) {
  const N = 256;
  const ys = new Float64Array(N);
  for (let i = 0; i < N; i++) ys[i] = shape(0.5 * Math.sin((2 * Math.PI * i) / N), mode, drive, bias, character, table);
  const amp = new Float64Array(9);
  for (let k = 1; k <= 8; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const ph = (2 * Math.PI * i) / N;
      re += ys[i] * Math.cos(k * ph);
      im += ys[i] * Math.sin(k * ph);
    }
    amp[k] = Math.hypot(re, im);
  }
  const ref = 0.5 * (N / 2); // the input sine's own bin, at the probe's half-scale amplitude
  return Array.from({ length: 7 }, (_, i) => 20 * Math.log10(Math.max(1e-9, amp[i + 2]) / ref));
}
