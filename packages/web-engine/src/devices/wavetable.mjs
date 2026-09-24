// The Wavetable synth: its descriptor, and the polyphonic engine behind it.
//
// The descriptor is the contract - `synth("Wavetable")` resolves its id, `.param("Osc 1
// Position", …)` resolves a parameter name here, and the generic panel is drawn from this list.
// So the names and units below are the part worth arguing about: they are what somebody types,
// what a later SuperCollider mirror of this synth would have to match, and what a saved song
// records.
//
// Everything continuous is a-rate, and READ per sample when a signal is moving it. That is the
// design: poptart's own modulators are ordinary signals, so a parameter that can be driven per
// sample can be driven by `lfo()`, by `env()`, by a macro, by a MIDI CC or by another track's
// audio without this synth knowing the difference. A signal on an oscillator's Phase is phase
// modulation and one on its Cents is vibrato; FM and PM from the OTHER sources in the voice are
// modes on the warp switch, with the warp amount as their depth (see warp.mjs). The k-rate
// controls are the handful where a value between two settings has no meaning - a mode, a table,
// an octave, a voice count.
//
// There is no filter. One filter per synth would be a worse copy of the Filter effect, which
// sits on the chain after any instrument, takes an `env()` on its cutoff as its envelope, and
// draws its response - and it costs nothing to put one there.

import { defineDevice } from '../descriptor.mjs';
import { WARP_MODES } from '../dsp/warp.mjs';
import { MAX_UNISON } from '../dsp/oscillator.mjs';
import { VoiceParams, WavetableVoice, midiToHz } from '../dsp/voice.mjs';
import { buildTable, powerOfTwoAtLeast, resampleFrame, sharedBuiltInTables, tableFromMips } from '../dsp/tables.mjs';
import { framesOf } from '../dsp/wavfile.mjs';

/** The tables the synth offers by name. Index 0 is what a fresh patch plays. */
export const TABLE_NAMES = Object.freeze(['Basic', 'Harmonics', 'Odd', 'PWM', 'Sync', 'Fold', 'FM', 'Organ', 'Vocal']);

/** How many table slots an oscillator has in all: the shipped ones and room for loaded files. */
export const TABLE_SLOTS = 64;

/** The most voices one track will ever run, whatever the voice count is set to. */
export const MAX_VOICES = 16;

const seconds = (id, name, def, group) => ({
  id, name, min: 0, max: 10, default: def, unit: 's', curve: 'pow', curveExp: 3, group,
});

function oscParams(n, group, levelDefault) {
  const p = `osc${n}`;
  return [
    { id: `${p}.level`, name: `Osc ${n} Level`, min: 0, max: 1, default: levelDefault, group },
    { id: `${p}.table`, name: `Osc ${n} Table`, default: 0, options: [...TABLE_NAMES], capacity: TABLE_SLOTS, takes: 'sample', sampleAs: 'wavetable', rate: 'k', group,
      description: 'Which stack of waveforms this oscillator reads. Name a sample - "pack:3" or "files:mytable.wav" - to load a file as a table: it is cut into frames of 2048 samples, or whatever length it declares; a file shorter than that is one cycle.' },
    { id: `${p}.position`, name: `Osc ${n} Position`, min: 0, max: 1, default: 0, group,
      description: 'Where in the table stack this oscillator reads. Sweeping it morphs one waveform into the next.' },
    { id: `${p}.warpmode`, name: `Osc ${n} Warp Mode`, default: 0, options: [...WARP_MODES], rate: 'k', group,
      description: 'How the warp bends this oscillator. The phase warps reshape the cycle; the fm, pm and ring modes bend it with another source in the voice - the other oscillator, the sub, the noise - and the warp amount is their depth.' },
    { id: `${p}.warp`, name: `Osc ${n} Warp`, min: 0, max: 1, default: 0, group,
      description: 'How hard the warp mode bends the phase, or the depth of a cross-modulation. Zero is neutral in every mode.' },
    { id: `${p}.phase`, name: `Osc ${n} Phase`, min: 0, max: 1, default: 0, unit: 'cyc', group,
      description: 'Shifts where the oscillator reads its cycle, in cycles. A signal here is phase modulation.' },
    { id: `${p}.octave`, name: `Osc ${n} Octave`, min: -3, max: 3, default: 0, step: 1, rate: 'k', ui: 'number', group },
    { id: `${p}.semi`, name: `Osc ${n} Semi`, min: -24, max: 24, default: 0, step: 1, unit: 'st', ui: 'number', group,
      description: 'Coarse tuning in semitones.' },
    { id: `${p}.cents`, name: `Osc ${n} Cents`, min: -100, max: 100, default: 0, step: 1, unit: 'ct', ui: 'number', group,
      description: 'Fine tuning. A signal here is vibrato.' },
    // The unison controls sit in a section of their own, under the picture of the spread they
    // move: in the oscillator's section they were the last four of thirteen knobs, a row and a
    // half below the figure that answers to them.
    { id: `${p}.unison`, name: `Osc ${n} Unison`, min: 1, max: MAX_UNISON, default: 1, step: 1, rate: 'k', ui: 'number', group: `${group} Unison` },
    { id: `${p}.detune`, name: `Osc ${n} Detune`, min: 0, max: 100, default: 15, unit: 'ct', group: `${group} Unison` },
    { id: `${p}.spread`, name: `Osc ${n} Spread`, min: 0, max: 1, default: 0.5, group: `${group} Unison`,
      description: 'How far apart the unison copies are panned.' },
    { id: `${p}.phaserand`, name: `Osc ${n} Phase Rand`, min: 0, max: 1, default: 1, rate: 'k', group: `${group} Unison`,
      description: 'Zero starts every copy together, which is a hard attack; one spreads them.' },
  ];
}

export const WAVETABLE = defineDevice({
  id: 'Wavetable',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-wavetable',
  description: 'Two band-limited wavetable oscillators with phase warping and cross-modulation, a sub and noise. Every continuous control follows a signal at the sample rate.',
  channels: { in: 0, out: 2 },
  params: [
    ...oscParams(1, 'Osc 1', 0.5),
    ...oscParams(2, 'Osc 2', 0),

    { id: 'sub.level', name: 'Sub Level', min: 0, max: 1, default: 0, group: 'Sub' },
    { id: 'sub.octave', name: 'Sub Octave', min: -3, max: 0, default: -1, step: 1, rate: 'k', ui: 'number', group: 'Sub' },
    { id: 'sub.shape', name: 'Sub Shape', default: 0, options: ['sine', 'square'], rate: 'k', group: 'Sub' },
    { id: 'noise.level', name: 'Noise Level', min: 0, max: 1, default: 0, group: 'Sub' },

    seconds('ampenv.attack', 'Amp Attack', 0.005, 'Amp Env'),
    seconds('ampenv.decay', 'Amp Decay', 0.1, 'Amp Env'),
    { id: 'ampenv.sustain', name: 'Amp Sustain', min: 0, max: 1, default: 0.8, group: 'Amp Env' },
    seconds('ampenv.release', 'Amp Release', 0.15, 'Amp Env'),
    // One curve per stage. The shape an attack wants and the shape a release wants are opposite
    // ends of this control, so a single knob for all three means picking which one to get right.
    { id: 'env.acurve', name: 'Attack Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative rises fast and levels off, positive holds back and then rushes.' },
    { id: 'env.dcurve', name: 'Decay Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative falls fast and trails off, which is what a plucked sound wants.' },
    { id: 'env.rcurve', name: 'Release Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative drops away quickly and then hangs, positive holds the level and then cuts.' },
    { id: 'env.scale', name: 'Env Scale', min: 0.05, max: 20, default: 1, curve: 'exp', unit: 'x', rate: 'k', group: 'Amp Env',
      description: 'Multiplies every envelope time at once.' },

    { id: 'glide', name: 'Glide', min: 0, max: 5, default: 0, unit: 's', curve: 'pow', curveExp: 3, group: 'Voice' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.7, group: 'Voice' },
    { id: 'voices', name: 'Voices', min: 1, max: MAX_VOICES, default: 8, step: 1, rate: 'k', ui: 'number', group: 'Voice' },
  ],

  // The pictures the panel draws, each one at the head of the section whose knobs it belongs
  // with. See figures.mjs: the drawing is generic and reads these, so what is device-specific
  // about this synth's window is exactly this list and nothing in the editor.
  //
  // A wavetable synth is the case the generic panel serves worst. Its most important control
  // reads "0.42" on a knob when what somebody wants to know is which waveform that is and what
  // it is turning into, and its envelope is four knobs saying what one curve says at a glance.
  // So the position and the envelope are drawn, and the drawn ones take the gesture as well: a
  // figure with `drag` is turned like a knob and writes its `.param()` call the same way on
  // release.
  figures: [
    ...oscFigures(1),
    ...oscFigures(2),
    // The envelope JOINS its four knobs rather than replacing them. It used to take them over,
    // which reads well until you want to type a number in: a curve is the right way to see an
    // envelope and the wrong way to set one to exactly 120 ms. The knobs mirror the picture and
    // the picture mirrors the knobs; dragging either moves both.
    {
      id: 'ampenv',
      kind: 'adsr',
      group: 'Amp Env',
      title: 'envelope',
      description: 'The amplitude envelope, drawn through the curve the voice shapes it with. Drag a point for its stage, the plateau for the sustain level.',
      params: {
        attack: 'ampenv.attack', decay: 'ampenv.decay', sustain: 'ampenv.sustain', release: 'ampenv.release',
        acurve: 'env.acurve', dcurve: 'env.dcurve', rcurve: 'env.rcurve', scale: 'env.scale',
      },
      // The three curves are the PICTURE'S, not the panel's: each is set by the wheel over the
      // stage it bends, which is where the shape being bent actually is. As number boxes they
      // were three more controls in a group that already had five, and the group wrapped onto a
      // second line with the four envelope times split across the break.
      subsumes: ['acurve', 'dcurve', 'rcurve'],
    },
  ],

  // The two oscillators side by side, because they are twins, each one's unison under it; the
  // rest in a row beneath.
  panel: { width: 920, rows: [['Osc 1', 'Osc 2'], ['Osc 1 Unison', 'Osc 2 Unison'], ['Sub', 'Amp Env', 'Voice']] },
});

/** The two pictures an oscillator gets: the waveform it is reading, and its unison spread. */
function oscFigures(n) {
  const p = `osc${n}`;
  const group = `Osc ${n}`;
  return [
    {
      id: `${p}.wave`,
      kind: 'wavetable',
      group,
      title: 'table',
      description: 'One cycle as this oscillator reads it, over the stack it is read from, with the warp applied. Drag across to sweep the position.',
      params: { table: `${p}.table`, position: `${p}.position`, warp: `${p}.warp`, warpmode: `${p}.warpmode` },
      drag: { x: 'position' },
      // The table control belongs ON the picture of the table, not under it as a second copy of
      // the same name: the panel draws a subsumed control in the figure's own heading.
      subsumes: ['table'],
    },
    {
      id: `${p}.spread`,
      kind: 'unison',
      group: `${group} Unison`,
      title: 'unison',
      description: 'Where the unison copies sit: detune across, pan up and down. Drag across for the detune, up for the spread.',
      params: { count: `${p}.unison`, detune: `${p}.detune`, spread: `${p}.spread` },
      drag: { x: 'detune', y: 'spread' },
    },
  ];
}

/**
 * Descriptor parameter id to the field it sets on the parameter struct.
 *
 * Written out rather than derived from the id, so that a renamed parameter is a test failure
 * here instead of a control that silently stops doing anything.
 */
export const PARAM_FIELDS = Object.freeze({
  'osc1.level': 'osc1Level', 'osc1.table': 'osc1Table', 'osc1.position': 'osc1Position',
  'osc1.warp': 'osc1Warp', 'osc1.warpmode': 'osc1WarpMode', 'osc1.phase': 'osc1Phase',
  'osc1.octave': 'osc1Octave', 'osc1.semi': 'osc1Semis', 'osc1.cents': 'osc1Cents',
  'osc1.unison': 'osc1Unison', 'osc1.detune': 'osc1Detune', 'osc1.spread': 'osc1Pan',
  'osc1.phaserand': 'osc1PhaseRand',

  'osc2.level': 'osc2Level', 'osc2.table': 'osc2Table', 'osc2.position': 'osc2Position',
  'osc2.warp': 'osc2Warp', 'osc2.warpmode': 'osc2WarpMode', 'osc2.phase': 'osc2Phase',
  'osc2.octave': 'osc2Octave', 'osc2.semi': 'osc2Semis', 'osc2.cents': 'osc2Cents',
  'osc2.unison': 'osc2Unison', 'osc2.detune': 'osc2Detune', 'osc2.spread': 'osc2Pan',
  'osc2.phaserand': 'osc2PhaseRand',

  'sub.level': 'subLevel', 'sub.octave': 'subOctave', 'sub.shape': 'subShape',
  'noise.level': 'noiseLevel',

  'ampenv.attack': 'ampAttack', 'ampenv.decay': 'ampDecay', 'ampenv.sustain': 'ampSustain',
  'ampenv.release': 'ampRelease',

  'env.acurve': 'envAttackCurve', 'env.dcurve': 'envDecayCurve', 'env.rcurve': 'envReleaseCurve', 'env.scale': 'envScale',
  'glide': 'glide', 'level': 'level',
});

/** The sub oscillator's own two-frame table: a sine and a square, band-limited like any other. */
function subTableOf(tables) {
  const basic = tables[0];
  return buildTable('Sub', [basic.mips[0][0], basic.mips[3][0]]);
}

/**
 * The frames of a loaded file as a table: the channels summed to one, cut at the frame length
 * the file declared, and each frame brought to a power of two so the pyramid can be built.
 * `mips` arriving already built are used as they are - see the engine, which builds them on
 * the main thread so a file does not stall the audio thread.
 */
export function tableFromSample(name, { channels = [], frameLength = null, mips = null } = {}) {
  if (mips) return tableFromMips(name, mips);
  if (!channels.length) return null;
  let mono = channels[0];
  if (channels.length > 1) {
    mono = new Float32Array(channels[0].length);
    for (const c of channels) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / channels.length;
  }
  const raw = framesOf(mono, frameLength ?? 2048);
  const length = powerOfTwoAtLeast(raw[0].length);
  const frames = raw.map((f) => (f.length === length ? f : resampleFrame(f, length)));
  return buildTable(name, frames);
}

/**
 * The polyphonic synth.
 *
 * Voice identity is the NOTE, because that is what the engine interface addresses: a note-off
 * names a pitch, not a voice, so the synth is responsible for matching it to whatever is
 * sounding. Two note-ons on the same pitch before an off means the second takes the first's
 * voice, which is the only reading that lets the single off that follows release both.
 */
export class WavetableSynth {
  constructor(sampleRate, tables = null) {
    this.sampleRate = sampleRate;
    // A copy, so a table loaded into this instance never reaches another synth's list.
    this.tables = [...(tables ?? sharedBuiltInTables())];
    this.subTable = subTableOf(this.tables);
    this.voices = Array.from({ length: MAX_VOICES }, () => new WavetableVoice(sampleRate));
    this.params = new VoiceParams();
    this.voiceCount = 8;
    this.clock = 0;          // bumped per note, so "oldest" has a meaning
    this.seed = 1;
    this.events = [];        // pending note edges, each with a sample offset into the next block
  }

  /**
   * Fills the parameter struct from a `{ paramId: value }` map, in real units.
   *
   * A value may be a number or a Float32Array - one sample long for a control that is still,
   * a block long for one a signal is moving - which is exactly how the worklet hands them over
   * once it has converted the positions. A moving one is kept whole so the voices can read it
   * per sample.
   */
  setParams(values) {
    const p = this.params;
    const a = p.a;
    for (const [id, field] of Object.entries(PARAM_FIELDS)) {
      const v = values[id];
      if (v === undefined) continue;
      if (typeof v === 'number') {
        if (Number.isFinite(v)) { p[field] = v; a[field] = null; }
      } else if (v.length > 1) {
        p[field] = v[0];
        a[field] = v;
      } else if (v.length === 1 && Number.isFinite(v[0])) {
        p[field] = v[0];
        a[field] = null;
      }
    }
    const voices = values.voices;
    const count = typeof voices === 'number' ? voices : voices?.[0];
    if (Number.isFinite(count)) this.voiceCount = Math.min(MAX_VOICES, Math.max(1, Math.round(count)));
  }

  /** The table an index names; a slot nothing has been loaded into plays the first table. */
  tableFor(index) {
    const i = Math.max(0, Math.round(index));
    return this.tables[i] ?? this.tables[0];
  }

  /**
   * Puts a loaded file in a table slot. The message is what the engine posts: the file's
   * channels at its own rate with the frame length it declared, or the pyramids ready-built.
   * A voice already sounding on the slot picks the table up at its next block.
   */
  loadSample(paramId, index, payload) {
    if (!/^osc[12]\.table$/.test(paramId)) return false;
    const table = tableFromSample(payload?.name ?? `table ${index}`, payload ?? {});
    if (!table) return false;
    this.tables[Math.max(0, Math.round(index))] = table;
    return true;
  }

  /**
   * Queues a note edge at a sample offset into the next block.
   *
   * Offsets rather than "at the next block boundary" because a block is nearly three
   * milliseconds and a drum part played on a synth shows that up immediately: onsets land early
   * or late by up to a block and the groove walks. The engine converts an absolute time into an
   * offset; the synth splits its block wherever one falls.
   */
  queueNoteOn(note, velocity, offset = 0) {
    this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity });
  }

  queueNoteOff(note, offset = 0) {
    this.events.push({ at: Math.max(0, offset | 0), kind: 0, note, velocity: 0 });
  }

  /** Releases everything, the way the host's hush does. */
  /** The track's .bend(), in semitones: every voice, sounding or to come. */
  setBend(semitones) {
    this.params.bend = Number.isFinite(semitones) ? semitones : 0;
  }

  allNotesOff() {
    this.events.length = 0;
    for (const v of this.voices) if (v.active) v.noteOff();
  }

  get activeVoices() {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  /**
   * Picks a voice for a note, from the first `voiceCount` voices. In order: the one already
   * playing this note, a free one, the oldest one already releasing, and finally the oldest
   * sounding voice.
   *
   * Stealing the oldest RELEASING voice before any held one is what keeps a held chord intact
   * while a fast part runs over the top of it.
   */
  allocate(note) {
    let free = null;
    let oldestReleasing = null;
    let oldest = null;
    const limit = this.voiceCount;
    for (let i = 0; i < limit; i++) {
      const v = this.voices[i];
      if (v.active && v.note === note && !v.releasing) return v;
      if (!v.active) { if (!free) free = v; continue; }
      if (v.releasing) { if (!oldestReleasing || v.age < oldestReleasing.age) oldestReleasing = v; }
      if (!oldest || v.age < oldest.age) oldest = v;
    }
    return free ?? oldestReleasing ?? oldest ?? this.voices[0];
  }

  startNote(note, velocity) {
    const voice = this.allocate(note);
    // Glide slides from whatever this voice was last playing, which is how a monophonic lead
    // with one voice glides between its notes.
    const from = voice.active && voice.note >= 0 ? midiToHz(voice.note) : null;
    voice.setTables(this.tableFor(this.params.osc1Table), this.tableFor(this.params.osc2Table), this.subTable);
    voice.age = this.clock++;
    voice.noteOn(note, velocity, this.params, (this.seed = (this.seed * 1664525 + 1013904223) >>> 0), from);
  }

  stopNote(note) {
    for (const v of this.voices) if (v.active && v.note === note && !v.releasing) v.noteOff();
  }

  /**
   * Renders one block, splitting it wherever a queued note edge falls.
   *
   * Every ACTIVE voice renders, not only the first `voiceCount`: the count limits what a new
   * note may take, and a voice above it that was sounding when the count came down finishes its
   * note and its release rather than being left silent and permanently busy.
   */
  process(outL, outR, count) {
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);

    // A table swapped under a sounding voice - a file that just landed, a switch of the table
    // control - reaches it at the block, which is soon enough and clicks no more than a switch.
    const t1 = this.tableFor(this.params.osc1Table);
    const t2 = this.tableFor(this.params.osc2Table);
    for (const v of this.voices) {
      if (!v.active) continue;
      if (v.osc1.table !== t1) v.osc1.setTable(t1);
      if (v.osc2.table !== t2) v.osc2.setTable(t2);
    }

    let at = 0;
    let next = 0;
    while (at < count) {
      while (next < events.length && events[next].at <= at) {
        const e = events[next++];
        if (e.kind === 1) this.startNote(e.note, e.velocity);
        else this.stopNote(e.note);
      }
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at;
      if (n > 0) {
        const l = subarray(outL, at, n);
        const r = subarray(outR, at, n);
        for (const v of this.voices) if (v.active) v.process(l, r, n, at, this.params);
      }
      at = until;
    }
    // Anything past the end of the block waits for the next one, shifted back by a block.
    if (next >= events.length) events.length = 0;
    else {
      this.events = events.slice(next).map((e) => ({ ...e, at: Math.max(0, e.at - count) }));
    }
  }
}

/** A view into a block without copying it - the voices add into the real output buffer. */
function subarray(buf, at, n) {
  return at === 0 && n === buf.length ? buf : buf.subarray(at, at + n);
}
