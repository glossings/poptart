// The Hat: an analog-style hi-hat, one hit at a time.
//
// THE SOURCE is a cluster of square waves at inharmonic frequencies (dsp/metal.mjs), every edge
// band-limited, with white noise blended in by Noise. Source picks the cluster: six squares at the
// frequencies of the classic analog cymbal circuit; a thinner six at a higher, closer-packed set;
// a dense twelve - those six and six more - which stands in for a recorded cymbal's crowd of
// partials; and the circuit's two highest alone, which is a cowbell. The note retunes the squares
// together: middle C plays them at their own frequencies, an octave up at twice.
//
// LOFI is a sample-and-hold at a lower rate and fewer bits, on the source before the filters: the
// grit of a short, coarse recording played back through analog filters. Its bits fall first and
// its rate after. The held steps are band-limited like the squares' edges, so the images of the
// lower rate are heard and nothing folds back off the real one. At zero it is out of the way.
//
// TWO BANDS, as the classic cymbal circuit has: each a bandpass, its own amplitude envelope and a
// highpass, moved together by Tone; with the dense source both open wide, as a recording's
// spectrum is. The upper band is the sizzle and lasts Decay. The lower one, an octave under it, is
// the body: Body sets its level and it rings several times as long, so a
// cymbal or an open hat falls fast from its attack and then hangs on - the two-stage tail of the
// real thing. Each envelope falls exponentially and lands on silence at a fixed point.
//
// WARP folds the squares' sum before it is drawn, crossing them into each other for a denser,
// clangier metal, still band-limited (dsp/metal.mjs). RING puts resonance on the bright band's
// highpass, up to the edge of ringing on its own, and FILTER SWEEP starts each hit's filters some
// semitones away from Tone and brings them back within a few tens of milliseconds - the zap of a
// filter swept by its own short envelope on every hit.
//
// EACH HIT differs a little: velocity sets the level and brightens the filters, as an accent
// does, and every hit draws a small offset for Tone and Decay from a seeded sequence - the same on
// both engines - so a run of identical notes is not a loop of one sample. The squares and the
// noise run on from hit to hit rather than restarting.
//
// One hit sounds at a time: a new one fades whatever was still ringing over a few milliseconds,
// which is how a closed hat cuts an open one. Note offs are ignored - a hit plays out.
//
// Translated line for line into native/devices/own/hat.cc for the desktop, and held to it by
// native-device-parity.test.mjs. Everything is computed in double and written to the output once
// per sample, as the C++ does.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { Svf } from '../dsp/filters.mjs';
import { BLEP_HALF, BlepLine, HistoryLine } from '../dsp/blep.mjs';
import { METAL_COUNT, METAL_HZ, MetalSource } from '../dsp/metal.mjs';

/** The sources, in the order the control lists them. */
export const HAT_SOURCES = Object.freeze(['metal', 'thin', 'dense', 'bell']);
const SOURCE_THIN = 1;
const SOURCE_DENSE = 2;
const SOURCE_BELL = 3;

/** The note the source plays at its own frequencies. */
const HAT_ROOT_NOTE = 60;
/** The analog circuit's squares are a little short of half high; the others are square. */
const METAL_WIDTH = 0.48;
/** The thinner cluster, and the six the dense one adds to the analog six. */
const THIN_HZ = Object.freeze([245, 306, 365, 415, 437, 619]);
const DENSE_HZ = Object.freeze([263.5, 331.7, 426.2, 471.9, 587.3, 713.1]);
/** The bell keeps the last two of METAL_HZ. */
const BELL_KEPT = 2;
/** White noise's level against the squares', where Noise blends them. */
const NOISE_GAIN = 0.6;
/** Tone's upper bandpass at its ends, in hertz. */
const TONE_DARK_HZ = 500;
const TONE_BRIGHT_HZ = 20000;
/** The bands' resonance (Svf, 0..1): the upper, the upper for the bell's two tones, and the body. */
const BAND_RESONANCE = 0.6;
const BELL_RESONANCE = 0.9;
const BODY_RESONANCE = 0.7;
/** Each band's highpass, as a share of its bandpass. */
const HIGHPASS_RATIO = 0.8;
const BODY_HIGHPASS_RATIO = 0.6;
/**
 * The dense source's bands are wide open instead - no resonance and the highpasses far below - as
 * a recorded cymbal's spectrum is broad, reaching well down into the middle.
 */
const WIDE_RESONANCE = 0;
const WIDE_HIGHPASS_RATIO = 0.25;
/** What the dense source's wide bands and the bell's narrow one are brought to the others' level by. */
const WIDE_GAIN = 0.4;
const BELL_GAIN = 1.4;
/** The body's bandpass against the upper one's, and how many times longer it rings. */
const BODY_RATIO = 0.48;
const BODY_LENGTH = 6;
/** The body's level at the top of Body, against the upper band's. */
const BODY_GAIN = 1.5;
/** How far a soft hit darkens Tone: this much at no velocity, none at full. */
const ACCENT_TONE = 0.12;
/** The most a hit moves Tone, and Decay as a share of itself. */
const JITTER_TONE = 0.015;
const JITTER_DECAY = 0.06;
/** Lofi's hold rate and bits, just past zero and at the top. */
const LOFI_RATE_TOP = 44000;
const LOFI_RATE_BOTTOM = 16000;
const LOFI_BITS_TOP = 16;
const LOFI_BITS_BOTTOM = 4;
/** The lowpass before the hold, as a share of its rate. */
const LOFI_FILTER = 0.45;
/** The envelopes' floor at the top of Hold: each falls exponentially toward it and stops at zero. */
const HOLD_FLOOR = 0.85;
/** Decay is the time to fall this far. */
const DECAY_DB = 60;
/** How much louder Warp at its top makes the squares, taken back after the fold. */
const HAT_WARP_LEVEL = 2.6;
/** Ring at its top: the bright band's highpass just short of ringing on its own (Svf, 0..1). */
const HAT_RING_TOP = 0.97;
/** How quickly a hit's filter sweep returns: its time constant, in seconds. */
const HAT_SWEEP_SEC = 0.03;
/** Under this many semitones, the sweep has finished. */
const HAT_SWEEP_DONE = 1e-3;
/** How long a hit a new one replaces takes to fade. */
const CHOKE_SEC = 0.003;
/** The output level against the source. */
const HAT_GAIN = 5;

/**
 * Starting points the device ships with, by name: some of its controls in their units, the rest at
 * their defaults. Four characters - an analog cluster, a thinner analog one, a crisp sampled one and a
 * grainier sampled one - each with a closed, an open and a pedal hat, and their cymbals and bells;
 * then a few that are none of those: folded, ringing and swept. All at levels that put their peaks
 * together.
 */
export const HAT_PRESETS = Object.freeze({
  analogclosed: Object.freeze({ source: 1, tone: 1, decay: 0.02, hold: 0, body: 1, noise: 0.55, lofi: 0.3, level: 0.51 }),
  analogopen: Object.freeze({ source: 1, tone: 0.8, decay: 0.364, hold: 0.89, body: 0, noise: 0.4, lofi: 0.65, level: 1 }),
  analogpedal: Object.freeze({ source: 1, tone: 0.92, decay: 0.012, hold: 0, body: 0.5, noise: 0.55, lofi: 0.3, level: 0.98 }),
  analogcymbal: Object.freeze({ source: 0, tone: 0.75, decay: 0.25, hold: 0.19, body: 0.16, noise: 0.56, lofi: 0.45, level: 0.73 }),
  cowbell: Object.freeze({ source: 3, tone: 0.17, decay: 0.148, hold: 0, body: 0.03, noise: 0.21, lofi: 0.23, level: 0.79 }),
  thinclosed: Object.freeze({ source: 1, tone: 1, decay: 0.018, hold: 0, body: 0.21, noise: 0.3, lofi: 0.6, level: 1 }),
  thinopen: Object.freeze({ source: 0, tone: 0.95, decay: 0.081, hold: 1, body: 1, noise: 0.57, lofi: 0.55, level: 0.4 }),
  thinpedal: Object.freeze({ source: 1, tone: 0.92, decay: 0.011, hold: 0, body: 0.11, noise: 0.3, lofi: 0.6, level: 1 }),
  thincymbal: Object.freeze({ source: 0, tone: 0.74, decay: 0.291, hold: 0, body: 0.14, noise: 0.61, lofi: 0.47, level: 0.73 }),
  crispclosed: Object.freeze({ source: 2, tone: 0.66, decay: 0.081, hold: 0.01, body: 0.03, noise: 0.34, lofi: 0.01, level: 0.55 }),
  crispopen: Object.freeze({ source: 2, tone: 0.65, decay: 0.232, hold: 0.14, body: 0.01, noise: 0, lofi: 0, level: 0.33 }),
  crisppedal: Object.freeze({ source: 2, tone: 0.58, decay: 0.049, hold: 0, body: 0.01, noise: 0.34, lofi: 0.01, level: 0.55 }),
  crispcrash: Object.freeze({ source: 0, tone: 0.5, decay: 0.2, hold: 0.91, body: 0.71, noise: 0.65, lofi: 0.05, level: 0.35 }),
  crispride: Object.freeze({ source: 2, tone: 0.8, decay: 0.2, hold: 0.2, body: 1, noise: 0.2, lofi: 0.6, level: 0.27 }),
  grainyclosed: Object.freeze({ source: 2, tone: 0.59, decay: 0.088, hold: 1, body: 0, noise: 0.24, lofi: 0.45, level: 0.5 }),
  grainyopen: Object.freeze({ source: 2, tone: 0.54, decay: 0.25, hold: 0.91, body: 0, noise: 0.53, lofi: 0.55, level: 0.71 }),
  grainypedal: Object.freeze({ source: 2, tone: 0.51, decay: 0.053, hold: 0, body: 0, noise: 0.24, lofi: 0.45, level: 0.51 }),
  grainycrash: Object.freeze({ source: 2, tone: 0.59, decay: 0.894, hold: 0.97, body: 0, noise: 0, lofi: 0.55, level: 0.41 }),
  grainycowbell: Object.freeze({ source: 3, tone: 0.23, decay: 0.025, hold: 0.33, body: 0.93, noise: 0.68, lofi: 0.97, level: 0.32 }),
  zap: Object.freeze({ source: 0, tone: 0.6, decay: 0.08, hold: 0.1, body: 0, noise: 0.2, lofi: 0, warp: 0, ring: 0.6, filtersweep: 24, level: 1 }),
  whistle: Object.freeze({ source: 1, tone: 0.82, decay: 0.09, hold: 0.15, body: 0, noise: 0.1, lofi: 0, warp: 0, ring: 0.95, filtersweep: 0, level: 0.81 }),
  clang: Object.freeze({ source: 0, tone: 0.72, decay: 0.14, hold: 0.1, body: 0.4, noise: 0, lofi: 0, warp: 0.8, ring: 0.3, filtersweep: 0, level: 0.79 }),
  foldcymbal: Object.freeze({ source: 2, tone: 0.66, decay: 0.6, hold: 0.2, body: 0.6, noise: 0.2, lofi: 0, warp: 0.6, ring: 0.5, filtersweep: -7, level: 0.37 }),
  shaker: Object.freeze({ source: 0, tone: 0.78, decay: 0.07, hold: 0.5, body: 0, noise: 1, lofi: 0, warp: 0, ring: 0.8, filtersweep: -12, level: 0.31 }),
});

export const HAT = defineDevice({
  id: 'Hat',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-hat',
  description: 'An analog-style hi-hat: a cluster of square waves at inharmonic pitches and white noise, through a bright band and a lower body band with envelopes of their own, one hit at a time, so a new hit cuts the last. Short is a closed hat, long an open one or a cymbal; the bell source is a cowbell, and Lofi a coarse sampled grit.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'source', name: 'Source', default: 0, options: [...HAT_SOURCES], rate: 'k', group: 'Hat',
      description: 'The squares: the analog circuit\'s six, a thinner six, a dense twelve that stands in for a recorded cymbal, or two, which is a cowbell.' },
    { id: 'tone', name: 'Tone', min: 0, max: 1, default: 0.86, group: 'Hat',
      description: 'The filters, from dark to bright.' },
    { id: 'decay', name: 'Decay', min: 0.01, max: 4, default: 0.07, unit: 's', curve: 'exp', group: 'Hat', amp: 'decay',
      description: 'The length of the hit: the time the bright band takes to fall 60 dB. Short is closed, long is open.' },
    { id: 'hold', name: 'Hold', min: 0, max: 1, default: 0.15, group: 'Hat',
      description: 'How long the level stays up before it falls away. None is a plain exponential fade; more holds and then drops, as an analog open hat does.' },
    { id: 'body', name: 'Body', min: 0, max: 1, default: 0, group: 'Hat',
      description: 'A lower band that rings several times as long as the bright one: the hang of an open hat or a cymbal.' },
    { id: 'noise', name: 'Noise', min: 0, max: 1, default: 0, group: 'Hat',
      description: 'Blends white noise in with the squares; at one, only noise.' },
    { id: 'warp', name: 'Warp', min: 0, max: 1, default: 0, group: 'Hat',
      description: 'Folds the squares into each other: a denser, clangier metal.' },
    { id: 'ring', name: 'Ring', min: 0, max: 1, default: 0, group: 'Hat',
      description: 'Resonance on the bright band\'s highpass, up to the edge of ringing on its own: a whistle in the sizzle.' },
    { id: 'filtersweep', name: 'Filter Sweep', min: -48, max: 48, default: 0, unit: 'st', group: 'Hat',
      description: 'Starts each hit\'s filters this far above or below Tone and brings them back within a few tens of milliseconds: a zap. Harder hits sweep further.' },
    { id: 'lofi', name: 'Lofi', min: 0, max: 1, default: 0, group: 'Hat',
      description: 'Holds the source at fewer bits and a lower rate before the filters: the grit of a coarse recording. Zero is clean.' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.7, group: 'Hat' },
  ],
  presets: HAT_PRESETS,
});


/** Lofi's hold rate in hertz and its bits, for a setting above zero: the bits go first. */
export function lofiRate(lofi, sampleRate) {
  return Math.min(0.9 * sampleRate, LOFI_RATE_TOP * Math.pow(LOFI_RATE_BOTTOM / LOFI_RATE_TOP, lofi * lofi));
}
export function lofiBits(lofi) {
  return LOFI_BITS_TOP - (LOFI_BITS_TOP - LOFI_BITS_BOTTOM) * lofi;
}

/** Tone's upper bandpass in hertz. */
export function toneHz(tone) {
  return TONE_DARK_HZ * Math.pow(TONE_BRIGHT_HZ / TONE_DARK_HZ, tone);
}

/** A hit's per-hit draw, -1..1: the next step of a seeded sequence, the same on both engines. */
function draw(seed) {
  return ((seed >>> 8) & 0xffff) / 32768 - 1;
}
const nextSeed = (seed) => (seed * 1664525 + 1013904223) >>> 0;

/**
 * Lofi: a sample-and-hold at a lower rate and fewer bits, behind a lowpass at a little under half
 * that rate, as a recording's own filter would be. What it takes is read at the hold's own tick,
 * between samples (HistoryLine), and the held steps are band-limited (BlepLine), so the output is
 * twice BLEP_HALF samples late - and just as late at zero, where nothing is held.
 */
export class Lofi {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.filter = new Svf(sampleRate);
    this.history = new HistoryLine();
    this.line = new BlepLine();
    this.reset();
  }

  reset() {
    this.filter.reset();
    this.history.reset();
    this.line.reset();
    this.phase = 0;
    this.held = 0;
    this.lastRate = -1;
  }

  next(x, lofi) {
    if (!(lofi > 0)) {
      this.history.push(x);
      const late = this.history.at(BLEP_HALF);
      this.held = late;
      return this.line.push(late);
    }
    return this.hold(x, lofiRate(lofi, this.sampleRate), lofiBits(lofi));
  }

  /** One sample held at `rate` hertz and rounded to `bits`. */
  hold(x, rate, bits) {
    if (rate !== this.lastRate) {
      this.filter.setCutoff(LOFI_FILTER * rate, 0);
      this.lastRate = rate;
    }
    this.history.push(this.filter.next(x, 0));
    const dt = rate / this.sampleRate;
    this.phase += dt;
    if (this.phase >= 1) {
      this.phase -= 1;
      // Taken at the tick, between this sample and the last, then rounded.
      const ago = this.phase / dt;
      const q = Math.pow(2, bits - 1);
      const v = Math.floor(this.history.read(ago) * q + 0.5) / q;
      this.line.jump(ago, v - this.held);
      this.held = v;
    }
    return this.line.push(this.held);
  }
}

/**
 * The squares, the noise and Lofi, shared by both hits, as the circuit shares its oscillators: they
 * run on from hit to hit rather than restarting.
 */
class HatSource {
  constructor(sampleRate) {
    this.analog = new MetalSource(sampleRate, METAL_HZ, METAL_WIDTH);
    this.thin = new MetalSource(sampleRate, THIN_HZ);
    this.extra = new MetalSource(sampleRate, DENSE_HZ);
    this.levels = new Float64Array(METAL_COUNT);
    this.lofi = new Lofi(sampleRate);
    this.reset();
  }

  reset() {
    this.analog.reset();
    this.thin.reset();
    this.extra.reset();
    this.lofi.reset();
    this.state = 1;
  }

  /** Uniform in [-1, 1): xorshift32, the same sequence on both engines. */
  white() {
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x / 2147483648 - 1;
  }

  /**
   * One sample of the source at `ratio` times the squares' frequencies, through Lofi. The squares
   * sum to a peak of one, the full scale Lofi rounds to, and are then brought to the same loudness
   * whatever their count.
   */
  next(source, ratio, noise, warp, lofi) {
    const levels = this.levels;
    let metal;
    let count;
    if (source === SOURCE_BELL) {
      count = BELL_KEPT;
      for (let k = 0; k < METAL_COUNT; k++) levels[k] = k < METAL_COUNT - BELL_KEPT ? 0 : 1 / count;
      metal = this.analog.nextFolded(ratio, levels, warp);
    } else if (source === SOURCE_THIN) {
      count = METAL_COUNT;
      levels.fill(1 / count);
      metal = this.thin.nextFolded(ratio, levels, warp);
    } else if (source === SOURCE_DENSE) {
      count = 2 * METAL_COUNT;
      levels.fill(1 / count);
      metal = this.analog.nextFolded(ratio, levels, warp) + this.extra.nextFolded(ratio, levels, warp);
    } else {
      count = METAL_COUNT;
      levels.fill(1 / count);
      metal = this.analog.nextFolded(ratio, levels, warp);
    }
    const loud = Math.sqrt(count / METAL_COUNT) / (1 + HAT_WARP_LEVEL * warp);
    const x = metal * loud * (1 - noise) + this.white() * NOISE_GAIN * noise;
    return this.lofi.next(x, lofi);
  }
}

/** One band's envelope: an exponential toward a floor under zero, stopping at zero. */
class BandEnvelope {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.start();
  }

  start() {
    this.level = 1;
    this.lastDecay = -1;
    this.lastFloor = -1;
    this.k = 1;
  }

  /** This sample's level, falling DECAY_DB over `decay` seconds toward `floor`. */
  next(decay, floor) {
    if (decay !== this.lastDecay || floor !== this.lastFloor) {
      const target = floor + Math.pow(10, -DECAY_DB / 20) * (1 - floor);
      this.k = Math.exp(Math.log(target) / (decay * this.sampleRate));
      this.lastDecay = decay;
      this.lastFloor = floor;
    }
    const out = (this.level - floor) / (1 - floor);
    this.level *= this.k;
    return out > 0 ? out : 0;
  }
}

class HatVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.band = new Svf(sampleRate);
    this.high = new Svf(sampleRate);
    this.bodyBand = new Svf(sampleRate);
    this.bodyHigh = new Svf(sampleRate);
    this.env = new BandEnvelope(sampleRate);
    this.bodyEnv = new BandEnvelope(sampleRate);
    this.kSweep = Math.exp(-1 / (HAT_SWEEP_SEC * sampleRate));
    this.age = 0;
    this.reset();
  }

  reset() {
    this.active = false;
    this.velocity = 1;
    this.toneShift = 0;
    this.decayScale = 1;
    this.choke = -1;
    this.lastTone = -1;
    this.lastSource = -1;
    this.lastRing = -1;
    this.lastShift = 0;
    this.swept = 1;
    this.ringGain = 1;
    this.env.start();
    this.bodyEnv.start();
    this.band.reset();
    this.high.reset();
    this.bodyBand.reset();
    this.bodyHigh.reset();
  }

  /** Starts a hit: `toneShift` and `decayScale` are its accent and its own small differences. */
  noteOn(velocity, toneShift, decayScale) {
    this.reset();
    this.active = true;
    this.velocity = velocity;
    this.toneShift = toneShift;
    this.decayScale = decayScale;
  }

  chokeLength() {
    return Math.max(1, Math.round(CHOKE_SEC * this.sampleRate));
  }

  /** Fades the hit out: a new one has replaced it. */
  chokeOff() {
    if (this.active && this.choke < 0) this.choke = this.chokeLength();
  }

  /** One sample of this hit from one sample of the source. */
  next(x, source, tone, decay, hold, body, ring, sweep, level) {
    const t = Math.min(1, Math.max(0, tone + this.toneShift));
    // The sweep: semitones off Tone, falling back toward it, as far as the hit was hard.
    let shift = sweep * this.velocity * this.swept;
    if (Math.abs(shift) < HAT_SWEEP_DONE) shift = 0;
    this.swept *= this.kSweep;
    if (t !== this.lastTone || source !== this.lastSource || ring !== this.lastRing || shift !== this.lastShift) {
      const hz = toneHz(t) * Math.pow(2, shift / 12);
      const wide = source === SOURCE_DENSE;
      this.band.setCutoff(hz, wide ? WIDE_RESONANCE : source === SOURCE_BELL ? BELL_RESONANCE : BAND_RESONANCE);
      this.high.setCutoff(hz * (wide ? WIDE_HIGHPASS_RATIO : HIGHPASS_RATIO), ring * HAT_RING_TOP);
      this.bodyBand.setCutoff(hz * BODY_RATIO, wide ? WIDE_RESONANCE : BODY_RESONANCE);
      this.bodyHigh.setCutoff(hz * BODY_RATIO * (wide ? WIDE_HIGHPASS_RATIO : BODY_HIGHPASS_RATIO), 0);
      this.lastTone = t;
      this.lastSource = source;
      this.lastRing = ring;
      this.lastShift = shift;
      // A ringing highpass is as loud at its corner as it is resonant; this takes most of that back.
      this.ringGain = Math.sqrt(this.high.k / 2);
    }
    const d = decay * this.decayScale;
    const floor = hold * HOLD_FLOOR;
    const e = this.env.next(d, floor);
    const eBody = this.bodyEnv.next(d * BODY_LENGTH, floor);
    const upper = this.high.next(this.band.next(x, 2) * this.band.k * e, 1) * this.ringGain;
    const lower = this.bodyHigh.next(this.bodyBand.next(x, 2) * this.bodyBand.k * eBody, 1);
    const out = upper + lower * body * BODY_GAIN;
    let gain = this.velocity * level * HAT_GAIN * (source === SOURCE_DENSE ? WIDE_GAIN : source === SOURCE_BELL ? BELL_GAIN : 1);
    if (this.choke >= 0) {
      gain *= this.choke / this.chokeLength();
      this.choke -= 1;
      if (this.choke < 0) this.active = false;
    }
    // Finished once both envelopes have landed and the highpasses have let go of the last of it.
    if (e <= 0 && (eBody <= 0 || body <= 0) && Math.abs(upper) + Math.abs(lower * body) < 1e-6) this.active = false;
    return out * gain;
  }
}

export class HatSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.source = new HatSource(sampleRate);
    // Two: the hit playing, and the one it replaced while that fades.
    this.voices = [new HatVoice(sampleRate), new HatVoice(sampleRate)];
    this.clock = 0;
    this.seed = 1;
    this.note = HAT_ROOT_NOTE;
    this.events = [];
    this.bend = 0;
    this.bendArray = null;
    this.values = Object.fromEntries(HAT.params.map((p) => [p.id, p.default]));
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    for (const p of HAT.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) this.values[p.id] = v;
    }
  }

  /** The track's bend in semitones, which retunes the squares. */
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
    this.events.push({ at: Math.max(0, offset | 0), note, velocity });
  }

  /** A hit plays out whatever the note's length: there is nothing for an off to do. */
  queueNoteOff() {}

  allNotesOff() {
    this.events.length = 0;
    for (const v of this.voices) v.chokeOff();
  }

  get activeVoices() {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  startNote(note, velocity) {
    // A free voice, or the older one; whatever else is sounding fades out under the new hit.
    let voice = null;
    for (const v of this.voices) if (!v.active) { voice = v; break; }
    if (!voice) voice = this.voices[0].age <= this.voices[1].age ? this.voices[0] : this.voices[1];
    for (const v of this.voices) if (v !== voice) v.chokeOff();
    // The accent darkens a soft hit; the two draws move this hit's Tone and Decay a little.
    this.seed = nextSeed(this.seed);
    const toneDraw = draw(this.seed);
    this.seed = nextSeed(this.seed);
    const decayDraw = draw(this.seed);
    const toneShift = ACCENT_TONE * (Math.min(1, Math.max(0, velocity)) - 1) + JITTER_TONE * toneDraw;
    voice.noteOn(velocity, toneShift, 1 + JITTER_DECAY * decayDraw);
    voice.age = this.clock++;
    this.note = note;
  }

  /** `count` samples from `offset` in the block, added into the output. */
  render(outL, outR, count, offset) {
    const p = this.values;
    const [a, b] = this.voices;
    for (let i = 0; i < count; i++) {
      if (!a.active && !b.active) return;
      const j = offset + i;
      const bend = this.bendArray ? this.bendArray[j] : this.bend;
      const ratio = Math.pow(2, (this.note + bend - HAT_ROOT_NOTE) / 12);
      const source = Math.min(HAT_SOURCES.length - 1, Math.max(0, Math.round(at(p.source, j))));
      const noise = Math.min(1, Math.max(0, at(p.noise, j)));
      const lofi = Math.min(1, Math.max(0, at(p.lofi, j)));
      const warp = Math.min(1, Math.max(0, at(p.warp, j)));
      const x = this.source.next(source, ratio, noise, warp, lofi);
      const tone = Math.min(1, Math.max(0, at(p.tone, j)));
      const decay = Math.max(1e-3, at(p.decay, j));
      const hold = Math.min(1, Math.max(0, at(p.hold, j)));
      const body = Math.min(1, Math.max(0, at(p.body, j)));
      const ring = Math.min(1, Math.max(0, at(p.ring, j)));
      const sweep = at(p.filtersweep, j);
      const level = at(p.level, j);
      let v = 0;
      if (a.active) v += a.next(x, source, tone, decay, hold, body, ring, sweep, level);
      if (b.active) v += b.next(x, source, tone, decay, hold, body, ring, sweep, level);
      outL[i] += v;
      outR[i] += v;
    }
    const lofi = this.source.lofi;
    if (!Number.isFinite(lofi.held + lofi.filter.ic1)) this.source.reset();
    for (const v of this.voices) {
      if (!Number.isFinite(v.band.ic1 + v.high.ic1 + v.bodyBand.ic1 + v.bodyHigh.ic1 + v.env.level + v.bodyEnv.level)) v.reset();
    }
  }

  /** Renders one block, split wherever a queued hit falls. */
  process(outL, outR, count) {
    const events = this.events;
    if (events.length > 1) events.sort((x, y) => x.at - y.at);
    let at0 = 0;
    let next = 0;
    while (at0 < count) {
      while (next < events.length && events[next].at <= at0) {
        const e = events[next++];
        this.startNote(e.note, e.velocity);
      }
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at0;
      if (n > 0) {
        const l = at0 === 0 && n === outL.length ? outL : outL.subarray(at0, until);
        const r = at0 === 0 && n === outR.length ? outR : outR.subarray(at0, until);
        this.render(l, r, n, at0);
      }
      at0 = until;
    }
    if (next >= events.length) events.length = 0;
    else this.events = events.slice(next).map((e) => ({ ...e, at: Math.max(0, e.at - count) }));
  }
}
