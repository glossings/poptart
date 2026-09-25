// Wavetable warp: a pure phase -> phase function applied before the table is read.
//
// Warping the phase rather than the sample is what makes one table into a family of timbres.
// Reading a sine table with a phase that speeds up and slows down inside the cycle IS frequency
// modulation, done cheaply and without a second oscillator; reading it with a phase that wraps
// early is oscillator sync; reading it through a staircase is decimation. Every mode below is
// one function of (phase, amount), so adding a mode is one case and nothing else changes.
//
// TWO RULES every mode keeps, and they are the whole reason this file is worth having:
//
//   1. amount 0 is the IDENTITY. Every mode. A warp amount is therefore an honest modulation
//      depth - an envelope or an LFO can sweep it up from nothing, and switching modes while
//      the amount sits at zero is silent. Where a mode has an internal parameter that
//      degenerates to identity (a bend exponent of 1, a sync ratio of 1) that parameter carries
//      it; where it does not (a fold is a fold at any depth) the mode blends with the dry phase
//      instead. Both are noted per mode below.
//   2. The result stays in 0..1 and stays periodic in the input phase, so the oscillator above
//      can keep treating one cycle as one cycle.
//
// Nothing here is random at run time: the modes that sound noisy (brownian, primes, binary) are
// deterministic functions of the phase, so a note sounds the same every time it is played and a
// song is reproducible. A genuinely random warp would be an LFO patched into the amount.

const TWO_PI = Math.PI * 2;

/** The phase warps, in panel order. The index is what the descriptor's enum stores in a song. */
export const PHASE_WARPS = Object.freeze([
  'none', 'asym', 'mirror', 'bend+', 'bend-', 'sync', 'quantize', 'fold', 'flip',
  'orbit', 'spin', 'chaos', 'reciprocal', 'sigmoid', 'fractal', 'brownian', 'primes', 'binary',
]);

/**
 * The cross-modulation modes, which sit on the same switch as the phase warps and use the same
 * amount knob as their depth. They are not phase functions: what bends the phase is another
 * source in the voice - the other oscillator, the sub, the noise - so warpPhase() treats them as
 * the identity and the voice does the work. Listing them here rather than on a second switch is
 * deliberate: "how is this oscillator being bent" is one question, whether the answer is a
 * shape or a signal.
 *
 * FM is linear, through zero: the modulator moves the frequency by a multiple of the carrier's
 * own, so the sidebands stay harmonic and the pitch stays put, as it does on a dedicated FM
 * synth. PM adds the modulator to the phase in cycles. Ring multiplies. All grow with the square
 * of the amount, so the first half of the knob is the musical range and the top is the noise.
 */
export const CROSS_MODES = Object.freeze([
  ['fm osc', 'fm', 'osc'], ['pm osc', 'pm', 'osc'],
  ['fm sub', 'fm', 'sub'], ['pm sub', 'pm', 'sub'],
  ['fm noise', 'fm', 'noise'], ['pm noise', 'pm', 'noise'],
  ['ring osc', 'ring', 'osc'],
]);

/** Every mode on the switch: the phase warps, then the cross-modulations. */
export const WARP_MODES = Object.freeze([...PHASE_WARPS, ...CROSS_MODES.map(([name]) => name)]);

/**
 * What a mode index does with another source, or null for a phase warp. `kind` is 'fm', 'pm'
 * or 'ring'; `source` is 'osc' (the other oscillator), 'sub' or 'noise'.
 */
export function crossModOf(mode) {
  const i = mode - PHASE_WARPS.length;
  if (i < 0 || i >= CROSS_MODES.length) return null;
  const [, kind, source] = CROSS_MODES[i];
  return { kind, source };
}

/** The frequency multiple a full-scale modulator swings the carrier by, at a cross-mod amount. */
export function fmDepth(amount) {
  const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  return 12 * a * a;
}

/** The phase offset, in cycles, a full-scale modulator adds at a cross-mod amount. */
export function pmDepth(amount) {
  const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  return 4 * a * a;
}

/** Name to index, for the descriptor's enum and for tests that would rather read a name. */
export const WARP_INDEX = Object.freeze(
  WARP_MODES.reduce((acc, name, i) => { acc[name] = i; return acc; }, Object.create(null)),
);

/** Positive fractional part - JS `%` keeps the sign of the dividend, which wraps phase wrong. */
const frac = (x) => x - Math.floor(x);

/** Blend from the dry phase to a warped one. The escape hatch for modes with no neutral setting. */
const blend = (phase, warped, amount) => phase + amount * (warped - phase);

/**
 * A deterministic smooth curve of period 1, in -1..1, used by `brownian`. Three hashed
 * harmonics with fixed irrational-ish offsets: cheap, periodic (so the waveform stays a
 * waveform), and the same on every machine.
 */
function wander(p) {
  return (
    Math.sin(TWO_PI * (p + 0.1237)) * 0.5 +
    Math.sin(TWO_PI * (2 * p + 0.6842)) * 0.3 +
    Math.sin(TWO_PI * (5 * p + 0.3159)) * 0.2
  );
}

/** The first primes, for `primes`. Small on purpose: past this the steps stop being audible. */
const PRIMES = Object.freeze([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]);

/**
 * Warps one phase.
 *
 * `phase` is 0..1 (already wrapped), `amount` is 0..1 (clamped here), `mode` is an index into
 * WARP_MODES. An unknown mode is the identity rather than an error: a song written against a
 * later version that adds a mode should play quietly wrong, not refuse to play.
 */
export function warpPhase(phase, amount, mode) {
  const p = frac(phase);
  const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  if (a === 0) return p;

  switch (mode) {
    // Two straight segments meeting at (b, 0.5): the first half of the table is squeezed into
    // the first b of the cycle and the second half stretched over the rest. On a saw table this
    // is pulse width; on anything else it is a lurch. Identity at b = 0.5.
    case 1: { // asym
      const b = 0.5 * (1 - 0.98 * a);
      return p < b ? (0.5 * p) / b : 0.5 + (0.5 * (p - b)) / (1 - b);
    }

    // The table read forward then backward inside one cycle, so the waveform becomes even-
    // symmetric and the odd harmonics cancel. No neutral setting - a mirror is a mirror - so it
    // blends up from the dry phase.
    case 2: { // mirror
      const skewed = warpPhase(p, a, 1);
      const mirrored = skewed < 0.5 ? skewed * 2 : 2 - skewed * 2;
      return blend(p, mirrored, a);
    }

    // Power curves. The exponent is 1 at amount 0, so both are neutral there by construction.
    case 3: return Math.pow(p, 1 + 3 * a);          // bend+ : dwell at the start
    case 4: return Math.pow(p, 1 / (1 + 3 * a));    // bend- : dwell at the end

    // Oscillator sync: the phase runs faster and wraps early, restarting the waveform inside
    // the cycle. The ratio is 1 at amount 0. Squaring the amount puts the musically useful
    // low ratios across most of the knob.
    case 5: { // sync
      const ratio = Math.pow(16, a * a);
      return frac(p * ratio);
    }

    // A staircase: the table is read at N points instead of continuously, which is decimation
    // in the phase domain rather than the time domain, so it tracks pitch. N falls from 128 to
    // 2, and the blend carries the neutral end.
    case 6: { // quantize
      const n = Math.max(2, Math.round(Math.pow(2, 7 - 6 * a)));
      return blend(p, Math.floor(p * n) / n, a);
    }

    // Triangle folding: the phase runs up and down k times per cycle, so one cycle of the table
    // becomes k mirrored repeats. Harmonically the loudest of these modes.
    case 7: { // fold
      const k = 1 + 6 * a;
      return blend(p, Math.abs(frac(k * p) - 0.5) * 2, a);
    }

    // The table read all the way up and then all the way back down inside one cycle, with the
    // turning point moving earlier as the amount rises: at amount 1 the rise takes a tenth of
    // the cycle and the fall the rest. Unlike `mirror` the turn is not centered, so the two
    // halves are read at different speeds and the result keeps its odd harmonics.
    //
    // The map is deliberately continuous at the turn AND lands back on 0 at the end of the
    // cycle, so there is no step at the turn and none at the wrap either.
    case 8: { // flip
      const t = 1 - 0.9 * a;
      if (p < t) return p / t;
      return 1 - (p - t) / (1 - t);
    }

    // A sine ripple added to the phase: the table is read faster then slower within the cycle,
    // which is phase modulation at a fixed harmonic ratio. Depth is 0 at amount 0.
    case 9: { // orbit
      return frac(p + 0.5 * a * Math.sin(TWO_PI * 3 * p));
    }

    // The same ripple, but its harmonic ratio climbs with the amount, so the timbre moves up
    // the series instead of just deepening.
    case 10: { // spin
      const n = 1 + Math.floor(5 * a);
      return frac(p + 0.5 * a * Math.sin(TWO_PI * n * p));
    }

    // One step of the logistic map, blended in. Smooth at low amounts, increasingly bunched at
    // the ends as it goes up - the phase spends its time at the edges of the table.
    case 11: { // chaos
      const r = 3.7 + 0.3 * a;
      return blend(p, Math.min(1, Math.max(0, r * p * (1 - p))), a);
    }

    // A Moebius curve: monotonic, smooth, no corners anywhere, compressing one end of the table
    // and stretching the other. The gentlest mode here, and the one that stays musical under a
    // fast LFO because it has no discontinuity to click on.
    case 12: { // reciprocal
      const k = 4 * a;
      return (p * (1 + k)) / (1 + k * p);
    }

    // An S-curve around the middle of the table: the two halves are pushed apart and the center
    // is crossed quickly. tanh's own slope carries the identity as the steepness goes to zero.
    case 13: { // sigmoid
      const s = 4 * a;
      if (s < 1e-4) return p;
      const t = Math.tanh(s * (2 * p - 1)) / Math.tanh(s);
      return 0.5 + 0.5 * t;
    }

    // Three octaves of ripple at once rather than orbit's one, which smears the table into
    // something closer to noise as it opens up. Scaled so the sum cannot outrun the phase.
    case 14: { // fractal
      const r =
        Math.sin(TWO_PI * 2 * p) * 0.5 +
        Math.sin(TWO_PI * 4 * p) * 0.25 +
        Math.sin(TWO_PI * 8 * p) * 0.125;
      return frac(p + 0.35 * a * r);
    }

    // A fixed wandering offset: the table is read out of order, but the same way every cycle,
    // so it is a timbre and not a noise source.
    case 15: { // brownian
      return frac(p + 0.35 * a * wander(p));
    }

    // The cycle cut into a prime number of steps which are then permuted by another prime. The
    // waveform is shuffled rather than smeared: chunks of the table in a fixed wrong order.
    case 16: { // primes
      const n = PRIMES[Math.min(PRIMES.length - 1, Math.floor(a * PRIMES.length))];
      const step = Math.floor(p * n);
      const within = p * n - step;
      const moved = (step * 7 + 3) % n;
      return blend(p, (moved + within) / n, a);
    }

    // The phase as a 12-bit integer, XORed with a mask that widens as the amount rises. The one
    // genuinely digital mode: hard steps, strong aliasing (the oscillator's mip selection reads
    // the local slope, so it does what it can), and completely deterministic.
    case 17: { // binary
      const bits = 12;
      const scale = 1 << bits;
      const i = Math.min(scale - 1, Math.floor(p * scale));
      const mask = Math.floor(a * (scale - 1));
      return blend(p, (i ^ mask) / scale, a);
    }

    default:
      return p;
  }
}

/**
 * How fast the table is being traversed right now, in table-cycles per sample.
 *
 * This is the number the oscillator needs to pick a band limit, and measuring it beats deriving
 * it per mode: a warp can multiply the traversal rate by a lot (sync at full amount reads the
 * table sixteen times per cycle, fold seven), and a table read faster than it was band-limited
 * for is exactly what aliases. Taking the difference across one real sample step also catches
 * the modes with corners, which have no derivative to solve for.
 *
 * Returns an absolute value; the sign of the traversal does not change what aliases. A wrap is
 * detected and folded back rather than being read as a huge jump, since a wrap is the phase
 * going round, not the table being read at 2000x.
 */
export function warpSlope(phase, increment, amount, mode) {
  const a = warpPhase(phase, amount, mode);
  const b = warpPhase(phase + increment, amount, mode);
  let d = b - a;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return Math.abs(d);
}
