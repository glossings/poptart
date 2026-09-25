// One voice of the wavetable synth, and the parameter struct every voice reads.
//
// Two wavetable oscillators, a sub, a noise source and an amplitude envelope. What is NOT here
// is as much of the design as what is: there is no filter, no LFO, no modulation matrix and no
// mod wheel. poptart already has a modulation system - every continuous control below is an
// a-rate parameter, so `lfo()`, `env()`, a macro, a MIDI CC or another track's audio patched
// into it are all the same thing to this synth, and they compose with the pattern language the
// way everything else does. A filter belongs on the chain after it, where an `env()` on its
// cutoff is the filter envelope, and where it is one device shared by every synth rather than a
// second copy inside each.
//
// The parameters arrive as a PLAIN STRUCT with fixed fields rather than a map keyed by
// parameter id, so the inner loop is on monomorphic property access instead of a hash lookup
// per sample per voice. Each field is the value for the block, and `a` holds, under the same
// names, a per-sample array for any control a signal is moving this block (null otherwise) -
// which is how a control that nobody is touching costs nothing more than it did when it was
// read once per block.
//
// WHAT IS READ PER SAMPLE, and what is not. The oscillator levels, phase, pitch, position and
// warp, the sub and noise levels and the voice level all follow their arrays sample by sample.
// The envelope times, the unison spread and the glide are read once per block: a stage length
// changing inside a stage has no meaning, and a detune stepping by a fraction of a cent at the
// block rate is not a staircase anybody can hear.
//
// CROSS-MODULATION is the one thing that changes the shape of the render. An oscillator whose
// warp switch names another source has to be rendered a sample at a time, interleaved with what
// it reads, so the block is walked sample by sample when either oscillator is bent that way and
// oscillator by oscillator when neither is. The interleaved order is osc 1, osc 2, sub, noise:
// osc 2 bending osc 1 is heard the same sample, osc 1 bending osc 2 a sample late, which is the
// one-sample feedback delay every FM synth has somewhere.

import { Adsr } from './adsr.mjs';
import { MAX_UNISON, WavetableOscillator } from './oscillator.mjs';
import { crossModOf, fmDepth, pmDepth } from './warp.mjs';

/** Concert pitch, and the MIDI note it sits on. Middle C is 60 here, as everywhere in poptart. */
const A4_HZ = 440;
const A4_NOTE = 69;

export const midiToHz = (note) => A4_HZ * Math.pow(2, (note - A4_NOTE) / 12);

/**
 * The parameter names of each oscillator, built once.
 *
 * They were built per oscillator per block from the oscillator's number, which is a dozen short
 * strings a voice a block: at sixteen voices that is a six-figure allocation rate on the thread
 * that must not pause, to arrive at the same thirteen names every time. Built here instead, where
 * the cost is paid once and the lookups are on interned constants.
 */
const oscKeys = (n) => ({
  octave: `osc${n}Octave`,
  level: `osc${n}Level`,
  phase: `osc${n}Phase`,
  semis: `osc${n}Semis`,
  cents: `osc${n}Cents`,
  position: `osc${n}Position`,
  warp: `osc${n}Warp`,
  warpMode: `osc${n}WarpMode`,
  unison: `osc${n}Unison`,
  detune: `osc${n}Detune`,
  pan: `osc${n}Pan`,
});

const OSC_KEYS = [null, oscKeys(1), oscKeys(2)];

/** The snapshot of every control, shared by all voices: a value each, plus `a` for the moving ones. */
export class VoiceParams {
  constructor() {
    this.osc1Level = 0.5; this.osc1Position = 0; this.osc1Warp = 0; this.osc1WarpMode = 0;
    this.osc1Phase = 0; this.osc1Octave = 0; this.osc1Semis = 0; this.osc1Cents = 0;
    this.osc1Unison = 1; this.osc1Detune = 15; this.osc1Pan = 0.5; this.osc1PhaseRand = 1;
    this.osc1Table = 0;

    this.osc2Level = 0; this.osc2Position = 0; this.osc2Warp = 0; this.osc2WarpMode = 0;
    this.osc2Phase = 0; this.osc2Octave = 0; this.osc2Semis = 0; this.osc2Cents = 0;
    this.osc2Unison = 1; this.osc2Detune = 15; this.osc2Pan = 0.5; this.osc2PhaseRand = 1;
    this.osc2Table = 0;

    this.subLevel = 0; this.subOctave = -1; this.subShape = 0;
    this.noiseLevel = 0;

    this.ampAttack = 0.005; this.ampDecay = 0.1; this.ampSustain = 0.8; this.ampRelease = 0.15;
    this.envAttackCurve = -4; this.envDecayCurve = -4; this.envReleaseCurve = -4; this.envScale = 1;

    this.glide = 0;
    this.level = 0.7;
    // Pitch bend in semitones, on every voice at once - the track's .bend(), not a knob.
    this.bend = 0;

    /** Per-sample arrays for the fields a signal is moving this block, or null. Same names. */
    this.a = {};
    for (const key of Object.keys(this)) if (key !== 'a') this.a[key] = null;

    // While a bend is moving, each oscillator's cents with the bend added, per sample: worked out
    // once a block for every voice to read (see WavetableSynth#_bendBlock). Unread while it is still.
    this.bendCents1 = new Float32Array(128);
    this.bendCents2 = new Float32Array(128);
    this.bendCentsSub = new Float32Array(128);
  }
}

/** The block value or the sample's, for a field and its array. */
const read = (value, arr, i) => (arr === null ? value : arr[i]);

/** A small deterministic noise source, so a patch with noise in it still renders reproducibly. */
class Noise {
  constructor() { this.state = 1; }
  seed(s) { this.state = (s >>> 0) || 1; }
  next() {
    // xorshift32 - cheap, white enough for a noise oscillator, and identical on every machine.
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return (x / 2147483648) - 1;
  }
}

export class WavetableVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.osc1 = new WavetableOscillator(sampleRate);
    this.osc2 = new WavetableOscillator(sampleRate);
    this.sub = new WavetableOscillator(sampleRate);
    this.noise = new Noise();

    this.ampEnv = new Adsr(sampleRate);

    this.note = -1;
    this.velocity = 1;
    this.age = 0;            // bumped by the synth so the oldest voice can be found
    this.releasing = false;
    this.targetHz = A4_HZ;
    this.currentHz = A4_HZ;

    // Scratch buffers, sized once. The oscillators add into these and the level reads them.
    this.bufL = new Float32Array(256);
    this.bufR = new Float32Array(256);
  }

  get active() {
    return this.ampEnv.active;
  }

  ensureCapacity(count) {
    if (this.bufL.length < count) {
      this.bufL = new Float32Array(count);
      this.bufR = new Float32Array(count);
    }
  }

  /**
   * Starts a note.
   *
   * `glideFrom` is the frequency to slide from - the synth passes the pitch of the note this
   * voice is replacing when glide is on and something was already sounding, and null otherwise.
   * The seed makes the unison phases and the noise reproducible.
   */
  noteOn(note, velocity, params, seed, glideFrom = null) {
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.targetHz = midiToHz(note);
    this.currentHz = glideFrom != null && params.glide > 0 ? glideFrom : this.targetHz;

    this.osc1.phaseRand = params.osc1PhaseRand;
    this.osc2.phaseRand = params.osc2PhaseRand;
    this.sub.phaseRand = 0;
    this.osc1.start(seed);
    this.osc2.start(seed ^ 0x9e3779b9);
    this.sub.start(seed ^ 0x85ebca6b);
    this.noise.seed(seed ^ 0xc2b2ae35);

    // A voice taken while it is still sounding keeps its envelope level: clearing it is a click
    // on the steal, and a steal is the one place clicks hide.
    this.ampEnv.gateOn(true);
  }

  noteOff() {
    this.releasing = true;
    this.ampEnv.gateOff();
  }

  /** Silences the voice outright. Used when a voice has to be taken before it finished. */
  kill() {
    this.ampEnv.reset();
    this.note = -1;
    this.releasing = false;
  }

  setTables(table1, table2, subTable) {
    this.osc1.setTable(table1);
    this.osc2.setTable(table2);
    this.sub.setTable(subTable);
  }

  /** Hands an oscillator its controls for the block: the still values and the moving arrays. */
  _aimOscillator(osc, baseHz, p, a, n) {
    const k = OSC_KEYS[n];
    osc.frequency = baseHz * Math.pow(2, p[k.octave]);
    osc.level = p[k.level]; osc.levelA = a[k.level];
    osc.phase = p[k.phase]; osc.phaseA = a[k.phase];
    osc.semis = p[k.semis]; osc.semisA = a[k.semis];
    osc.cents = p[k.cents]; osc.centsA = a[k.cents];
    osc.position = p[k.position]; osc.positionA = a[k.position];
    osc.warpAmount = p[k.warp]; osc.warpAmountA = a[k.warp];
    osc.warpMode = p[k.warpMode];
    osc.unison = p[k.unison];
    osc.detuneCents = p[k.detune];
    osc.panSpread = p[k.pan];
  }

  /**
   * Renders one piece of a block and adds it into the output.
   *
   * `offset` is where the piece starts in the block's per-sample arrays (see the oscillator).
   */
  process(outL, outR, count, offset, p) {
    if (!this.ampEnv.active) return;
    this.ensureCapacity(count);
    const a = p.a;
    const bufL = this.bufL;
    const bufR = this.bufR;
    bufL.fill(0, 0, count);
    bufR.fill(0, 0, count);

    // Glide is a per-block approach toward the target, which is plenty: a glide shorter than a
    // block is instant anyway, and anything audible lasts tens of blocks.
    if (p.glide > 0 && this.currentHz !== this.targetHz) {
      const blockSec = count / this.sampleRate;
      const k = 1 - Math.exp(-blockSec / Math.max(1e-4, p.glide));
      this.currentHz += (this.targetHz - this.currentHz) * k;
      if (Math.abs(this.currentHz - this.targetHz) < 0.01) this.currentHz = this.targetHz;
    } else {
      this.currentHz = this.targetHz;
    }
    // A still bend moves the note; a moving one rides each oscillator's cents, per sample.
    const bendA = a.bend;
    const baseHz = bendA === null && p.bend ? this.currentHz * Math.pow(2, p.bend / 12) : this.currentHz;

    const osc1 = this.osc1;
    const osc2 = this.osc2;
    const sub = this.sub;
    this._aimOscillator(osc1, baseHz, p, a, 1);
    this._aimOscillator(osc2, baseHz, p, a, 2);
    sub.frequency = baseHz * Math.pow(2, p.subOctave);
    sub.position = p.subShape; sub.positionA = null;
    sub.level = p.subLevel; sub.levelA = a.subLevel;
    sub.cents = 0; sub.centsA = null;
    if (bendA !== null) {
      osc1.centsA = p.bendCents1;
      osc2.centsA = p.bendCents2;
      sub.centsA = p.bendCentsSub;
    }

    const cross1 = crossModOf(p.osc1WarpMode);
    const cross2 = crossModOf(p.osc2WarpMode);
    // A source another oscillator reads has to render even at zero level.
    osc1.heard = cross2?.source === 'osc';
    osc2.heard = cross1?.source === 'osc';
    sub.heard = cross1?.source === 'sub' || cross2?.source === 'sub';
    const noiseA = a.noiseLevel;
    const wantNoise = noiseA !== null || p.noiseLevel > 0 || cross1?.source === 'noise' || cross2?.source === 'noise';

    if (!cross1 && !cross2) {
      osc1.process(bufL, bufR, count, offset);
      osc2.process(bufL, bufR, count, offset);
      sub.process(bufL, bufR, count, offset);
      if (wantNoise) {
        for (let i = 0; i < count; i++) {
          const v = this.noise.next() * read(p.noiseLevel, noiseA, offset + i);
          bufL[i] += v;
          bufR[i] += v;
        }
      }
    } else {
      // Interleaved: each sample of osc 1, then osc 2, then the sub, reading each other as they
      // go. The depth is the warp amount, read per sample where a signal moves it.
      const on1 = osc1.begin(count, offset);
      const on2 = osc2.begin(count, offset);
      const onSub = sub.begin(count, offset);
      const warp1A = a.osc1Warp;
      const warp2A = a.osc2Warp;
      let noiseSample = 0;
      for (let i = 0; i < count; i++) {
        if (wantNoise) {
          noiseSample = this.noise.next();
          const v = noiseSample * read(p.noiseLevel, noiseA, offset + i);
          bufL[i] += v;
          bufR[i] += v;
        }
        if (on1) this._bent(osc1, cross1, read(p.osc1Warp, warp1A, offset + i), osc2, sub, noiseSample, i, bufL, bufR);
        if (on2) this._bent(osc2, cross2, read(p.osc2Warp, warp2A, offset + i), osc1, sub, noiseSample, i, bufL, bufR);
        if (onSub) sub.sample(i, bufL, bufR);
      }
    }

    this.ampEnv.setStages(
      p.ampAttack, p.ampDecay, p.ampSustain, p.ampRelease,
      p.envAttackCurve, p.envDecayCurve, p.envReleaseCurve, p.envScale,
    );

    const velocity = this.velocity;
    const levelA = a.level;
    for (let i = 0; i < count; i++) {
      const g = this.ampEnv.next() * velocity * read(p.level, levelA, offset + i);
      outL[i] += bufL[i] * g;
      outR[i] += bufR[i] * g;
    }
  }

  /** One sample of an oscillator bent by whatever its cross-mode names. */
  _bent(osc, cross, amount, other, sub, noiseSample, i, bufL, bufR) {
    if (!cross) { osc.sample(i, bufL, bufR); return; }
    const mod = cross.source === 'osc' ? other.last : cross.source === 'sub' ? sub.last : noiseSample;
    if (cross.kind === 'fm') osc.sample(i, bufL, bufR, 0, 1 + fmDepth(amount) * mod);
    else if (cross.kind === 'pm') osc.sample(i, bufL, bufR, pmDepth(amount) * mod);
    else osc.sample(i, bufL, bufR, 0, 1, 1 + amount * (mod - 1));
  }
}

export { MAX_UNISON };
