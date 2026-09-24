// Wavetables: frames, mipmaps, and the tables poptart ships with.
//
// A wavetable is a stack of single-cycle FRAMES. The oscillator's `position` control picks a
// place in that stack and reads between the two frames on either side of it, so sweeping the
// position morphs one waveform into the next. The shipped "Basic" table puts the classic
// waveforms in one stack in order of brightness, which is the usual way to ship them: a single
// oscillator with a position knob covers what a whole bank of shapes would otherwise need.
//
// MIPMAPS are the other half. Every frame is kept at several band limits - the same frame with
// progressively fewer harmonics - and the oscillator reads whichever copy is safe at the rate
// it is currently traversing the table. Without that, a bright frame played high folds its
// harmonics back down as inharmonic hash, and a warp that reads the table eight times per
// cycle (sync, fold) does it eight times worse. This is the single biggest difference between
// a wavetable oscillator that sounds expensive and one that does not.
//
// The levels are stored at FULL LENGTH rather than decimated. A decimated pyramid would save
// about half the memory, at the cost of a different index step per level and a second set of
// interpolation edge cases in the hottest loop in the synth. A whole table is under a megabyte.

import { fft, fromHarmonics } from './fft.mjs';

/** The frame length every shipped table uses, and the default when a file says nothing else. */
export const FRAME_LENGTH = 2048;

/** Cached per frame length - the schedule is a pure function of it and is walked every block. */
const schedules = new Map();

/**
 * The harmonic limit of each mip level, brightest first.
 *
 * The spacing is deliberately uneven, and that is the whole design. Down the bright end, levels
 * are half an octave apart: losing the top third of a spectrum that runs to the twentieth
 * harmonic is not something anybody hears. Up the dull end - a note so high that only four
 * harmonics fit under the Nyquist rate - one harmonic either way is the difference between two
 * audibly different timbres, so the schedule steps one harmonic at a time there.
 *
 * A fixed halving per level would be uniform and wrong: it would waste levels where they do
 * nothing and skip whole timbres where they matter.
 */
export function harmonicSchedule(frameLength) {
  const cached = schedules.get(frameLength);
  if (cached) return cached;
  const out = [];
  let h = frameLength / 2;
  while (h > 8) {
    out.push(Math.max(1, Math.round(h)));
    h /= Math.SQRT2;
  }
  for (let k = 8; k >= 1; k--) out.push(k);
  const frozen = Object.freeze(out);
  schedules.set(frameLength, frozen);
  return frozen;
}

/** Harmonics kept at mip level L. */
export function harmonicsAtLevel(frameLength, level) {
  const schedule = harmonicSchedule(frameLength);
  const l = Math.min(schedule.length - 1, Math.max(0, Math.floor(level)));
  return schedule[l];
}

/** How many levels it takes to get from the full spectrum down to the fundamental alone. */
export function levelCount(frameLength) {
  return harmonicSchedule(frameLength).length;
}

/**
 * How long a level's copy needs to be. A frame band-limited to H harmonics is fully described
 * by 2H samples, and four per harmonic leaves enough headroom that reading it with straight
 * linear interpolation does not audibly dull it further. Keeping the dull levels short is what
 * makes the whole pyramid cost about twice one frame rather than twenty times it.
 */
export function lengthAtLevel(frameLength, level) {
  const want = harmonicsAtLevel(frameLength, level) * 4;
  let len = 16;
  while (len < want && len < frameLength) len *= 2;
  return Math.min(frameLength, len);
}

/**
 * Band-limited copies of one frame, level 0 first (every harmonic) down to a sine.
 *
 * Level 0 is the frame itself rather than a round trip through the transform: an unchanged
 * frame should be bit-for-bit what was loaded, so a table somebody made survives being loaded.
 *
 * The spectrum is taken ONCE and each level is one inverse transform of it with the bins above
 * its limit dropped - half the work of transforming every level from scratch, which matters
 * because a loaded table is hundreds of frames and this runs on every one of them.
 *
 * Levels below the first are decimated to `lengthAtLevel`. Decimation needs no filter of its
 * own because the band limit has already removed everything above the new half-length, so
 * dropping samples is exact rather than approximate.
 */
export function buildMipmaps(frame) {
  const n = frame.length;
  const levels = levelCount(n);
  const out = new Array(levels);
  out[0] = frame instanceof Float32Array ? frame : Float32Array.from(frame);
  const re0 = Float64Array.from(out[0]);
  const im0 = new Float64Array(n);
  fft(re0, im0);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let l = 1; l < levels; l++) {
    const keep = Math.max(0, Math.min(n / 2 - 1, harmonicsAtLevel(n, l)));
    re.set(re0);
    im.set(im0);
    for (let k = keep + 1; k <= n / 2; k++) {
      re[k] = 0; im[k] = 0;
      const mirror = n - k;
      if (mirror > k && mirror < n) { re[mirror] = 0; im[mirror] = 0; }
    }
    fft(re, im, true);
    const len = lengthAtLevel(n, l);
    const small = new Float32Array(len);
    const step = n / len;
    for (let i = 0; i < len; i++) small[i] = re[i * step];
    out[l] = small;
  }
  return out;
}

/**
 * Where to read the pyramid when the table is being traversed at `rate` cycles per sample.
 *
 * The highest harmonic that survives at that rate is `0.5 / rate` - harmonic H of a waveform
 * read at `rate` sits at `H * rate`, and anything at or above half the sample rate folds back.
 *
 * The number returned is a FRACTIONAL level, and the two properties it guarantees are what
 * makes the oscillator's crossfade both smooth and correct:
 *
 *   - its FLOOR is always a level that fits under the limit, so the brighter of the two copies
 *     the oscillator blends is already safe and the blend cannot alias. Interpolating towards
 *     the nearest level in each direction - the obvious thing - blends in a copy that is too
 *     bright by definition, and lets exactly the harmonics this is supposed to remove back in
 *     at a reduced volume.
 *   - it moves CONTINUOUSLY with the rate, including across the boundary where the floor
 *     changes, so a sweeping pitch hears a gradual change and never a step.
 *
 * `rate` is the post-warp traversal rate, not the note's frequency: a warp that reads the table
 * several times per cycle has to band-limit for the rate it actually reads at.
 */
export function mipLevelFor(rate, frameLength) {
  const schedule = harmonicSchedule(frameLength);
  const top = schedule.length - 1;
  const r = Math.abs(rate);
  if (!(r > 0)) return 0;
  const maxHarmonic = 0.5 / r;
  if (maxHarmonic >= schedule[0]) return 0;
  if (maxHarmonic <= schedule[top]) return top;
  // The first level that fits under the limit. Everything above it is too bright to blend in.
  let level = 0;
  while (level < top && schedule[level] > maxHarmonic) level++;
  if (level >= top) return top;
  if (level === 0) return 0;
  // How far the wanted limit has fallen through THIS level's window - from the limit that made
  // this level necessary down to its own. It reads 0 the moment a level becomes the safe one
  // and 1 the moment the next one takes over, which is what carries the value across every
  // boundary without a step.
  //
  // The one place it cannot is the very top: level 0 is the frame itself, so as soon as the
  // full spectrum stops fitting there is nothing to fade from and the value steps to 1. That
  // happens at a traversal of one cycle per frame length - a note around 23 Hz at the usual
  // sample rate - and the harmonics involved are the ones above 17 kHz, so the step is real and
  // inaudible rather than hidden.
  const prev = schedule[level - 1];
  const here = schedule[level];
  const w = prev === here ? 0 : (prev - maxHarmonic) / (prev - here);
  return level + Math.min(1, Math.max(0, w));
}

/**
 * A loaded wavetable: frames, their mipmaps, and enough metadata to name it in a panel.
 *
 * `frames` is an array of equal-length Float32Arrays. A single-frame table is legal and is what
 * a plain waveform is; the position control then has nowhere to go and is ignored.
 */
export function buildTable(name, frames, meta = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error(`[web-engine] table "${name}" has no frames`);
  }
  const length = frames[0].length;
  if (length < 4 || (length & (length - 1)) !== 0) {
    throw new Error(`[web-engine] table "${name}": frame length must be a power of two, got ${length}`);
  }
  for (const f of frames) {
    if (f.length !== length) throw new Error(`[web-engine] table "${name}": every frame must be the same length`);
  }
  return {
    name,
    length,
    frameCount: frames.length,
    levels: levelCount(length),
    mips: frames.map((f) => buildMipmaps(f)),
    source: meta.source ?? null,
    license: meta.license ?? null,
    // What each frame IS, where the table knows. A position readout that can say "saw → square"
    // beats one that can only say 0.42, and a table loaded from a file will not always know.
    names: meta.names ? Object.freeze(meta.names.map((n) => String(n))) : null,
  };
}

/**
 * A table whose pyramids were built elsewhere - on the main thread, in pieces, so a loaded file
 * does not stall the audio thread for the second its transforms take. `mips` is what buildTable
 * would have computed, frame by frame.
 */
export function tableFromMips(name, mips, meta = {}) {
  if (!Array.isArray(mips) || mips.length === 0) throw new Error(`[web-engine] table "${name}" has no frames`);
  const length = mips[0][0].length;
  return {
    name,
    length,
    frameCount: mips.length,
    levels: mips[0].length,
    mips,
    source: meta.source ?? null,
    license: meta.license ?? null,
    names: meta.names ? Object.freeze(meta.names.map((n) => String(n))) : null,
  };
}

/**
 * A frame at another length, read by linear interpolation - for a file whose frames are not a
 * power of two long, which the pyramid needs them to be.
 */
export function resampleFrame(frame, length) {
  const out = new Float32Array(length);
  const m = frame.length;
  for (let i = 0; i < length; i++) {
    const x = (i / length) * m;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = frame[j % m] + (frame[(j + 1) % m] - frame[j % m]) * f;
  }
  return out;
}

/** The power of two a frame length is rounded up to. */
export function powerOfTwoAtLeast(n) {
  let len = 4;
  while (len < n) len *= 2;
  return len;
}

/** Peak-normalizes a frame to 1, leaving a silent frame alone. */
export function normalizeFrame(frame) {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
  if (peak <= 0) return frame;
  const g = 1 / peak;
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] * g;
  return out;
}

/** Subtracts the mean, so a pulse frame sits around zero rather than pushing the amp off center. */
export function removeDc(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i];
  const mean = sum / frame.length;
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] - mean;
  return out;
}

/** The frame names of the shipped Basic table, for the panel's position readout. */
export const BASIC_FRAME_NAMES = Object.freeze([
  'sine', 'triangle', 'saw', 'square', 'pulse 37', 'pulse 25', 'pulse 12',
]);

const HARMONIC_LIMIT = FRAME_LENGTH / 2 - 1;

/** A band-limited rising sawtooth: every harmonic at 1/k. */
function sawFrame(length = FRAME_LENGTH) {
  return fromHarmonics(length, HARMONIC_LIMIT, (k) => (k % 2 === 1 ? 1 : -1) * (2 / Math.PI) / k);
}

/** A band-limited square: odd harmonics at 1/k. */
function squareFrame(length = FRAME_LENGTH) {
  return fromHarmonics(length, HARMONIC_LIMIT, (k) => (k % 2 === 1 ? (4 / Math.PI) / k : 0));
}

/** A band-limited triangle: odd harmonics at 1/k squared, alternating sign. */
function triangleFrame(length = FRAME_LENGTH) {
  return fromHarmonics(length, HARMONIC_LIMIT, (k) => {
    if (k % 2 === 0) return 0;
    const sign = ((k - 1) / 2) % 2 === 0 ? 1 : -1;
    return sign * (8 / (Math.PI * Math.PI)) / (k * k);
  });
}

function sineFrame(length = FRAME_LENGTH) {
  return fromHarmonics(length, 1, (k) => (k === 1 ? 1 : 0));
}

/**
 * A band-limited pulse of the given duty, built as the difference of two sawtooths a duty
 * apart. Deriving it from the saw rather than from a pulse's own series keeps it exactly as
 * band-limited as the saw is, and a duty of 0.5 comes out as the square it should be.
 */
function pulseFrame(duty, length = FRAME_LENGTH) {
  const saw = sawFrame(length);
  const shift = Math.round(duty * length);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = saw[i] - saw[(i + shift) % length];
  return normalizeFrame(removeDc(out));
}

/** A naive render of one cycle at the frame length - for the shapes a series does not describe. */
function rendered(fn, length = FRAME_LENGTH) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = fn(i / length);
  return normalizeFrame(removeDc(out));
}

/** Triangle folding at a gain: past full scale the wave turns round and comes back. */
function fold(x) {
  let p = (x + 1) * 0.25;
  p -= Math.floor(p);
  return 1 - Math.abs(p * 4 - 2);
}

/**
 * The vowels of the Vocal table, as formant centers in Hz over a fundamental near c2, so the
 * harmonic each peak sits on is the center divided by that. The bandwidths widen up the series,
 * as a vocal tract's do.
 */
const VOWELS = Object.freeze([
  ['a', [730, 1090, 2440]],
  ['e', [530, 1840, 2480]],
  ['i', [270, 2290, 3010]],
  ['o', [570, 840, 2410]],
  ['u', [300, 870, 2240]],
]);

/** A frame with peaks at the given harmonics, each a Gaussian of the given width in harmonics. */
function formantFrame(centersHz, fundamentalHz = 130) {
  return normalizeFrame(fromHarmonics(FRAME_LENGTH, 64, (k) => {
    let a = 0;
    centersHz.forEach((hz, i) => {
      const center = hz / fundamentalHz;
      const width = 1.2 + i * 1.5;
      a += Math.exp(-((k - center) * (k - center)) / (2 * width * width)) * (i === 0 ? 1 : 0.6);
    });
    return a / Math.pow(k, 0.3);
  }));
}

/** The frame names of the shipped tables whose frames have names worth printing. */
const NAMES = Object.freeze({
  PWM: ['50%', '42%', '34%', '26%', '19%', '13%', '8%', '5%'],
  Vocal: VOWELS.map(([v]) => v),
});

/**
 * The tables poptart ships with. The first is the one that matters:
 *
 * "Basic" holds the classic waveforms in one stack, ordered so that sweeping the position runs
 * from the softest to the hardest and then through narrowing pulse widths. That ordering is the
 * whole reason to ship them as one table rather than as seven - a position envelope on this
 * table is a filter sweep's worth of movement from an oscillator that costs nothing extra.
 *
 * The rest are each one classic technique laid out along the position: harmonic count, pulse
 * width, oscillator sync, wavefolding, frequency modulation, drawbar organ, vowels. A position
 * sweep on any of them is that technique's sweep, and it costs the same nothing.
 */
export function builtInTables() {
  const basic = [
    sineFrame(),
    triangleFrame(),
    sawFrame(),
    squareFrame(),
    pulseFrame(0.375),
    pulseFrame(0.25),
    pulseFrame(0.125),
  ].map(normalizeFrame);

  // A run from a pure tone to a full 1/k series: the same sweep a lowpass makes, but done as
  // harmonic content, so it keeps its brightness when the note moves.
  const harmonics = [1, 2, 3, 5, 8, 16, 32, 64].map((count) =>
    normalizeFrame(fromHarmonics(FRAME_LENGTH, count, (k) => (k <= count ? 1 / k : 0))));

  // The same, odd harmonics only - hollow where the one above is bright.
  const odd = [1, 3, 5, 9, 17, 33, 65].map((count) =>
    normalizeFrame(fromHarmonics(FRAME_LENGTH, count, (k) => (k % 2 === 1 && k <= count ? 1 / k : 0))));

  // Pulse width, from a square to a needle: the sweep a PWM patch makes.
  const pwm = [0.5, 0.42, 0.34, 0.26, 0.19, 0.13, 0.08, 0.05].map((duty) => pulseFrame(duty));

  // A sawtooth hard-synced to the note, the slave running from one to four times the master:
  // the sweep a sync lead makes, rendered rather than summed because a reset has no series.
  const sync = [1, 1.3, 1.65, 2, 2.4, 2.9, 3.4, 4].map((ratio) =>
    rendered((t) => { const p = (t * ratio) % 1; return p * 2 - 1; }));

  // A sine through a wavefolder, driven harder frame by frame.
  const folded = [1, 1.4, 1.9, 2.5, 3.2, 4, 5, 6.5].map((gain) =>
    rendered((t) => fold(Math.sin(2 * Math.PI * t) * gain)));

  // Two-operator FM at a ratio of two, the index rising: a sine into a bell into a buzz.
  const fm = [0, 0.4, 0.9, 1.5, 2.3, 3.4, 5, 7].map((index) =>
    rendered((t) => Math.sin(2 * Math.PI * t + index * Math.sin(4 * Math.PI * t))));

  // Drawbar organ: sub and fundamental, then thirds and fifths, then the mixture.
  const drawbars = [
    [0, 1, 0, 0, 0, 0, 0, 0, 0],
    [0.5, 1, 0, 0, 0, 0, 0, 0, 0],
    [0.5, 1, 0, 0.6, 0, 0, 0, 0, 0],
    [0.5, 1, 0.5, 0.6, 0, 0.4, 0, 0, 0],
    [0.6, 1, 0.6, 0.8, 0.5, 0.5, 0, 0.3, 0],
    [0.7, 1, 0.8, 0.9, 0.7, 0.7, 0.5, 0.5, 0.4],
  ];
  const organHarmonics = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];
  const organ = drawbars.map((bars) =>
    rendered((t) => bars.reduce((sum, level, i) => sum + level * Math.sin(2 * Math.PI * organHarmonics[i] * 2 * t), 0)));

  const vocal = VOWELS.map(([, centers]) => formantFrame(centers));

  return [
    buildTable('Basic', basic, { license: 'AGPL-3.0-only', names: BASIC_FRAME_NAMES }),
    buildTable('Harmonics', harmonics, { license: 'AGPL-3.0-only' }),
    buildTable('Odd', odd, { license: 'AGPL-3.0-only' }),
    buildTable('PWM', pwm, { license: 'AGPL-3.0-only', names: NAMES.PWM }),
    buildTable('Sync', sync, { license: 'AGPL-3.0-only' }),
    buildTable('Fold', folded, { license: 'AGPL-3.0-only' }),
    buildTable('FM', fm, { license: 'AGPL-3.0-only' }),
    buildTable('Organ', organ, { license: 'AGPL-3.0-only' }),
    buildTable('Vocal', vocal, { license: 'AGPL-3.0-only', names: NAMES.Vocal }),
  ];
}

/**
 * The shipped tables, built once per realm and shared by everything in it.
 *
 * Building them is a hundred milliseconds of harmonic sums and they are read-only, so a second
 * synth on the same thread has no reason to pay for its own - and neither does the panel, which
 * draws the same frames the synth is reading. A worklet warms them when its script loads (see
 * wavetable.worklet.js), which is before the context is producing sound.
 */
let sharedTables = null;

export function sharedBuiltInTables() {
  if (!sharedTables) sharedTables = builtInTables();
  return sharedTables;
}
