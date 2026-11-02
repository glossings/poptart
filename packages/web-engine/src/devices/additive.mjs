// The Additive synth: every voice a bank of sine partials.
//
// Each partial is a sine at a ratio of the note - the ratios are 1, 2, 3, ... pulled apart by
// Stretch - with a level set by the controls laid over each other: how many partials there are,
// the slope across them (Tilt), the balance of odd and even (Odd) and a drawn Spectrum. Damp
// makes the higher partials die away faster than the lower ones through each note. The levels are
// brought to one loudness, so a control that changes the shape of the spectrum does not also
// change how loud it is. There is no filter: that belongs on the chain after the synth (see
// dsp/voice.mjs).
//
// CLICK-FREE. Every control arrives once a block, and every partial's level and frequency is
// RAMPED to its new value across the block rather than stepped at its edge, so a pattern or a
// signal on any of them moves the sound without a click. The ramp runs to the end of the WHOLE
// block, through the cuts the block takes at note edges.
//
// THE PARTIALS ARE A TABLE OF RATIOS. A partial's frequency is its ratio times the note, and the
// ratios are worked out once a block for every voice; Stretch is the only thing that sets them
// today. Tilt and Damp follow the ratio (a slope per octave of frequency), Odd and Spectrum the
// partial's number.
//
// A partial is read from one shared sine table, linearly between its points, on a phase kept in
// double precision: the same arithmetic in the desktop's C++ comes out the same to the last few
// bits, which is what the parity test holds the two to.
//
// Translated line for line in osc-engine/native/devices/own/additive.cc, and held to it by
// native-device-parity.test.mjs: change one, change both.

import { defineDevice } from '../descriptor.mjs';
import { Adsr } from '../dsp/adsr.mjs';
import { hashPhase } from '../dsp/oscillator.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** The most partials a voice has. */
export const ADDITIVE_PARTIALS = 64;
/** How far the Voices knob reaches. Not a most: the count is open, as the Wavetable's is. */
export const ADDITIVE_VOICES_KNOB = 128;

/** The sine table's length; one more entry repeats the first, so a read never wraps. */
const ADD_SINE_SIZE = 4096;
const ADD_SINE = new Float64Array(ADD_SINE_SIZE + 1);
for (let i = 0; i <= ADD_SINE_SIZE; i++) ADD_SINE[i] = Math.sin((2 * Math.PI * i) / ADD_SINE_SIZE);

/** A partial fades out over this share of the sample rate below Nyquist, so nothing aliases. */
const ADD_NYQUIST_FADE = 0.05;
/** Damp at 1, in nepers a second per unit of ratio above the fundamental. */
const ADD_DAMP_RATE = 10;
/** The voice's level against the controls, as the FM synth's. */
const ADD_VOICE_GAIN = 0.5;
/** Below this, the partials' summed power is silence and is not brought up to level. */
const ADD_SILENT_POWER = 1e-12;

const additiveSeconds = (id, name, def) => ({
  id, name, min: 0, max: 10, default: def, unit: 's', curve: 'pow', curveExp: 3, group: 'Amp Env',
});

export const ADDITIVE = defineDevice({
  id: 'Additive',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-additive',
  description: 'Up to sixty-four sine partials a voice, shaped by their count, a slope, the balance of odd and even, a stretch off the harmonic series, a damping that darkens each note as it rings, and a spectrum you draw.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'partials', name: 'Partials', min: 1, max: ADDITIVE_PARTIALS, default: 16, step: 1, group: 'Partials',
      description: 'How many partials. The ones that would sit above the highest frequency the engine can play are left out.' },
    { id: 'tilt', name: 'Tilt', min: -24, max: 12, default: -6, unit: 'dB', group: 'Partials',
      description: 'The slope across the partials, in decibels an octave. Zero plays them all at one level; -6 is a saw\'s slope; lower is darker.' },
    { id: 'odd', name: 'Odd', min: -1, max: 1, default: 0, group: 'Partials',
      description: 'The balance of odd and even partials. At 1 only the odd ones play, hollow like a square; at -1 only the even ones, an octave up; at 0 both.' },
    { id: 'stretch', name: 'Stretch', min: -0.5, max: 0.5, default: 0, curve: 'sym', curveExp: 3, group: 'Partials',
      description: 'Moves the partials off the harmonic series: partial n sits at n to the power of one plus this. A little is a piano string, more is a bell; below zero squeezes them together.' },
    { id: 'damp', name: 'Damp', min: 0, max: 1, default: 0, curve: 'pow', curveExp: 2, group: 'Partials',
      description: 'How much faster the higher partials die away than the lower ones through each note, so a struck sound darkens as it rings. At zero they hold.' },
    { id: 'spectrum', name: 'Spectrum', default: 0, options: ['flat'], takes: 'shape', rate: 'k', group: 'Partials',
      description: 'A level for each partial, laid over the rest: a curve you draw, read from the first partial at the left to the sixty-fourth at the right. Flat leaves them all at one.' },

    { ...additiveSeconds('ampenv.attack', 'Amp Attack', 0.005), amp: 'attack' },
    { ...additiveSeconds('ampenv.decay', 'Amp Decay', 0.1), amp: 'decay' },
    { id: 'ampenv.sustain', name: 'Amp Sustain', min: 0, max: 1, default: 0.8, group: 'Amp Env', amp: 'sustain' },
    { ...additiveSeconds('ampenv.release', 'Amp Release', 0.15), amp: 'release' },
    { id: 'env.acurve', name: 'Attack Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative rises fast and levels off, positive holds back and then rushes.' },
    { id: 'env.dcurve', name: 'Decay Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative falls fast and trails off.' },
    { id: 'env.rcurve', name: 'Release Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative drops away quickly and then hangs, positive holds the level and then cuts.' },

    { id: 'glide', name: 'Glide', min: 0, max: 5, default: 0, unit: 's', curve: 'pow', curveExp: 3, group: 'Voice' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.7, group: 'Voice' },
    { id: 'voices', name: 'Voices', min: 1, open: true, uiMax: ADDITIVE_VOICES_KNOB, default: 8, step: 1, rate: 'k', ui: 'number', group: 'Voice' },
  ],
  figures: [
    {
      id: 'spectrum',
      kind: 'partials',
      group: 'Partials',
      // No title: the Spectrum picker heads the picture, which is what it draws.
      description: 'Every partial at its place above the note and at the level it plays, for middle C: Partials, Tilt, Odd, Stretch and the drawn Spectrum together. The pale part of a bar is what Damp takes away in the first quarter second.',
      params: { spectrum: 'spectrum', partials: 'partials', tilt: 'tilt', odd: 'odd', stretch: 'stretch', damp: 'damp' },
      subsumes: ['spectrum'],
    },
    {
      id: 'ampenv',
      kind: 'adsr',
      group: 'Amp Env',
      title: 'envelope',
      description: 'The amplitude envelope, drawn through the curve the voice shapes it with. Drag a point for its stage, the plateau for the sustain level.',
      params: {
        attack: 'ampenv.attack', decay: 'ampenv.decay', sustain: 'ampenv.sustain', release: 'ampenv.release',
        acurve: 'env.acurve', dcurve: 'env.dcurve', rcurve: 'env.rcurve',
      },
      subsumes: ['acurve', 'dcurve', 'rcurve'],
    },
  ],
  panel: { rows: [['Partials'], ['Amp Env', 'Voice']] },
});

/** One partial's level from a drawn spectrum: the table read at `x` (0..1), linearly. */
export function spectrumLevel(table, x) {
  if (!table || table.length === 0) return 1;
  const n = table.length;
  const pos = Math.min(1, Math.max(0, x)) * (n - 1);
  const i = Math.floor(pos);
  const a = table[i];
  const b = table[Math.min(n - 1, i + 1)];
  return a + (b - a) * (pos - i);
}

/**
 * Every partial's ratio to the note, its level before the note's own pitch is taken into account,
 * and what Damp multiplies that level by each sample - from the controls. Shared by the synth and
 * by the picture of it (figures.mjs), so the bars drawn are the levels played.
 */
export function shapePartials({ partials, tilt, odd, stretch, damp, table }, sampleRate, ratioOut, baseOut, dampOut) {
  const count = Math.min(ADDITIVE_PARTIALS, Math.max(1, partials));
  const balance = Math.min(1, Math.max(-1, odd));
  const fall = Math.max(0, damp);
  const oddLevel = Math.min(1, 1 + balance);
  const evenLevel = Math.min(1, 1 - balance);
  for (let k = 0; k < ADDITIVE_PARTIALS; k++) {
    const n = k + 1;
    const ratio = Math.pow(n, 1 + stretch);
    ratioOut[k] = ratio;
    const count01 = Math.min(1, Math.max(0, count - k));
    const slope = Math.pow(10, (tilt * Math.log2(ratio)) / 20);
    const parity = n % 2 === 1 ? oddLevel : evenLevel;
    baseOut[k] = count01 * slope * parity * spectrumLevel(table, k / (ADDITIVE_PARTIALS - 1));
    dampOut[k] = Math.exp(-(ADD_DAMP_RATE * fall * (ratio - 1)) / sampleRate);
  }
}

/** How far a partial at `hz` is let through: one below the fade, none at Nyquist and above. */
export function nyquistFade(hz, sampleRate) {
  return Math.min(1, Math.max(0, (0.5 * sampleRate - hz) / (ADD_NYQUIST_FADE * sampleRate)));
}

/**
 * Where each partial's level is going on a note at `hz`: faded near Nyquist, into `out`. Returns
 * what brings them to one loudness (unit summed power), which `out` is not yet multiplied by.
 */
export function aimPartials(base, ratio, hz, sampleRate, out) {
  let power = 0;
  for (let k = 0; k < ADDITIVE_PARTIALS; k++) {
    const g = base[k] * nyquistFade(ratio[k] * hz, sampleRate);
    out[k] = g;
    power += g * g;
  }
  return power > ADD_SILENT_POWER ? 1 / Math.sqrt(power) : 0;
}

/** A control's value at the end of the block: a number, or the last of a block of values. */
const endOf = (v) => (typeof v === 'number' ? v : v[v.length - 1]);

/** What every voice reads, worked out once a block from the controls. */
class AdditiveParams {
  constructor() {
    this.values = Object.fromEntries(ADDITIVE.params.map((p) => [p.id, p.default]));
    // Per partial: its ratio to the note, its level before the voice's own pitch is taken into
    // account, and what Damp multiplies its level by each sample.
    this.ratio = new Float64Array(ADDITIVE_PARTIALS);
    this.base = new Float64Array(ADDITIVE_PARTIALS);
    this.dampMul = new Float64Array(ADDITIVE_PARTIALS);
    // The controls shapePartials reads, kept here so a block does not build an object for them.
    this.settings = { partials: 16, tilt: -6, odd: 0, stretch: 0, damp: 0, table: null };
    this.block = 128;
    this.attack = 0.005; this.decay = 0.1; this.sustain = 0.8; this.release = 0.15;
    this.acurve = -4; this.dcurve = -4; this.rcurve = -4;
    this.glide = 0;
    this.level = 0.7;
    this.levelA = null;
    this.bend = 0;
    this.bendRatio = new Float64Array(128);
    this.bendRatioA = null;
    this.bendEnd = 1;
  }
}

class AdditiveVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    const n = ADDITIVE_PARTIALS;
    this.phase = new Float64Array(n);
    this.gain = new Float64Array(n);   // each partial's level where the ramp stands
    this.gainTo = new Float64Array(n); // and where it is going by the end of the block
    this.gainStep = new Float64Array(n);
    this.inc = new Float64Array(n);    // each partial's phase step, likewise
    this.incStep = new Float64Array(n);
    this.damp = new Float64Array(n);   // how far Damp has brought each partial down this note
    this.env = new Adsr(sampleRate);
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.releasing = false;
    this.holds = 0;
    this.fresh = false;
    this.targetHz = 440;
    this.currentHz = 440;
  }

  get active() { return this.env.active; }

  noteOn(note, velocity, p, seed, glideFrom) {
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.targetHz = midiToHz(note);
    this.currentHz = glideFrom != null && p.glide > 0 ? glideFrom : this.targetHz;
    for (let k = 0; k < ADDITIVE_PARTIALS; k++) {
      this.phase[k] = hashPhase(seed, k);
      this.damp[k] = 1;
    }
    // The first block of a note starts every partial where it should be, rather than ramping in
    // from the note before: the envelope is what brings a note in.
    this.fresh = true;
    this.env.gateOn(true);
  }

  noteOff() {
    this.releasing = true;
    this.env.gateOff();
  }

  /** Renders a piece of the block, `offset` samples into it, adding into the outputs. */
  process(outL, outR, count, offset, p) {
    if (!this.env.active) return;
    const sr = this.sampleRate;
    if (p.glide > 0 && this.currentHz !== this.targetHz) {
      const k = 1 - Math.exp(-(count / sr) / Math.max(1e-4, p.glide));
      this.currentHz += (this.targetHz - this.currentHz) * k;
      if (Math.abs(this.currentHz - this.targetHz) < 0.01) this.currentHz = this.targetHz;
    } else {
      this.currentHz = this.targetHz;
    }
    // A still bend moves the note; a moving one rides the phase steps per sample.
    const hz = p.bendRatioA === null && p.bend ? this.currentHz * Math.pow(2, p.bend / 12) : this.currentHz;
    const heard = hz * p.bendEnd;

    // Where each partial is going: its level brought to one loudness with the others, and out
    // altogether as it nears Nyquist.
    const gainTo = this.gainTo;
    const norm = aimPartials(p.base, p.ratio, heard, sr, gainTo);
    const remaining = p.block - offset;
    const gain = this.gain;
    const gainStep = this.gainStep;
    const inc = this.inc;
    const incStep = this.incStep;
    let top = 0;
    for (let k = 0; k < ADDITIVE_PARTIALS; k++) {
      const to = gainTo[k] * norm;
      gainTo[k] = to;
      const incTo = (p.ratio[k] * hz) / sr;
      if (this.fresh) {
        gain[k] = to;
        inc[k] = incTo;
        gainStep[k] = 0;
        incStep[k] = 0;
      } else {
        gainStep[k] = (to - gain[k]) / remaining;
        incStep[k] = (incTo - inc[k]) / remaining;
      }
      if (to > 0 || gain[k] > 0) top = k + 1;
    }
    this.fresh = false;

    this.env.setStages(p.attack, p.decay, p.sustain, p.release, p.acurve, p.dcurve, p.rcurve);
    const phase = this.phase;
    const damp = this.damp;
    const dampMul = p.dampMul;
    const bendA = p.bendRatioA;
    const levelA = p.levelA;
    const vel = this.velocity * ADD_VOICE_GAIN;
    for (let i = 0; i < count; i++) {
      const t = offset + i;
      const bent = bendA === null ? 1 : bendA[t];
      let sum = 0;
      for (let k = 0; k < top; k++) {
        const d = damp[k];
        const a = (gain[k] + gainStep[k] * i) * d;
        damp[k] = d * dampMul[k];
        let ph = phase[k];
        const x = ph * ADD_SINE_SIZE;
        const j = x | 0;
        const s = ADD_SINE[j];
        sum += (s + (ADD_SINE[j + 1] - s) * (x - j)) * a;
        ph += (inc[k] + incStep[k] * i) * bent;
        if (ph >= 1) ph -= Math.floor(ph);
        phase[k] = ph;
      }
      const g = this.env.next() * vel * (levelA === null ? p.level : levelA[t]);
      outL[i] += sum * g;
      outR[i] += sum * g;
    }
    // Where the ramps have got to - exactly where they were aimed, at the end of the block.
    const end = offset + count >= p.block;
    for (let k = 0; k < ADDITIVE_PARTIALS; k++) {
      gain[k] = end ? gainTo[k] : gain[k] + gainStep[k] * count;
      inc[k] = end ? (p.ratio[k] * hz) / sr : inc[k] + incStep[k] * count;
    }
  }
}

export class AdditiveSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.params = new AdditiveParams();
    this.voices = Array.from({ length: 16 }, () => new AdditiveVoice(sampleRate)); // as the Wavetable's
    this.voiceCount = 8;
    this.clock = 0;
    this.seed = 1;
    this.events = [];
    this.tables = [];  // option index -> a drawn spectrum, sampled by the engine
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.params.values;
    for (const p of ADDITIVE.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s[p.id] = v;
    }
    const count = endOf(s.voices);
    if (Number.isFinite(count)) this.voiceCount = Math.max(1, Math.round(count));
    // The voices are made as the count asks for them - there is no most - so a count past what is
    // made grows the list, once, at the new high mark.
    while (this.voices.length < this.voiceCount) this.voices.push(new AdditiveVoice(this.sampleRate));
  }

  /** Keeps a drawn spectrum in a Spectrum slot. */
  loadShape(paramId, index, table) {
    if (paramId !== 'spectrum' || !table?.length) return false;
    this.tables[Math.max(0, Math.round(index))] = table;
    return true;
  }

  /**
   * The track's .bend(), in semitones: a number while it is still, a block of values while
   * something moves it (see bendOf in worklets/shared.mjs).
   */
  setBend(bend) {
    const p = this.params;
    if (typeof bend === 'number') {
      p.bend = Number.isFinite(bend) ? bend : 0;
      p.bendRatioA = null;
      return;
    }
    if (p.bendRatio.length < bend.length) p.bendRatio = new Float64Array(bend.length);
    for (let i = 0; i < bend.length; i++) p.bendRatio[i] = Math.pow(2, bend[i] / 12);
    p.bend = bend[0];
    p.bendRatioA = p.bendRatio;
  }

  queueNoteOn(note, velocity, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity }); }
  queueNoteOff(note, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 0, note, velocity: 0 }); }

  allNotesOff() {
    this.events.length = 0;
    for (const v of this.voices) {
      v.holds = 0;
      if (v.active) v.noteOff();
    }
  }

  get activeVoices() {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  /** The voice already on this note, a free one, the oldest releasing one, or the oldest. */
  allocate(note) {
    let free = null;
    let oldestReleasing = null;
    let oldest = null;
    for (let i = 0; i < this.voiceCount; i++) {
      const v = this.voices[i];
      if (v.active && v.note === note && !v.releasing) return v;
      if (!v.active) { if (!free) free = v; continue; }
      if (v.releasing && (!oldestReleasing || v.age < oldestReleasing.age)) oldestReleasing = v;
      if (!oldest || v.age < oldest.age) oldest = v;
    }
    return free ?? oldestReleasing ?? oldest ?? this.voices[0];
  }

  startNote(note, velocity) {
    const voice = this.allocate(note);
    // Glide slides from whatever this voice was last playing.
    const from = voice.active && voice.note >= 0 ? midiToHz(voice.note) : null;
    const holds = voice.active && voice.note === note && !voice.releasing ? voice.holds + 1 : 1;
    voice.age = this.clock++;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    voice.noteOn(note, velocity, this.params, this.seed, from);
    voice.holds = holds;
  }

  stopNote(note) {
    for (const v of this.voices) {
      if (!(v.active && v.note === note && !v.releasing)) continue;
      if (--v.holds > 0) continue; // an earlier note on this pitch ending: a later one still holds it
      v.holds = 0;
      v.noteOff();
    }
  }

  /** The block's partials - ratios, levels, damping - from the controls where the block ends. */
  _prepare(count) {
    const p = this.params;
    const s = p.values;
    const sr = this.sampleRate;
    p.block = count;
    const slot = Math.round(endOf(s.spectrum));
    const set = p.settings;
    set.partials = endOf(s.partials);
    set.tilt = endOf(s.tilt);
    set.odd = endOf(s.odd);
    set.stretch = endOf(s.stretch);
    set.damp = endOf(s.damp);
    set.table = slot >= 1 ? (this.tables[slot] ?? null) : null;
    shapePartials(set, sr, p.ratio, p.base, p.dampMul);
    p.attack = endOf(s['ampenv.attack']);
    p.decay = endOf(s['ampenv.decay']);
    p.sustain = endOf(s['ampenv.sustain']);
    p.release = endOf(s['ampenv.release']);
    p.acurve = endOf(s['env.acurve']);
    p.dcurve = endOf(s['env.dcurve']);
    p.rcurve = endOf(s['env.rcurve']);
    p.glide = endOf(s.glide);
    const level = s.level;
    if (typeof level === 'number') { p.level = level; p.levelA = null; } else { p.level = level[0]; p.levelA = level.length > 1 ? level : null; }
    p.bendEnd = p.bendRatioA === null ? 1 : p.bendRatioA[count - 1];
  }

  /** Renders one block, split wherever a queued note edge falls. */
  process(outL, outR, count) {
    this._prepare(count);
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);
    let at = 0;
    let next = 0;
    while (at < count) {
      while (next < events.length && events[next].at <= at) {
        const e = events[next++];
        if (e.kind === 1) this.startNote(e.note, e.velocity); else this.stopNote(e.note);
      }
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at;
      if (n > 0) {
        const l = at === 0 && n === outL.length ? outL : outL.subarray(at, at + n);
        const r = at === 0 && n === outR.length ? outR : outR.subarray(at, at + n);
        for (const v of this.voices) if (v.active) v.process(l, r, n, at, this.params);
      }
      at = until;
    }
    if (next >= events.length) events.length = 0;
    else this.events = events.slice(next).map((e) => ({ ...e, at: Math.max(0, e.at - count) }));
  }
}
