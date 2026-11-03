// The Kick: an analog-style bass drum, one hit per note.
//
// Fitted to measurements of a classic analog kick circuit; every constant below is from that fit.
//
// THE PITCH starts Sweep semitones above the note and falls to the note on ONE FIXED CURVE. The
// trigger pulse charges it (a short Click Length charges it less), it holds a moment, then falls
// as an exponential with an offset: (1 + knee) e^(-t/tau) - knee, which reaches the note in a
// finite time (about 70 ms) with a knee rather than creeping in for ever. The excess is in hertz,
// as an oscillator driven by a control current has it, so the drop is slow at the top and quick
// near the note. A drawn curve replaces the fixed one's shape and Sweep stays its depth: the
// curve's top is Sweep semitones above the note, its bottom the note, on a square-root time axis
// 0 to 400 ms (see KICK_DRAW_SEC) - so a curve transposes with the note it is played on.
//
// THE BODY is a sine through the level envelope and then a saturator (tanh) whose Drive is the
// circuit's, offset a little so the wave is tipped and has even harmonics: at the measured
// settings it squares the wave off, and since the saturator comes
// after the envelope, the level holds near full while the envelope is above it and the wave
// rounds off as the hit dies. A slow highpass after it sags the flat tops, as a coupling
// capacitor does. The level envelope is the same offset exponential: Decay is the time it
// reaches zero, Decay Curve its shape - up holds the belly, down falls away quickly into a thin
// tail. A drawn Amp Env replaces that shape, stretched over Decay.
//
// THE CLICK is the trigger pulse (rising over a fraction of a millisecond, falling on the pulse's
// end), a tick of sine at Click Pitch for as long as the pulse, or a burst of white noise for as
// long (Click Tone runs from the tick through the pulse to the noise). Both edges of the pulse are
// band-limited with a polynomial step correction. A Click Sample replaces that source: the file
// plays from its start, transposed by Click Pitch, which reads in semitones while a sample is on.
// Either goes through Click HP and Click LP and is added before the saturator at Click's level; a
// sample's highpass never sits below where the sweep starts, so its lows cannot fight the body's.
// Tone is a gentle lowpass over the whole hit: up is bright, down is soft.
//
// One hit sounds at a time: a new note restarts the sweep, and whatever was still ringing is
// faded out over a few milliseconds rather than cut. Note offs are ignored - a hit plays out.
//
// Translated line for line into native/devices/own/kick.cc for the desktop, and held to it by
// native-device-parity.test.mjs. Everything is computed in double and written to the output once
// per sample, as the C++ does.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** The most Sweep reaches, in semitones above the note. */
export const KICK_SWEEP_MAX_ST = 48;
/** The fixed curve's time constant and knee (see the header). */
export const KICK_SWEEP_SEC = 0.073;
export const KICK_SWEEP_KNEE = 0.66;
/** How long the sweep holds after the pulse before it falls. */
export const KICK_SWEEP_HOLD_SEC = 0.003;
/** How fast the trigger pulse charges the sweep: a pulse this long gets it to 63%. */
export const KICK_CHARGE_SEC = 0.0005;
/** A drawn pitch curve's time axis: 0 to this many seconds, read on a square root (x = sqrt(t / span)). */
export const KICK_DRAW_SEC = 0.4;
/** Drive's saturation, from clean to square. */
export const KICK_DRIVE_MIN = 0.1;
export const KICK_DRIVE_MAX = 6;
/** Decay Curve's knee on the level envelope: an exponential at the bottom, near a straight line at the top. */
export const KICK_CURVE_KNEE_MIN = 0.02;
export const KICK_CURVE_KNEE_MAX = 3;
/** The longest Decay, which is the span the picture of the level is drawn over. */
export const KICK_DECAY_MAX = 4;
/** The saturator's offset, which tips the wave and gives it its even harmonics (about -25 dB second). */
export const KICK_BODY_BIAS = 0.08;
/** The coupling highpass after the saturator. */
const KICK_BODY_HP_HZ = 4;
/** The pulse's rise. */
const KICK_CLICK_RISE_SEC = 0.0004;
/** The noise's level against the pulse's. */
const KICK_NOISE_GAIN = 0.7;
/**
 * Click Pitch's range. Its middle is a sample's own pitch, and either end is two octaves from it,
 * which is what the knob reads in semitones while a sample is on.
 */
export const KICK_CLICK_PITCH_MIN = 375;
export const KICK_CLICK_PITCH_CENTER = 1500;
export const KICK_CLICK_PITCH_MAX = 6000;
/** Tone's lowpass, fully soft and fully bright. */
const KICK_TONE_SOFT_HZ = 150;
const KICK_TONE_BRIGHT_HZ = 20000;
/** Below this the hit has finished. */
const KICK_SILENT = 1e-5;
/** How long a hit that a new one replaces takes to fade. */
const KICK_CHOKE_SEC = 0.003;
/**
 * Drive is full up to the first of these fundamentals (as a share of the sample rate) and gone by
 * the second: the saturator's upper harmonics would otherwise fold back down.
 */
const KICK_DRIVE_FULL = 1 / 48;
const KICK_DRIVE_NONE = 1 / 12;
/** The note a picture of the sweep is labeled for before anything has played: f0. */
export const KICK_FIGURE_NOTE = 29;

const KICK_TWO_PI = 2 * Math.PI;

/** Drive's position to the saturator's gain. */
export const kickDrive = (drive) => KICK_DRIVE_MIN + (KICK_DRIVE_MAX - KICK_DRIVE_MIN) * Math.min(1, Math.max(0, drive));
/** Decay Curve's position to the level envelope's knee. */
export const kickCurveKnee = (curve) => KICK_CURVE_KNEE_MIN * Math.pow(KICK_CURVE_KNEE_MAX / KICK_CURVE_KNEE_MIN, Math.min(1, Math.max(0, curve)));

/** The fixed level envelope `t` of the way through a hit (0..1 of Decay), at a Decay Curve of `curve`. */
export function kickLevelAt(curve, t) {
  const knee = kickCurveKnee(curve);
  const v = (1 + knee) * Math.pow(knee / (1 + knee), t) - knee;
  return v > 0 ? v : 0;
}

/**
 * Settings that start from a kind of kick, by name: controls in real units, the rest at their
 * defaults. Each is the middle of a group of measured hits; the defaults are `classic`.
 */
export const KICK_PRESETS = Object.freeze({
  classic: { sweep: 31, decay: 0.69, drive: 0.32, dcurve: 0.86, click: 0.51, clicktone: 0.525, clicklength: 2, tone: 0.45 },
  hard: { sweep: 29, decay: 0.42, drive: 0.72, dcurve: 0.37, click: 1, clicktone: 0.775, clicklength: 2.15, tone: 0.41 },
  bright: { sweep: 25, decay: 0.67, drive: 0.29, dcurve: 0.65, click: 0.55, clicktone: 0.59, clicklength: 1.84, tone: 0.79 },
  short: { sweep: 27.5, decay: 0.11, drive: 0.36, dcurve: 0.65, click: 0.4, clicktone: 0.605, clicklength: 1.9, tone: 0.61 },
  rumble: { sweep: 25, decay: 2, drive: 0.28, dcurve: 0.5, click: 0.39, clicktone: 0.6, clicklength: 1.5, tone: 0.64 },
  soft: { sweep: 35, decay: 0.95, drive: 0.55, dcurve: 0.9, click: 0.44, clicktone: 0.5, clicklength: 2.2, tone: 0.05 },
});

/**
 * Pitch curves for the shape editor to start a drawing from, in the drawn curve's space: x the
 * square root of the time over KICK_DRAW_SEC, y the share of Sweep. The fixed curve is added by
 * the picture, at the Sweep and Click Length set.
 */
export const KICK_PITCH_CURVES = Object.freeze({
  snap: '0,1 0.05,0.7 0.12,0.35 0.2,0.1 0.25,0 1,0',
  glide: '0,1 0.1,0.75 0.25,0.45 0.45,0.22 0.7,0.08 0.87,0 1,0',
  'two-stage': '0,1 0.08,0.45 0.15,0.3 0.5,0.15 0.8,0 1,0',
  linear: '0,1 0.158,0.9 0.25,0.75 0.354,0.5 0.433,0.25 0.5,0 1,0',
});

/**
 * Level curves for the shape editor to start a drawing from: x the share of Decay, y the level.
 * The fixed curve is added by the picture, at the Decay Curve set.
 */
export const KICK_AMP_CURVES = Object.freeze({
  hold: '0,1 0.7,0.95 0.85,0.4 1,0',
  exponential: '0,1 0.1,0.55 0.25,0.25 0.5,0.07 1,0',
  linear: '0,1 1,0',
  punch: '0,1 0.05,0.6 0.4,0.5 0.8,0.2 1,0',
});

const FIXED_ONLY = { param: 'ampenv', is: 'fixed' };
const NO_SAMPLE = { param: 'clicksample', is: 'none' };

export const KICK = defineDevice({
  id: 'Kick',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-kick',
  description: 'An analog-style bass drum: a saturated body swept down to the note on a fixed curve, or one you draw, with a click on top. The note is the pitch the sweep settles on.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'sweep', name: 'Sweep', min: 0, max: KICK_SWEEP_MAX_ST, default: 31, unit: 'st', group: 'Body',
      description: 'How far above the note the pitch starts, in semitones - the depth of the fixed curve or a drawn one. High is a hard, punchy hit; low a round one.' },
    { id: 'pitchenv', name: 'Pitch Env', default: 0, options: ['fixed'], takes: 'shape', rate: 'k', group: 'Body',
      description: 'The shape of the pitch over the hit: the fixed curve, or one you draw over the first 400 ms, from Sweep above the note down to the note.' },
    { id: 'drive', name: 'Drive', min: 0, max: 1, default: 0.32, group: 'Body',
      description: 'Saturates the body, from a clean sine to a squared-off, harder tone that holds its level longer.' },
    { id: 'decay', name: 'Decay', min: 0.05, max: KICK_DECAY_MAX, default: 0.69, unit: 's', curve: 'exp', group: 'Amp Env', amp: 'decay',
      description: 'The length of the hit: the time its level takes to reach zero.' },
    { id: 'dcurve', name: 'Decay Curve', min: 0, max: 1, default: 0.86, group: 'Amp Env', active: FIXED_ONLY,
      description: 'The shape of the decay: up holds the belly to the end, down falls away quickly into a thin tail.' },
    { id: 'ampenv', name: 'Amp Env', default: 0, options: ['fixed'], takes: 'shape', rate: 'k', group: 'Amp Env',
      description: 'The level over the hit: the fixed curve Decay Curve shapes, or one you draw, stretched over Decay.' },
    { id: 'click', name: 'Click', min: 0, max: 1, default: 0.51, group: 'Click',
      description: 'The level of the click on top of the hit.' },
    { id: 'clicktone', name: 'Click Tone', min: 0, max: 1, default: 0.525, group: 'Click', active: NO_SAMPLE,
      description: 'From a pitched tick (0) through the trigger pulse (0.5) to a burst of noise (1).' },
    { id: 'clickpitch', name: 'Click Pitch', min: KICK_CLICK_PITCH_MIN, max: KICK_CLICK_PITCH_MAX, default: KICK_CLICK_PITCH_CENTER,
      unit: 'Hz', curve: 'exp', group: 'Click', alt: { param: 'clicksample', not: 'none', unit: 'st', min: -24, max: 24 },
      description: 'The pitch of the tick, or with a Click Sample on, how far the sample is transposed, in semitones.' },
    { id: 'clickhp', name: 'Click HP', min: 20, max: 8000, default: 20, unit: 'Hz', curve: 'exp', group: 'Click',
      description: 'A highpass on the click. A sample is always cut at least where the sweep starts.' },
    { id: 'clicklp', name: 'Click LP', min: 300, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', group: 'Click',
      description: 'A lowpass on the click.' },
    { id: 'clicklength', name: 'Click Length', min: 0.1, max: 15, default: 2, unit: 'ms', curve: 'exp', rate: 'k', group: 'Click',
      description: 'The length of the trigger pulse. Shorter is a brighter click and less sweep.' },
    { id: 'clicksample', name: 'Click Sample', default: 0, options: ['none'], takes: 'sample', rate: 'k', group: 'Click',
      description: 'A file to play as the click instead of the pulse, with its lows cut where the sweep starts so it sits on the body.' },
    { id: 'tone', name: 'Tone', min: 0, max: 1, default: 0.45, group: 'Output',
      description: 'A gentle lowpass over the whole hit: up is bright and punchy, down is soft and round.' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.7, group: 'Output' },
  ],
  figures: [
    {
      id: 'sweep',
      kind: 'hitpitch',
      group: 'Body',
      // No title: the curve's name heads the picture, in the control that picks it.
      description: 'The pitch over the first 400 ms of the hit, labeled for the note last played.',
      params: { shape: 'pitchenv', sweep: 'sweep', clicklength: 'clicklength' },
      // The curve control belongs ON the picture of the curve, as a waveshaper's mode heads its own.
      subsumes: ['shape'],
    },
    {
      id: 'level',
      kind: 'hitlevel',
      group: 'Amp Env',
      description: 'The level over the hit, out to the longest Decay.',
      params: { shape: 'ampenv', decay: 'decay', curve: 'dcurve' },
      subsumes: ['shape'],
    },
  ],
  presets: KICK_PRESETS,
});

/** A drawn curve, read at `t` - linear between the points the engine sampled. */
export function kickDrawnAt(table, t) {
  const n = table.length;
  const x = Math.min(1, Math.max(0, t)) * (n - 1);
  const i = Math.floor(x);
  const a = table[i];
  const b = table[Math.min(n - 1, i + 1)];
  return a + (b - a) * (x - i);
}

/** Where `seconds` into the hit sits on a drawn pitch curve's time axis, 0..1. */
export const kickDrawX = (seconds) => Math.sqrt(Math.max(0, seconds) / KICK_DRAW_SEC);

/**
 * The trigger pulse at sample `n` of a hit whose pulse ends at `edge` samples: 1 while it is high,
 * with both edges band-limited by a polynomial step correction. The rising edge is on sample 0.
 */
export function kickGateAt(n, edge) {
  let g = n < edge ? 1 : 0;
  if (n === 0) g -= 0.5;
  if (n < edge && edge <= n + 1) {
    const p = n + 1 - edge;
    g -= p * p * 0.5;
  } else if (n - 1 < edge && edge <= n) {
    const p = n - edge;
    g += (1 - p) * (1 - p) * 0.5;
  }
  return g;
}

/**
 * The fixed sweep, stepped a sample at a time: 0..1 of the way from the note to Sweep above it.
 * The voice plays it, and the panel's picture of it is drawn by stepping the same thing.
 */
export class KickSweep {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.kc = 1 - Math.exp(-1 / (KICK_CHARGE_SEC * sampleRate));
    this.kFall = Math.exp(-1 / (KICK_SWEEP_SEC * sampleRate));
    this.hold = KICK_SWEEP_HOLD_SEC * sampleRate;
    this.start(0);
  }

  /** A new hit, whose pulse ends `edge` samples in. */
  start(edge) {
    this.edge = edge;
    this.charge = 0;
    this.fall = 1;
  }

  /** Sample `n`'s sweep. */
  next(n) {
    if (n < this.edge) {
      this.charge += (1 - this.charge) * this.kc;
      return this.charge;
    }
    if (n < this.edge + this.hold) return this.charge;
    const e = (1 + KICK_SWEEP_KNEE) * this.fall - KICK_SWEEP_KNEE;
    this.fall *= this.kFall;
    return e > 0 ? this.charge * e : 0;
  }
}

/** The pitch at a sweep of `e` (0..1), for a note at `hz` and a Sweep of `st` semitones. */
export const kickSweptHz = (hz, st, e) => hz * (1 + (Math.pow(2, st / 12) - 1) * e);

class KickVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.sweep = new KickSweep(sampleRate);
    this.active = false;
    this.reset();
  }

  reset() {
    this.active = false;
    this.n = 0;
    this.note = 0;
    this.velocity = 1;
    this.age = 0;
    this.phase = 0;
    this.edge = 0;
    this.pitchTable = null;
    this.ampTable = null;
    this.sweep.start(0);
    this.env = 1;
    this.choke = -1;
    this.state = 1;
    this.hpIn = 0;
    this.hpOut = 0;
    this.lp = 0;
    this.tickPhase = 0;
    this.clp = 0;
    this.sample = null;
    this.spos = 0;
    this.sstep = 1;
    this.floorHz = 0;
    this.hx1 = 0; this.hx2 = 0; this.hy1 = 0; this.hy2 = 0;
  }

  /**
   * Starts a hit. The pulse's length is read here: it is the trigger, not a control on the sound.
   * So are the click sample and the lowest its highpass goes - where the sweep starts for this note.
   */
  noteOn(note, velocity, seed, clickMs, pitchTable, ampTable, sample, sweepSt) {
    this.reset();
    this.active = true;
    this.note = note;
    this.velocity = velocity;
    this.state = (seed >>> 0) || 1;
    this.edge = Math.max(0, clickMs) * 0.001 * this.sampleRate;
    this.sweep.start(this.edge);
    this.pitchTable = pitchTable;
    this.ampTable = ampTable;
    if (sample !== null) {
      const sr = this.sampleRate;
      this.sample = sample;
      this.sstep = sample.sampleRate / sr;
      const st = Math.min(KICK_SWEEP_MAX_ST, Math.max(0, sweepSt));
      this.floorHz = midiToHz(note) * Math.pow(2, st / 12);
    }
  }

  /** Fades the hit out: a new one has replaced it. */
  chokeOff() {
    if (this.active && this.choke < 0) this.choke = Math.max(1, Math.round(KICK_CHOKE_SEC * this.sampleRate));
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

  /** Renders `count` samples of this hit and adds them into the output. */
  process(outL, outR, count, offset, s) {
    const sr = this.sampleRate;
    const p = s.values;
    const hpA = Math.exp((-KICK_TWO_PI * KICK_BODY_HP_HZ) / sr);
    const kRise = Math.exp(-1 / (KICK_CLICK_RISE_SEC * sr));
    let lastTone = -1;
    let kTone = 1;
    let lastDecay = -1;
    let lastCurve = -1;
    let knee = 1;
    let kEnv = 1;
    let lastHp = -1;
    let hb0 = 0, hb1 = 0, hb2 = 0, ha1 = 0, ha2 = 0;
    let lastLp = -1;
    let kClick = 1;
    for (let i = 0; i < count; i++) {
      if (!this.active) break;
      const j = offset + i;
      const n = this.n;

      // The pitch: the fixed sweep, or the drawn curve, Sweep deep.
      const noteHz = midiToHz(this.note + s.bendAt(j));
      const st = Math.min(KICK_SWEEP_MAX_ST, Math.max(0, at(p.sweep, j)));
      let hz;
      if (this.pitchTable !== null) {
        hz = noteHz * Math.pow(2, (st * kickDrawnAt(this.pitchTable, kickDrawX(n / sr))) / 12);
      } else {
        hz = kickSweptHz(noteHz, st, this.sweep.next(n));
      }
      hz = Math.min(0.49 * sr, hz);

      // The level envelope: an exponential with a knee reaching zero at Decay, or the drawn one
      // stretched over Decay.
      const decay = Math.max(1e-3, at(p.decay, j));
      let level;
      if (this.ampTable !== null) {
        const x = n / (decay * sr);
        const v = x < 1 ? kickDrawnAt(this.ampTable, x) : 0;
        level = v > 0 ? v : 0;
      } else {
        const curve = at(p.dcurve, j);
        if (decay !== lastDecay || curve !== lastCurve) {
          knee = kickCurveKnee(curve);
          kEnv = Math.exp(-Math.log((1 + knee) / knee) / (decay * sr));
          lastDecay = decay;
          lastCurve = curve;
        }
        const envNow = (1 + knee) * this.env - knee;
        level = envNow > 0 ? envNow : 0;
        this.env *= kEnv;
      }

      // The click's source: the sample, transposed by Click Pitch; or the tick, the pulse or the
      // noise for as long as the pulse is high.
      const pitch = Math.min(KICK_CLICK_PITCH_MAX, Math.max(KICK_CLICK_PITCH_MIN, at(p.clickpitch, j)));
      let src = 0;
      let sounding = false;
      if (this.sample !== null) {
        const d = this.sample.data;
        if (this.spos < d.length) {
          const k = Math.floor(this.spos);
          const f = this.spos - k;
          const a = d[k];
          const b = k + 1 < d.length ? d[k + 1] : 0;
          src = a + (b - a) * f;
          this.spos += this.sstep * (pitch / KICK_CLICK_PITCH_CENTER);
          sounding = true;
        }
      } else if (n <= this.edge + 1) {
        const gate = kickGateAt(n, this.edge);
        const shape = Math.min(1, Math.max(0, at(p.clicktone, j)));
        const pulse = gate * (1 - Math.pow(kRise, n));
        if (shape < 0.5) {
          const w = shape * 2;
          const tick = pulse * Math.sin(KICK_TWO_PI * this.tickPhase);
          src = (1 - w) * tick + w * pulse;
        } else {
          const w = (shape - 0.5) * 2;
          src = (1 - w) * pulse + w * this.white() * KICK_NOISE_GAIN * gate;
        }
        this.tickPhase += pitch / sr;
        if (this.tickPhase >= 1) this.tickPhase -= 1;
      }

      // Click HP, a second-order Butterworth (the cookbook's), never below a sample's floor; then
      // Click LP, one pole.
      const hpHz = Math.min(0.45 * sr, Math.max(this.floorHz, at(p.clickhp, j)));
      if (hpHz !== lastHp) {
        const w = (KICK_TWO_PI * hpHz) / sr;
        const cw = Math.cos(w);
        const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
        const a0 = 1 + alpha;
        hb0 = (1 + cw) / 2 / a0;
        hb1 = -(1 + cw) / a0;
        hb2 = hb0;
        ha1 = (-2 * cw) / a0;
        ha2 = (1 - alpha) / a0;
        lastHp = hpHz;
      }
      const y = hb0 * src + hb1 * this.hx1 + hb2 * this.hx2 - ha1 * this.hy1 - ha2 * this.hy2;
      this.hx2 = this.hx1; this.hx1 = src;
      this.hy2 = this.hy1; this.hy1 = y;
      const lpHz = Math.min(0.49 * sr, Math.max(1, at(p.clicklp, j)));
      if (lpHz !== lastLp) {
        kClick = 1 - Math.exp((-KICK_TWO_PI * lpHz) / sr);
        lastLp = lpHz;
      }
      this.clp += kClick * (y - this.clp);
      const click = at(p.click, j) * this.clp;

      // The body, through the saturator with the click, as much Drive as the pitch allows.
      const ratio = hz / sr;
      const room = Math.min(1, Math.max(0, (KICK_DRIVE_NONE - ratio) / (KICK_DRIVE_NONE - KICK_DRIVE_FULL)));
      const drive = KICK_DRIVE_MIN + (kickDrive(at(p.drive, j)) - KICK_DRIVE_MIN) * room;
      const body = -Math.sin(KICK_TWO_PI * this.phase) * level;
      this.phase += ratio;
      if (this.phase >= 1) this.phase -= 1;
      const lift = Math.tanh(drive * KICK_BODY_BIAS);
      const shaped = (Math.tanh(drive * (body + click + KICK_BODY_BIAS)) - lift) / (Math.tanh(drive * (1 + KICK_BODY_BIAS)) - lift);
      this.hpOut = hpA * (this.hpOut + shaped - this.hpIn);
      this.hpIn = shaped;

      // Tone, then the hit's level, its velocity and a fade when it has been replaced.
      const tone = Math.min(1, Math.max(0, at(p.tone, j)));
      if (tone !== lastTone) {
        kTone = 1 - Math.exp((-KICK_TWO_PI * KICK_TONE_SOFT_HZ * Math.pow(KICK_TONE_BRIGHT_HZ / KICK_TONE_SOFT_HZ, tone)) / sr);
        lastTone = tone;
      }
      this.lp += kTone * (this.hpOut - this.lp);
      let gain = this.velocity * at(p.level, j);
      if (this.choke >= 0) {
        gain *= this.choke / Math.max(1, Math.round(KICK_CHOKE_SEC * sr));
        this.choke -= 1;
        if (this.choke < 0) this.active = false;
      }
      const v = this.lp * gain;
      outL[i] += v;
      outR[i] += v;
      this.n = n + 1;

      // Finished once the level has gone and the click with it.
      if (level === 0 && !sounding && n > this.edge + 1 && Math.abs(click) < KICK_SILENT
        && Math.abs(this.lp) < KICK_SILENT && Math.abs(this.hpOut) < KICK_SILENT) this.active = false;
    }
    if (!Number.isFinite(this.lp + this.hpOut + this.phase + this.clp + this.hy1)) this.reset();
  }
}

export class KickSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Two: the hit playing, and the one it replaced while that fades.
    this.voices = [new KickVoice(sampleRate), new KickVoice(sampleRate)];
    this.clock = 0;
    this.seed = 1;
    this.events = [];
    this.bend = 0;
    this.bendArray = null;
    this.shapes = { pitchenv: [], ampenv: [] }; // control -> option index -> a drawn curve
    this.samples = [];        // option index -> a loaded click
    this.lastNote = null;     // what the picture labels its pitches for
    this.state = {
      values: Object.fromEntries(KICK.params.map((p) => [p.id, p.default])),
      bendAt: (i) => (this.bendArray ? this.bendArray[i] : this.bend),
    };
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.state;
    for (const p of KICK.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s.values[p.id] = v;
    }
  }

  /** The track's bend in semitones, which moves the pitch the sweep settles on. */
  setBend(bend) {
    if (typeof bend === 'number') {
      this.bend = Number.isFinite(bend) ? bend : 0;
      this.bendArray = null;
    } else {
      this.bend = bend[0];
      this.bendArray = bend;
    }
  }

  /** Keeps a drawn curve in a Pitch Env or Amp Env slot. */
  loadShape(paramId, index, table) {
    if (!(paramId in this.shapes) || !table?.length) return false;
    this.shapes[paramId][Math.max(0, Math.round(index))] = table;
    return true;
  }

  /** Keeps a loaded click, summed to one channel at its own rate, in a Click Sample slot. */
  loadSample(paramId, index, payload) {
    if (paramId !== 'clicksample' || !payload?.channels?.length) return false;
    const chans = payload.channels;
    let data = chans[0];
    if (chans.length > 1) {
      data = new Float32Array(chans[0].length);
      for (const c of chans) for (let i = 0; i < data.length; i++) data[i] += c[i] / chans.length;
    }
    this.samples[Math.max(0, Math.round(index))] = { data, sampleRate: payload.sampleRate ?? this.sampleRate };
    return true;
  }

  /** The note last played, for the picture of the sweep to label its pitches with. */
  report() {
    return this.lastNote === null ? null : { note: this.lastNote };
  }

  queueNoteOn(note, velocity, offset = 0) {
    this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity });
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

  /** The drawn curve `id` is on, or null for the fixed one. */
  _drawn(id) {
    const index = Math.round(at(this.state.values[id], 0));
    if (!(index >= 1)) return null;
    return this.shapes[id][index] ?? null;
  }

  /** The click file Click Sample is on, or null for none. */
  _sample() {
    const index = Math.round(at(this.state.values.clicksample, 0));
    if (!(index >= 1)) return null;
    const one = this.samples[index];
    return one?.data?.length ? one : null;
  }

  startNote(note, velocity) {
    // A free voice, or the older one; whatever else is sounding fades out under the new hit.
    let voice = null;
    for (const v of this.voices) if (!v.active) { voice = v; break; }
    if (!voice) voice = this.voices[0].age <= this.voices[1].age ? this.voices[0] : this.voices[1];
    for (const v of this.voices) if (v !== voice) v.chokeOff();
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    const values = this.state.values;
    voice.noteOn(note, velocity, this.seed, at(values.clicklength, 0), this._drawn('pitchenv'), this._drawn('ampenv'),
      this._sample(), at(values.sweep, 0));
    voice.age = this.clock++;
    this.lastNote = note;
  }

  /** Renders one block, split wherever a queued hit falls. */
  process(outL, outR, count) {
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);
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
