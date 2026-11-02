// The Drum: a struck body and a burst of noise, one hit per note.
//
// THE BODY is a bank of decaying sines - the modes of whatever was struck - started together at
// zero phase, which is what an impulse into a set of resonances gives. Material moves the modes'
// frequencies and levels continuously along one line: a single resonance at the bottom (a
// clave), the free bar's modes in the middle (1, 2.76, 5.40, 8.93 - a wood block), and a
// circular membrane's at the top (1, 1.59, 2.14, 2.30, 2.65, 2.92 - a tom, a conga). How many
// modes are heard follows: below the middle the bar's upper modes fade in, above it the
// membrane's last two do. On the way from bar to membrane the second mode passes through twice
// the first, which is where two lower tones - a snare's shell - sit. The lowest mode is the note.
//
// Edge is where the body is struck: at zero the modes start at their own levels, and turned up
// each is raised by its ratio to the fourth power times Edge, so the upper modes come forward -
// at the top an upper mode is louder than the lowest, as a bongo slapped near its rim is. The
// loudness is held as it moves.
//
// Every mode rings for Decay divided by its ratio to the lowest, so the upper modes die first,
// as they do in wood and skin alike, and what is left of a long hit is its lowest tone. Ring
// takes that away: at one every mode rings as long as the lowest, which is a metal shell. Drop is
// how far the whole body starts above its pitch, falling back over an eighth of the decay.
// Click is a short burst of differentiated noise on the strike: the stick, not the drum.
//
// THE NOISE is white noise through a bandpass at Noise Tone, lasting Noise Length. Noise
// crossfades the body against it, from none to all-noise. Stutter splits the start of the noise
// into three short bursts and a tail, the way a clap is several hands a few milliseconds apart:
// at zero they all land together and are one hit; turned up, they spread to 15 ms apart. Noise
// Tail adds a second, quieter stage under the noise that lasts eight times as long - the room a clap
// leaves, the wires still buzzing after a snare's crack.
//
// COLOR is the hit's brightness over time, on one envelope of its own that falls over Filter
// Decay. FM bends every mode's phase with a second sine at FM Ratio times the note, as deep as
// FM says at the strike and fading with that envelope - clang and zap at the start, the body
// after - and fading too as its sidebands near the top of the band, so a high note does not fold
// them back down. Cutoff is a resonant four-pole lowpass over the whole hit, each hit its own,
// swept from Filter Sweep semitones away (up or down) back to Cutoff over the same envelope: the
// snap and the knock of a filtered drum. At the top of Resonance it rings at the cutoff for
// seconds. With Cutoff at the top and Filter Sweep at or above zero there is no filter at all.
//
// The synths are otherwise filterless, a filter belonging on the chain after them. This one is
// the exception: a chain filter is shared by every hit still ringing and can follow one sweep,
// and a sweep per hit is the sound.
//
// Drive pushes the whole hit into a soft saturator: denser, louder in its quiet parts, with
// harmonics the modes do not have. At zero it is not there at all.
//
// Velocity scales the level, and the click a second time - a hard hit is brighter as well as
// louder. Note offs are ignored: a hit plays out, and hits ring into one another on voices of
// their own.
//
// EVERY SOUND CONTROL IS READ ONCE, WHEN THE HIT STARTS - Pitch, Material, Edge, Decay, Ring,
// Drop, Click, Noise, Noise Tone, Noise Length, Noise Tail, Stutter and Drive - and the hit keeps them while it rings, as a struck drum keeps
// what it was made of. So one track plays a whole kit: a preset or a control changed per note
// strikes the next hit with it and leaves the ones still ringing alone, and a signal on a control
// is sampled at each strike. They are read a sample into the hit, because a change timed with the
// note can land a sample after the note does when both are rounded to the sample grid. Level and
// the track's bend follow as the hit plays.
//
// Translated line for line into native/devices/own/drum.cc for the desktop, and held to it by
// native-device-parity.test.mjs. Everything is computed in double and written to the output once
// per sample, as the C++ does.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { Ladder, Svf } from '../dsp/filters.mjs';
import { midiToHz } from '../dsp/voice.mjs';

/** How many modes the body has. */
export const DRUM_MODES = 6;
/** The free bar's mode ratios, then two slots parked on the membrane's, silent here. */
export const BAR_RATIOS = Object.freeze([1, 2.76, 5.40, 8.93, 2.65, 2.92]);
export const BAR_LEVELS = Object.freeze([1, 0.45, 0.25, 0.15, 0, 0]);
/** The circular membrane's first six mode ratios. */
export const MEMBRANE_RATIOS = Object.freeze([1, 1.59, 2.14, 2.30, 2.65, 2.92]);
export const MEMBRANE_LEVELS = Object.freeze([1, 0.25, 0.18, 0.14, 0.1, 0.08]);
/** Stutter at its top: the gap between the noise's bursts. */
export const DRUM_GAP_SEC = 0.015;
/** The bursts before the tail. */
export const DRUM_BURSTS = 3;
/** How long each burst takes to fall 60 dB (or Noise Length, if that is shorter). */
const BURST_SEC = 0.02;
/** Drop falls back over this share of Decay (its time constant). */
export const DROP_SHARE = 0.12;
/** Edge at its top raises each mode by its ratio to this power. */
export const EDGE_POWER = 4;
/** Noise Tail's second stage: as loud as this times Noise Tail squared, lasting this many times Noise Length. */
const TAIL_LEVEL = 0.3;
export const TAIL_LENGTH = 8;
/** Drive's gain at its top, and how soon the shaped sound has taken over from the dry one. */
const DRIVE_GAIN = 12;
const DRIVE_BLEND = 4;
/** FM at its top: how far, in radians, the second sine bends each mode's phase. */
export const DRUM_FM_DEPTH = 6;
/**
 * The lowpass loses its low end as Resonance rises (a ladder's feedback takes it): this much of
 * the feedback is given back as gain, so a resonant hit is not a quiet one.
 */
export const DRUM_RES_MAKEUP = 0.5;
/**
 * The ladder's feedback at the top of Resonance: just short of the four where it would
 * oscillate for ever, so a hit rings at its cutoff for seconds and still ends.
 */
export const DRUM_LADDER_K = 3.99;
/** FM is full while its widest sideband is under the first share of the rate, and gone by the second. */
const DRUM_FM_FULL = 0.35;
const DRUM_FM_NONE = 0.5;
/** Cutoff at or above this, with no downward sweep, is no filter. */
export const DRUM_CUTOFF_TOP = 20000;
/** The click's 60 dB fall. */
const CLICK_SEC = 0.003;
const CLICK_GAIN = 1.5;
/** The noise bandpass's resonance (the filter's 0..1). */
const NOISE_RES = 0.3;
/** A mode is full up to this share of the sample rate and gone by the next: nothing folds back. */
const BL_FULL = 0.4;
const BL_NONE = 0.45;
/** Below this the hit has finished. */
const SILENT = 1e-5;
/** ln(1000): a 60 dB fall. */
const LN1000 = 6.907755278982137;
const DRUM_TWO_PI = 2 * Math.PI;
/** The shortest Decay and Noise Length the arithmetic is given. */
const MIN_SEC = 0.001;

/** How far the Voices knob reaches, which is no most (see the Wavetable's VOICES_KNOB). */
export const DRUM_VOICES_KNOB = 128;

/**
 * The body's modes at a Material and an Edge: each ratio to the lowest and each level, written
 * into `ratios` and `levels`. Returns the gain that keeps the body's loudness level as the count
 * and the balance change.
 */
export function drumModes(material, edge, ratios, levels) {
  const m = Math.min(1, Math.max(0, material));
  const e = EDGE_POWER * Math.min(1, Math.max(0, edge));
  let sum = 0;
  if (m <= 0.5) {
    const u = m * 2;
    for (let k = 0; k < DRUM_MODES; k++) {
      ratios[k] = BAR_RATIOS[k];
      levels[k] = (k === 0 ? 1 : u * BAR_LEVELS[k]) * Math.pow(ratios[k], e);
      sum += levels[k] * levels[k];
    }
  } else {
    const u = (m - 0.5) * 2;
    for (let k = 0; k < DRUM_MODES; k++) {
      ratios[k] = BAR_RATIOS[k] * Math.pow(MEMBRANE_RATIOS[k] / BAR_RATIOS[k], u);
      levels[k] = (BAR_LEVELS[k] + u * (MEMBRANE_LEVELS[k] - BAR_LEVELS[k])) * Math.pow(ratios[k], e);
      sum += levels[k] * levels[k];
    }
  }
  return 1 / Math.sqrt(sum);
}

/**
 * The gain that puts the bandpassed noise at white noise's loudness, for a center in Hz: the
 * filter passes sin(2 pi f / rate) / 2k of white noise's power, its analog bandwidth carried
 * through the bilinear map. Held at a quarter of the rate, past which the band is squeezed against
 * the top and the formula would only chase it.
 */
export function noiseGain(tone, sampleRate) {
  const k = 2 - 1.98 * NOISE_RES;
  const f = Math.min(sampleRate * 0.25, Math.max(20, tone));
  return Math.sqrt((2 * k) / Math.sin((DRUM_TWO_PI * f) / sampleRate));
}

/** A soft saturator: odd, smooth, flat at plus and minus one from three on. */
function driveShape(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/**
 * One sample through Drive: the dry sound blended into the saturated one over the first quarter
 * of the range, so zero is the sound untouched and nothing jumps as it turns.
 */
export function drive(x, amount) {
  if (!(amount > 0)) return x;
  const g = 1 + (DRIVE_GAIN - 1) * amount;
  const w = Math.min(1, DRIVE_BLEND * amount);
  return (1 - w) * x + (w * driveShape(g * x)) / driveShape(g);
}

const BODY = 'Body';
const NOISE_GROUP = 'Noise';
const COLOR = 'Color';
const VOICE = 'Voice';

export const DRUM = defineDevice({
  id: 'Drum',
  kind: 'synth',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-drum',
  description: 'A struck body and a burst of noise: claves, wood blocks, rims, toms, congas, snares and claps, and everything between them. The note is the pitch of the lowest mode.',
  channels: { in: 0, out: 2 },
  params: [
    { id: 'pitch', latch: true, name: 'Pitch', min: -48, max: 48, default: 0, unit: 'st', group: BODY,
      description: 'Moves the body from the note, in semitones.' },
    { id: 'material', latch: true, name: 'Material', min: 0, max: 1, default: 1, group: BODY,
      description: 'What is struck: one resonance at the bottom, a wooden bar in the middle, a drum skin at the top, and every blend between.' },
    { id: 'edge', latch: true, name: 'Edge', min: 0, max: 1, default: 0, group: BODY,
      description: 'Where it is struck: at zero the lowest mode leads, turned up the upper modes come forward, past the lowest at the top.' },
    { id: 'decay', latch: true, name: 'Decay', min: 0.01, max: 4, default: 0.4, unit: 's', curve: 'exp', group: BODY, amp: 'decay',
      description: 'How long the body rings: the time its lowest mode takes to fall 60 dB. Higher modes die sooner.' },
    { id: 'ring', latch: true, name: 'Ring', min: 0, max: 1, default: 0, group: BODY,
      description: 'How long the upper modes ring: at zero they die sooner the higher they are, at one they last as long as the lowest, like a metal shell.' },
    { id: 'drop', latch: true, name: 'Drop', min: 0, max: 24, default: 2, unit: 'st', group: BODY,
      description: 'How far above its pitch the body starts, falling back quickly.' },
    { id: 'click', latch: true, name: 'Click', min: 0, max: 1, default: 0.2, group: BODY,
      description: 'The stick: a short bright burst on the strike.' },
    { id: 'noise', latch: true, name: 'Noise', min: 0, max: 1, default: 0.1, group: NOISE_GROUP,
      description: 'The mix of noise against the body, from none to all noise.' },
    { id: 'noisetone', latch: true, name: 'Noise Tone', min: 100, max: 16000, default: 3000, unit: 'Hz', curve: 'exp', group: NOISE_GROUP,
      description: 'Where the noise sits: the center of its bandpass.' },
    { id: 'noiselength', latch: true, name: 'Noise Length', min: 0.01, max: 2, default: 0.15, unit: 's', curve: 'exp', group: NOISE_GROUP,
      description: 'How long the noise lasts: the time it takes to fall 60 dB.' },
    { id: 'noisetail', latch: true, name: 'Noise Tail', min: 0, max: 1, default: 0, group: NOISE_GROUP,
      description: 'A quieter second stage under the noise, lasting eight times as long as Noise Length: the room after a clap, the wires after a snare.' },
    { id: 'stutter', latch: true, name: 'Stutter', min: 0, max: 1, default: 0, group: NOISE_GROUP,
      description: 'Splits the start of the noise into three quick bursts before its tail, as a clap does. Zero is one hit; up spreads them to 15 ms apart.' },
    { id: 'fm', latch: true, name: 'FM', min: 0, max: 1, default: 0, group: COLOR,
      description: 'Bends the body with a second sine at FM Ratio times the note, deepest at the strike and fading over Filter Decay: clang, bell, zap.' },
    { id: 'fmratio', latch: true, name: 'FM Ratio', min: 0.25, max: 8, default: 1, unit: 'x', curve: 'exp', group: COLOR,
      description: 'The second sine\'s frequency against the note. Whole numbers are tuned; between them is metal.' },
    { id: 'cutoff', latch: true, name: 'Cutoff', min: 40, max: DRUM_CUTOFF_TOP, default: DRUM_CUTOFF_TOP, unit: 'Hz', curve: 'exp', group: COLOR,
      description: 'A resonant four-pole lowpass over each hit, where it settles. At the top with no downward sweep there is no filter.' },
    { id: 'resonance', latch: true, name: 'Resonance', min: 0, max: 1, default: 0, group: COLOR,
      description: 'How much the lowpass rings at its cutoff as it sweeps.' },
    { id: 'filtersweep', latch: true, name: 'Filter Sweep', min: -96, max: 96, default: 0, unit: 'st', group: COLOR,
      description: 'How far from Cutoff the lowpass starts, up or down, falling back to it over Filter Decay.' },
    { id: 'filterdecay', latch: true, name: 'Filter Decay', min: 0.005, max: 4, default: 0.2, unit: 's', curve: 'exp', group: COLOR,
      description: 'How long the filter sweep and the FM take to fade: the time to fall 60 dB.' },
    { id: 'drive', latch: true, name: 'Drive', min: 0, max: 1, default: 0, group: VOICE,
      description: 'Pushes the whole hit into a soft saturator: denser and grittier, with harmonics the body does not have.' },
    { id: 'level', name: 'Level', min: 0, max: 1, default: 0.7, group: VOICE },
    { id: 'voices', name: 'Voices', min: 1, open: true, uiMax: DRUM_VOICES_KNOB, default: 8, step: 1, rate: 'k', ui: 'number', group: VOICE,
      description: 'How many hits ring at once. A hit past that takes the oldest one\'s place.' },
  ],
  panel: { rows: [[BODY], [COLOR], [NOISE_GROUP], [VOICE]] },
  figures: [
    {
      id: 'body',
      kind: 'modes',
      group: BODY,
      description: 'The body\'s modes at middle C, as loud as they start, and the band the noise sits in.',
      params: { material: 'material', edge: 'edge', pitch: 'pitch', noise: 'noise', tone: 'noisetone' },
    },
  ],
  presets: {
    lowtom: { pitch: -18.66, material: 0.05, decay: 0.6, drop: 4, click: 0.15, noise: 0.02, noisetone: 1500, noiselength: 0.05 },
    midtom: { pitch: -11.46, material: 0.05, decay: 0.4, drop: 1, click: 0.15, noise: 0.02, noisetone: 1500, noiselength: 0.05 },
    hightom: { pitch: -5.81, material: 0.05, decay: 0.3, drop: 1, click: 0.15, noise: 0.02, noisetone: 2000, noiselength: 0.05 },
    sweeplow: { pitch: -14.4, material: 0.85, edge: 0.2, ring: 0.3, decay: 0.6, drop: 4, click: 0.3, noise: 0.1, noisetone: 1000, noiselength: 0.05 },
    sweepmid: { pitch: -10.8, material: 0.85, edge: 0.2, ring: 0.3, decay: 0.45, drop: 6, click: 0.3, noise: 0.1, noisetone: 1200, noiselength: 0.05 },
    sweephigh: { pitch: -7.7, material: 0.85, edge: 0.2, ring: 0.3, decay: 0.4, drop: 7, click: 0.3, noise: 0.1, noisetone: 1500, noiselength: 0.05 },
    ringlow: { pitch: -14.3, material: 0.87, edge: 0.2, ring: 0.7, decay: 1.4, drop: 0.5, click: 0.3, noise: 0.05, noisetone: 1000, noiselength: 0.05 },
    ringmid: { pitch: -11.2, material: 0.87, edge: 0.2, ring: 0.7, decay: 1.2, drop: 0.5, click: 0.3, noise: 0.05, noisetone: 1200, noiselength: 0.05 },
    ringhigh: { pitch: -7.9, material: 0.87, edge: 0.2, ring: 0.7, decay: 1, drop: 0.5, click: 0.3, noise: 0.05, noisetone: 1500, noiselength: 0.05 },
    conga: { pitch: -7.94, material: 1, decay: 0.9, drop: 0.5, click: 0.3, noise: 0.1, noisetone: 800, noiselength: 0.08 },
    bongo: { pitch: 2.73, material: 1, decay: 0.6, drop: 0.5, click: 0.3, noise: 0.15, noisetone: 1000, noiselength: 0.06 },
    slapbongo: { pitch: 5.3, material: 0.78, edge: 0.42, ring: 0.7, decay: 0.15, drop: 0.5, click: 0.3, noise: 0.25, noisetone: 1500, noiselength: 0.04 },
    lowbongo: { pitch: -0.24, material: 0.95, edge: 0.35, ring: 0.4, decay: 0.3, drop: 0.3, click: 0.4, noise: 0.2, noisetone: 1200, noiselength: 0.05 },
    doum: { pitch: -10.34, material: 1, decay: 1.1, drop: 0.5, click: 0.2, noise: 0.03, noisetone: 1000, noiselength: 0.08 },
    tek: { pitch: 10.4, material: 1, decay: 0.3, drop: 0.3, click: 0.6, noise: 0.6, noisetone: 700, noiselength: 0.15 },
    timbale: { pitch: -5.72, material: 0.85, edge: 0.45, ring: 0.8, decay: 1, drop: 0.3, click: 0.6, noise: 0.3, noisetone: 2500, noiselength: 0.15 },
    lowtimbale: { pitch: -9.12, material: 0.85, edge: 0.6, ring: 0.8, decay: 1.3, drop: 0.3, click: 0.6, noise: 0.3, noisetone: 1500, noiselength: 0.15 },
    woodblock: { pitch: 28.31, material: 1, decay: 0.3, drop: 0, click: 0.5, noise: 0.3, noisetone: 3000, noiselength: 0.03 },
    clave: { pitch: 38.53, material: 0, decay: 0.065, drop: 0, click: 0.1, noise: 0, noisetone: 6000, noiselength: 0.02 },
    rim: { pitch: 10.47, material: 0.75, edge: 0.3, decay: 0.025, drop: 0, click: 1, noise: 0.7, noisetone: 2500, noiselength: 0.015 },
    lowrim: { pitch: -2.75, material: 0.7, edge: 0.45, decay: 0.06, drop: 0, click: 0.6, noise: 0.25, noisetone: 3000, noiselength: 0.02 },
    woodrim: { pitch: 12.38, material: 0.85, edge: 0.45, ring: 0.5, decay: 0.1, drop: 0, click: 0.7, noise: 0.3, noisetone: 3000, noiselength: 0.02 },
    snare: { pitch: -7.26, material: 0.8, decay: 0.21, drop: 6, click: 0.3, noise: 0.45, noisetone: 7000, noiselength: 0.19 },
    brightsnare: { pitch: -1.47, material: 0.82, decay: 0.2, drop: 4, click: 0.4, noise: 0.55, noisetone: 6000, noiselength: 0.1, noisetail: 0.8 },
    tightsnare: { pitch: -2.17, material: 0.2, decay: 0.15, drop: 3, click: 0.3, noise: 0.8, noisetone: 3500, noiselength: 0.15 },
    gritsnare: { pitch: -8.4, material: 1, edge: 0.2, ring: 0.3, decay: 0.18, drop: 1, click: 0.3, noise: 0.4, noisetone: 4000, noiselength: 0.1, noisetail: 0.3, drive: 0.4 },
    hisssnare: { pitch: 3.6, material: 0.5, decay: 0.12, drop: 1, click: 0.2, noise: 0.9, noisetone: 7000, noiselength: 0.07, noisetail: 0.5 },
    clap: { pitch: 0, material: 0, decay: 0.1, drop: 0, click: 0, noise: 1, noisetone: 1100, noiselength: 0.12, noisetail: 0.5, stutter: 0.77 },
    bigclap: { pitch: 0, material: 0, decay: 0.1, drop: 0, click: 0, noise: 1, noisetone: 1300, noiselength: 0.1, noisetail: 0.45, stutter: 0.7 },
    shortclap: { pitch: 0, material: 0, decay: 0.1, drop: 0, click: 0, noise: 1, noisetone: 1200, noiselength: 0.12, stutter: 0.45, drive: 0.3 },
    zap: { pitch: 12, material: 0, decay: 0.25, drop: 24, click: 0.2, noise: 0, fm: 0.8, fmratio: 1.5, cutoff: 300, resonance: 0.8, filtersweep: 60, filterdecay: 0.08 },
    knock: { pitch: 5, material: 0.6, decay: 0.15, drop: 2, click: 0.5, noise: 0.1, noisetone: 2000, noiselength: 0.03, cutoff: 800, resonance: 0.7, filtersweep: 36, filterdecay: 0.02 },
    clang: { pitch: 7, material: 0.5, ring: 0.5, decay: 0.5, drop: 0, click: 0.3, noise: 0, fm: 0.6, fmratio: 2.71, filterdecay: 0.3 },
    boom: { pitch: -18, material: 0.2, decay: 1, drop: 6, click: 0.2, noise: 0.05, noisetone: 500, noiselength: 0.05, cutoff: 120, resonance: 0.85, filtersweep: 48, filterdecay: 0.12 },
    buzz: { pitch: -12, material: 0, decay: 0.4, drop: 4, click: 0.3, noise: 0.2, noisetone: 1500, noiselength: 0.1, fm: 0.4, fmratio: 0.5, cutoff: 2000, resonance: 0.5, filtersweep: 24, filterdecay: 0.1, drive: 0.8 },
    crunch: { pitch: -5, material: 0.8, decay: 0.15, drop: 3, click: 0.4, noise: 0.8, noisetone: 2500, noiselength: 0.2, cutoff: 3000, resonance: 0.6, filtersweep: 30, filterdecay: 0.05, drive: 0.6 },
  },
});

/**
 * One stream of xorshift32 with unsigned shifts throughout, which is the same sequence here (with
 * `>>> 0` after each shift that can carry into the sign) and in C++ (on an unsigned int).
 */
class DrumNoise {
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

class DrumVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.phase = new Float64Array(DRUM_MODES);
    this.env = new Float64Array(DRUM_MODES);
    this.ratios = new Float64Array(DRUM_MODES);
    this.levels = new Float64Array(DRUM_MODES);
    this.gains = new Float64Array(DRUM_MODES);
    this.burstAt = new Float64Array(DRUM_BURSTS);
    this.rng = new DrumNoise();
    this.filter = new Svf(sampleRate);
    this.note = -1;
    this.velocity = 1;
    this.age = 0;
    this.active = false;
    // What the hit was struck with (see noteOn).
    this.norm = 1;
    this.pitch = 0;
    this.drop = 0;
    this.dropG = 0;
    this.clickLevel = 0;
    this.mix = 0;
    this.toneGain = 1;
    this.tailG = 0;
    this.burstG = 0;
    this.slowLevel = 0;
    this.slowG = 0;
    this.drive = 0;
    this.fm = 0;
    this.fmRatio = 1;
    this.cutoff = DRUM_CUTOFF_TOP;
    this.resonance = 0;
    this.sweep = 0;
    this.sweepG = 0;
    this.filtered = false;
    this.topRatio = 0;
    this.ladder = new Ladder(sampleRate);
    this.reset();
  }

  reset() {
    this.phase.fill(0);
    this.env.fill(0);
    this.t = 0;
    this.dropEnv = 0;
    this.burst = 0;
    this.tail = 0;
    this.slow = 0;
    this.nextBurst = DRUM_BURSTS;
    this.tailAt = 0;
    this.tailOn = true;
    this.click = 0;
    this.lastWhite = 0;
    this.sweepEnv = 0;
    this.fmPhase = 0;
    this.filter.reset();
    this.ladder.reset();
  }

  /**
   * Starts a hit, reading every sound control at sample `j` of the block's values `p` - the
   * strike. The hit keeps them for as long as it rings.
   */
  noteOn(note, velocity, seed, p, j) {
    this.reset();
    this.note = note;
    this.velocity = velocity;
    this.active = true;
    this.env.fill(1);
    this.dropEnv = 1;
    this.click = 1;
    this.rng.seed(seed);
    const sr = this.sampleRate;
    this.norm = drumModes(at(p.material, j), at(p.edge, j), this.ratios, this.levels);
    const decay = Math.max(MIN_SEC, at(p.decay, j));
    const d = decay * sr;
    const tilt = 1 - Math.min(1, Math.max(0, at(p.ring, j)));
    for (let k = 0; k < DRUM_MODES; k++) this.gains[k] = Math.exp((-LN1000 * Math.pow(this.ratios[k], tilt)) / d);
    this.dropG = Math.exp(-1 / (DROP_SHARE * decay * sr));
    this.pitch = at(p.pitch, j);
    this.drop = at(p.drop, j);
    this.clickLevel = at(p.click, j);
    this.mix = Math.min(1, Math.max(0, at(p.noise, j)));
    const tone = at(p.noisetone, j);
    this.filter.setCutoff(tone, NOISE_RES);
    this.toneGain = noiseGain(tone, sr);
    const snap = Math.max(MIN_SEC, at(p.noiselength, j));
    this.tailG = Math.exp(-LN1000 / (snap * sr));
    this.burstG = Math.exp(-LN1000 / (Math.min(BURST_SEC, snap) * sr));
    const tail = Math.min(1, Math.max(0, at(p.noisetail, j)));
    this.slowLevel = TAIL_LEVEL * tail * tail;
    this.slowG = Math.exp(-LN1000 / (TAIL_LENGTH * snap * sr));
    this.drive = Math.min(1, Math.max(0, at(p.drive, j)));
    this.fm = DRUM_FM_DEPTH * Math.min(1, Math.max(0, at(p.fm, j)));
    this.fmRatio = at(p.fmratio, j);
    this.cutoff = at(p.cutoff, j);
    this.resonance = at(p.resonance, j);
    this.sweep = at(p.filtersweep, j);
    this.sweepG = Math.exp(-LN1000 / (Math.max(MIN_SEC, at(p.filterdecay, j)) * sr));
    this.sweepEnv = 1;
    this.filtered = !(this.cutoff >= DRUM_CUTOFF_TOP && this.sweep >= 0);
    if (this.filtered) this.tune(this.cutoff);
    // The highest mode sounding, for how far the FM's sidebands reach.
    this.topRatio = 0;
    for (let k = 0; k < DRUM_MODES; k++) if (this.levels[k] > 0 && this.ratios[k] > this.topRatio) this.topRatio = this.ratios[k];
    const gap = Math.min(1, Math.max(0, at(p.stutter, j))) * DRUM_GAP_SEC * sr;
    for (let b = 0; b < DRUM_BURSTS; b++) this.burstAt[b] = Math.round(b * gap);
    this.nextBurst = 0;
    this.tailAt = Math.round(DRUM_BURSTS * gap);
    this.tailOn = false;
  }

  /** Tunes the lowpass, with Resonance reaching nearly to oscillation (DRUM_LADDER_K). */
  tune(hz) {
    this.ladder.setCutoff(hz, 0);
    this.ladder.k = DRUM_LADDER_K * Math.min(1, Math.max(0, this.resonance));
  }

  /** Renders `count` samples of this voice and adds them into the output. */
  process(outL, outR, count, offset, s) {
    const sr = this.sampleRate;
    const p = s.values;
    const phase = this.phase;
    const env = this.env;
    const ratios = this.ratios;
    const levels = this.levels;
    const gains = this.gains;
    const bendMoving = s.bendArray !== null;
    let hz = midiToHz(this.note + this.pitch + s.bendAt(offset));
    const clickG = Math.exp(-LN1000 / (CLICK_SEC * sr));
    const velocity = this.velocity;
    const norm = this.norm;
    const mix = this.mix;
    const clickGain = CLICK_GAIN * velocity * this.clickLevel;

    for (let i = 0; i < count; i++) {
      const j = offset + i;
      if (bendMoving && i > 0) hz = midiToHz(this.note + this.pitch + s.bendAt(j));

      // The body: every mode at the lowest one's frequency times its ratio, raised by the drop.
      const semis = this.drop * this.dropEnv;
      this.dropEnv *= this.dropG;
      const f = (hz * (semis > 1e-6 ? Math.pow(2, semis / 12) : 1)) / sr;
      // The second sine's bend on every mode's phase, fading with the sweep's envelope.
      let bend = 0;
      if (this.fm > 0) {
        const index = this.fm * this.sweepEnv;
        // Carson's rule: the sidebands reach the index plus one times the FM's frequency past
        // the highest mode. Faded out as that nears the top of the band.
        const reach = f * (this.topRatio + (index + 1) * this.fmRatio);
        const fade = reach <= DRUM_FM_FULL ? 1 : (reach >= DRUM_FM_NONE ? 0 : (DRUM_FM_NONE - reach) / (DRUM_FM_NONE - DRUM_FM_FULL));
        bend = index * fade * Math.sin(DRUM_TWO_PI * this.fmPhase);
        this.fmPhase += f * this.fmRatio;
        if (this.fmPhase >= 1) this.fmPhase -= Math.floor(this.fmPhase);
      }
      let body = 0;
      for (let k = 0; k < DRUM_MODES; k++) {
        if (levels[k] > 0) {
          const inc = f * ratios[k];
          const bl = inc < BL_FULL ? 1 : (inc >= BL_NONE ? 0 : (BL_NONE - inc) / (BL_NONE - BL_FULL));
          if (bl > 0) body += levels[k] * env[k] * bl * Math.sin(DRUM_TWO_PI * phase[k] + bend);
          phase[k] += inc;
          if (phase[k] >= 1) phase[k] -= Math.floor(phase[k]);
        }
        env[k] *= gains[k];
      }

      // The noise: bursts as Stutter laid them out, then the tail, whichever is louder.
      const t = this.t;
      while (this.nextBurst < DRUM_BURSTS && t >= this.burstAt[this.nextBurst]) {
        this.burst = 1;
        this.nextBurst++;
      }
      if (!this.tailOn && t >= this.tailAt) {
        this.tail = 1;
        this.slow = 1;
        this.tailOn = true;
      }
      const w = this.rng.white();
      const stages = this.tail + this.slowLevel * this.slow;
      const level = this.burst > stages ? this.burst : stages;
      const noise = this.filter.next(w, 2) * this.toneGain * level;
      this.burst *= this.burstG;
      this.tail *= this.tailG;
      this.slow *= this.slowG;
      const click = (w - this.lastWhite) * this.click;
      this.lastWhite = w;
      this.click *= clickG;
      this.t = t + 1;

      let x = ((1 - mix) * norm * body + mix * noise + clickGain * click) * velocity;
      if (this.filtered) {
        if (this.sweep !== 0) this.tune(this.cutoff * Math.pow(2, (this.sweep * this.sweepEnv) / 12));
        x = this.ladder.next(x) * (1 + DRUM_RES_MAKEUP * this.ladder.k);
      }
      this.sweepEnv *= this.sweepG;
      const v = drive(x, this.drive) * at(p.level, j);
      outL[i] += v;
      outR[i] += v;
    }

    if (!Number.isFinite(this.filter.ic1 + this.filter.ic2 + phase[0] + env[0])) {
      this.reset();
      this.active = false;
      return;
    }
    const ls = this.ladder.s;
    const ringing = this.filtered && Math.abs(ls[0]) + Math.abs(ls[1]) + Math.abs(ls[2]) + Math.abs(ls[3]) >= SILENT;
    if (this.tailOn && env[0] < SILENT && this.tail < SILENT && this.slowLevel * this.slow < SILENT && this.burst < SILENT && this.click < SILENT && !ringing) {
      this.active = false;
    }
  }
}

export class DrumSynth {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.voices = Array.from({ length: 16 }, () => new DrumVoice(sampleRate));
    this.voiceCount = 8;
    this.clock = 0;
    this.seed = 1;
    this.events = [];
    this.bend = 0;
    this.bendArray = null;
    this.state = {
      values: Object.fromEntries(DRUM.params.map((p) => [p.id, p.default])),
      bendArray: null,
      bendAt: (i) => (this.bendArray ? this.bendArray[i] : this.bend),
    };
  }

  /** The controls in real units: a number, or a block of values for one a signal is moving. */
  setParams(values) {
    const s = this.state;
    for (const p of DRUM.params) {
      const v = values[p.id];
      if (v === undefined) continue;
      if (typeof v === 'number' ? Number.isFinite(v) : v.length > 0) s.values[p.id] = v;
    }
    const count = at(s.values.voices, 0);
    if (Number.isFinite(count)) this.voiceCount = Math.max(1, Math.round(count));
    while (this.voices.length < this.voiceCount) this.voices.push(new DrumVoice(this.sampleRate));
  }

  /** The track's bend in semitones, which moves every body. */
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
    this.events.push({ at: Math.max(0, offset | 0), note, velocity });
  }

  /** A hit plays out: there is nothing for a note off to do. */
  queueNoteOff() {}

  /** Stop lets what is ringing ring out; only hits not yet started are dropped. */
  allNotesOff() {
    this.events.length = 0;
  }

  get activeVoices() {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  /** A free voice, or the oldest. */
  allocate() {
    let oldest = null;
    for (let i = 0; i < this.voiceCount; i++) {
      const v = this.voices[i];
      if (!v.active) return v;
      if (!oldest || v.age < oldest.age) oldest = v;
    }
    return oldest ?? this.voices[0];
  }

  /** Starts a hit, struck with the controls at sample `j` of the block. */
  startNote(note, velocity, j) {
    const voice = this.allocate();
    voice.age = this.clock++;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    voice.noteOn(note, velocity, this.seed, this.state.values, j);
  }

  /** Renders one block, split wherever a queued hit falls. */
  process(outL, outR, count) {
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);
    let at0 = 0;
    let next = 0;
    while (at0 < count) {
      const first = next;
      while (next < events.length && events[next].at <= at0) next++;
      const until = next < events.length ? Math.min(count, events[next].at) : count;
      const n = until - at0;
      // Struck with the controls a sample in, where the piece has one (see the header).
      for (let e = first; e < next; e++) this.startNote(events[e].note, events[e].velocity, n > 1 ? at0 + 1 : at0);
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
