// The Pluck synth: a plucked string per voice, by Karplus-Strong - a burst of noise into a delay
// line one period long, fed back through a filter that takes a little of the top off every trip.
//
// Each voice is two strings, one per side, detuned apart by Detune. What goes into them is the
// exciter: a burst of noise Burst long, darkened by Tone, and combed by Position - the pluck's
// place along the string, which cancels the harmonics that have a node there, as plucking a
// guitar near the bridge or over the sound hole does. The loop around each string is:
//
//   the delay line, a whole number of samples
//   a first-order allpass for the fraction, solved to land exactly on the note at its fundamental
//   four first-order allpasses (Stretch): high partials go round faster than low ones, so they
//   sit sharp of the harmonic series - a stiff string, then a bar, then a bell. Their coefficient
//   is tied to the note, so the same Stretch bends the same partials at any pitch
//   the loss: a gain and a one-pole lowpass, designed together (Valimaki and Tolonen's one-pole
//   loss filter) from two decay times - Decay at the bottom of the spectrum, and Decay shortened
//   by Damping at the top - so a partial's decay falls smoothly between the two. The loss is
//   never under one at any frequency, so no setting can feed a partial back louder than it came.
//
// Every filter in the loop delays it, and that delay is taken off the line at the fundamental, so
// the note is in tune at any setting. A voice is free once its burst is over and the string has
// fallen silent.
//
// Translated line for line into native/devices/own/pluck.cc for the desktop, and held to it by
// native-device-parity.test.mjs. Everything is computed in double.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** How far the Voices knob reaches, which is no most (see the Wavetable's VOICES_KNOB). */
export const PLUCK_VOICES_KNOB = 128;

/** The lowest and highest a string is tuned, in Hz: the line is sized for the lowest. */
const LOWEST_HZ = 25;
/**
 * The highest, as a share of the sample rate: the Stretch stages are a sample each even when they
 * do nothing, and the line wants one and a half more, so the loop must be seven samples long.
 */
const HIGHEST_SHARE = 1 / 7;

/**
 * The Stretch allpasses. Each one's delay drops off above a corner near (1 + c) radians, so the
 * coefficient is set from the note: the corner sits STRETCH_TIGHTEST times the note's frequency up
 * at Stretch 1, and a factor of STRETCH_RANGE further up at Stretch 0 - where there is none.
 */
const STRETCH_STAGES = 4;
const STRETCH_TIGHTEST = 1.5;
const STRETCH_RANGE = 64;
const STRETCH_MOST = 0.999;

/** How many times shorter the decay is at the top of the spectrum than the bottom, at Damping 1. */
const DAMPING_RANGE = 100;

/**
 * The lowest the loss's corner goes, as a multiple of the note. Under it the lowpass would take
 * the fundamental itself, and a heavily damped string would make no sound at all instead of a
 * dead one.
 */
const DAMPING_FLOOR = 1.5;

/** The most a partial is fed back with: a hair under one. */
const MOST_GAIN = 0.99999;

/** The shortest a loop's whole-sample part may be, and how often a loop that will not fit is eased. */
const SHORTEST_WHOLE = 1.5;
const FIT_TRIES = 24;

/**
 * The burst length its level is set for. A longer one is turned down by the square root of how
 * much longer, so it puts the same energy into the string and Burst changes the sound, not the
 * level; a shorter one is not turned up.
 */
const BURST_REFERENCE = 0.004;

/** The burst's level into the strings, and each voice's level out. */
const EXCITE_GAIN = 0.7;
const PLUCK_VOICE_GAIN = 0.8;

/** Under this a string has stopped: the voice is free. */
const PLUCK_SILENT = 1e-5;
/** How fast the follower that decides that falls, in seconds. */
const FOLLOW_FALL = 0.05;

/** Starting points for the preset menu: each the defaults with these controls changed. */
export const PLUCK_PRESETS = Object.freeze({
  nylon: { tone: 5000, position: 0.2, decay: 3, damping: 0.5, detune: 3 },
  steel: { tone: 14000, position: 0.1, decay: 6, damping: 0.25, detune: 4 },
  bass: { burst: 0.008, tone: 2500, position: 0.25, decay: 4, damping: 0.55, detune: 0 },
  harp: { tone: 7000, position: 0.45, decay: 5, damping: 0.4, detune: 2, release: 3 },
  muted: { tone: 3000, position: 0.15, decay: 0.25, damping: 0.75, release: 0.08, level: 1 },
  bell: { burst: 0.001, tone: 16000, position: 0.07, decay: 8, damping: 0.1, stretch: 0.85, detune: 8, release: 4 },
  metal: { burst: 0.002, tone: 12000, decay: 2.5, damping: 0.2, stretch: 0.6, detune: 25 },
  bowed: { burst: 0.15, tone: 4000, position: 0.3, decay: 6, damping: 0.45, detune: 10, release: 1.5 },
});

export const PLUCK = defineDevice({
  id: 'Pluck',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-pluck',
  description: 'A plucked string per voice: a burst of noise into a tuned delay loop that loses its top a little every trip. Two strings a voice, detuned apart, with stiffness for bars and bells.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'burst', name: 'Burst', min: 0.0005, max: 0.2, default: 0.004, unit: 's', curve: 'exp', group: 'Exciter',
      description: 'How long the burst of noise that plucks the string lasts. Short is a pick; long rubs it like a bow.' },
    { id: 'tone', name: 'Tone', min: 200, max: 20000, default: 9000, unit: 'Hz', curve: 'exp', group: 'Exciter',
      description: 'A lowpass on the burst: how hard and bright the pluck is.' },
    { id: 'position', name: 'Position', min: 0, max: 0.5, default: 0.13, group: 'Exciter',
      description: 'Where along the string it is plucked, as a share of its length. Near 0 is at the bridge, thin and bright; 0.5 is the middle, hollow, with the even harmonics gone.' },
    { id: 'decay', name: 'Decay', min: 0.05, max: 30, default: 2.5, unit: 's', curve: 'exp', group: 'String',
      description: 'How long the bottom of the spectrum takes to fall sixty decibels while the note is held. The partials above it die sooner, by Damping.' },
    { id: 'damping', name: 'Damping', min: 0, max: 1, default: 0.35, group: 'String',
      description: 'How much faster the top of the spectrum dies than the bottom: at 0 every partial rings as long, at 1 the top dies a hundred times faster.' },
    { id: 'stretch', name: 'Stretch', min: 0, max: 1, default: 0, group: 'String',
      description: 'Stiffness: pushes the high partials sharp of the harmonic series, from a string through a bar to a bell.' },
    { id: 'detune', name: 'Detune', min: 0, max: 50, default: 6, unit: 'ct', group: 'String',
      description: 'How far apart the voice\'s two strings, one per side, are tuned. At 0 they are one string in the middle.' },
    { id: 'release', name: 'Release', min: 0.01, max: 10, default: 0.5, unit: 's', curve: 'exp', group: 'Voice',
      description: 'How long the string takes to fall sixty decibels once the note is let go.' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.5, group: 'Voice' },
    { id: 'voices', name: 'Voices', min: 1, open: true, uiMax: PLUCK_VOICES_KNOB, default: 8, step: 1, rate: 'k', ui: 'number', group: 'Voice' },
  ],
  presets: PLUCK_PRESETS,
});

/** The phase delay, in samples, of the first-order allpass (c + z^-1) / (1 + c z^-1) at `w`. */
function allpassDelay(c, w) {
  return 1 - (2 * Math.atan2(c * Math.sin(w), 1 + c * Math.cos(w))) / w;
}

/** The phase delay, in samples, of the one-pole lowpass (1 - b) / (1 - b z^-1) at `w`. */
function lowpassDelay(b, w) {
  return Math.atan2(b * Math.sin(w), 1 - b * Math.cos(w)) / w;
}

/**
 * Everything one string's loop needs to play `hz` at these settings, worked out once a block:
 * the line's whole samples, the fraction's allpass, the lowpass pole, the stretch coefficient,
 * and the loop gain. A loop too short for its filters (a high note, stiff and
 * dull) is eased - the stretch first, then the damping, halved until it fits - so it stays in tune.
 */
export function tuneString(hz, sampleRate, damping, stretch, seconds, out) {
  const f = Math.min(sampleRate * HIGHEST_SHARE, Math.max(LOWEST_HZ, hz));
  const w = (2 * Math.PI * f) / sampleRate;
  const period = sampleRate / f;
  // What a trip keeps at the bottom of the spectrum, and at the top, from the two decay times.
  const low = Math.min(MOST_GAIN, Math.pow(10, -3 / (f * Math.max(0.01, seconds))));
  const shorter = Math.pow(DAMPING_RANGE, Math.min(1, Math.max(0, damping)));
  const high = Math.pow(10, -3 / (f * Math.max(0.01, seconds) / shorter));
  const floor = Math.exp((-2 * Math.PI * Math.min(sampleRate * 0.45, f * DAMPING_FLOOR)) / sampleRate);
  let b = Math.min(floor, (low - high) / (low + high));
  const stiff = Math.min(1, Math.max(0, stretch));
  let c = stiff > 0
    ? -Math.min(STRETCH_MOST, Math.max(0, 1 - STRETCH_TIGHTEST * Math.pow(STRETCH_RANGE, 1 - stiff) * w))
    : 0;
  let rest = period - lowpassDelay(b, w) - STRETCH_STAGES * allpassDelay(c, w);
  for (let i = 0; i < FIT_TRIES && rest < SHORTEST_WHOLE; i++) {
    if (c < -1e-6) c *= 0.5;
    else b *= 0.5;
    rest = period - lowpassDelay(b, w) - STRETCH_STAGES * allpassDelay(c, w);
  }
  const whole = Math.max(1, Math.floor(rest - 0.5));
  const d = rest - whole;
  // The first-order allpass whose phase delay at w is exactly d.
  out.whole = whole;
  out.eta = Math.sin((w * (1 - d)) / 2) / Math.sin((w * (1 + d)) / 2);
  out.b = b;
  out.c = c;
  out.gain = low;
  out.period = period;
}

/** One string: the line and the state of every filter in its loop. */
class PluckString {
  constructor(size) {
    this.line = new Float64Array(size);
    this.mask = size - 1;
    this.ap = new Float64Array(STRETCH_STAGES * 2);   // each stage's last input and output
    this.tune = { whole: 1, eta: 0, b: 0, c: 0, gain: 0, period: 4 };
    this.reset();
  }

  reset() {
    this.line.fill(0);
    this.ap.fill(0);
    this.pos = 0;
    this.frac = 0;
    this.lp = 0;
  }

  /** One sample: what arrives round the loop, with `input` added in behind it. */
  next(input) {
    const t = this.tune;
    const line = this.line;
    const u0 = line[(this.pos - t.whole) & this.mask];
    const u1 = line[(this.pos - t.whole - 1) & this.mask];
    const d = t.eta * u0 + u1 - t.eta * this.frac;
    this.frac = d;
    this.lp = (1 - t.b) * d + t.b * this.lp;
    let v = this.lp;
    const ap = this.ap;
    for (let k = 0; k < STRETCH_STAGES; k++) {
      const y = t.c * v + ap[2 * k] - t.c * ap[2 * k + 1];
      ap[2 * k] = v;
      ap[2 * k + 1] = y;
      v = y;
    }
    v *= t.gain;
    line[this.pos] = input + v;
    this.pos = (this.pos + 1) & this.mask;
    return v;
  }
}

class PluckVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    let size = 16;
    while (size < Math.ceil(sampleRate / LOWEST_HZ) + 8) size *= 2;
    this.left = new PluckString(size);
    this.right = new PluckString(size);
    this.history = new Float64Array(size);   // the burst, for Position's comb
    this.mask = size - 1;
    this.fall = Math.exp(-1 / (FOLLOW_FALL * sampleRate));
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.releasing = false;
    this.holds = 0;
    this.sounding = false;
    this.burstLeft = 0;
    this.burstLength = 1;
    this.burstGain = 1;
    this.seed = 1;
    this.reset();
  }

  reset() {
    this.left.reset();
    this.right.reset();
    this.history.fill(0);
    this.hpos = 0;
    this.tone1 = 0;
    this.tone2 = 0;
    this.follow = 0;
  }

  get active() { return this.sounding; }

  noteOn(note, velocity, seed, burstSamples) {
    // A string still ringing is plucked again where it is; a silent one starts clean.
    if (!this.sounding) this.reset();
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.seed = (seed >>> 0) || 1;
    this.burstLength = Math.max(1, burstSamples);
    this.burstLeft = this.burstLength;
    this.burstGain = Math.sqrt(Math.min(1, (BURST_REFERENCE * this.sampleRate) / this.burstLength));
    this.sounding = true;
  }

  noteOff() {
    this.releasing = true;
  }

  /** The burst's noise: xorshift32, uniform in [-1, 1). */
  white() {
    let x = this.seed;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    this.seed = x;
    return x / 2147483648 - 1;
  }

  /** Renders `count` samples of this voice and adds them into the output. */
  process(outL, outR, count, offset, s) {
    const sr = this.sampleRate;
    const p = s.values;
    const pitch = this.note + s.bendAt(offset);
    const detune = Math.max(0, at(p.detune, offset)) / 200;   // half the cents, in semitones
    const damping = at(p.damping, offset);
    const stretch = at(p.stretch, offset);
    const seconds = this.releasing ? at(p.release, offset) : at(p.decay, offset);
    tuneString(midiToHz(pitch - detune), sr, damping, stretch, seconds, this.left.tune);
    tuneString(midiToHz(pitch + detune), sr, damping, stretch, seconds, this.right.tune);
    const toneK = 1 - Math.exp((-2 * Math.PI * Math.min(sr * 0.45, Math.max(20, at(p.tone, offset)))) / sr);
    const position = Math.min(0.5, Math.max(0, at(p.position, offset)));
    const comb = Math.round(position * this.left.tune.period);
    for (let i = 0; i < count; i++) {
      const j = offset + i;
      // The burst: noise falling away in a straight line, darkened, then combed.
      let e = 0;
      if (this.burstLeft > 0) {
        e = this.white() * (this.burstLeft / this.burstLength) * this.burstGain;
        this.burstLeft -= 1;
      }
      this.tone1 += toneK * (e - this.tone1);
      this.tone2 += toneK * (this.tone1 - this.tone2);
      let x = this.tone2;
      this.history[this.hpos] = x;
      if (comb >= 1) x -= this.history[(this.hpos - comb) & this.mask];
      this.hpos = (this.hpos + 1) & this.mask;
      x *= this.velocity * EXCITE_GAIN;
      const l = this.left.next(x);
      const r = this.right.next(x);
      const level = at(p.level, j) * PLUCK_VOICE_GAIN;
      outL[i] += l * level;
      outR[i] += r * level;
      // What is going in counts as sounding too: a low string's first trip round is long.
      const peak = Math.max(Math.abs(x), Math.abs(l), Math.abs(r));
      this.follow = peak > this.follow ? peak : this.follow * this.fall;
    }
    if (!Number.isFinite(this.follow)) this.reset();
    // Free once the burst has gone in and the string has fallen silent.
    if (this.burstLeft <= 0 && this.follow < PLUCK_SILENT) this.sounding = false;
  }
}

export class PluckSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.voices = Array.from({ length: 16 }, () => new PluckVoice(sampleRate));
    this.voiceCount = 8;
    this.clock = 0;
    this.seed = 1;
    this.events = [];
    this.bend = 0;
    this.bendArray = null;
    this.state = {
      values: Object.fromEntries(PLUCK.params.map((p) => [p.id, p.default])),
      bendAt: (i) => (this.bendArray ? this.bendArray[i] : this.bend),
    };
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.state;
    for (const p of PLUCK.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s.values[p.id] = v;
    }
    const count = at(s.values.voices, 0);
    if (Number.isFinite(count)) this.voiceCount = Math.max(1, Math.round(count));
    while (this.voices.length < this.voiceCount) this.voices.push(new PluckVoice(this.sampleRate));
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
    voice.age = this.clock++;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    const burst = Math.round(Math.max(0, at(this.state.values.burst, offset)) * this.sampleRate);
    voice.noteOn(note, velocity, this.seed, burst);
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
