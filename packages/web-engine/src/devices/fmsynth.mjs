// The FM synth: eight operators and a modulation matrix.
//
// No fixed algorithms. Every operator can modulate every operator, itself included, by an
// amount in the matrix, and every operator has a level of its own to the output - so the classic
// algorithms are settings of the matrix rather than a list to pick from, and anything in
// between them is a setting too. Phase modulation throughout, which is what every FM synth
// since the first has actually done: the modulator is added to the carrier's phase, so the
// pitch stays put and the sidebands stay harmonic at any depth.
//
// Each operator is a ratio of the note (or a fixed frequency), a wave, a level and its own
// envelope. The matrix is a figure on the panel - sixty-four cells is a picture, not a rack of
// knobs - and its cells are ordinary parameters underneath, so `.param("Mod 2 to 1", …)` and an
// `env()` on it work like any other control.

import { defineDevice } from '../descriptor.mjs';
import { Adsr } from '../dsp/adsr.mjs';
import { midiToHz } from '../dsp/voice.mjs';

export const OPS = 8;
export const FM_VOICES = 12;

const WAVES = Object.freeze(['sine', 'triangle', 'saw', 'square']);
const FM_TWO_PI = Math.PI * 2;

const opSeconds = (id, name, def, group, max = 10) => ({
  id, name, min: 0, max, default: def, unit: 's', curve: 'pow', curveExp: 3, group,
});

function opParams(n) {
  const p = `op${n}`;
  const group = `Op ${n}`;
  return [
    { id: `${p}.level`, name: `Op ${n} Level`, min: 0, max: 1, default: n === 1 ? 0.8 : 0, group,
      description: 'How much of this operator reaches the output. An operator that only modulates others sits at zero.' },
    { id: `${p}.ratio`, name: `Op ${n} Ratio`, min: 0.25, max: 32, default: 1, step: 0.01, unit: 'x', ui: 'number', group,
      description: 'The operator\'s frequency as a multiple of the note. Whole numbers are harmonic.' },
    { id: `${p}.detune`, name: `Op ${n} Detune`, min: -100, max: 100, default: 0, step: 1, unit: 'ct', ui: 'number', group },
    { id: `${p}.fixed`, name: `Op ${n} Fixed`, min: 0, max: 1, default: 0, ui: 'toggle', rate: 'k', group,
      description: 'Ignore the note: the ratio times a hundred Hertz, whatever is played.' },
    { id: `${p}.wave`, name: `Op ${n} Wave`, default: 0, options: [...WAVES], rate: 'k', group },
    opSeconds(`${p}.attack`, `Op ${n} Attack`, 0.005, group),
    opSeconds(`${p}.decay`, `Op ${n} Decay`, 0.3, group),
    { id: `${p}.sustain`, name: `Op ${n} Sustain`, min: 0, max: 1, default: 0.7, group },
    opSeconds(`${p}.release`, `Op ${n} Release`, 0.3, group),
    { id: `${p}.velocity`, name: `Op ${n} Vel > Level`, min: 0, max: 1, default: 0.5, group,
      description: 'How much the note\'s velocity sets this operator\'s level. At 0 every note plays it at full level; at 1 its level follows velocity all the way, so a soft note barely sounds it. On an operator that modulates others, that makes soft notes darker and hard ones brighter.' },
  ];
}

function matrixParams() {
  const out = [];
  for (let from = 1; from <= OPS; from++) {
    for (let to = 1; to <= OPS; to++) {
      out.push({
        id: `mod.${from}.${to}`, name: `Mod ${from} to ${to}`, min: 0, max: 1, default: 0, group: 'Matrix',
        description: from === to
          ? `Operator ${from}'s feedback: how much it modulates its own phase, which is how a sine turns into a saw.`
          : `How much operator ${from} modulates operator ${to}'s phase.`,
      });
    }
  }
  return out;
}

const matrixRoles = {};
for (let from = 1; from <= OPS; from++) {
  for (let to = 1; to <= OPS; to++) matrixRoles[`m${from}.${to}`] = `mod.${from}.${to}`;
}
for (let n = 1; n <= OPS; n++) matrixRoles[`level${n}`] = `op${n}.level`;

const opFigures = [];
for (let n = 1; n <= OPS; n++) {
  opFigures.push({
    id: `op${n}.env`,
    kind: 'adsr',
    group: `Op ${n}`,
    title: 'envelope',
    description: `Operator ${n}'s envelope. Drag a point for its stage, the plateau for the sustain.`,
    params: { attack: `op${n}.attack`, decay: `op${n}.decay`, sustain: `op${n}.sustain`, release: `op${n}.release` },
    subsumes: ['attack', 'decay', 'sustain', 'release'],
  });
}

export const FMSYNTH = defineDevice({
  id: 'FM',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-fm',
  description: 'Eight operators and a modulation matrix: every operator can modulate every other and itself, each with its own ratio, wave and envelope, so an algorithm is a setting rather than a choice.',
  channels: { in: 0, out: 2 },
  params: [
    ...opParams(1), ...opParams(2), ...opParams(3), ...opParams(4),
    ...opParams(5), ...opParams(6), ...opParams(7), ...opParams(8),
    ...matrixParams(),
    { id: 'depth', name: 'Depth', min: 0, max: 1, default: 0.5, group: 'Voice',
      description: 'Scales the whole matrix at once: how hard everything modulates.' },
    { id: 'glide', name: 'Glide', min: 0, max: 5, default: 0, unit: 's', curve: 'pow', curveExp: 3, group: 'Voice' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.6, group: 'Voice' },
    { id: 'voices', name: 'Voices', min: 1, max: FM_VOICES, default: 8, step: 1, rate: 'k', ui: 'number', group: 'Voice' },
  ],
  figures: [
    ...opFigures,
    {
      id: 'matrix',
      kind: 'matrix',
      ops: OPS,
      group: 'Matrix',
      // No title: it sits under the Matrix heading, which has named it already.
      title: '',
      description: 'Rows modulate columns: the cell in row 2, column 1 is how much operator 2 bends operator 1. The last column is each operator\'s level to the output. Drag a cell up and down.',
      params: matrixRoles,
      subsumes: Object.keys(matrixRoles).filter((r) => r.startsWith('m')),
    },
  ],
  // THE MATRIX FIRST. It is what the synth IS - the operators are eight copies of the same few
  // controls, and which of them is modulating which is the thing somebody needs to see before any
  // of those controls mean anything. Underneath it, the operators in two rows of four.
  panel: { width: 980, rows: [['Matrix', 'Voice'], ['Op 1', 'Op 2', 'Op 3', 'Op 4'], ['Op 5', 'Op 6', 'Op 7', 'Op 8']] },
});

/** A wave at a phase in cycles, in -1..1, cheap enough for eight of them per sample per voice. */
function wave(shape, phase) {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 1: return p < 0.5 ? p * 4 - 1 : 3 - p * 4;
    case 2: return p * 2 - 1;
    case 3: return p < 0.5 ? 1 : -1;
    default: return Math.sin(FM_TWO_PI * p);
  }
}

/**
 * Values that reach their new setting ACROSS a block rather than at its edge.
 *
 * A matrix cell, an operator's level and the depth are all read on every sample of every voice,
 * and all of them arrive once a block. Taking the new number at the block boundary steps the
 * value a hundred and fifty times a second, and a stepped modulation index is not a quiet
 * imperfection: it puts sidebands either side of everything sounding, at the block rate and its
 * multiples, which is a buzz riding the note for as long as the control is moving. It is at its
 * worst exactly when somebody is dragging a cell to find a sound.
 *
 * So each entry keeps where the block STARTS, where it should end, and the increment between -
 * and `moving` lists the few entries that are actually going anywhere, so a still matrix costs
 * one comparison per entry per block and nothing at all per sample.
 */
class Ramped {
  constructor(n, fill = 0) {
    this.value = new Float64Array(n).fill(fill);
    this.target = new Float64Array(n).fill(fill);
    this.step = new Float64Array(n);
    this.moving = [];
  }

  /** Where entry `i` should be by the end of the block. */
  aim(i, target) {
    if (Number.isFinite(target)) this.target[i] = target;
  }

  /** Works out this block's per-sample increments, and which entries have one. */
  begin(samples) {
    this.moving.length = 0;
    for (let i = 0; i < this.value.length; i++) {
      const d = this.target[i] - this.value[i];
      if (d === 0) { this.step[i] = 0; continue; }
      this.step[i] = samples > 0 ? d / samples : 0;
      this.moving.push(i);
    }
  }

  /** After the block, every entry is exactly where it was aimed - no drift over a long sweep. */
  commit() {
    for (let r = 0; r < this.moving.length; r++) this.value[this.moving[r]] = this.target[this.moving[r]];
    this.moving.length = 0;
  }

  /** Entry `i` at sample `t` of the block. */
  at(i, t) {
    return this.value[i] + this.step[i] * t;
  }
}

/** The per-block snapshot of every control, unpacked into arrays the voices index by operator. */
class FmParams {
  constructor() {
    this.ratio = new Float64Array(OPS).fill(1);
    this.detune = new Float64Array(OPS);
    this.fixed = new Uint8Array(OPS);
    this.wave = new Uint8Array(OPS);
    this.attack = new Float64Array(OPS).fill(0.005);
    this.decay = new Float64Array(OPS).fill(0.3);
    this.sustain = new Float64Array(OPS).fill(0.7);
    this.release = new Float64Array(OPS).fill(0.3);
    this.velocity = new Float64Array(OPS).fill(0.5);
    // The three that are read per sample, and so are ramped across the block.
    this.matrix = new Ramped(OPS * OPS);
    this.level = new Ramped(OPS);
    this.depth = new Ramped(1, 0.5);
    this.glide = 0;
    this.out = 0.6;
    this.outA = null;
    // The track's bend in semitones, and while it moves, the frequency ratio it makes per sample
    // - worked out once a block for every voice (see FmSynth#setBend). Null while it is still.
    this.bend = 0;
    this.bendRatio = new Float32Array(128);
    this.bendRatioA = null;
  }

  /** Called once per block, with the whole block's length, before any voice renders. */
  beginBlock(samples) {
    this.matrix.begin(samples);
    this.level.begin(samples);
    this.depth.begin(samples);
  }

  /** And once after, so the next block starts where this one finished. */
  commitBlock() {
    this.matrix.commit();
    this.level.commit();
    this.depth.commit();
  }
}

class FmVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.phase = new Float64Array(OPS);
    this.last = new Float64Array(OPS);
    // Scratch for the controls that are being moved: a voice follows the ramp into its own copy
    // rather than advancing the shared one, which the next voice of the block would then read
    // already spent.
    this.mtx = new Float64Array(OPS * OPS);
    this.lvl = new Float64Array(OPS);
    this.inc = new Float64Array(OPS);    // each operator's phase step this block
    this.envs = Array.from({ length: OPS }, () => new Adsr(sampleRate));
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.releasing = false;
    this.targetHz = 440;
    this.currentHz = 440;
  }

  get active() { return this.envs.some((e) => e.active); }

  noteOn(note, velocity, p, glideFrom) {
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.targetHz = midiToHz(note);
    this.currentHz = glideFrom != null && p.glide > 0 ? glideFrom : this.targetHz;
    this.phase.fill(0);
    this.last.fill(0);
    for (const e of this.envs) e.gateOn(true);
  }

  noteOff() {
    this.releasing = true;
    for (const e of this.envs) e.gateOff();
  }

  process(outL, outR, count, offset, p) {
    if (!this.active) return;
    if (p.glide > 0 && this.currentHz !== this.targetHz) {
      const k = 1 - Math.exp(-(count / this.sampleRate) / Math.max(1e-4, p.glide));
      this.currentHz += (this.targetHz - this.currentHz) * k;
      if (Math.abs(this.currentHz - this.targetHz) < 0.01) this.currentHz = this.targetHz;
    } else {
      this.currentHz = this.targetHz;
    }
    const inc = this.inc;
    for (let o = 0; o < OPS; o++) {
      // A fixed operator holds its frequency; the rest follow the note, bent - by the block's
      // bend while it is still, per sample below while it moves.
      const base = p.fixed[o] ? 100 : this.currentHz * (p.bendRatioA === null && p.bend ? Math.pow(2, p.bend / 12) : 1);
      inc[o] = (base * p.ratio[o] * Math.pow(2, p.detune[o] / 1200)) / this.sampleRate;
      this.envs[o].setStages(p.attack[o], p.decay[o], p.sustain[o], p.release[o], -4, -4, -4);
    }
    const vel = this.velocity;
    const bendRatioA = p.bendRatioA;

    // A still control is read straight out of the block's values; one that is moving is followed
    // per sample. `moving` is almost always empty - nothing is being dragged, nothing is being
    // modulated - so the arrays below are the parameters themselves and this costs nothing.
    const mMoving = p.matrix.moving;
    const lMoving = p.level.moving;
    const dMoving = p.depth.moving.length > 0;
    const matrix = mMoving.length ? this.mtx : p.matrix.value;
    const level = lMoving.length ? this.lvl : p.level.value;
    if (mMoving.length) matrix.set(p.matrix.value);
    if (lMoving.length) level.set(p.level.value);

    for (let i = 0; i < count; i++) {
      // Where this sample sits in the WHOLE block, not in this piece of it: the block is cut at
      // every note edge, and a ramp that restarted at each cut would step at the cuts instead.
      const t = offset + i;
      for (let r = 0; r < mMoving.length; r++) matrix[mMoving[r]] = p.matrix.at(mMoving[r], t);
      for (let r = 0; r < lMoving.length; r++) level[lMoving[r]] = p.level.at(lMoving[r], t);
      const depth = (dMoving ? p.depth.at(0, t) : p.depth.value[0]) * 4;
      const bent = bendRatioA === null ? 1 : bendRatioA[t];

      let sum = 0;
      for (let o = 0; o < OPS; o++) {
        const env = this.envs[o].next() * (1 - p.velocity[o] + p.velocity[o] * vel);
        // The phase this operator reads: its own, plus everything modulating it from the last
        // sample - itself included, which is the matrix's diagonal: an operator's feedback.
        let mod = 0;
        const row = o;
        for (let from = 0; from < OPS; from++) {
          const amount = matrix[from * OPS + row];
          if (amount > 0) mod += amount * depth * this.last[from];
        }
        const v = wave(p.wave[o], this.phase[o] + mod) * env;
        this.last[o] = v;
        this.phase[o] += p.fixed[o] ? inc[o] : inc[o] * bent;
        if (this.phase[o] >= 1) this.phase[o] -= 1;
        sum += v * level[o];
      }
      const g = (p.outA ? p.outA[offset + i] : p.out) * 0.5;
      outL[i] += sum * g;
      outR[i] += sum * g;
    }
  }
}

export class FmSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.params = new FmParams();
    this.voices = Array.from({ length: FM_VOICES }, () => new FmVoice(sampleRate));
    this.voiceCount = 8;
    this.clock = 0;
    this.events = [];
  }

  /** Fills the struct from a `{ id: value }` map in real units; arrays are read at their head. */
  setParams(values) {
    const p = this.params;
    const num = (v) => (typeof v === 'number' ? v : v?.length ? v[0] : undefined);
    // The END of a block of values, for a control that is ramped to where it has got to rather
    // than jumped to where it started.
    const last = (v) => (typeof v === 'number' ? v : v?.length ? v[v.length - 1] : undefined);
    for (let o = 0; o < OPS; o++) {
      const id = `op${o + 1}`;
      const read = (key, into) => { const v = num(values[`${id}.${key}`]); if (Number.isFinite(v)) into[o] = v; };
      read('ratio', p.ratio); read('detune', p.detune);
      read('attack', p.attack); read('decay', p.decay);
      read('sustain', p.sustain); read('release', p.release); read('velocity', p.velocity);
      // The ramped ones are AIMED rather than set, at where the block ends: a signal driving one
      // arrives as a whole block of values, and the last of them is where it has got to.
      p.level.aim(o, last(values[`${id}.level`]));
      const fixed = num(values[`${id}.fixed`]); if (Number.isFinite(fixed)) p.fixed[o] = fixed >= 0.5 ? 1 : 0;
      const w = num(values[`${id}.wave`]); if (Number.isFinite(w)) p.wave[o] = Math.round(w);
      for (let t = 0; t < OPS; t++) p.matrix.aim(o * OPS + t, last(values[`mod.${o + 1}.${t + 1}`]));
    }
    p.depth.aim(0, last(values.depth));
    const glide = num(values.glide); if (Number.isFinite(glide)) p.glide = glide;
    const level = values.level;
    if (typeof level === 'number') { p.out = level; p.outA = null; } else if (level?.length > 1) { p.out = level[0]; p.outA = level; } else if (level?.length === 1) { p.out = level[0]; p.outA = null; }
    const voices = num(values.voices);
    if (Number.isFinite(voices)) this.voiceCount = Math.min(FM_VOICES, Math.max(1, Math.round(voices)));
  }

  queueNoteOn(note, velocity, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity }); }
  queueNoteOff(note, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 0, note }); }

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
    if (p.bendRatio.length < bend.length) p.bendRatio = new Float32Array(bend.length);
    for (let i = 0; i < bend.length; i++) p.bendRatio[i] = Math.pow(2, bend[i] / 12);
    p.bend = bend[0];
    p.bendRatioA = p.bendRatio;
  }

  allNotesOff() {
    this.events.length = 0;
    for (const v of this.voices) if (v.active) v.noteOff();
  }

  get activeVoices() { return this.voices.filter((v) => v.active).length; }

  allocate(note) {
    let free = null; let oldestReleasing = null; let oldest = null;
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
    const from = voice.active && voice.note >= 0 ? midiToHz(voice.note) : null;
    voice.age = this.clock++;
    voice.noteOn(note, velocity, this.params, from);
  }

  stopNote(note) {
    for (const v of this.voices) if (v.active && v.note === note && !v.releasing) v.noteOff();
  }

  process(outL, outR, count) {
    // The ramps are worked out for the WHOLE block and committed after it, so the cuts this loop
    // makes at note edges do not become steps of their own.
    this.params.beginBlock(count);
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
    this.params.commitBlock();
  }
}
