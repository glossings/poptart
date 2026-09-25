// Waveshapers - the eleven curves behind the one Distort device.
//
// One device with a mode switch rather than eleven devices, because they all want the same
// things around them: drive into the curve, bias to push it off center, a tone control after
// it, a dry/wet and an output trim. Splitting them up would be eleven copies of that plumbing
// and eleven names to remember, and it would make A/B-ing two curves an edit rather than a knob.
//
// Every curve here is a PURE function of one sample. That is what lets the device oversample:
// run the same function at four times the rate and the harmonics it generates above the
// original Nyquist rate are filtered off rather than folded back down. Two of the modes are not
// pure in that sense, and they are
// marked so the device runs them at the real rate, where they mean something.

/** Mode names, in panel order. The index is what the descriptor's enum stores in a song. */
export const SHAPER_MODES = Object.freeze([
  'soft', 'hard', 'fold', 'sine', 'asym', 'tube', 'diode', 'westcoast', 'cheby',
]);

export const SHAPER_INDEX = Object.freeze(
  SHAPER_MODES.reduce((acc, name, i) => { acc[name] = i; return acc; }, Object.create(null)),
);

/**
 * Every mode here is a curve, and so can be oversampled. It was not always: bit crushing and
 * downsampling lived here too and had to be exempted, which is half of why they are their own
 * device now (see devices/crush.mjs). The flag stays because the oversampler asks.
 */
export const IS_CURVE = Object.freeze(SHAPER_MODES.map(() => true));

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

/**
 * One sample through one curve.
 *
 * `drive` is a linear gain (the device converts its dB knob before calling), `bias` shifts the
 * input before shaping - which is how the symmetric curves are made to produce even harmonics -
 * and `extra` is the one mode-specific number some curves want.
 */
export function shape(x, mode, drive, bias, extra) {
  const v = x * drive + bias;
  switch (mode) {
    // The workhorse. Rounds the peaks off rather than cutting them, so it stays musical a long
    // way past the point where hard clipping has turned to buzz.
    case 0: return Math.tanh(v);

    // A straight cut. Everything above full scale becomes full scale, which is the harshest
    // thing here and the most useful on drums.
    case 1: return clamp1(v);

    // Past full scale the signal turns round and comes back. Piling on drive walks the output
    // up and down through the fold repeatedly, which is where the metallic, inharmonic sound
    // comes from.
    case 2: return foldTriangle(v);

    // A sine as the transfer curve: smooth folding, with a gentler first fold than the triangle
    // and a warmer result.
    case 3: return Math.sin(v * Math.PI * 0.5);

    // Asymmetric soft clipping: the positive half is squashed harder than the negative one, so
    // the curve produces even harmonics on its own without needing a bias.
    case 4: return v >= 0 ? Math.tanh(v) : Math.tanh(v * 0.6) * 0.8;

    // A valve-ish curve: soft in the middle, a long shoulder one way and a harder knee the
    // other. The asymmetry puts a second harmonic under everything, which is the part people
    // mean by warmth.
    case 5: {
      if (v >= 0) return 1 - Math.exp(-v);
      return -1 + Math.exp(v * 0.7);
    }

    // A pair of diodes to ground: almost nothing happens below the forward voltage and the
    // curve bends sharply above it. The knee is what makes it sound like a pedal.
    case 6: {
      const knee = 0.35;
      const a = Math.abs(v);
      if (a <= knee) return v;
      const over = a - knee;
      return Math.sign(v) * (knee + (1 - knee) * Math.tanh(over / (1 - knee)));
    }

    // Two folds in series, each driven into the next, which is the west-coast arrangement: the
    // second stage folds what the first already folded, so the series it generates is far denser
    // than one fold at the same drive.
    //
    // The offset between the stages is the BIAS and nothing else. A fixed offset here - which is
    // the obvious way to write it - makes the mode asymmetric even with the bias at zero, so it
    // puts a constant on its output and shifts a quiet signal off center whatever the settings
    // say. Driven by the bias, the curve stays odd until somebody asks for it not to be.
    //
    // It has real gain inside it, so it is louder than the other curves at the same drive. That
    // is the shape doing its job, and the auto-gain control is what evens it out.
    case 7: {
      const stage = foldTriangle(v * 1.5);
      return foldTriangle(stage * 1.5 + bias * 0.5);
    }

    // A Chebyshev polynomial adds one chosen harmonic rather than a whole series, so it can
    // pitch the signal up an octave or a fifth without the buzz a clipper would bring. `extra`
    // picks which harmonic, and the input is clipped first because the polynomials only behave
    // inside the unit interval.
    case 8: {
      const n = Math.max(1, Math.min(8, Math.round(extra)));
      const t = clamp1(v);
      return Math.cos(n * Math.acos(clamp1(t)));
    }

    default:
      return clamp1(v);
  }
}

/**
 * Which modes put a DC offset on their output by their own shape, and so always need blocking.
 * The rest only need it when a bias has been dialled in - and blocking a mode that does not
 * need it is not free - it is one more filter in the path of a signal that did not ask for one.
 */
export const ASYMMETRIC = Object.freeze(
  SHAPER_MODES.map((_, i) => i === 4 || i === 5),
);

/**
 * How much a curve at this setting changes the level, measured rather than derived.
 *
 * The auto-gain knob is there so that turning drive up does not just turn everything up - the
 * point of a distortion is the shape it makes, and comparing two settings is impossible if one
 * is simply louder. Deriving the correction per curve would be eleven bits of algebra that go
 * stale the moment a curve is edited, so this probes the curve with a sine instead and returns
 * the ratio of what came out to what went in.
 *
 * Clamped, because a fold can land almost exactly on a zero crossing for a whole probe and ask
 * for a correction of several hundred.
 */
export function autoGainFor(mode, drive, bias, extra) {
  const PROBES = 64;
  const amplitude = 0.5;
  let sum = 0;
  for (let i = 0; i < PROBES; i++) {
    const x = Math.sin((i / PROBES) * Math.PI * 2) * amplitude;
    const y = shape(x, mode, drive, bias, extra);
    sum += y * y;
  }
  const out = Math.sqrt(sum / PROBES);
  const inRms = amplitude / Math.SQRT2;
  if (!(out > 1e-6)) return 1;
  return Math.min(8, Math.max(0.05, inRms / out));
}
