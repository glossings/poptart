// The Acid synth: one voice of the classic acid bassline machine, modeled from its circuit - a
// saw or the square its shaper makes of it, a four-pole diode ladder with a highpass inside its
// feedback, a filter envelope, an amp envelope, the accent sweep and the slide.
//
// THE OSCILLATOR is a rising saw, band-limited by placing each reset at its exact fraction of a
// sample (dsp/blep.mjs). The square is not a pulse of its own: as on the circuit it is the saw
// through a single-transistor shaper, -tanh(70·saw + 4.37) (about 37 dB of gain and an offset),
// after a 54 Hz coupling highpass. The highpass makes each ramp sag toward zero, so where the
// shaper flips depends on the pitch - the low notes come out lopsided and the high ones nearly
// even - and the shaper's gain leaves its middle edge slow. Its reset is a jump of the shaper's
// output, band-limited like the saw's. It is half the saw's height. Waveform blends the two.
//
// THE FILTER is the diode ladder: four capacitors coupled through diode pairs, the one at the
// output end half the size of the rest, which is the response
//   H(s) = 1 / (s^4 + 6.727 s^3 + 14.142 s^2 + 9.514 s + 1)
// at zero resonance: four poles, 24 dB an octave, with the poles spread so the knee comes in early
// and soft. Each diode pair is a saturating curve on the difference across it. The resonance is
// negative feedback from the output to the bottom, through a 150 Hz highpass: under it nothing is
// fed back, so the bass is not cut by the resonance the way the band around the cutoff is, and
// the filter cannot whistle on its own at the bottom of its range. The loop gain reaches 17, a
// hair over where the linear loop would start to ring on its own, which the curves hold to a
// squeal rather than a tone. It is solved as a zero-delay-feedback filter - trapezoidal
// integrators, each curve linearized around where it was a step ago, the loop (highpass and all)
// closed in the same step - at four times the sample rate through the polyphase half-bands of
// dsp/analog.mjs. Resonance is skewed toward its top, and the output is made up for the band the
// resonance takes away, fully, so a held note keeps its level as Resonance comes up and only the
// peak stands out (the circuit itself makes up only part of it).
//
// CHARACTER is not the circuit's. At zero the filter is the ladder above, whose lowest pole sits
// a decade under the resonant peak the cutoff names, so with the resonance down it is a soft,
// one-pole-like slope. Turned up, each stage loads the one before less (the coupling back from
// the next stage is scaled down to nothing), the end capacitor grows to the size of the rest, a
// loop gain of up to one goes round outside the highpass, and the stages are retuned: at one it
// is four equal buffered stages whose corner at zero resonance lands on the cutoff, 21 dB down an
// octave on and 42 two octaves on, with the resonant peak back on the cutoff as the resonance
// comes up. The loop gain at the top of Resonance goes from 17 to 4 with it.
//
// THE SWEEP. Cutoff is the knob, Env Mod how far the filter envelope moves it, both as the
// circuit's fitted curves: Env Mod raises the top of the sweep and lowers its floor together.
//
//   c = the Cutoff knob's position, e = Env Mod
//   scale  = (1 - c)(3.774 e + 0.737) + c (4.195 e + 0.864)
//   offset = 0.0483 c + 0.2944
//   cutoff = Cutoff · 2^(scale · (envelope - offset) + 2.5 · accent sweep)
//
// THE ENVELOPES. The filter envelope rises at once and falls exponentially, over Decay on a plain
// note and over 0.2 s on an accented one whatever Decay says - to about 5% in that time, three
// time constants. It also opens the amplifier a little
// (by up to 0.45 more). The amp envelope rises in 3 ms and falls with a 1.23 s time constant while
// the gate is up; at the gate's end it holds 8 ms and then falls to nothing over 8 more.
//
// THE ACCENT. A note at velocity 0.9 or more is accented: the filter envelope, scaled by Accent,
// charges the accent sweep circuit - a diode and 47k into one end of the second gang of the
// Resonance pot (100k), a 1 µF capacitor at the other end, and the circuits it feeds (taken as
// 100k) as its load. With the resonance low the capacitor sits on the output and the sweep is the
// envelope smoothed a little; with it high the capacitor charges through 147k and drains through
// the pot and the load, and the diode will not let it back out the way it came - so a run of
// accents stacks, each one opening the filter further than the last. The circuit is solved
// exactly every sample (backward Euler, the diode on or off). Its output moves the cutoff, by up
// to 2.5 octaves, and the level, by up to twice. Sweep scales the capacitor.
//
// THE SLIDE. A note marked to slide (see Sig#slide) while the voice is sounding keeps the gate
// up: neither envelope starts again, and the pitch glides through an RC lag - a fixed time
// whatever the interval, most of the way there in Slide. The note it slides to takes its own
// accent. A plain note jumps straight to its pitch and starts both envelopes. One voice: a note
// over another starts it over, as the circuit's gate does.
//
// THE COUPLING. A 44 Hz highpass before the filter; after the amplifier a 14 Hz allpass, a 24 Hz
// highpass and a broad notch at 7.5 Hz, as the output stages put there - the shape of the low end
// a note thumps with, and no DC. No saturation on the way out unless Drive asks for it.
//
// Translated line for line into native/devices/own/acid.cc for the desktop, and held to it by
// native-device-parity.test.mjs. Everything is computed in double.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { BlepLine } from '../dsp/blep.mjs';
import { ANALOG_HALFBAND_A, ANALOG_HALFBAND_B, AnalogHalfband, analogClip, analogClipGain } from '../dsp/analog.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** The Cutoff knob's ends, in Hz. */
export const ACID_CUTOFF_MIN = 314;
export const ACID_CUTOFF_MAX = 2394;
/**
 * The velocity from which a note is accented: 0.9, compared as the MIDI velocity it is on the
 * desktop (114), where a velocity arrives as a step of 1/127 and 0.9 lands just under it.
 */
export const ACID_ACCENT_FROM = 0.9;
const ACID_ACCENT_STEP = Math.round(ACID_ACCENT_FROM * 127);
/** How long the filter envelope falls on an accented note, in seconds, whatever Decay says. */
export const ACID_ACCENT_DECAY = 0.2;
/**
 * Decay is the whole fall, not its time constant: three time constants, so the envelope is down
 * to about 5% when Decay has passed.
 */
export const ACID_DECAY_SPANS = 3;

// The oscillator.
/** The square's shaper: its gain (36.9 dB) and its offset, against a saw of ±1. */
const ACID_SHAPER_GAIN = 69.98;
const ACID_SHAPER_OFFSET = 4.37;
/** The coupling highpass in front of the shaper, in Hz. */
const ACID_SHAPER_HP = 54;
/** The square against the saw. */
const ACID_SQUARE_LEVEL = 0.5;
/** The highest the oscillator plays, as a share of the sample rate. */
const ACID_TOP = 0.45;

// The filter.
/** The loop gain at the top of Resonance, and how hard the knob is skewed toward it. */
export const ACID_FEEDBACK = 17;
const ACID_SKEW = 3;
/** The highpass inside the feedback, in Hz. */
export const ACID_FEEDBACK_HP = 150;
/**
 * The ladder's own resonant frequency in units of its stage corner: with the end capacitor at
 * half size the loop turns 180 degrees at 1.4132 times one stage's corner (see dsp/analog.mjs).
 */
const ACID_TUNE = 1.4132;
/**
 * Character at one: four buffered stages of the same size, each a one-pole of its own, with a
 * loop gain of one around them even at zero resonance (not through the feedback highpass), which
 * squares the knee off: 1 / ((1 + s)^4 + 1), made back up to unity in the passband, is 3 dB down
 * at 0.9779 of one stage's corner, 21 dB an octave on and 42 two octaves on, with 2.3 dB of rise
 * before the knee. The stages are tuned up by that 0.9779 so the corner lands on the cutoff;
 * with the resonance up they come back down to it, where the peak is. The loop starts to ring at 4.
 */
const ACID_SHARP_TUNE = 1.0225978666301174;
const ACID_SHARP_BASE = 1;
export const ACID_SHARP_FEEDBACK = 4;
/** The cutoff's clamps: in Hz at the bottom, as a share of the sample rate at the top. */
const ACID_LOWEST = 20;
const ACID_HIGHEST = 0.45;
/** How far a full accent sweep moves the cutoff, in octaves. */
const ACID_ACCENT_OCTAVES = 2.5;
/** States smaller than this are flushed to zero, so a decaying tail never goes subnormal. */
const ACID_FLUSH = 1e-20;

// The envelopes.
const ACID_AMP_ATTACK = 0.003;
const ACID_AMP_DECAY = 1.23;
const ACID_GATE_HOLD = 0.008;
const ACID_GATE_FALL = 0.008;
/** How much the filter envelope opens the amplifier, and a full accent sweep. */
const ACID_ENV_TO_AMP = 0.45;
const ACID_ACCENT_TO_AMP = 1;

// The accent sweep circuit, in kilohms and microfarads (so its times are in milliseconds).
const ACID_SWEEP_FEED = 47;
const ACID_SWEEP_POT = 100;
const ACID_SWEEP_LOAD = 100;
const ACID_SWEEP_CAP = 1;
/** The pot's least, so the capacitor is never tied straight to the output. */
const ACID_SWEEP_POT_MIN = 0.5;
/** What the output settles at under a steady input of one, which is a full sweep. */
const ACID_SWEEP_FULL = (1 / ACID_SWEEP_FEED) / (1 / ACID_SWEEP_FEED + 1 / ACID_SWEEP_LOAD);

// The coupling, in Hz, and the notch's width.
const ACID_INPUT_HP = 44;
const ACID_OUTPUT_AP = 14;
const ACID_OUTPUT_HP = 24;
const ACID_NOTCH = 7.5;
const ACID_NOTCH_Q = 0.3;

/** How much Drive pushes into the clipper at its top. */
const ACID_DRIVE_GAIN = 15;
/** The voice's level against Volume. */
const ACID_OUTPUT_GAIN = 0.34;
/** How long after the gate falls the voice keeps running, so the coupling's tail settles. */
const ACID_TAIL = 0.25;

// --- the descriptor ---------------------------------------------------------------------------

const ACID_MAIN = 'Acid';
const ACID_CIRCUIT = 'Circuit';

/** Starting points for the preset menu: each the defaults with these controls changed. */
export const ACID_PRESETS = Object.freeze({
  squelch: { waveform: 0, cutoff: 520, resonance: 0.85, envmod: 0.7, decay: 0.45, accent: 0.75 },
  rubber: { waveform: 0, cutoff: 420, resonance: 0.65, envmod: 0.45, decay: 0.3, accent: 0.5 },
  square: { waveform: 1, cutoff: 600, resonance: 0.55, envmod: 0.5, decay: 0.6, accent: 0.6 },
  mellow: { waveform: 0, cutoff: 360, resonance: 0.3, envmod: 0.25, decay: 1.2, accent: 0.3 },
  scream: { waveform: 0, cutoff: 900, resonance: 0.97, envmod: 0.85, decay: 0.35, accent: 1, sweep: 1.6 },
  hollow: { waveform: 0.6, cutoff: 700, resonance: 0.75, envmod: 0.6, decay: 0.8, accent: 0.6 },
  driven: { waveform: 0, cutoff: 650, resonance: 0.8, envmod: 0.65, decay: 0.5, accent: 0.8, drive: 0.5, volume: 0.5 },
});

export const ACID = defineDevice({
  id: 'Acid',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-acid',
  description: 'An acid bassline voice modeled from its circuit: diode ladder, accent sweep and slide.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'tuning', name: 'Tuning', min: -12, max: 12, default: 0, unit: 'st', group: ACID_MAIN,
      description: 'The pitch, in semitones either way.' },
    { id: 'waveform', name: 'Waveform', min: 0, max: 1, default: 0, group: ACID_MAIN,
      description: 'Saw at 0, the square shaped from it at 1, a blend between.' },
    { id: 'cutoff', name: 'Cutoff', min: ACID_CUTOFF_MIN, max: ACID_CUTOFF_MAX, default: 600, unit: 'Hz', curve: 'exp', group: ACID_MAIN,
      description: 'Where the filter sits; Env Mod sweeps it from here.' },
    { id: 'resonance', name: 'Resonance', min: 0, max: 1, default: 0.6, group: ACID_MAIN,
      description: 'The filter\'s peak. Higher also stacks accents into a rising sweep.' },
    { id: 'character', name: 'Character', min: 0, max: 1, default: 0, group: ACID_MAIN,
      description: 'How sharp the filter is: the circuit\'s soft ladder at 0, a steep lowpass at 1.' },
    { id: 'envmod', name: 'Env Mod', min: 0, max: 1, default: 0.5, group: ACID_MAIN,
      description: 'How far the filter envelope sweeps: the top up and the floor down.' },
    { id: 'decay', name: 'Decay', min: 0.2, max: 2, default: 0.5, unit: 's', curve: 'exp', rate: 'k', group: ACID_MAIN,
      description: 'How long the filter envelope takes to fall. Accented notes always take 0.2 s.' },
    { id: 'accent', name: 'Accent', min: 0, max: 1, default: 0.5, group: ACID_MAIN,
      description: 'How hard accented notes (velocity 0.9 and up) open the filter and level.' },
    { id: 'volume', name: 'Volume', min: 0, max: 1, default: 0.7, group: ACID_MAIN },

    { id: 'slide', name: 'Slide', min: 0.01, max: 0.5, default: 0.066, unit: 's', curve: 'exp', rate: 'k', group: ACID_CIRCUIT,
      description: 'How long a slide takes to get most of the way, whatever the interval.' },
    { id: 'shape', name: 'Square Shape', min: -1, max: 1, default: 0, group: ACID_CIRCUIT,
      description: 'Moves the square\'s edge within the cycle: its shaper\'s offset.' },
    { id: 'sweep', name: 'Sweep', min: 0.25, max: 4, default: 1, unit: 'x', curve: 'exp', rate: 'k', group: ACID_CIRCUIT,
      description: 'The accent sweep\'s capacitor: larger holds accents longer and stacks them higher.' },
    { id: 'drive', name: 'Drive', min: 0, max: 1, default: 0, group: ACID_CIRCUIT,
      description: 'Soft clipping after the amplifier. Off at zero.' },
  ],
  panel: { rows: [[ACID_MAIN], [ACID_CIRCUIT]] },
  presets: ACID_PRESETS,
});

// --- the filter -------------------------------------------------------------------------------

/**
 * The diode ladder with its feedback highpass, at four times the sample rate.
 *
 *   y1' = wc (T(u - y1) - T(y1 - y2))
 *   y2' = wc (T(y1 - y2) - T(y2 - y3))
 *   y3' = wc (T(y2 - y3) - T(y3 - y4))
 *   y4' = 2 wc T(y3 - y4)                  (the half-size capacitor)
 *   u   = x - k · highpass(y4)
 *
 * with T the diode pairs' curve. Linearized, the chain is tridiagonal: solved from the top down
 * as y_i = a_i·y_(i-1) + b_i, so y4 = A·u + B, and the highpass is affine in y4, so the loop
 * closes in one division.
 */
export class AcidLadder {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.rate = sampleRate * 4;
    this.s = new Float64Array(4);   // the capacitors
    this.v = new Float64Array(5);   // where each curve's input was a step ago: u, y1..y4
    this.hp = 0;                     // the feedback highpass's state
    this.g = 0;
    this.k = 0;
    this.base = 0;                   // the loop gain that does not go through the highpass
    this.load = 1;                   // how much each stage loads the one before: 1 the ladder, 0 buffered
    this.end = 2;                    // the end capacitor's smallness: 2 the ladder's half size, 1 the rest's
    this.gh = Math.tan((Math.PI * ACID_FEEDBACK_HP) / this.rate);
    this.upA = new AnalogHalfband(ANALOG_HALFBAND_A);
    this.downA = new AnalogHalfband(ANALOG_HALFBAND_A);
    this.upB = new AnalogHalfband(ANALOG_HALFBAND_B);
    this.downB = new AnalogHalfband(ANALOG_HALFBAND_B);
  }

  reset() {
    this.s.fill(0);
    this.v.fill(0);
    this.hp = 0;
    this.upA.reset();
    this.downA.reset();
    this.upB.reset();
    this.downB.reset();
  }

  /**
   * The cutoff in Hz, the loop gain, the Character (0..1) and the skewed resonance. At Character 0
   * the resonant peak lands on the cutoff; at 1 the corner does at zero resonance, and the peak
   * with the resonance up.
   */
  set(hz, k, character = 0, r = 0) {
    const f = Math.min(this.sampleRate * ACID_HIGHEST, Math.max(ACID_LOWEST, hz));
    const w = Math.tan((Math.PI * f) / this.rate);
    if (character > 0) {
      const sharp = Math.log(ACID_SHARP_TUNE) * (1 - r);
      this.g = w * Math.exp(-Math.log(ACID_TUNE) * (1 - character) + sharp * character);
    } else {
      this.g = w / ACID_TUNE;
    }
    this.k = k;
    this.base = ACID_SHARP_BASE * character;
    this.load = 1 - character;
    this.end = 2 - character;
  }

  /** One sample in, one out, through the oversampler. */
  process(x) {
    const a = this.upA.path(x, 0);
    const b = this.upA.path(x, 1);
    const a0 = this.upB.path(a, 0);
    const a1 = this.upB.path(a, 1);
    const b0 = this.upB.path(b, 0);
    const b1 = this.upB.path(b, 1);
    const ya0 = this._step(a0);
    const ya1 = this._step(a1);
    const yb0 = this._step(b0);
    const yb1 = this._step(b1);
    const ya = 0.5 * (this.downB.path(ya1, 0) + this.downB.path(ya0, 1));
    const yb = 0.5 * (this.downB.path(yb1, 0) + this.downB.path(yb0, 1));
    const y = 0.5 * (this.downA.path(yb, 0) + this.downA.path(ya, 1));
    const s = this.s;
    for (let i = 0; i < 4; i++) if (s[i] > -ACID_FLUSH && s[i] < ACID_FLUSH) s[i] = 0;
    if (this.hp > -ACID_FLUSH && this.hp < ACID_FLUSH) this.hp = 0;
    return y;
  }

  _step(x) {
    const g = this.g;
    const k = this.k;
    const s = this.s;
    const v = this.v;
    // Each stage is charged through the curve across it and loaded by the next one through the
    // next curve; Character takes the loading away, toward stages that do not see each other.
    const lg = this.load * g;
    const e1 = analogClipGain(v[0] - v[1]);
    const e2 = analogClipGain(v[1] - v[2]);
    const e3 = analogClipGain(v[2] - v[3]);
    const e4 = analogClipGain(v[3] - v[4]);
    const g4 = this.end * g * e4;
    const a4 = g4 / (1 + g4);
    const b4 = s[3] / (1 + g4);
    const d3 = 1 + g * e3 + lg * e4 - lg * e4 * a4;
    const a3 = (g * e3) / d3;
    const b3 = (s[2] + lg * e4 * b4) / d3;
    const d2 = 1 + g * e2 + lg * e3 - lg * e3 * a3;
    const a2 = (g * e2) / d2;
    const b2 = (s[1] + lg * e3 * b3) / d2;
    const d1 = 1 + g * e1 + lg * e2 - lg * e2 * a2;
    const a1 = (g * e1) / d1;
    const b1 = (s[0] + lg * e2 * b2) / d1;
    const A = a4 * a3 * a2 * a1;
    const B = a4 * (a3 * (a2 * b1 + b2) + b3) + b4;
    // The feedback highpass, trapezoidal: hp(y4) = (y4 - state) / (1 + gh).
    const h = 1 / (1 + this.gh);
    const k0 = this.base;
    const u = (x - k0 * B - k * h * (B - this.hp)) / (1 + k0 * A + k * h * A);
    const y1 = a1 * u + b1;
    const y2 = a2 * y1 + b2;
    const y3 = a3 * y2 + b3;
    const y4 = a4 * y3 + b4;
    s[0] = 2 * y1 - s[0];
    s[1] = 2 * y2 - s[1];
    s[2] = 2 * y3 - s[2];
    s[3] = 2 * y4 - s[3];
    const low = y4 - h * (y4 - this.hp);
    this.hp = 2 * low - this.hp;
    v[0] = u; v[1] = y1; v[2] = y2; v[3] = y3; v[4] = y4;
    return y4 * (1 + k0);
  }
}

/**
 * The loop gain through the highpass at the top of Resonance for a Character: the whole loop's
 * runs from the ladder's 17 to the buffered stages' 4, geometrically, which keeps it a hair under
 * where it would ring on its own all the way across (found numerically: the onset runs 17, 14.9,
 * 13.0, 11.3, 9.8, ..., 4.65, 4), less the part that goes round without the highpass.
 */
export function acidFeedback(character) {
  if (!(character > 0)) return ACID_FEEDBACK;
  return Math.exp(Math.log(ACID_FEEDBACK) * (1 - character) + Math.log(ACID_SHARP_FEEDBACK) * character)
    - ACID_SHARP_BASE * character;
}

/**
 * The output's makeup for the band the resonance takes away, so a held note keeps its level as
 * Resonance comes up, at any cutoff and any Character. The band under the cutoff is fed back k
 * times over and a held saw loses about 1 / (1 + a k) of its level, with `a` fitted by measuring
 * held saws under the cutoff against the same with no resonance (Env Mod 0, notes F1-F3):
 *
 *   Character 0: a = 0.255 + 0.1 per octave of cutoff from 730 Hz (0.11 at 270 Hz, 0.40 at
 *                1.95 kHz) - the feedback highpass takes more of the loop at a low cutoff, so
 *                less is lost there - held between 0.05 and 0.45
 *   Character 1: a = 0.27, whatever the cutoff
 *   and in between a blend, less 0.09 r Character^2 (the buffered stages lose a little less at
 *   the top of the knob).
 *
 * `hz` is where the filter is, so the makeup follows the envelope as smoothly as the cutoff does.
 * The peak is left standing over the passband.
 */
export function acidMakeup(r, character, k, hz) {
  const low = Math.min(ACID_MAKEUP_MOST, Math.max(ACID_MAKEUP_LEAST, ACID_MAKEUP + ACID_MAKEUP_OCTAVE * Math.log2(hz / ACID_MAKEUP_HZ)));
  const a = (1 - character) * low + character * ACID_MAKEUP_SHARP - ACID_MAKEUP_TOP * r * character * character;
  return 1 + a * k;
}
const ACID_MAKEUP = 0.255;
const ACID_MAKEUP_OCTAVE = 0.1;
const ACID_MAKEUP_HZ = 730;
const ACID_MAKEUP_LEAST = 0.05;
const ACID_MAKEUP_MOST = 0.45;
const ACID_MAKEUP_SHARP = 0.27;
const ACID_MAKEUP_TOP = 0.09;

/** The Resonance knob skewed toward its top, 0..1. */
export function acidSkew(resonance) {
  const r = Math.min(1, Math.max(0, resonance));
  return (1 - Math.exp(-ACID_SKEW * r)) / (1 - Math.exp(-ACID_SKEW));
}

// --- the coupling -----------------------------------------------------------------------------

/** A first-order highpass, bilinear. */
class AcidHighpass {
  constructor(hz, sampleRate) {
    const t = Math.tan((Math.PI * hz) / sampleRate);
    this.b = 1 / (1 + t);
    this.a = (1 - t) / (1 + t);
    this.x1 = 0;
    this.y1 = 0;
  }
  reset() { this.x1 = 0; this.y1 = 0; }
  next(x) {
    const y = this.b * (x - this.x1) + this.a * this.y1;
    this.x1 = x;
    this.y1 = y > -ACID_FLUSH && y < ACID_FLUSH ? 0 : y;
    return y;
  }
}

/** A first-order allpass, bilinear: its phase turns through 90 degrees at `hz`. */
class AcidAllpass {
  constructor(hz, sampleRate) {
    const t = Math.tan((Math.PI * hz) / sampleRate);
    this.c = (t - 1) / (t + 1);
    this.x1 = 0;
    this.y1 = 0;
  }
  reset() { this.x1 = 0; this.y1 = 0; }
  next(x) {
    const y = this.c * x + this.x1 - this.c * this.y1;
    this.x1 = x;
    this.y1 = y > -ACID_FLUSH && y < ACID_FLUSH ? 0 : y;
    return y;
  }
}

/** A notch, as a biquad (the cookbook's), direct form I. */
class AcidNotch {
  constructor(hz, q, sampleRate) {
    const w = (2 * Math.PI * hz) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = 1 / a0;
    this.b1 = (-2 * cos) / a0;
    this.b2 = 1 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  reset() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  next(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y > -ACID_FLUSH && y < ACID_FLUSH ? 0 : y;
    return y;
  }
}

// --- the synth --------------------------------------------------------------------------------

/**
 * The square the shaper makes of the highpassed saw, at `offset`. The transistor inverts; it is
 * turned back over here so the square rises where the saw does and a blend adds rather than cancels.
 */
function acidSquare(h, offset) {
  return analogClip(ACID_SHAPER_GAIN * h + offset);
}

/** A control's value at the end of the block: a number, or the last of a block of values. */
const acidEndOf = (v) => (typeof v === 'number' ? v : v[v.length - 1]);

export class AcidSynth {
  constructor(sampleRate) {
    const sr = sampleRate;
    this.sampleRate = sr;
    this.values = Object.fromEntries(ACID.params.map((p) => [p.id, p.default]));
    this.events = [];
    this.bend = 0;
    this.bendArray = null;

    this.line = new BlepLine();
    this.ladder = new AcidLadder(sr);
    this.shaperHp = new AcidHighpass(ACID_SHAPER_HP, sr);
    this.inputHp = new AcidHighpass(ACID_INPUT_HP, sr);
    this.outputAp = new AcidAllpass(ACID_OUTPUT_AP, sr);
    this.outputHp = new AcidHighpass(ACID_OUTPUT_HP, sr);
    this.notch = new AcidNotch(ACID_NOTCH, ACID_NOTCH_Q, sr);

    // The once-a-block constants.
    this.decayK = 1;
    this.accentK = Math.exp(-ACID_DECAY_SPANS / (ACID_ACCENT_DECAY * sr));
    this.ampK = Math.exp(-1 / (ACID_AMP_DECAY * sr));
    this.attackStep = 1 / (ACID_AMP_ATTACK * sr);
    this.gateUp = 1 / (ACID_AMP_ATTACK * sr);
    this.gateDown = 1 / (ACID_GATE_FALL * sr);
    this.holdFor = Math.round(ACID_GATE_HOLD * sr);
    this.tailFor = Math.round(ACID_TAIL * sr);
    this.slideK = 1;
    this.capacitor = ACID_SWEEP_CAP;
    this.dtMs = 1000 / sr;

    // The voice.
    this.note = -1;          // the note the gate is up for
    this.pitch = 60;         // where the pitch is, in semitones, and where it is going
    this.target = 60;
    this.sliding = false;
    this.phase = 0;
    this.gate = false;
    this.gain = 0;           // the gate's own level: up at once, held and then let fall at its end
    this.hold = 0;
    this.tail = 0;
    this.awake = false;
    this.attacking = false;
    this.amp = 0;            // the amp envelope
    this.env = 0;            // the filter envelope
    this.accented = false;
    this.accentLevel = 0;    // the note's velocity, when it is accented
    this.cap = 0;            // the accent sweep's capacitor, in volts of envelope
    this.sweep = 0;          // and what the circuit puts out, 0..1 of a full sweep
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.values;
    for (const p of ACID.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s[p.id] = v;
    }
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

  queueNoteOn(note, velocity, offset = 0, slide = false) { this.events.push({ at: Math.max(0, offset | 0), kind: 1, note, velocity, slide }); }
  queueNoteOff(note, offset = 0) { this.events.push({ at: Math.max(0, offset | 0), kind: 0, note, velocity: 0, slide: false }); }

  allNotesOff() {
    this.events.length = 0;
    this._gateOff();
  }

  /** One voice, sounding or not. */
  get activeVoices() { return this.awake ? 1 : 0; }

  /** Whether the voice is sounding: its gate up, or letting go. */
  get sounding() { return this.gain > 0 || this.gate; }

  startNote(note, velocity, slide) {
    const accented = Math.round(velocity * 127) >= ACID_ACCENT_STEP;
    this.accented = accented;
    this.accentLevel = accented ? velocity : 0;
    this.target = note;
    this.note = note;
    if (slide && this.sounding) {
      // The gate stays up: the pitch glides, the envelopes carry on.
      this.sliding = true;
      this.gate = true;
      this.hold = 0;
      return;
    }
    if (!this.awake) this._wake();
    this.sliding = false;
    this.pitch = note;
    // The gate opens again: both envelopes start over, the amp from where it is.
    this.amp *= this.gain;
    this.gain = 1;
    this.gate = true;
    this.hold = 0;
    this.attacking = true;
    this.env = 1;
  }

  stopNote(note) {
    if (note === this.note) this._gateOff();
  }

  _gateOff() {
    if (!this.gate) return;
    this.gate = false;
    this.hold = this.holdFor;
  }

  /** A voice coming back from silence starts from rest. */
  _wake() {
    this.awake = true;
    this.line.reset();
    this.ladder.reset();
    this.shaperHp.reset();
    this.inputHp.reset();
    this.outputAp.reset();
    this.outputHp.reset();
    this.notch.reset();
    this.phase = 0;
    this.amp = 0;
    this.gain = 0;
  }

  /** What the voice reads once a block, where the block ends. */
  _prepare() {
    const v = this.values;
    const sr = this.sampleRate;
    this.decayK = Math.exp(-ACID_DECAY_SPANS / (Math.max(0.01, acidEndOf(v.decay)) * sr));
    // An RC lag: three time constants is most of the way.
    this.slideK = 1 - Math.exp(-3 / (Math.max(0.001, acidEndOf(v.slide)) * sr));
    this.capacitor = ACID_SWEEP_CAP * Math.max(0.01, acidEndOf(v.sweep));
  }

  /** The envelopes and the accent sweep, one sample on. They run whether the voice sounds or not. */
  _control(resonance, accentKnob) {
    // The filter envelope.
    this.env *= this.accented ? this.accentK : this.decayK;
    if (this.env < ACID_FLUSH) this.env = 0;
    // The amp envelope, and the gate's own level.
    if (this.attacking) {
      this.amp += this.attackStep;
      if (this.amp >= 1) { this.amp = 1; this.attacking = false; }
    } else {
      this.amp *= this.ampK;
      if (this.amp < ACID_FLUSH) this.amp = 0;
    }
    if (this.gate) {
      this.gain = Math.min(1, this.gain + this.gateUp);
    } else if (this.hold > 0) {
      this.hold--;
    } else if (this.gain > 0) {
      this.gain = Math.max(0, this.gain - this.gateDown);
      if (this.gain === 0) this.tail = this.tailFor;
    }
    // The accent sweep: the input charges node A through the diode and the feed resistor; A is
    // loaded, and tied through the pot to the capacitor, which is what the sweep is taken from.
    const vin = this.accented ? accentKnob * this.accentLevel * this.env : 0;
    const pot = Math.max(ACID_SWEEP_POT_MIN, ACID_SWEEP_POT * Math.min(1, Math.max(0, resonance)));
    const beta = this.dtMs / (this.capacitor * pot);
    const gp = 1 / (pot * (1 + beta));
    const gs = 1 / ACID_SWEEP_FEED;
    const gl = 1 / ACID_SWEEP_LOAD;
    let va = (gs * vin + gp * this.cap) / (gs + gl + gp);
    if (va > vin) va = (gp * this.cap) / (gl + gp);   // the diode is off
    this.cap = (this.cap + beta * va) / (1 + beta);
    if (this.cap < ACID_FLUSH) this.cap = 0;
    this.sweep = this.cap / ACID_SWEEP_FULL;
  }

  /** Renders `count` samples, `offset` into the block, adding into the output. */
  _render(outL, outR, count, offset) {
    const p = this.values;
    const sr = this.sampleRate;
    const line = this.line;
    const ladder = this.ladder;
    let y = 0;
    for (let i = 0; i < count; i++) {
      const j = offset + i;
      const resonance = at(p.resonance, j);
      this._control(resonance, at(p.accent, j));
      if (!this.awake) continue;

      // The pitch: straight to the note, or through the slide's lag.
      if (this.sliding && this.pitch !== this.target) {
        this.pitch += (this.target - this.pitch) * this.slideK;
        if (Math.abs(this.target - this.pitch) < 1e-6) this.pitch = this.target;
      }
      const bend = this.bendArray ? this.bendArray[j] : this.bend;
      const dt = Math.min(ACID_TOP, midiToHz(this.pitch + at(p.tuning, j) + bend) / sr);

      // The saw, and the square its shaper makes of it.
      const w = Math.min(1, Math.max(0, at(p.waveform, j)));
      const offsetV = ACID_SHAPER_OFFSET * (1 + 2 * Math.min(1, Math.max(-1, at(p.shape, j))));
      let phase = this.phase + dt;
      let wrapped = false;
      if (phase >= 1) { phase -= 1; wrapped = true; }
      this.phase = phase;
      const saw = 2 * phase - 1;
      const h = this.shaperHp.next(saw);
      const square = acidSquare(h, offsetV);
      if (wrapped) {
        // The reset, at its fraction of a sample: the saw falls by two, and the shaper's output
        // jumps by whatever it does across the highpassed saw's own fall.
        const before = acidSquare(h + 2 * this.shaperHp.b, offsetV);
        line.jump(phase / dt, (1 - w) * -2 + w * ACID_SQUARE_LEVEL * (square - before));
      }
      const x = this.inputHp.next(line.push((1 - w) * saw + w * ACID_SQUARE_LEVEL * square));

      // The filter, where the envelope and the accent put it.
      const c = Math.log(Math.min(ACID_CUTOFF_MAX, Math.max(ACID_CUTOFF_MIN, at(p.cutoff, j))) / ACID_CUTOFF_MIN)
        / Math.log(ACID_CUTOFF_MAX / ACID_CUTOFF_MIN);
      const e = Math.min(1, Math.max(0, at(p.envmod, j)));
      const scale = (1 - c) * (3.774 * e + 0.737) + c * (4.195 * e + 0.864);
      const floor = 0.0483 * c + 0.2944;
      const octaves = scale * (this.env - floor) + ACID_ACCENT_OCTAVES * this.sweep;
      const r = acidSkew(resonance);
      const character = Math.min(1, Math.max(0, at(p.character, j)));
      const k = acidFeedback(character) * r;
      const hz = at(p.cutoff, j) * Math.pow(2, octaves);
      ladder.set(hz, k, character, r);
      const makeup = acidMakeup(r, character, k, hz);
      const filtered = ladder.process(x) * makeup;

      // The amplifier, then the output stages.
      const level = this.gain * this.amp * (1 + ACID_ENV_TO_AMP * this.env + ACID_ACCENT_TO_AMP * this.sweep);
      let amped = filtered * level;
      const drive = at(p.drive, j);
      if (drive > 0) {
        const push = 1 + ACID_DRIVE_GAIN * drive;
        amped = analogClip(amped * push) / Math.sqrt(push);
      }
      y = this.notch.next(this.outputHp.next(this.outputAp.next(amped)));
      const out = y * at(p.volume, j) * ACID_OUTPUT_GAIN;
      outL[i] += out;
      outR[i] += out;

      if (this.tail > 0 && --this.tail === 0 && !this.gate && this.gain === 0) this.awake = false;
    }
    if (!Number.isFinite(y)) {
      this.line.reset();
      this.ladder.reset();
    }
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
        if (e.kind === 1) this.startNote(e.note, e.velocity, e.slide); else this.stopNote(e.note);
      }
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at0;
      if (n > 0) {
        const l = at0 === 0 && n === outL.length ? outL : outL.subarray(at0, at0 + n);
        const r = at0 === 0 && n === outR.length ? outR : outR.subarray(at0, at0 + n);
        this._render(l, r, n, at0);
      }
      at0 = until;
    }
    if (next >= events.length) events.length = 0;
    else this.events = events.slice(next).map((e) => ({ ...e, at: Math.max(0, e.at - count) }));
  }
}
