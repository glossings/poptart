// The Analog synth: two oscillators, a sub and noise into an analog filter circuit with its own
// envelope, on every voice.
//
// THE OSCILLATORS are a saw, a square with a width, a triangle or a sine each, drawn
// band-limited: every jump in a saw or a square and every corner of a triangle is placed at its
// exact fraction of a sample and corrected with a windowed sinc (dsp/blep.mjs), so a high note
// does not fold back. Osc 2 sits Semi and Detune away from osc 1, and Sync restarts it at every
// cycle of osc 1 - each restart a jump of its own, drawn the same way. Mix crossfades the two.
// The sub is a square an octave below osc 1, flipped at osc 1's own cycle, and noise is white.
// Everything is summed into one line and comes out BLEP_HALF samples late.
//
// DRIFT. Each oscillator wanders a few cents on its own, as a pair of analog oscillators never
// quite agree: a smoothed random walk a voice keeps from note to note, seeded, so a render plays
// the same twice and on both engines.
//
// ONE FILTER PER VOICE, which is the exception to the synths being filterless (see
// dsp/voice.mjs): a chain filter is shared by every voice and follows one envelope, and an
// envelope per note is the sound of this instrument. Cutoff moves with the note (Key Track, from
// middle C) and with the filter envelope (Env Amount, in semitones, either way); Velocity sets how
// much a note's velocity scales that envelope, so a harder note opens it further.
//
// THE FILTER is a circuit model from dsp/analog.mjs, the same ones the Filter device's analog
// modes run: Filter Type picks the model (ANALOG_MODELS, in Filter's order), Drive is the level
// into it, Morph the response of the multimode ones. A voice talks to it only through
// setModel, setCutoff, setResonance, setDrive, setMorph, process and reset; the model has its own
// saturation and its own oversampling.
//
// MONO. With Voices at one the synth is a monosynth: a note played while another is held slides
// to it over Glide without starting either envelope again, and letting go of it slides back to the
// note still held. A note on its own starts both envelopes. With more voices each note takes a
// voice, and Glide slides a voice from whatever it was last playing.
//
// Translated line for line into native/devices/own/analog.cc for the desktop, and held to it by
// native-device-parity.test.mjs. Everything is computed in double and written to the output once
// per voice per sample, as the C++ does.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { Adsr } from '../dsp/adsr.mjs';
import { BlepLine } from '../dsp/blep.mjs';
import { ANALOG_MODELS, ANALOG_MORPHING, AnalogFilter } from '../dsp/analog.mjs';
import { FILTER_MODES } from '../dsp/filters.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** The oscillator shapes, in the order the controls list them. */
export const ANALOG_SHAPES = Object.freeze(['saw', 'square', 'triangle', 'sine']);
const ANALOG_SAW = 0;
const ANALOG_SQUARE = 1;
const ANALOG_TRIANGLE = 2;

/** How far the Voices knob reaches, which is no most (see the Wavetable's VOICES_KNOB). */
export const ANALOG_VOICES_KNOB = 128;
/** The note Key Track turns on: at middle C the cutoff is the knob's. */
export const ANALOG_TRACK_NOTE = 60;
/** Drift at one: how far, in cents, an oscillator wanders either way. */
export const ANALOG_DRIFT_CENTS = 12;
/** How often the wander picks somewhere new to go, and how slowly it gets there. */
const ANALOG_DRIFT_STEP_SEC = 0.4;
const ANALOG_DRIFT_SMOOTH_SEC = 0.2;
/** The narrowest a pulse gets, as a share of the cycle, at either end of Width. */
const ANALOG_MIN_WIDTH = 0.02;
/** The highest an oscillator plays, as a share of the sample rate: past it, it is held there. */
const ANALOG_TOP = 0.45;
/** A voice's level against the controls, as the other synths'. */
const ANALOG_VOICE_GAIN = 0.5;
/** How close a glide gets, in semitones, before it lands. */
const ANALOG_GLIDE_LAND = 1e-6;
/** The most notes a monosynth remembers being held. */
const ANALOG_HELD = 64;
const ANALOG_TWO_PI = 2 * Math.PI;

const analogClamp01 = (x) => Math.min(1, Math.max(0, x));

/** The Filter Type options: the circuit models, in the Filter device's order. */
export const ANALOG_FILTER_TYPES = ANALOG_MODELS;

/** A filter type as the Filter device's mode of the same circuit, for the panel's picture. */
export function analogResponse(type) {
  const t = Math.min(ANALOG_MODELS.length - 1, Math.max(0, Math.round(type)));
  return FILTER_MODES.indexOf(ANALOG_MODELS[t]);
}

/** A filter type's index by name, for the presets. */
const ANALOG_TYPE = Object.freeze(Object.fromEntries(ANALOG_MODELS.map((name, i) => [name, i])));

// --- the descriptor ---------------------------------------------------------------------------

const ANALOG_OSC = 'Oscillators';
const ANALOG_MIXER = 'Mixer';
const ANALOG_FILTER_GROUP = 'Filter';
const ANALOG_FILTER_ENV = 'Filter Env';
const ANALOG_AMP_ENV = 'Amp Env';
const ANALOG_VOICE = 'Voice';

const analogSeconds = (id, name, def, group) => ({
  id, name, min: 0, max: 10, default: def, unit: 's', curve: 'pow', curveExp: 3, group,
});
const analogCurve = (id, name, group, description) => ({
  id, name, min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group, description,
});

const analogOscParams = (n) => [
  { id: `osc${n}.shape`, name: `Osc ${n} Shape`, default: 0, options: [...ANALOG_SHAPES], rate: 'k', group: ANALOG_OSC },
  { id: `osc${n}.width`, name: `Osc ${n} Width`, min: 0, max: 1, default: 0.5, group: ANALOG_OSC,
    active: { param: `osc${n}.shape`, is: 'square' },
    description: 'How much of each cycle the square is high: a half is square, toward either end a thinner pulse.' },
];

export const ANALOG = defineDevice({
  id: 'Analog',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-analog',
  description: 'Two drifting analog-style oscillators, a sub and noise into an analog filter circuit with its own envelope on every voice. One voice and a glide is an acid bass; more are pads, brass and strings.',
  channels: { in: 0, out: 2 },
  params: [
    ...analogOscParams(1),
    ...analogOscParams(2),
    { id: 'osc2.semi', name: 'Osc 2 Semi', min: -24, max: 24, default: 0, step: 1, unit: 'st', ui: 'number', group: ANALOG_OSC,
      description: 'Osc 2 against osc 1, in semitones.' },
    { id: 'osc2.detune', name: 'Osc 2 Detune', min: -100, max: 100, default: 7, unit: 'ct', group: ANALOG_OSC,
      description: 'Osc 2 against osc 1, in cents. A few is the beating of two oscillators side by side.' },
    { id: 'sync', name: 'Sync', min: 0, max: 1, default: 0, ui: 'toggle', rate: 'k', group: ANALOG_OSC,
      description: 'Restarts osc 2 at every cycle of osc 1, so its Semi moves the tone rather than the pitch.' },
    { id: 'drift', name: 'Drift', min: 0, max: 1, default: 0.2, group: ANALOG_OSC,
      description: 'How far each oscillator wanders out of tune on its own, slowly. At one, twelve cents either way.' },

    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.5, group: ANALOG_MIXER,
      description: 'Osc 1 against osc 2: all osc 1 at zero, all osc 2 at one.' },
    { id: 'sub', name: 'Sub', min: 0, max: 1, default: 0, group: ANALOG_MIXER,
      description: 'A square an octave below osc 1.' },
    { id: 'noise', name: 'Noise', min: 0, max: 1, default: 0, group: ANALOG_MIXER },

    { id: 'filter.type', name: 'Filter Type', default: 0, options: [...ANALOG_FILTER_TYPES], rate: 'k', group: ANALOG_FILTER_GROUP,
      description: 'The circuit each voice plays through, as the Filter device\'s modes of the same names.' },
    { id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, default: 1500, unit: 'Hz', curve: 'exp', group: ANALOG_FILTER_GROUP,
      description: 'Where the filter sits for middle C with the envelope closed.' },
    { id: 'resonance', name: 'Resonance', min: 0, max: 1, default: 0.2, group: ANALOG_FILTER_GROUP },
    { id: 'drive', name: 'Drive', min: 1, max: 8, default: 1, unit: 'x', group: ANALOG_FILTER_GROUP,
      description: 'Level into the circuit. Higher saturates its stages, and the resonance with them.' },
    { id: 'morph', name: 'Morph', min: 0, max: 1, default: 0, group: ANALOG_FILTER_GROUP,
      active: { param: 'filter.type', is: [...ANALOG_MORPHING] },
      description: 'The response of the two-pole circuits: lowpass, bandpass, highpass from left to right. On statevar the middle is a notch.' },
    { id: 'keytrack', name: 'Key Track', min: 0, max: 1, default: 0.5, group: ANALOG_FILTER_GROUP,
      description: 'How far the cutoff follows the note: at one it moves as far as the note does, from middle C.' },
    { id: 'envamount', name: 'Env Amount', min: -96, max: 96, default: 24, unit: 'st', group: ANALOG_FILTER_GROUP,
      description: 'How far the filter envelope moves the cutoff at its peak, up or down.' },
    { id: 'velocity', name: 'Velocity', min: 0, max: 1, default: 0.5, group: ANALOG_FILTER_GROUP,
      description: 'How much a note\'s velocity scales the filter envelope: at one a soft note barely opens it and a hard one opens it all the way.' },

    analogSeconds('fenv.attack', 'Filter Attack', 0.002, ANALOG_FILTER_ENV),
    analogSeconds('fenv.decay', 'Filter Decay', 0.3, ANALOG_FILTER_ENV),
    { id: 'fenv.sustain', name: 'Filter Sustain', min: 0, max: 1, default: 0.3, group: ANALOG_FILTER_ENV },
    analogSeconds('fenv.release', 'Filter Release', 0.2, ANALOG_FILTER_ENV),
    analogCurve('fenv.acurve', 'Filter Attack Curve', ANALOG_FILTER_ENV, 'Zero is a straight line; negative rises fast and levels off, positive holds back and then rushes.'),
    analogCurve('fenv.dcurve', 'Filter Decay Curve', ANALOG_FILTER_ENV, 'Zero is a straight line; negative falls fast and trails off.'),
    analogCurve('fenv.rcurve', 'Filter Release Curve', ANALOG_FILTER_ENV, 'Zero is a straight line; negative drops away quickly and then hangs.'),

    { ...analogSeconds('ampenv.attack', 'Amp Attack', 0.005, ANALOG_AMP_ENV), amp: 'attack' },
    { ...analogSeconds('ampenv.decay', 'Amp Decay', 0.1, ANALOG_AMP_ENV), amp: 'decay' },
    { id: 'ampenv.sustain', name: 'Amp Sustain', min: 0, max: 1, default: 0.8, group: ANALOG_AMP_ENV, amp: 'sustain' },
    { ...analogSeconds('ampenv.release', 'Amp Release', 0.15, ANALOG_AMP_ENV), amp: 'release' },
    analogCurve('env.acurve', 'Attack Curve', ANALOG_AMP_ENV, 'Zero is a straight line; negative rises fast and levels off, positive holds back and then rushes.'),
    analogCurve('env.dcurve', 'Decay Curve', ANALOG_AMP_ENV, 'Zero is a straight line; negative falls fast and trails off.'),
    analogCurve('env.rcurve', 'Release Curve', ANALOG_AMP_ENV, 'Zero is a straight line; negative drops away quickly and then hangs, positive holds the level and then cuts.'),

    { id: 'glide', name: 'Glide', min: 0, max: 5, default: 0, unit: 's', curve: 'pow', curveExp: 3, group: ANALOG_VOICE,
      description: 'How long a slide between notes takes. With one voice it slides between notes played over each other; with more, each voice slides from what it last played.' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.7, group: ANALOG_VOICE },
    { id: 'voices', name: 'Voices', min: 1, open: true, uiMax: ANALOG_VOICES_KNOB, default: 8, step: 1, rate: 'k', ui: 'number', group: ANALOG_VOICE,
      description: 'How many notes sound at once. At one it is a monosynth.' },
  ],
  figures: [
    {
      id: 'response',
      kind: 'response',
      group: ANALOG_FILTER_GROUP,
      title: 'response',
      description: 'The filter at Cutoff, Resonance and Morph, before the note and the envelope move it. Drag across for the cutoff, up for the resonance.',
      params: { mode: 'filter.type', cutoff: 'cutoff', resonance: 'resonance', drive: 'drive', morph: 'morph' },
      drag: { x: 'cutoff', y: 'resonance' },
    },
    {
      id: 'filterenv',
      kind: 'adsr',
      group: ANALOG_FILTER_ENV,
      title: 'envelope',
      description: 'The filter envelope, which Env Amount scales. Drag a point for its stage, the plateau for the sustain level.',
      params: {
        attack: 'fenv.attack', decay: 'fenv.decay', sustain: 'fenv.sustain', release: 'fenv.release',
        acurve: 'fenv.acurve', dcurve: 'fenv.dcurve', rcurve: 'fenv.rcurve',
      },
      subsumes: ['acurve', 'dcurve', 'rcurve'],
    },
    {
      id: 'ampenv',
      kind: 'adsr',
      group: ANALOG_AMP_ENV,
      title: 'envelope',
      description: 'The amplitude envelope. Drag a point for its stage, the plateau for the sustain level.',
      params: {
        attack: 'ampenv.attack', decay: 'ampenv.decay', sustain: 'ampenv.sustain', release: 'ampenv.release',
        acurve: 'env.acurve', dcurve: 'env.dcurve', rcurve: 'env.rcurve',
      },
      subsumes: ['acurve', 'dcurve', 'rcurve'],
    },
  ],
  panel: { rows: [[ANALOG_OSC, ANALOG_MIXER], [ANALOG_FILTER_GROUP], [ANALOG_FILTER_ENV, ANALOG_AMP_ENV], [ANALOG_VOICE]] },
  // Every one names Voices: a mono patch is one voice, and the next preset puts the voices back.
  presets: {
    acid: {
      'osc1.shape': 0, mix: 0, drift: 0.05, 'filter.type': ANALOG_TYPE.diode, cutoff: 220, resonance: 0.88, drive: 3.45,
      keytrack: 0.3, envamount: 52, velocity: 0.8,
      'fenv.attack': 0.001, 'fenv.decay': 0.16, 'fenv.sustain': 0, 'fenv.release': 0.08,
      'ampenv.attack': 0.002, 'ampenv.decay': 0.4, 'ampenv.sustain': 0.6, 'ampenv.release': 0.03,
      glide: 0.05, voices: 1,
    },
    bass: {
      'osc1.shape': 0, 'osc2.shape': 1, 'osc2.semi': -12, 'osc2.detune': 4, mix: 0.4, sub: 0.6, drift: 0.1,
      cutoff: 320, resonance: 0.3, drive: 3.8, keytrack: 0.4, envamount: 30, velocity: 0.4,
      'fenv.attack': 0.001, 'fenv.decay': 0.25, 'fenv.sustain': 0.15, 'fenv.release': 0.1,
      'ampenv.attack': 0.002, 'ampenv.decay': 0.3, 'ampenv.sustain': 0.85, 'ampenv.release': 0.06,
      voices: 1,
    },
    lead: {
      'osc1.shape': 0, 'osc2.shape': 1, 'osc2.width': 0.3, 'osc2.detune': 9, mix: 0.5, drift: 0.25,
      cutoff: 1800, resonance: 0.35, drive: 2.75, keytrack: 0.8, envamount: 18, velocity: 0.5,
      'fenv.attack': 0.01, 'fenv.decay': 0.5, 'fenv.sustain': 0.4, 'fenv.release': 0.3,
      'ampenv.attack': 0.005, 'ampenv.decay': 0.2, 'ampenv.sustain': 0.9, 'ampenv.release': 0.2,
      glide: 0.04, voices: 1,
    },
    pad: {
      'osc1.shape': 0, 'osc2.shape': 0, 'osc2.detune': 14, mix: 0.5, noise: 0.03, drift: 0.4, 'filter.type': ANALOG_TYPE.statevar,
      cutoff: 900, resonance: 0.15, keytrack: 0.5, envamount: 14, velocity: 0.2,
      'fenv.attack': 1.2, 'fenv.decay': 2, 'fenv.sustain': 0.5, 'fenv.release': 2,
      'ampenv.attack': 0.8, 'ampenv.decay': 1, 'ampenv.sustain': 0.9, 'ampenv.release': 2.5,
      voices: 8,
    },
    brass: {
      'osc1.shape': 0, 'osc2.shape': 0, 'osc2.detune': 6, mix: 0.5, drift: 0.2, 'filter.type': ANALOG_TYPE.ota,
      cutoff: 600, resonance: 0.1, drive: 1.6, keytrack: 0.7, envamount: 36, velocity: 0.6,
      'fenv.attack': 0.06, 'fenv.decay': 0.4, 'fenv.sustain': 0.45, 'fenv.release': 0.2,
      'ampenv.attack': 0.03, 'ampenv.decay': 0.2, 'ampenv.sustain': 0.85, 'ampenv.release': 0.2,
      voices: 8,
    },
    pluck: {
      'osc1.shape': 1, 'osc1.width': 0.35, 'osc2.shape': 0, 'osc2.semi': 12, 'osc2.detune': 3, mix: 0.3, drift: 0.1,
      cutoff: 400, resonance: 0.4, keytrack: 0.6, envamount: 40, velocity: 0.7,
      'fenv.attack': 0.001, 'fenv.decay': 0.18, 'fenv.sustain': 0, 'fenv.release': 0.18,
      'ampenv.attack': 0.001, 'ampenv.decay': 0.5, 'ampenv.sustain': 0, 'ampenv.release': 0.3,
      voices: 8,
    },
    sync: {
      'osc1.shape': 0, 'osc2.shape': 0, 'osc2.semi': 9, 'osc2.detune': 0, sync: 1, mix: 0.8, drift: 0.15,
      cutoff: 3000, resonance: 0.2, drive: 3.1, keytrack: 0.8, envamount: 12, velocity: 0.4,
      'fenv.attack': 0.005, 'fenv.decay': 0.6, 'fenv.sustain': 0.5, 'fenv.release': 0.3,
      'ampenv.attack': 0.003, 'ampenv.decay': 0.3, 'ampenv.sustain': 0.85, 'ampenv.release': 0.2,
      glide: 0.03, voices: 1,
    },
    strings: {
      'osc1.shape': 0, 'osc2.shape': 0, 'osc2.detune': 18, mix: 0.5, drift: 0.5, 'filter.type': ANALOG_TYPE.sallen,
      cutoff: 2400, resonance: 0.05, keytrack: 0.6, envamount: 6, velocity: 0.3,
      'fenv.attack': 0.4, 'fenv.decay': 1, 'fenv.sustain': 0.7, 'fenv.release': 1,
      'ampenv.attack': 0.35, 'ampenv.decay': 0.5, 'ampenv.sustain': 0.9, 'ampenv.release': 1.2,
      voices: 8,
    },
    keys: {
      'osc1.shape': 1, 'osc1.width': 0.5, 'osc2.shape': 2, 'osc2.semi': 12, mix: 0.35, drift: 0.15, 'filter.type': ANALOG_TYPE.statevar,
      cutoff: 1200, resonance: 0.1, keytrack: 0.8, envamount: 20, velocity: 0.6,
      'fenv.attack': 0.001, 'fenv.decay': 0.7, 'fenv.sustain': 0.2, 'fenv.release': 0.4,
      'ampenv.attack': 0.002, 'ampenv.decay': 1.2, 'ampenv.sustain': 0.4, 'ampenv.release': 0.4,
      voices: 8,
    },
    sub: {
      'osc1.shape': 2, 'osc2.shape': 3, 'osc2.semi': -12, 'osc2.detune': 0, mix: 0.5, sub: 0.3, drift: 0.05, 'filter.type': ANALOG_TYPE.statevar,
      cutoff: 400, resonance: 0, keytrack: 1, envamount: 6, velocity: 0.2,
      'fenv.attack': 0.001, 'fenv.decay': 0.2, 'fenv.sustain': 0.5, 'fenv.release': 0.1,
      'ampenv.attack': 0.004, 'ampenv.decay': 0.2, 'ampenv.sustain': 1, 'ampenv.release': 0.08,
      glide: 0.02, voices: 1,
    },
  },
});

// --- the voice --------------------------------------------------------------------------------

/**
 * One stream of xorshift32 with unsigned shifts throughout, the same sequence here and in C++
 * (on an unsigned int).
 */
class AnalogRandom {
  constructor() { this.state = 1; }
  seed(s) { this.state = (s >>> 0) || 1; }
  white() {
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x / 2147483648 - 1;
  }
}

/** A shape's value at a phase, 0..1, centered on zero. */
function analogWave(shape, p, w) {
  switch (shape) {
    case ANALOG_SAW: return 2 * p - 1;
    case ANALOG_SQUARE: return p < w ? 2 - 2 * w : -2 * w;
    case ANALOG_TRIANGLE: return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    default: return Math.sin(ANALOG_TWO_PI * p);
  }
}

/** A shape's analogSlope at a phase, per cycle. */
function analogSlope(shape, p) {
  switch (shape) {
    case ANALOG_SAW: return 2;
    case ANALOG_SQUARE: return 0;
    case ANALOG_TRIANGLE: return p < 0.5 ? 4 : -4;
    default: return ANALOG_TWO_PI * Math.cos(ANALOG_TWO_PI * p);
  }
}

/**
 * Moves an oscillator's phase from `from` to `to` (less than a cycle on), drawing every jump and
 * corner it passes into the line at `gain`, and returns where it ends, within the cycle. `agoEnd`
 * is how long before the coming sample the move ends; `dt` is the phase step a sample.
 */
function analogTravel(line, shape, w, gain, from, to, dt, agoEnd) {
  switch (shape) {
    case ANALOG_SAW:
      if (to >= 1) {
        to -= 1;
        line.jump(agoEnd + to / dt, -2 * gain);
      }
      return to;
    case ANALOG_SQUARE:
      if (from < w && to >= w) line.jump(agoEnd + (to - w) / dt, -2 * gain);
      if (to >= 1) {
        to -= 1;
        line.jump(agoEnd + to / dt, 2 * gain);
        if (to >= w) line.jump(agoEnd + (to - w) / dt, -2 * gain);
      }
      return to;
    case ANALOG_TRIANGLE:
      if (from < 0.5 && to >= 0.5) line.kink(agoEnd + (to - 0.5) / dt, -8 * dt * gain);
      if (to >= 1) {
        to -= 1;
        line.kink(agoEnd + to / dt, 8 * dt * gain);
        if (to >= 0.5) line.kink(agoEnd + (to - 0.5) / dt, -8 * dt * gain);
      }
      return to;
    default:
      return to >= 1 ? to - 1 : to;
  }
}

class AnalogVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.line = new BlepLine();
    this.filter = new AnalogFilter(sampleRate);
    this.ampEnv = new Adsr(sampleRate);
    this.filterEnv = new Adsr(sampleRate);
    this.random = new AnalogRandom();
    this.noise = new AnalogRandom();
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.releasing = false;
    this.holds = 0;
    this.target = 60;    // the note the pitch is going to, and where it is (both in semitones)
    this.pitch = 60;
    this.phase1 = 0;
    this.phase2 = 0;
    this.sub = 1;
    this.drift1 = 0;
    this.drift2 = 0;
    this.drift1To = 0;
    this.drift2To = 0;
    this.driftLeft = 0;
  }

  get active() { return this.ampEnv.active; }

  /**
   * Starts a note, sliding from `glideFrom` (a note) when there is one. A voice that had finished
   * starts clean - its oscillators at phases the seed picks - and one still sounding carries on
   * from where it is, so a steal does not click.
   */
  noteOn(note, velocity, seed, glideFrom) {
    if (!this.ampEnv.active) {
      this.line.reset();
      this.filter.reset();
      this.random.seed(seed);
      this.noise.seed(seed ^ 0x9e3779b9);
      this.phase1 = (this.random.white() + 1) * 0.5;
      this.phase2 = (this.random.white() + 1) * 0.5;
      this.sub = 1;
      this.drift1 = this.random.white();
      this.drift2 = this.random.white();
      this.drift1To = this.drift1;
      this.drift2To = this.drift2;
      this.driftLeft = 0;
    }
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.target = note;
    this.pitch = glideFrom !== null ? glideFrom : note;
    this.ampEnv.gateOn(true);
    this.filterEnv.gateOn(true);
  }

  /** A monosynth's legato: the pitch goes to `note` and the envelopes carry on. */
  slide(note) {
    this.note = note;
    this.target = note;
  }

  noteOff() {
    this.releasing = true;
    this.ampEnv.gateOff();
    this.filterEnv.gateOff();
  }

  /** Renders `count` samples of this voice, `offset` into the block, adding into the output. */
  process(outL, outR, count, offset, s) {
    const p = s.values;
    const sr = this.sampleRate;
    const filter = this.filter;
    filter.setModel(s.type);
    const line = this.line;
    const shape1 = s.shape1;
    const shape2 = s.shape2;
    const sync = s.sync;
    const glideK = s.glideK;
    const driftK = s.driftK;
    const velocity = this.velocity;
    this.ampEnv.setStages(s.attack, s.decay, s.sustain, s.release, s.acurve, s.dcurve, s.rcurve);
    this.filterEnv.setStages(s.fattack, s.fdecay, s.fsustain, s.frelease, s.facurve, s.fdcurve, s.frcurve);
    let y = 0;

    for (let i = 0; i < count; i++) {
      const j = offset + i;
      if (this.pitch !== this.target) {
        this.pitch += (this.target - this.pitch) * glideK;
        if (Math.abs(this.target - this.pitch) < ANALOG_GLIDE_LAND) this.pitch = this.target;
      }
      const note = this.pitch + s.bendAt(j);

      // The wander: somewhere new every so often, reached slowly.
      if (--this.driftLeft <= 0) {
        this.driftLeft = s.driftStep;
        this.drift1To = this.random.white();
        this.drift2To = this.random.white();
      }
      this.drift1 += (this.drift1To - this.drift1) * driftK;
      this.drift2 += (this.drift2To - this.drift2) * driftK;
      const wander = (at(p.drift, j) * ANALOG_DRIFT_CENTS) / 100;
      const dt1 = Math.min(ANALOG_TOP, midiToHz(note + wander * this.drift1) / sr);
      const tune2 = at(p['osc2.semi'], j) + at(p['osc2.detune'], j) / 100;
      const dt2 = Math.min(ANALOG_TOP, midiToHz(note + tune2 + wander * this.drift2) / sr);
      const w1 = Math.min(1 - ANALOG_MIN_WIDTH, Math.max(ANALOG_MIN_WIDTH, at(p['osc1.width'], j)));
      const w2 = Math.min(1 - ANALOG_MIN_WIDTH, Math.max(ANALOG_MIN_WIDTH, at(p['osc2.width'], j)));
      const mix = analogClamp01(at(p.mix, j));
      const g1 = 1 - mix;
      const g2 = mix;
      const gs = at(p.sub, j);

      // Osc 1, then the sub it flips, then osc 2 - restarted where osc 1 came round, if synced.
      const to1 = this.phase1 + dt1;
      const wrapped = to1 >= 1;
      const ago1 = wrapped ? (to1 - 1) / dt1 : 0;
      this.phase1 = analogTravel(line, shape1, w1, g1, this.phase1, to1, dt1, 0);
      if (wrapped) {
        line.jump(ago1, -2 * this.sub * gs);
        this.sub = -this.sub;
      }
      if (sync && wrapped) {
        const end = analogTravel(line, shape2, w2, g2, this.phase2, this.phase2 + dt2 * (1 - ago1), dt2, ago1);
        line.jump(ago1, g2 * (analogWave(shape2, 0, w2) - analogWave(shape2, end, w2)));
        const bend = analogSlope(shape2, 0) - analogSlope(shape2, end);
        if (bend !== 0) line.kink(ago1, g2 * bend * dt2);
        this.phase2 = analogTravel(line, shape2, w2, g2, 0, dt2 * ago1, dt2, 0);
      } else {
        this.phase2 = analogTravel(line, shape2, w2, g2, this.phase2, this.phase2 + dt2, dt2, 0);
      }
      const plain = g1 * analogWave(shape1, this.phase1, w1) + g2 * analogWave(shape2, this.phase2, w2)
        + gs * this.sub + at(p.noise, j) * this.noise.white();
      const x = line.push(plain);

      // The filter: the knob, moved by the note and by the envelope as hard as the note was played.
      const fenv = this.filterEnv.next();
      const v = at(p.velocity, j);
      const amount = at(p.envamount, j) * (1 - v + v * velocity);
      const semis = at(p.keytrack, j) * (note - ANALOG_TRACK_NOTE) + amount * fenv;
      filter.setResonance(at(p.resonance, j));
      filter.setDrive(at(p.drive, j));
      filter.setMorph(at(p.morph, j));
      filter.setCutoff(at(p.cutoff, j) * Math.pow(2, semis / 12));
      y = filter.process(x);

      const out = y * this.ampEnv.next() * velocity * at(p.level, j) * ANALOG_VOICE_GAIN;
      outL[i] += out;
      outR[i] += out;
    }

    if (!Number.isFinite(y)) {
      this.line.reset();
      filter.reset();
    }
  }
}

// --- the synth --------------------------------------------------------------------------------

/** A control's value at the end of the block: a number, or the last of a block of values. */
const analogEndOf = (v) => (typeof v === 'number' ? v : v[v.length - 1]);

export class AnalogSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.voices = Array.from({ length: 16 }, () => new AnalogVoice(sampleRate)); // as the Wavetable's
    this.voiceCount = 8;
    this.clock = 0;
    this.seed = 1;
    this.events = [];
    this.held = [];   // a monosynth's held notes, oldest first
    this.bend = 0;
    this.bendArray = null;
    this.state = {
      values: Object.fromEntries(ANALOG.params.map((p) => [p.id, p.default])),
      bendAt: (i) => (this.bendArray ? this.bendArray[i] : this.bend),
      shape1: 0, shape2: 0, sync: false, type: 0,
      glideK: 1,
      driftK: 1 - Math.exp(-1 / (ANALOG_DRIFT_SMOOTH_SEC * sampleRate)),
      driftStep: Math.round(ANALOG_DRIFT_STEP_SEC * sampleRate),
      attack: 0.005, decay: 0.1, sustain: 0.8, release: 0.15, acurve: -4, dcurve: -4, rcurve: -4,
      fattack: 0.002, fdecay: 0.3, fsustain: 0.3, frelease: 0.2, facurve: -4, fdcurve: -4, frcurve: -4,
    };
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.state.values;
    for (const p of ANALOG.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s[p.id] = v;
    }
    const count = analogEndOf(s.voices);
    if (Number.isFinite(count)) {
      const next = Math.max(1, Math.round(count));
      // Into or out of mono: what a monosynth remembers being held is its own.
      if ((next === 1) !== (this.voiceCount === 1)) this.held.length = 0;
      this.voiceCount = next;
    }
    while (this.voices.length < this.voiceCount) this.voices.push(new AnalogVoice(this.sampleRate));
  }

  /** The track's bend in semitones: a number while it is still, a block of values while it moves. */
  setBend(bend) {
    if (typeof bend === 'number') {
      this.bend = Number.isFinite(bend) ? bend : 0;
      this.bendArray = null;
    } else {
      this.bend = bend[0];
      this.bendArray = bend;
    }
  }

  queueNoteOn(note, velocity, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity }); }
  queueNoteOff(note, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 0, note, velocity: 0 }); }

  allNotesOff() {
    this.events.length = 0;
    this.held.length = 0;
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
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    if (this.voiceCount === 1) {
      const voice = this.voices[0];
      const legato = this.held.length > 0 && voice.active && !voice.releasing;
      if (this.held.length >= ANALOG_HELD) this.held.shift();
      this.held.push(note);
      // One hold on the voice, so the note's off still ends it if Voices goes up before it comes.
      voice.holds = 1;
      if (legato) {
        voice.slide(note);
        return;
      }
      voice.age = this.clock++;
      voice.noteOn(note, velocity, this.seed, null);
      return;
    }
    const voice = this.allocate(note);
    // Glide slides from whatever this voice was last playing.
    const from = this.state.glideK < 1 && voice.active ? voice.pitch : null;
    const holds = voice.active && voice.note === note && !voice.releasing ? voice.holds + 1 : 1;
    voice.age = this.clock++;
    voice.noteOn(note, velocity, this.seed, from);
    voice.holds = holds;
  }

  stopNote(note) {
    if (this.voiceCount === 1) {
      const held = this.held;
      const k = held.lastIndexOf(note);
      // Not one the monosynth took: a note started while there were more voices, still sounding
      // on one of them. It ends the way it would have.
      if (k < 0) { this._release(note); return; }
      held.splice(k, 1);
      const voice = this.voices[0];
      if (!voice.active || voice.releasing) return;
      if (held.length === 0) { voice.noteOff(); return; }
      // Back to the note still held, as a monosynth does.
      const top = held[held.length - 1];
      if (top !== voice.note) voice.slide(top);
      return;
    }
    this._release(note);
  }

  /** Releases every voice sounding `note`, but for a pitch held twice, whose last off ends it. */
  _release(note) {
    for (const v of this.voices) {
      if (!(v.active && v.note === note && !v.releasing)) continue;
      if (--v.holds > 0) continue; // an earlier note on this pitch ending: a later one still holds it
      v.holds = 0;
      v.noteOff();
    }
  }

  /** What every voice reads once a block: the switches and the envelopes, where the block ends. */
  _prepare() {
    const s = this.state;
    const v = s.values;
    const last = ANALOG_SHAPES.length - 1;
    s.shape1 = Math.min(last, Math.max(0, Math.round(analogEndOf(v['osc1.shape']))));
    s.shape2 = Math.min(last, Math.max(0, Math.round(analogEndOf(v['osc2.shape']))));
    s.sync = analogEndOf(v.sync) >= 0.5;
    s.type = Math.min(ANALOG_MODELS.length - 1, Math.max(0, Math.round(analogEndOf(v['filter.type']))));
    const glide = analogEndOf(v.glide);
    s.glideK = glide > 0 ? 1 - Math.exp(-1 / (glide * this.sampleRate)) : 1;
    s.attack = analogEndOf(v['ampenv.attack']);
    s.decay = analogEndOf(v['ampenv.decay']);
    s.sustain = analogEndOf(v['ampenv.sustain']);
    s.release = analogEndOf(v['ampenv.release']);
    s.acurve = analogEndOf(v['env.acurve']);
    s.dcurve = analogEndOf(v['env.dcurve']);
    s.rcurve = analogEndOf(v['env.rcurve']);
    s.fattack = analogEndOf(v['fenv.attack']);
    s.fdecay = analogEndOf(v['fenv.decay']);
    s.fsustain = analogEndOf(v['fenv.sustain']);
    s.frelease = analogEndOf(v['fenv.release']);
    s.facurve = analogEndOf(v['fenv.acurve']);
    s.fdcurve = analogEndOf(v['fenv.dcurve']);
    s.frcurve = analogEndOf(v['fenv.rcurve']);
  }

  /** Renders one block, split wherever a queued note edge falls. */
  process(outL, outR, count) {
    this._prepare();
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);
    let at0 = 0;
    let next = 0;
    while (at0 < count) {
      while (next < events.length && events[next].at <= at0) {
        const e = events[next++];
        if (e.kind === 1) this.startNote(e.note, e.velocity); else this.stopNote(e.note);
      }
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at0;
      if (n > 0) {
        const l = at0 === 0 && n === outL.length ? outL : outL.subarray(at0, at0 + n);
        const r = at0 === 0 && n === outR.length ? outR : outR.subarray(at0, at0 + n);
        for (const v of this.voices) if (v.active) v.process(l, r, n, at0, this.state);
      }
      at0 = until;
    }
    if (next >= events.length) events.length = 0;
    else this.events = events.slice(next).map((e) => ({ ...e, at: Math.max(0, e.at - count) }));
  }
}
