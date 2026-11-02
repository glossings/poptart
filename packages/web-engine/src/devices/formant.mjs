// The Formant synth: an oscillator whose spectral peak is set apart from its pitch, in two ways.
//
// VOSIM (Kaegi and Tempelaars, 1978). Every pitch period starts a train of sin² pulses, each one
// period of a raised cosine at the formant frequency, each `decay` times as loud as the one
// before, followed by silence until the next period. The pulse width fixes a peak in the spectrum
// wherever the note is, which is what makes it sound like a voice; the count and the decay set
// how narrow that peak is. A train is as many pulses as fit in the period, up to the count, so a
// high note plays fewer of them. When not even one fits - the formant below the pitch - the one
// pulse plays whole and the periods it covers pass without starting another: the note drops to a
// whole fraction of its pitch, an undertone, rather than cutting a pulse short.
//
// FORMANT_SQUARE. A core oscillator at the note's pitch fires an impulse on every cycle: a rise and a fall
// from the bottom of the range to the top and back, then a rest at the bottom until the next one.
// The impulse lasts one period of the formant frequency whatever the pitch, so again the peak
// stays put while the note moves. `shape` splits that time between the rise and the fall - a
// ramp up and a drop at none, a triangle in the middle, a jump and a ramp down at one. While an
// impulse is rising, or falling but not yet near the bottom, a new cycle is ignored; near the
// bottom of the fall it turns the impulse round to rise again from where it is. So an impulse
// longer than the period plays undertones - a half, a third of the pitch - and the stretch where
// the turn-rounds land is rougher and multiphonic. `air` drives the impulse into a sine-shaped
// curve: clean at zero, a sine out of a triangle around the middle, squarer above.
//
// `track` makes the formant follow the note: at one the formant is the knob's frequency at
// middle C and moves with the pitch, so the waveform keeps its shape up and down the keyboard.
//
// BAND-LIMITED. Each voice runs at four times the sample rate, and the sum of the voices comes
// down through two half-band stages. The square impulse's corners are corrected with a two-point
// polynomial band-limited ramp at that rate, and every corner lands at its own fraction of a
// sample, so a sharp impulse on a high note does not fold back. The sin² pulses are smooth enough
// as they are. Each voice has its own DC blocker, started at the waveform's own average so a note
// does not thump in.
//
// Translated line for line into native/devices/own/formant.cc for the desktop, and held to it by
// native-device-parity.test.mjs.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { Adsr } from '../dsp/adsr.mjs';
import { Stage2x } from '../dsp/oversample.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** The modes, in the order the control lists them. */
export const FORMANT_MODES = Object.freeze(['vosim', 'square']);
const FORMANT_SQUARE = 1;

/** How far the Voices knob reaches, which is no most (see the Wavetable's VOICES_KNOB). */
export const FORMANT_VOICES_KNOB = 128;

/** The rate each voice runs at, as a multiple of the sample rate. */
const FORMANT_OVER = 4;

/** The most pulses a VOSIM train has. */
const FORMANT_MAX_COUNT = 16;

/** Where a falling impulse starts to take a new cycle, as a share of its height. */
const FORMANT_RECEPTIVE = 0.2;

/** The DC blocker's corner. */
const FORMANT_DC_HZ = 10;

/** How long the drive takes to reach a new setting, so a stepped value does not click. */
const FORMANT_AIR_SEC = 0.005;

/** The note the formant is the knob's frequency at when it tracks: middle C. */
const FORMANT_TRACK_NOTE = 60;

/** The highest formant, as a share of the sample rate: a pulse is never shorter than two of a voice's samples. */
const FORMANT_TOP = 0.45;

const formantSeconds = (id, name, def) => ({
  id, name, min: 0, max: 10, default: def, unit: 's', curve: 'pow', curveExp: 3, group: 'Amp Env',
});

const VOSIM_ONLY = { param: 'mode', is: 'vosim' };
const SQUARE_ONLY = { param: 'mode', is: 'square' };

/** Starting points for the preset menu: each the defaults with these controls changed. */
export const FORMANT_PRESETS = Object.freeze({
  vowelpad: { formant: 900, count: 6, decay: 0.85, 'ampenv.attack': 0.7, 'ampenv.sustain': 1, 'ampenv.release': 1.5 },
  talker: { formant: 1400, count: 3, decay: 0.7, track: 0.3, 'ampenv.attack': 0.01, 'ampenv.sustain': 1, 'ampenv.release': 0.12, glide: 0.08 },
  buzzbass: { mode: 1, formant: 320, shape: 0.15, air: 0.7, track: 0.5, 'ampenv.attack': 0.003, 'ampenv.decay': 0.3, 'ampenv.sustain': 0.7, 'ampenv.release': 0.08 },
  choir: { formant: 420, count: 10, decay: 0.92, 'ampenv.attack': 0.45, 'ampenv.sustain': 1, 'ampenv.release': 1.2 },
  whistle: { formant: 270, track: 1, count: 1, 'ampenv.attack': 0.06, 'ampenv.sustain': 1, 'ampenv.release': 0.2, glide: 0.05 },
  growl: { mode: 1, formant: 140, shape: 0.85, air: 1, 'ampenv.attack': 0.01, 'ampenv.sustain': 1 },
  reed: { mode: 1, formant: 2400, air: 0.15, track: 0.2, 'ampenv.attack': 0.03, 'ampenv.sustain': 1 },
  ping: { formant: 3200, count: 14, decay: 0.95, track: 0.5, 'ampenv.decay': 0.35, 'ampenv.sustain': 0, 'ampenv.release': 0.3 },
});

export const FORMANT = defineDevice({
  id: 'Formant',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-formant',
  description: 'A formant oscillator: a spectral peak that stays put while the pitch moves. VOSIM plays a train of sin² pulses each period; square fires an impulse of fixed length on every cycle of a core oscillator, and drives it.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'mode', name: 'Mode', default: 0, options: [...FORMANT_MODES], rate: 'k', group: 'Formant',
      description: 'VOSIM is a train of pulses each period, then silence. Square is one impulse per cycle, shaped and driven.' },
    { id: 'formant', name: 'Formant', min: 20, max: 12000, default: 800, unit: 'Hz', curve: 'exp', group: 'Formant',
      description: 'Where the peak in the spectrum sits: the width of a pulse, or the length of an impulse, as a frequency. Below the pitch, the note drops to an undertone.' },
    { id: 'track', name: 'Track', min: 0, max: 1, default: 0, group: 'Formant',
      description: 'How far the formant follows the note. At one it is the knob\'s frequency at middle C and moves with the pitch.' },
    { id: 'count', name: 'Count', min: 1, max: FORMANT_MAX_COUNT, default: 4, step: 1, ui: 'number', group: 'Formant', active: VOSIM_ONLY,
      description: 'Pulses in each period, as many as fit. More is a narrower peak.' },
    { id: 'decay', name: 'Decay', min: 0, max: 1, default: 0.8, group: 'Formant', active: VOSIM_ONLY,
      description: 'Each pulse\'s level against the one before. Lower is a wider peak.' },
    { id: 'shape', name: 'Shape', min: 0, max: 1, default: 0.5, group: 'Formant', active: SQUARE_ONLY,
      description: 'The impulse\'s rise against its fall. Zero ramps up and drops, the middle is a triangle, one jumps up and ramps down.' },
    { id: 'air', name: 'Air', min: 0, max: 1, default: 0.3, group: 'Formant', active: SQUARE_ONLY,
      description: 'Drive into a sine-shaped curve: clean at zero, rounder toward the middle, squarer at one.' },

    { ...formantSeconds('ampenv.attack', 'Amp Attack', 0.005), amp: 'attack' },
    { ...formantSeconds('ampenv.decay', 'Amp Decay', 0.1), amp: 'decay' },
    { id: 'ampenv.sustain', name: 'Amp Sustain', min: 0, max: 1, default: 0.8, group: 'Amp Env', amp: 'sustain' },
    { ...formantSeconds('ampenv.release', 'Amp Release', 0.15), amp: 'release' },
    { id: 'env.acurve', name: 'Attack Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative rises fast and levels off, positive holds back and then rushes.' },
    { id: 'env.dcurve', name: 'Decay Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative falls fast and trails off.' },
    { id: 'env.rcurve', name: 'Release Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative drops away quickly and then hangs, positive holds the level and then cuts.' },

    { id: 'glide', name: 'Glide', min: 0, max: 5, default: 0, unit: 's', curve: 'pow', curveExp: 3, group: 'Voice' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.5, group: 'Voice' },
    { id: 'voices', name: 'Voices', min: 1, open: true, uiMax: FORMANT_VOICES_KNOB, legacyMax: 16, default: 8, step: 1, rate: 'k', ui: 'number', group: 'Voice' },
  ],
  figures: [
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
  presets: FORMANT_PRESETS,
});

/** The formant in Hz for a pitch: the knob, moved with the note as far as `track` says, kept under the top. */
function formantHz(knob, track, pitchHz, sampleRate) {
  const hz = knob * Math.pow(pitchHz / midiToHz(FORMANT_TRACK_NOTE), track);
  return Math.min(FORMANT_TOP * sampleRate, Math.max(1, hz));
}

/** How many pulses a VOSIM train has at these settings, and whether one alone outlasts the period. */
function pulsesFor(count, formant, pitch) {
  const fit = Math.floor(formant / pitch);
  if (fit < 1) return 0;
  const want = Math.min(FORMANT_MAX_COUNT, Math.max(1, Math.round(count)));
  return fit < want ? fit : want;
}

/** The air control's drive into the curve. */
const airDrive = (air) => 0.1 * Math.pow(30, air);

/** The curve: a sine across -1..1, flat beyond. */
const airCurve = (v) => Math.sin(Math.PI * 0.5 * Math.min(1, Math.max(-1, v)));

/** The curve's integral, zero at both ends of the sine. */
function airCurveIntegral(v) {
  if (v > 1) return v - 1;
  if (v < -1) return -v - 1;
  return -Math.cos(Math.PI * 0.5 * v) / (Math.PI * 0.5);
}

/** Below this step between two samples the curve's integral says nothing the curve does not. */
const FORMANT_SLOPE_EPSILON = 1e-6;

class FormantVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.env = new Adsr(sampleRate);
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.releasing = false;
    this.holds = 0;
    this.targetHz = 440;
    this.currentHz = 440;
    this.reset();
  }

  reset() {
    this.phase = 0;
    // VOSIM: where the sounding pulse is, which of the train it is, how many the train has and
    // how loud this one is; whether a period started while it sounded; whether it outlasts one.
    this.pulse = 0;
    this.pulsing = false;
    this.index = 0;
    this.pulses = 0;
    this.amp = 1;
    this.pending = false;
    this.under = false;
    // Square: the impulse's height (0..1) and stage (0 rest, 1 rise, 2 fall), and the sample
    // before this one with its corrections, which is the one that goes out.
    this.u = 0;
    this.stage = 0;
    this.out = 0;
    this.air = 0;
    // The last input to the curve and its integral there.
    this.v = -1;
    this.vInt = 0;
    this.dcIn = 0;
    this.dcOut = 0;
  }

  get active() { return this.env.active; }

  noteOn(note, velocity, s, offset, glideFrom) {
    const fresh = !this.env.active;
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.targetHz = midiToHz(note);
    this.currentHz = glideFrom >= 0 && s.glide > 0 ? glideFrom : this.targetHz;
    if (fresh) {
      this.reset();
      // A full phase, so the first period starts on the note's own sample.
      this.phase = 1;
      const p = s.values;
      const pitch = this.currentHz * Math.pow(2, s.bendAt(offset) / 12);
      const formant = formantHz(at(p.formant, offset), at(p.track, offset), pitch, this.sampleRate);
      this.air = at(p.air, offset);
      // The curve starts where the impulse rests.
      this.v = -airDrive(this.air);
      this.vInt = airCurveIntegral(this.v);
      // The DC blocker starts where the waveform's average is, rather than at zero.
      if (s.mode === FORMANT_SQUARE) {
        const length = pitch / formant;
        const covers = length > 1 ? Math.ceil(length) : 1;
        this.dcIn = -0.5 * (1 - length / covers);
      } else {
        const n = pulsesFor(at(p.count, offset), formant, pitch);
        const b = at(p.decay, offset);
        let sum = 0;
        let g = 1;
        for (let k = 0; k < (n < 1 ? 1 : n); k++) { sum += g; g *= b; }
        const length = pitch / formant;
        const covers = n < 1 ? Math.ceil(length) : 1;
        this.dcIn = (0.5 * sum * length) / covers;
      }
      this.dcOut = 0;
    }
    // A voice taken while it is still sounding keeps its envelope's level and its waveform.
    this.env.gateOn(true);
  }

  noteOff() {
    this.releasing = true;
    this.env.gateOff();
  }

  /** Starts a VOSIM train, the first pulse already `start` of the way through. */
  _train(start, count, formant, pitch) {
    const n = pulsesFor(count, formant, pitch);
    this.under = n < 1;
    this.pulses = n < 1 ? 1 : n;
    this.index = 0;
    this.amp = 1;
    this.pulse = start;
    this.pulsing = true;
    this.pending = false;
  }

  /** One of the voice's samples of VOSIM, at the voice's rate. */
  _vosim(inc, pinc, count, decay, formant, pitch) {
    if (this.pulsing) {
      this.pulse += pinc;
      if (this.pulse >= 1) {
        this.pulse -= 1;
        if (this.pending) this._train(this.pulse, count, formant, pitch);
        else if (++this.index < this.pulses) this.amp *= decay;
        else this.pulsing = false;
      }
    }
    this.phase += inc;
    if (this.phase >= 1) {
      this.phase -= 1;
      // A new period: a train now, from the moment it began; or after the pulse still sounding.
      if (!this.pulsing) this._train((this.phase / inc) * pinc, count, formant, pitch);
      else if (!this.under) this.pending = true;
    }
    if (!this.pulsing) return 0;
    const s = Math.sin(Math.PI * this.pulse);
    return this.amp * s * s;
  }

  /**
   * One of the voice's samples of the square mode's impulse, at the voice's rate, returned one
   * sample late with its corners band-limited. `rise` and `fall` are the slopes, in height per
   * sample.
   */
  _square(inc, rise, fall) {
    const before = this.phase;
    this.phase += inc;
    let trigger = -1;
    if (this.phase >= 1) {
      this.phase -= 1;
      trigger = (1 - before) / inc;
      if (trigger > 1) trigger = 1;
    }
    // Walk the sample's span, corner by corner. `t` is how far through it the walk is.
    let t = 0;
    let u = this.u;
    let next = 0;
    for (let guard = 0; guard < 8; guard++) {
      const slope = this.stage === 1 ? rise : this.stage === 2 ? -fall : 0;
      // When the stage would end by itself, from here.
      let end = 2;
      if (this.stage === 1) end = t + (1 - u) / rise;
      else if (this.stage === 2) end = t + u / fall;
      const fires = trigger >= t ? trigger : 2;
      if (end > 1 && fires > 1) { u += slope * (1 - t); break; }
      let change;
      if (fires <= end) {
        u += slope * (fires - t);
        t = fires;
        trigger = -1;
        // A new cycle starts a rest or a late fall rising; anything else ignores it.
        if (this.stage === 0 || (this.stage === 2 && u <= FORMANT_RECEPTIVE)) {
          this.stage = 1;
          change = rise - slope;
        } else {
          continue;
        }
      } else {
        t = end;
        if (this.stage === 1) { u = 1; this.stage = 2; change = -fall - rise; } else { u = 0; this.stage = 0; change = fall; }
      }
      // The corner's two-point band-limited ramp: on this sample's predecessor, and on it.
      const a = 1 - t;
      this.out += (change * a * a * a) / 6;
      next += (change * t * t * t) / 6;
    }
    this.u = u;
    const value = this.out;
    this.out = u + next;
    return value;
  }

  /** Renders `count` samples at the voice's rate into `buf`, enveloped, added to what is there. */
  process(buf, count, offset, s) {
    const sr = this.sampleRate;
    const p = s.values;
    this.env.setStages(at(p['ampenv.attack'], offset), at(p['ampenv.decay'], offset), at(p['ampenv.sustain'], offset),
      at(p['ampenv.release'], offset), s.acurve, s.dcurve, s.rcurve);
    const square = s.mode === FORMANT_SQUARE;
    const fast = sr * FORMANT_OVER;
    const glideK = s.glide > 0 ? 1 - Math.exp(-1 / (sr * s.glide)) : 1;
    const dcR = 1 - (2 * Math.PI * FORMANT_DC_HZ) / fast;
    const airK = 1 - Math.exp(-1 / (FORMANT_AIR_SEC * sr));
    const pitchMoving = s.bendArray !== null || this.currentHz !== this.targetHz;
    let pitch = this.currentHz * Math.pow(2, s.bendAt(offset) / 12);
    for (let i = 0; i < count; i++) {
      const j = offset + i;
      if (this.currentHz !== this.targetHz) {
        this.currentHz += (this.targetHz - this.currentHz) * glideK;
        if (Math.abs(this.currentHz - this.targetHz) < 0.01) this.currentHz = this.targetHz;
      }
      if (pitchMoving) pitch = this.currentHz * Math.pow(2, s.bendAt(j) / 12);
      const formant = formantHz(at(p.formant, j), at(p.track, j), pitch, sr);
      const inc = pitch / fast;
      const gain = this.env.next() * this.velocity * at(p.level, j);
      let rise = 0;
      let fall = 0;
      let drive = 0;
      let norm = 1;
      const pinc = formant / fast;
      if (square) {
        const length = fast / formant;
        const share = 1 - Math.min(1, Math.max(0, at(p.shape, j)));
        rise = 1 / Math.max(1, share * length);
        fall = 1 / Math.max(1, (1 - share) * length);
        this.air += (at(p.air, j) - this.air) * airK;
        drive = airDrive(this.air);
        // Half: the impulse spans twice the height of a VOSIM pulse.
        norm = 0.5 / Math.sin(Math.PI * 0.5 * Math.min(1, drive));
      }
      const count0 = at(p.count, j);
      const decay = Math.min(1, Math.max(0, at(p.decay, j)));
      for (let k = 0; k < FORMANT_OVER; k++) {
        let x;
        if (square) {
          // The curve read through its integral, the average over the step between two samples
          // rather than the value at one, which keeps the edges a high drive makes from folding.
          const v = drive * (2 * this._square(inc, rise, fall) - 1);
          const vInt = airCurveIntegral(v);
          const dv = v - this.v;
          x = (Math.abs(dv) > FORMANT_SLOPE_EPSILON ? (vInt - this.vInt) / dv : airCurve(0.5 * (v + this.v))) * norm;
          this.v = v;
          this.vInt = vInt;
        } else {
          x = this._vosim(inc, pinc, count0, decay, formant, pitch);
        }
        const d = x - this.dcIn + dcR * this.dcOut;
        this.dcIn = x;
        this.dcOut = d;
        buf[i * FORMANT_OVER + k] += d * gain;
      }
    }
    if (!Number.isFinite(this.dcOut + this.out)) this.reset();
  }
}

export class FormantSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.voices = Array.from({ length: 16 }, () => new FormantVoice(sampleRate)); // as the Wavetable's
    this.voiceCount = 8;
    this.clock = 0;
    this.events = [];
    this.bend = 0;
    this.bendArray = null;
    this.fast = new Float64Array(128 * FORMANT_OVER);
    this.half = new Float64Array(128 * 2);
    this.down = new Float64Array(128);
    this.stageA = new Stage2x();
    this.stageB = new Stage2x();
    this.state = {
      values: Object.fromEntries(FORMANT.params.map((p) => [p.id, p.default])),
      mode: 0,
      glide: 0,
      acurve: -4,
      dcurve: -4,
      rcurve: -4,
      bendArray: null,
      bendAt: (i) => (this.bendArray ? this.bendArray[i] : this.bend),
    };
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.state;
    for (const p of FORMANT.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s.values[p.id] = v;
    }
    const first = (id, fallback) => {
      const v = s.values[id];
      return v === undefined ? fallback : at(v, 0);
    };
    s.mode = Math.min(FORMANT_MODES.length - 1, Math.max(0, Math.round(first('mode', 0))));
    s.glide = first('glide', 0);
    s.acurve = first('env.acurve', -4);
    s.dcurve = first('env.dcurve', -4);
    s.rcurve = first('env.rcurve', -4);
    const count = first('voices', 8);
    if (Number.isFinite(count)) this.voiceCount = Math.max(1, Math.round(count));
    // The voices are made as the count asks for them - there is no most.
    while (this.voices.length < this.voiceCount) this.voices.push(new FormantVoice(this.sampleRate));
  }

  /** The track's bend in semitones. */
  setBend(bend) {
    if (typeof bend === 'number') {
      this.bend = Number.isFinite(bend) ? bend : 0;
      this.bendArray = null;
    } else {
      this.bend = bend[0];
      this.bendArray = bend;
    }
    this.state.bendArray = this.bendArray;
  }

  queueNoteOn(note, velocity, offset = 0) {
    this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity });
  }

  queueNoteOff(note, offset = 0) {
    this.events.push({ at: Math.max(0, offset | 0), kind: 0, note, velocity: 0 });
  }

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

  startNote(note, velocity, offset) {
    const voice = this.allocate(note);
    const holds = voice.active && voice.note === note && !voice.releasing ? voice.holds + 1 : 1;
    // Glide slides from whatever this voice was last playing.
    const from = voice.active && voice.note >= 0 ? midiToHz(voice.note) : -1;
    voice.age = this.clock++;
    voice.noteOn(note, velocity, this.state, offset, from);
    voice.holds = holds;
  }

  stopNote(note) {
    for (const v of this.voices) {
      if (!(v.active && v.note === note && !v.releasing)) continue;
      if (--v.holds > 0) continue;
      v.holds = 0;
      v.noteOff();
    }
  }

  /** Renders one block, split wherever a queued note edge falls. */
  process(outL, outR, count) {
    if (this.fast.length < count * FORMANT_OVER) {
      this.fast = new Float64Array(count * FORMANT_OVER);
      this.half = new Float64Array(count * 2);
      this.down = new Float64Array(count);
    }
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);
    let at0 = 0;
    let next = 0;
    while (at0 < count) {
      while (next < events.length && events[next].at <= at0) {
        const e = events[next++];
        if (e.kind === 1) this.startNote(e.note, e.velocity, at0);
        else this.stopNote(e.note);
      }
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at0;
      if (n > 0) this._render(outL, outR, at0, n);
      at0 = until;
    }
    if (next >= events.length) events.length = 0;
    else this.events = events.slice(next).map((e) => ({ ...e, at: Math.max(0, e.at - count) }));
  }

  /** Every voice at the voices' rate, summed, and brought down to the sample rate once. */
  _render(outL, outR, at0, n) {
    const fast = this.fast;
    fast.fill(0, 0, n * FORMANT_OVER);
    for (const v of this.voices) if (v.active) v.process(fast, n, at0, this.state);
    this.stageB.down(fast, this.half, n * 2);
    this.stageA.down(this.half, this.down, n);
    for (let i = 0; i < n; i++) {
      outL[at0 + i] += this.down[i];
      outR[at0 + i] += this.down[i];
    }
  }
}
