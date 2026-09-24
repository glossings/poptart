// The wavetable oscillator.
//
// One of these is a stack of unison copies of the same wavetable, detuned and panned around a
// center pitch, read through a warp (see warp.mjs) and band-limited against the rate the warp
// actually traverses the table at (see tables.mjs).
//
// THE BAND LIMIT IS THE POINT. A wavetable oscillator that reads its table at whatever rate the
// note asks for is four lines of code and sounds like it: every harmonic above half the sample
// rate folds back down as inharmonic hash, worst exactly where the interesting warps live,
// because a warp like sync or fold reads the table several times per cycle and multiplies the
// problem by that factor. So the rate is MEASURED each block, through the warp, and the mip
// level that survives it is chosen from that - which means the warp modes get band-limited for
// free and adding a mode needs no new analysis.
//
// The level is chosen per block and ramped across it. Per sample would cost a logarithm in the
// hottest loop for a number that barely moves inside three milliseconds; per block with no ramp
// would step the brightness audibly on a fast sweep. Ramping between the two is neither.
//
// EVERY CONTINUOUS CONTROL IS READ PER SAMPLE when something is moving it. Each one is a value
// for the block plus, when a signal is driving it, an array read at the offset process() is
// given - so phase, pitch, position, warp and level all follow an LFO, an envelope or another
// track's audio at the sample rate, and the same loop serves a control nobody is touching at no
// extra cost. The band limit is chosen against the block's WORST case of pitch and warp, which
// is the conservative side: at most it costs a little brightness during a sweep.
//
// WHAT THIS DOES NOT FIX. Measured on a saw table, band-limiting puts the inharmonic floor
// around -47 dB where a naive read sits at -14 dB, and under full sync -55 dB against -6 dB.
// The one case it only half-helps is a warp with CORNERS in it - fold at a high amount sits
// near -39 dB - because a kink in the phase map is a discontinuity in the traversal rate, and
// its spectrum falls off too slowly for any choice of band limit to remove. Fixing that
// properly needs a band-limited step correction at each corner rather than a duller table, and
// it is not worth the complexity for a mode whose whole character is being harsh.
//
// Everything is allocation-free after construction: the arrays are sized for the maximum unison
// at construction and the per-block setup writes into them.

import { mipLevelFor } from './tables.mjs';
import { crossModOf, fmDepth, warpPhase, warpSlope } from './warp.mjs';

/** The most unison copies one oscillator will run. Beyond this the cost stops buying anything. */
export const MAX_UNISON = 8;

/** How many points across the cycle the block's traversal rate is measured at. */
const SLOPE_PROBES = 8;

/**
 * Where `n` unison copies sit: a frequency ratio and a pair of gains for each.
 *
 * Fills arrays the caller owns rather than returning any, because the oscillator calls it once
 * per block from the audio thread and a per-block allocation there is a per-block collection
 * later. The panel calls it with arrays of its own to draw the spread, which is the reason it is
 * a function at all: a picture of the spread computed from a second copy of these four lines
 * would drift away from the sound the first time one of them was tuned.
 */
export function fillUnison(n, detuneCents, panSpread, ratios, gainsL, gainsR) {
  for (let i = 0; i < n; i++) {
    // Evenly spaced across the detune, centered: one copy is exactly in tune, two straddle it.
    const offset = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    ratios[i] = Math.pow(2, (offset * detuneCents) / 1200);
    // Equal-power panning, so widening a unison does not make it louder in the middle.
    const pan = n === 1 ? 0 : offset * panSpread;
    const angle = ((pan + 1) * Math.PI) / 4;
    // Each copy carries 1/sqrt(n) so that stacking copies does not raise the level.
    const g = 1 / Math.sqrt(n);
    gainsL[i] = Math.cos(angle) * g * Math.SQRT2;
    gainsR[i] = Math.sin(angle) * g * Math.SQRT2;
  }
}

/**
 * A small deterministic generator for unison start phases. Seeded per note so that a song
 * sounds the same every time it is played - a unison whose phases are genuinely random is a
 * unison whose attack transient changes on every note, which is not a feature anybody asked for.
 */
function hashPhase(seed, index) {
  let h = (seed * 2654435761 + index * 40503) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Reads one band-limited frame, wrapping at the end.
 *
 * Catmull-Rom rather than straight linear interpolation, and it earns its two extra taps. The
 * dull levels of the pyramid are stored SHORT - four samples per harmonic - so at the top of a
 * note's range the table being read is a few dozen samples long. Linear interpolation on that
 * is a rough approximation, and its error is not a gentle dulling: it lands as sidebands around
 * the read rate, which is inharmonic, which is the exact thing the band-limiting was for.
 * Measured against linear interpolation on the same tables, cubic drops the inharmonic floor by
 * 6 dB on a plain bright note and 13 dB under a warp that reads the table many times per cycle.
 */
function readMip(mip, phase) {
  const n = mip.length;
  let x = phase * n;
  if (x < 0) x = 0;
  let i = x | 0;
  if (i >= n) i = n - 1;
  const f = x - i;
  const a = mip[i === 0 ? n - 1 : i - 1];
  const b = mip[i];
  const c = mip[i + 1 >= n ? i + 1 - n : i + 1];
  const d = mip[i + 2 >= n ? i + 2 - n : i + 2];
  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
}

export class WavetableOscillator {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.table = null;

    this.phases = new Float64Array(MAX_UNISON);
    this.ratios = new Float64Array(MAX_UNISON);   // per-copy frequency multiplier
    this.gainsL = new Float64Array(MAX_UNISON);
    this.gainsR = new Float64Array(MAX_UNISON);

    /** The note in Hz with the octave setting folded in. Set per block by the voice. */
    this.frequency = 440;

    // The continuous controls: a value for the block, and an array (or null) for one that is
    // moving inside it. The array is read at the offset process() is given, since a voice
    // renders a block in pieces around its note edges and the arrays cover the whole block.
    this.level = 1; this.levelA = null;
    this.phase = 0; this.phaseA = null;               // in cycles; a signal here is phase modulation
    this.semis = 0; this.semisA = null;               // a signal here is frequency modulation
    this.cents = 0; this.centsA = null;
    this.position = 0; this.positionA = null;         // 0..1 across the frame stack
    this.warpAmount = 0; this.warpAmountA = null;

    this.warpMode = 0;
    this.unison = 1;
    this.detuneCents = 0;
    this.panSpread = 0;
    this.phaseRand = 0;
    this.seed = 1;

    this.lastLevel = 0;
    this.started = false;
    /** The last sample this oscillator made, at unit level - what a cross-modulation reads. */
    this.last = 0;
    /** Set by the voice when another oscillator is listening, so a silent level still renders. */
    this.heard = false;

    // Where the block reads in the frame stack, kept here so placing it costs no allocation.
    this._lowFrame = null;
    this._highFrame = null;
    this._frameMix = 0;
  }

  setTable(table) {
    this.table = table;
    this.lastLevel = 0;
  }

  /**
   * Starts a note. Unison copies take their start phases from the seed, so a note is
   * reproducible; at phaseRand 0 they all start together, which is the hard, phase-aligned
   * attack a plucked or percussive patch wants.
   */
  start(seed) {
    this.seed = seed >>> 0;
    for (let i = 0; i < MAX_UNISON; i++) {
      this.phases[i] = this.phaseRand > 0 ? hashPhase(this.seed, i) * this.phaseRand : 0;
    }
    this.started = true;
    this.lastLevel = 0;
  }

  reset() {
    this.phases.fill(0);
    this.started = false;
    this.lastLevel = 0;
  }

  /**
   * Per-block setup: the unison spread, and the band limit for this block.
   *
   * The spread is recomputed every block because the detune and the unison count are ordinary
   * controls somebody may be sweeping. It is cheap - a handful of powers for at most eight
   * copies, once per 128 samples - and a detune that steps at the block rate steps by a fraction
   * of a cent, which is why it is the one continuous control here that is not read per sample.
   */
  prepare() {
    const n = Math.max(1, Math.min(MAX_UNISON, Math.round(this.unison)));
    fillUnison(n, this.detuneCents, this.panSpread, this.ratios, this.gainsL, this.gainsR);
    return n;
  }

  /**
   * The mip level this block needs: the fastest the table will be traversed anywhere in the
   * cycle, measured through the warp at the given amount.
   *
   * Probing across the cycle rather than at the current phase matters because most warps are
   * not uniform - fold is slow at its turning points and fast between them - and a level chosen
   * from the slow part would alias through the fast part. Taking the worst case is the
   * conservative choice: at most it costs a little brightness.
   */
  bandLimit(increment, warpAmount) {
    const table = this.table;
    if (!table) return 0;
    let worst = Math.abs(increment);
    if (warpAmount > 0) {
      for (let i = 0; i < SLOPE_PROBES; i++) {
        const s = warpSlope(i / SLOPE_PROBES, increment, warpAmount, this.warpMode);
        if (s > worst) worst = s;
      }
    }
    return mipLevelFor(worst, table.length);
  }

  /** Places a 0..1 position in the frame stack: the two frames it sits between and the blend. */
  _placeFrames(position) {
    const table = this.table;
    const frameCount = table.frameCount;
    const pos = Math.min(1, Math.max(0, position)) * (frameCount - 1);
    let frameLow = pos | 0;
    if (frameLow >= frameCount - 1) frameLow = Math.max(0, frameCount - 2);
    this._lowFrame = table.mips[frameCount === 1 ? 0 : frameLow];
    this._highFrame = table.mips[frameCount === 1 ? 0 : frameLow + 1];
    this._frameMix = frameCount === 1 ? 0 : pos - frameLow;
  }

  /**
   * Per-block setup for a render: the band limit for the block's worst case of pitch and warp,
   * the frame pair while the position is still, and the unison spread. After this, `sample()`
   * renders one sample at a time - which is how the voice interleaves two oscillators that bend
   * each other - and `process()` is the same loop with nothing between the samples.
   *
   * `offset` is where this piece of the block starts in the per-sample control arrays: a voice
   * cuts its block at every note edge and renders the pieces separately, and each piece has to
   * read the controls from where it actually sits.
   */
  begin(count, offset = 0) {
    const table = this.table;
    if (!table) return false;
    const levelA = this.levelA;
    if (levelA === null && this.level === 0 && !this.heard) return false;

    this._n = this.prepare();
    this._topLevel = table.levels - 1;
    this._offset = offset;
    const end = offset + count;

    // Pitch: the note's increment, bent by the semitone and cent controls. Still, the power is
    // taken once for the block; moving, it is taken per sample, which is what pitch modulation
    // is. The block's highest bend is what the band limit is chosen against.
    const baseInc = this.frequency / this.sampleRate;
    const semisA = this.semisA;
    const centsA = this.centsA;
    const semisS = this.semis;
    const centsS = this.cents;
    const pitchMoving = semisA !== null || centsA !== null;
    let peakBend = semisS / 12 + centsS / 1200;
    if (pitchMoving) {
      for (let i = offset; i < end; i++) {
        const bend = (semisA === null ? semisS : semisA[i]) / 12 + (centsA === null ? centsS : centsA[i]) / 1200;
        if (i === offset || bend > peakBend) peakBend = bend;
      }
    }
    this._baseInc = baseInc;
    this._pitchMoving = pitchMoving;
    this._stillInc = baseInc * Math.pow(2, peakBend);

    // The warp amount, per sample when it moves, with the block's largest for the band limit. A
    // cross-modulation mode is not a phase warp: its amount is a depth the voice reads, and the
    // band limit allows for the extra traversal it costs.
    const warpA = this.warpAmountA;
    const warpS = this.warpAmount;
    let peakWarp = warpS;
    if (warpA !== null) {
      peakWarp = 0;
      for (let i = offset; i < end; i++) if (warpA[i] > peakWarp) peakWarp = warpA[i];
    }
    this._cross = crossModOf(this.warpMode);
    const traversal = this._cross ? this._stillInc * (1 + (this._cross.kind === 'fm' ? fmDepth(peakWarp) : 0)) : this._stillInc;
    const levelEnd = this.bandLimit(traversal, this._cross ? 0 : peakWarp);
    const levelStart = this.started && this.lastLevel > 0 ? this.lastLevel : levelEnd;
    this.lastLevel = levelEnd;
    this._levelStart = levelStart;
    this._levelStep = count > 0 ? (levelEnd - levelStart) / count : 0;

    // Where in the frame stack the block reads: placed once while the position is still, and
    // per sample when a signal is sweeping it.
    if (this.positionA === null) this._placeFrames(this.position);
    return true;
  }

  /**
   * One sample, added into `outL[s]` and `outR[s]`, and kept as `last` for whatever the voice
   * bends with it. `xpm` is a phase offset in cycles and `xinc` a multiplier on the increment -
   * the cross-modulation inputs, both neutral by default - and `ring` multiplies the output.
   */
  sample(s, outL, outR, xpm = 0, xinc = 1, ring = 1) {
    const i = this._offset + s;
    const level = this._levelStart + this._levelStep * s;
    const topLevel = this._topLevel;
    let lo = level | 0;
    if (lo < 0) lo = 0;
    if (lo > topLevel) lo = topLevel;
    const hi = lo === topLevel ? topLevel : lo + 1;
    const levelMix = hi === lo ? 0 : level - lo;

    const positionA = this.positionA;
    if (positionA !== null) this._placeFrames(positionA[i]);
    const lowFrame = this._lowFrame;
    const highFrame = this._highFrame;
    const frameMix = this._frameMix;
    const lowA = lowFrame[lo];
    const lowB = lowFrame[hi];
    const highA = highFrame[lo];
    const highB = highFrame[hi];

    const phaseA = this.phaseA;
    const pm = (phaseA === null ? this.phase : phaseA[i]) + xpm;
    const warpA = this.warpAmountA;
    const warpAmount = this._cross ? 0 : (warpA === null ? this.warpAmount : warpA[i]);
    const warpMode = this.warpMode;
    const levelA = this.levelA;
    const gain = levelA === null ? this.level : levelA[i];
    const semisA = this.semisA;
    const centsA = this.centsA;
    const inc = (this._pitchMoving
      ? this._baseInc * Math.pow(2, (semisA === null ? this.semis : semisA[i]) / 12 + (centsA === null ? this.cents : centsA[i]) / 1200)
      : this._stillInc) * xinc;

    let sumL = 0;
    let sumR = 0;
    const n = this._n;
    for (let v = 0; v < n; v++) {
      let ph = this.phases[v] + pm;
      ph -= Math.floor(ph);
      const w = warpAmount > 0 ? warpPhase(ph, warpAmount, warpMode) : ph;

      // Two frames, two band limits, blended both ways. The fast paths matter: a single-frame
      // table and a settled band limit are both common, and each halves the reads.
      let sample;
      if (levelMix === 0) {
        sample = frameMix === 0 ? readMip(lowA, w) : readMip(lowA, w) + (readMip(highA, w) - readMip(lowA, w)) * frameMix;
      } else if (frameMix === 0) {
        const a = readMip(lowA, w);
        sample = a + (readMip(lowB, w) - a) * levelMix;
      } else {
        const a = readMip(lowA, w) + (readMip(highA, w) - readMip(lowA, w)) * frameMix;
        const b = readMip(lowB, w) + (readMip(highB, w) - readMip(lowB, w)) * frameMix;
        sample = a + (b - a) * levelMix;
      }

      sumL += sample * this.gainsL[v];
      sumR += sample * this.gainsR[v];

      // A negative increment is a real thing here: through-zero FM runs the table backwards.
      let next = this.phases[v] + inc * this.ratios[v];
      next -= Math.floor(next);
      this.phases[v] = next;
    }

    // What another oscillator hears of this one: the unison sum at unit level, before the level
    // knob, so a modulator can be turned down without losing the modulation.
    this.last = (sumL + sumR) * 0.5 * ring;
    outL[s] += sumL * gain * ring;
    outR[s] += sumR * gain * ring;
  }

  /**
   * Renders one block, adding into the output buffers - `begin()` and then every `sample()`,
   * with nothing bending this oscillator from outside.
   */
  process(outL, outR, count, offset = 0) {
    if (!this.begin(count, offset)) return;
    for (let s = 0; s < count; s++) this.sample(s, outL, outR);
  }
}
