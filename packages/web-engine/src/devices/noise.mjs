// The Noise synth: a noise source per voice, in ten colors, with an amplitude envelope.
//
// The first five colors are the spectra - white, pink, brown, blue, violet - each scaled to the
// same loudness as white, so changing color changes the tone and not the level. The other five
// are the textures a modular rack gets out of a noise module rather than its filter: sparse
// impulses (velvet), random pops (crackle), a shift register clocked like an oscillator
// (digital), a random level stepped at a rate (stepped) and an iterated chaotic map (chaos).
//
// The three CLOCKED colors - digital, stepped and chaos - run at the note's own pitch, so playing
// them is playing a pitched noise: a run of notes on the digital color is the sound of an old
// console's noise channel, and on stepped it is a sample-and-hold sequence at audio rate. Pitch
// offsets that clock and the track's bend moves it. The other colors ignore the note's pitch;
// a note is when they sound, not what they sound at.
//
// Every voice has TWO independent streams, which is what Width blends between: at zero both
// sides play the first one (mono), at one each side has its own (fully decorrelated).
//
// Translated line for line into native/devices/own/noise.cc for the desktop, and held to it by
// native-device-parity.test.mjs. Everything is computed in double and written to the output
// once per sample, as the C++ does.

import { defineDevice } from '../descriptor.mjs';
import { at, isMoving } from '../dsp/control.mjs';
import { Adsr } from '../dsp/adsr.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** The colors, in the order the control lists them. Index is what the DSP switches on. */
export const NOISE_COLORS = Object.freeze([
  'white', 'pink', 'brown', 'blue', 'violet', 'velvet', 'crackle', 'digital', 'stepped', 'chaos',
]);

// White is index 0, and the color every unknown index falls back to.
const PINK = 1;
const BROWN = 2;
const BLUE = 3;
const VIOLET = 4;
const VELVET = 5;
const CRACKLE = 6;
const DIGITAL = 7;
const STEPPED = 8;
const CHAOS = 9;

/** The most voices one track will ever run, whatever the voice count is set to. */
export const NOISE_MAX_VOICES = 16;

/** Where the tone control stops filtering at all. */
const TONE_TOP = 20000;

/** The DC blocker's corner: below anything audible, above the drift a random walk makes. */
const DC_HZ = 5;

/** The brown color's corner: a one-pole lowpass on white, 6 dB an octave above it. */
const BROWN_HZ = 10;

/**
 * The pink color's sections: one-pole lowpasses two octaves apart, each weighted by the inverse
 * square root of its corner. Summed, their slopes add to the -3 dB an octave of pink noise
 * between the lowest corner and the top of the range, within about half a decibel.
 */
const PINK_POLES = Object.freeze([15, 60, 240, 960, 3840, 15360]);

/** How long a crackle's pop rings, in seconds. */
const CRACKLE_RING = 0.0003;

/** How loud the chaotic map plays, against white. Its values bunch at the ends of the range. */
const CHAOS_GAIN = 0.8;

/** The digital color's level: a sequence of +1 and -1 is a square wave's loudness, not noise's. */
const DIGITAL_GAIN = 0.5773502691896258;

const envSeconds = (id, name, def) => ({
  id, name, min: 0, max: 10, default: def, unit: 's', curve: 'pow', curveExp: 3, group: 'Amp Env',
});

export const NOISE = defineDevice({
  id: 'Noise',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-noise',
  description: 'A noise source per voice in ten colors - white, pink, brown, blue, violet, velvet, crackle, digital, stepped and chaos - with an amplitude envelope. The digital, stepped and chaos colors are clocked at the note\'s pitch.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'color', name: 'Color', default: 0, options: [...NOISE_COLORS], rate: 'k', group: 'Noise',
      description: 'The kind of noise. White to violet are spectra at equal loudness; velvet is sparse impulses, crackle random pops, digital a shift register, stepped a random level held at a rate, chaos an iterated chaotic map.' },
    { id: 'character', name: 'Character', min: 0, max: 1, default: 0.5, group: 'Noise',
      description: 'Velvet and crackle: how many impulses a second, from 20 to 20000. Digital: a long sequence below the middle, a short metallic one above. Stepped: how far each step glides into the next. Chaos: from periodic to fully chaotic.' },
    { id: 'pitch', name: 'Pitch', min: -48, max: 48, default: 0, step: 1, unit: 'st', ui: 'number', group: 'Noise',
      description: 'Moves the clock of the digital, stepped and chaos colors from the note\'s pitch, in semitones.' },
    { id: 'tone', name: 'Tone', min: 20, max: TONE_TOP, default: TONE_TOP, unit: 'Hz', curve: 'exp', group: 'Noise',
      description: 'A 12 dB an octave lowpass on each voice. At the top, nothing is filtered.' },
    { id: 'width', name: 'Width', min: 0, max: 1, default: 1, group: 'Noise',
      description: 'Zero plays the same noise on both sides; one gives each side its own.' },

    { ...envSeconds('ampenv.attack', 'Amp Attack', 0.002), amp: 'attack' },
    { ...envSeconds('ampenv.decay', 'Amp Decay', 0.15), amp: 'decay' },
    { id: 'ampenv.sustain', name: 'Amp Sustain', min: 0, max: 1, default: 0.6, group: 'Amp Env', amp: 'sustain' },
    { ...envSeconds('ampenv.release', 'Amp Release', 0.1), amp: 'release' },
    { id: 'env.acurve', name: 'Attack Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative rises fast and levels off, positive holds back and then rushes.' },
    { id: 'env.dcurve', name: 'Decay Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative falls fast and trails off.' },
    { id: 'env.rcurve', name: 'Release Curve', min: -8, max: 8, default: -4, step: 0.5, rate: 'k', ui: 'number', group: 'Amp Env',
      description: 'Zero is a straight line; negative drops away quickly and then hangs, positive holds the level and then cuts.' },

    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.5, group: 'Voice' },
    { id: 'voices', name: 'Voices', min: 1, max: NOISE_MAX_VOICES, default: 8, step: 1, rate: 'k', ui: 'number', group: 'Voice' },
  ],
});

/** A one-pole lowpass coefficient for a corner in Hz. */
const onePoleK = (hz, sampleRate) => 1 - Math.exp((-2 * Math.PI * hz) / sampleRate);

/**
 * How loud the summed pink sections come out against the white noise driving them, and how loud
 * their first difference (the blue color) does - both exactly, from the sections' own
 * coefficients, so every color plays at white's loudness at any sample rate.
 *
 * Each section is y += a (w - y), so two of them driven by the same white noise have a
 * covariance of a_j a_k / (1 - (1 - a_j)(1 - a_k)) times the noise's variance, and a lag-one
 * covariance of (1 - a_j) times that. The pink output's variance is the weighted sum of the
 * first; the difference's is twice the gap between the two sums.
 */
export function pinkScales(sampleRate) {
  const a = PINK_POLES.map((hz) => onePoleK(hz, sampleRate));
  const g = PINK_POLES.map((hz) => Math.sqrt(PINK_POLES[0] / hz));
  let r0 = 0;
  let r1 = 0;
  for (let j = 0; j < a.length; j++) {
    for (let k = 0; k < a.length; k++) {
      const c = (a[j] * a[k]) / (1 - (1 - a[j]) * (1 - a[k]));
      r0 += g[j] * g[k] * c;
      r1 += g[j] * g[k] * (1 - a[j]) * c;
    }
  }
  return { a, g, pink: Math.sqrt(1 / r0), blue: Math.sqrt(1 / (2 * (r0 - r1))) };
}

/**
 * One noise stream: a generator and the state every color keeps.
 *
 * The random source is xorshift32 with unsigned shifts throughout, which is the same sequence in
 * JavaScript (with `>>> 0` after each shift that can carry into the sign) and in C++ (on an
 * unsigned int).
 */
class NoiseStream {
  constructor(scales) {
    this.scales = scales;
    this.state = 1;
    this.pink = new Float64Array(PINK_POLES.length);
    this.reset();
  }

  reset() {
    this.pink.fill(0);
    this.pinkLast = 0;
    this.whiteLast = 0;
    this.brown = 0;
    this.phase = 0;
    this.target = 0;
    this.fired = true;
    this.pop = 0;
    this.register = 1;
    this.held = 0;
    this.from = 0;
    this.chaos = 0.5;
  }

  seed(s) {
    this.state = (s >>> 0) || 1;
    // The shift register and the chaotic map start somewhere of their own, so two voices on the
    // same note do not play the same sequence.
    this.register = (this.next() & 0x7fff) || 1;
    this.chaos = 0.1 + 0.8 * this.unit();
    this.held = this.unit() * 2 - 1;
    this.from = this.held;
  }

  /** The next raw 32-bit value. */
  next() {
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x;
  }

  /** Uniform in [0, 1). */
  unit() { return this.next() / 4294967296; }

  /** Uniform in [-1, 1), white. Its RMS is the loudness every color is scaled to. */
  white() { return this.next() / 2147483648 - 1; }

  /**
   * One sample of a color. `clock` is the clocked colors' rate as a share of the sample rate
   * (cycles per sample); `density` the velvet and crackle impulses per sample; `character` the
   * control as it is, for the colors that read it directly.
   */
  sample(color, clock, density, character, ring, brownK) {
    switch (color) {
      case PINK: case BLUE: {
        const w = this.white();
        const { a, g } = this.scales;
        let sum = 0;
        for (let k = 0; k < a.length; k++) {
          this.pink[k] += a[k] * (w - this.pink[k]);
          sum += g[k] * this.pink[k];
        }
        if (color === PINK) return sum * this.scales.pink;
        const d = sum - this.pinkLast;
        this.pinkLast = sum;
        return d * this.scales.blue;
      }
      case BROWN: {
        const w = this.white();
        this.brown += brownK * (w - this.brown);
        return this.brown * Math.sqrt((2 - brownK) / brownK);
      }
      case VIOLET: {
        const w = this.white();
        const d = w - this.whiteLast;
        this.whiteLast = w;
        return d * Math.SQRT1_2;
      }
      case VELVET: {
        // One impulse in every period, at a random point in it, of a random sign.
        this.phase += density;
        if (this.phase >= 1) {
          this.phase -= Math.floor(this.phase);
          this.target = this.unit();
          this.fired = false;
        }
        if (!this.fired && this.phase >= this.target) {
          this.fired = true;
          return this.unit() < 0.5 ? -1 : 1;
        }
        return 0;
      }
      case CRACKLE: {
        // A pop at random, mostly small and now and then large, with a short ring after it.
        if (this.unit() < density) {
          const w = this.white();
          this.pop = w * w * w;
        }
        const out = this.pop;
        this.pop *= ring;
        return out;
      }
      case DIGITAL: case STEPPED: case CHAOS: {
        this.phase += clock;
        if (this.phase >= 1) {
          this.phase -= Math.floor(this.phase);
          this.step(color, character);
        }
        if (color === STEPPED) {
          // A glide from the last level to this one over the first part of each step: none at
          // zero, the whole step at one.
          const glide = Math.min(1, this.phase / Math.max(1e-6, character));
          return this.from + (this.held - this.from) * glide;
        }
        return this.held;
      }
      default:
        return this.white();
    }
  }

  /** A clocked color's next step. */
  step(color, character) {
    if (color === DIGITAL) {
      // A fifteen-bit shift register fed back from its lowest bit and one other: the bit next to
      // it gives the full 32767-step sequence, the seventh a 93-step one that rings like a tone.
      const tap = character >= 0.5 ? 6 : 1;
      const r = this.register;
      const bit = (r ^ (r >> tap)) & 1;
      this.register = (r >> 1) | (bit << 14);
      this.held = (this.register & 1 ? 1 : -1) * DIGITAL_GAIN;
    } else if (color === STEPPED) {
      this.from = this.held;
      this.held = this.white();
    } else {
      const r = 3.5 + 0.5 * character;
      let x = this.chaos;
      x = (r * x) * (1 - x);
      // A map run this close to its edge can land exactly on 0 or 1 and stay there.
      if (!(x > 1e-9 && x < 1 - 1e-9)) x = 0.1 + 0.8 * this.unit();
      this.chaos = x;
      this.held = (x * 2 - 1) * CHAOS_GAIN;
    }
  }
}

class NoiseVoice {
  constructor(sampleRate, scales) {
    this.sampleRate = sampleRate;
    this.a = new NoiseStream(scales);
    this.b = new NoiseStream(scales);
    this.env = new Adsr(sampleRate);
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.releasing = false;
    this.holds = 0;
    this.resetFilters();
  }

  resetFilters() {
    this.l1 = 0; this.l2 = 0; this.r1 = 0; this.r2 = 0;
    this.dcInL = 0; this.dcOutL = 0; this.dcInR = 0; this.dcOutR = 0;
  }

  get active() { return this.env.active; }

  noteOn(note, velocity, seed) {
    if (!this.env.active) {
      this.a.reset();
      this.b.reset();
      this.resetFilters();
    }
    this.note = note;
    this.velocity = velocity;
    this.releasing = false;
    this.a.seed(seed ^ 0x9e3779b9);
    this.b.seed(seed ^ 0x85ebca6b);
    // A voice taken while it is still sounding keeps its envelope's level, as every synth here
    // does: clearing it is a click on the steal.
    this.env.gateOn(true);
  }

  noteOff() {
    this.releasing = true;
    this.env.gateOff();
  }

  /** Renders `count` samples of this voice and adds them into the output. */
  process(outL, outR, count, offset, s) {
    const sr = this.sampleRate;
    const color = s.color;
    const p = s.values;
    this.env.setStages(at(p['ampenv.attack'], offset), at(p['ampenv.decay'], offset), at(p['ampenv.sustain'], offset),
      at(p['ampenv.release'], offset), s.acurve, s.dcurve, s.rcurve);
    const pitchMoving = isMoving(p.pitch) || s.bendArray !== null;
    let clock = Math.min(0.5, Math.max(0.1 / sr, midiToHz(this.note + at(p.pitch, offset) + s.bendAt(offset)) / sr));
    const dcR = 1 - (2 * Math.PI * DC_HZ) / sr;
    let lastTone = -1;
    let toneK = 1;
    for (let i = 0; i < count; i++) {
      const j = offset + i;
      if (pitchMoving && i > 0) {
        clock = Math.min(0.5, Math.max(0.1 / sr, midiToHz(this.note + at(p.pitch, j) + s.bendAt(j)) / sr));
      }
      const character = Math.min(1, Math.max(0, at(p.character, j)));
      const density = (20 * Math.pow(1000, character)) / sr;
      const x = this.a.sample(color, clock, density, character, s.ring, s.brownK);
      const y = this.b.sample(color, clock, density, character, s.ring, s.brownK);
      // Width: the two streams as mid and side, at a constant loudness.
      const width = Math.min(1, Math.max(0, at(p.width, j)));
      const norm = 1 / Math.sqrt(1 + width * width);
      let l = (x + width * y) * norm;
      let r = (x - width * y) * norm;
      // A random walk and a held level both carry DC; nothing here should.
      const dl = l - this.dcInL + dcR * this.dcOutL;
      this.dcInL = l; this.dcOutL = dl; l = dl;
      const dr = r - this.dcInR + dcR * this.dcOutR;
      this.dcInR = r; this.dcOutR = dr; r = dr;
      const tone = at(p.tone, j);
      if (tone < TONE_TOP - 1) {
        if (tone !== lastTone) { toneK = 1 - Math.exp((-2 * Math.PI * tone) / sr); lastTone = tone; }
        this.l1 += toneK * (l - this.l1); this.l2 += toneK * (this.l1 - this.l2); l = this.l2;
        this.r1 += toneK * (r - this.r1); this.r2 += toneK * (this.r1 - this.r2); r = this.r2;
      }
      const gain = this.env.next() * this.velocity * at(p.level, j);
      outL[i] += l * gain;
      outR[i] += r * gain;
    }
    if (!Number.isFinite(this.dcOutL + this.dcOutR + this.l2 + this.r2)) {
      this.a.reset();
      this.b.reset();
      this.resetFilters();
    }
  }
}

export class NoiseSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    const scales = pinkScales(sampleRate);
    this.voices = Array.from({ length: NOISE_MAX_VOICES }, () => new NoiseVoice(sampleRate, scales));
    this.voiceCount = 8;
    this.clock = 0;
    this.seed = 1;
    this.events = [];
    this.bend = 0;
    this.bendArray = null;
    this.state = {
      values: Object.fromEntries(NOISE.params.map((p) => [p.id, p.default])),
      color: 0,
      acurve: -4,
      dcurve: -4,
      rcurve: -4,
      bendArray: null,
      ring: Math.exp(-1 / (CRACKLE_RING * sampleRate)),
      brownK: onePoleK(BROWN_HZ, sampleRate),
      bendAt: (i) => (this.bendArray ? this.bendArray[i] : this.bend),
    };
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.state;
    for (const p of NOISE.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s.values[p.id] = v;
    }
    const first = (id, fallback) => {
      const v = s.values[id];
      return v === undefined ? fallback : at(v, 0);
    };
    s.color = Math.min(NOISE_COLORS.length - 1, Math.max(0, Math.round(first('color', 0))));
    s.acurve = first('env.acurve', -4);
    s.dcurve = first('env.dcurve', -4);
    s.rcurve = first('env.rcurve', -4);
    const count = first('voices', 8);
    if (Number.isFinite(count)) this.voiceCount = Math.min(NOISE_MAX_VOICES, Math.max(1, Math.round(count)));
  }

  /** The track's bend in semitones, which moves the clocked colors' pitch. */
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

  startNote(note, velocity) {
    const voice = this.allocate(note);
    const holds = voice.active && voice.note === note && !voice.releasing ? voice.holds + 1 : 1;
    voice.age = this.clock++;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    voice.noteOn(note, velocity, this.seed);
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
        if (e.kind === 1) this.startNote(e.note, e.velocity);
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
