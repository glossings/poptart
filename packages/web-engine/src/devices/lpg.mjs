// The LPG effect: a low-pass gate - a level and a lowpass opened together by one control,
// through the slow, uneven response of a light-dependent resistor rather than a straight line.
//
// What makes a low-pass gate sound the way it does is not the filter, which is an ordinary
// two-pole lowpass, but the element driving it. A lamp lights a photoresistor: it brightens in
// a millisecond or two and fades over a long, lopsided tail, slower the darker it gets. Opening
// the level and the cutoff together on that one curve is why a struck gate sounds like a struck
// object - the tone dulls as it dies away, the way a real one does.
//
// Two ways to drive it. With nothing routed in, Level is how far open it is - set it, sweep it,
// or put an env() or lfo() on it, and the response smooths whatever arrives. With notes routed
// in (`.fx("LPG").midi("lead")`), each note STRIKES it: a few milliseconds of drive, as high as
// Level times the note's velocity, and then it closes on its own over Decay.
//
// Translated line for line into native/devices/own/lpg.cc for the desktop, and held to it by
// native-device-parity.test.mjs.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';

export const LPG_MODES = Object.freeze(['combined', 'vca', 'lowpass']);

/** How quickly the element brightens, in seconds: a lamp warming up, not an instant. */
const ATTACK_SEC = 0.0015;

/** How long a struck note drives the element for, in seconds. */
const STRIKE_SEC = 0.004;

/** The lowest and highest the cutoff goes as the gate opens. */
const CUTOFF_LOW = 20;
const CUTOFF_SPAN = 1000;

/** Where the element counts as dark, so its tail does not run on in denormals. */
const DARK = 1e-9;

export const LPG = defineDevice({
  id: 'LPG',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-lpg',
  description: 'A low-pass gate: a level and a lowpass opened together through a slow, uneven response, so a sound dulls as it dies away. Notes routed in with .midi() strike it open.',
  channels: { in: 2, out: 2 },
  notes: true,
  params: [
    { id: 'level', name: 'Level', min: 0, max: 1, default: 1,
      description: 'How far open the gate is. With notes routed in with .midi(), how far each note strikes it open, times its velocity.' },
    { id: 'decay', name: 'Decay', min: 0.02, max: 5, default: 0.4, unit: 's', curve: 'pow', curveExp: 2,
      description: 'How long the gate takes to close. The end of the close is slower than the start.' },
    { id: 'mode', name: 'Mode', default: 0, options: [...LPG_MODES], rate: 'k',
      description: 'Combined opens the level and the lowpass together; vca is the level alone; lowpass is the filter alone.' },
    { id: 'resonance', name: 'Resonance', min: 0, max: 1, default: 0,
      description: 'A peak at the cutoff, which rings as the gate closes.' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB' },
  ],
});

export class LpgProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.frames = 0;
    this.noteRouted = false;
    this.pending = [];        // [time, velocity] of strikes not yet reached, oldest first
    this.strikeLen = Math.round(STRIKE_SEC * sampleRate);
    this.attackK = 1 / (1 + ATTACK_SEC * sampleRate);
    this.reset();
  }

  reset() {
    this.light = 0;
    this.pulse = 0;
    this.pulseLeft = 0;
    this.ic1L = 0; this.ic2L = 0; this.ic1R = 0; this.ic2R = 0;
    this.lastLight = -1;
    this.lastRes = -1;
    this.a1 = 1; this.a2 = 0; this.a3 = 0; this.gain = 0;
  }

  /** A route of notes was set or cleared (see the engine's injectMidi). */
  setNoteRoute(on) {
    this.noteRouted = !!on;
    if (!this.noteRouted) this.pending.length = 0;
  }

  /** A note from the routed track strikes the gate at the note's time. */
  noteOn(_note, velocity, time) {
    if (!(velocity > 0)) return;
    this.noteRouted = true;
    const t = Number.isFinite(time) ? time : 0;
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1][0] > t) i -= 1;
    this.pending.splice(i, 0, [t, velocity]);
    if (this.pending.length > 64) this.pending.shift();
  }

  noteOff() { /* a strike is a shape in time, not a gate: an off changes nothing */ }

  process(inputs, outputs, count, params, _sidechain = null, timeSec = null) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sr = this.sampleRate;
    const start = timeSec ?? this.frames / sr;
    const mode = Math.min(LPG_MODES.length - 1, Math.max(0, Math.round(at(params.mode, 0))));
    for (let i = 0; i < count; i++) {
      const level = Math.min(1, Math.max(0, at(params.level, i)));
      let drive = level;
      if (this.noteRouted) {
        const now = start + i / sr;
        while (this.pending.length && this.pending[0][0] <= now) {
          const strike = level * this.pending.shift()[1];
          this.pulse = this.pulseLeft > 0 ? Math.max(this.pulse, strike) : strike;
          this.pulseLeft = this.strikeLen;
        }
        drive = this.pulseLeft > 0 ? this.pulse : 0;
        if (this.pulseLeft > 0) this.pulseLeft -= 1;
      }
      // The element: quick to brighten, slow to fade, and slower the darker it gets.
      if (drive > this.light) {
        this.light += (drive - this.light) * this.attackK;
      } else {
        const tau = (at(params.decay, i) * 0.25) / (0.3 + 0.7 * this.light);
        this.light += (drive - this.light) / (1 + tau * sr);
      }
      if (this.light < DARK) this.light = 0;

      const res = Math.min(1, Math.max(0, at(params.resonance, i)));
      if (this.light !== this.lastLight || res !== this.lastRes) {
        const cutoff = Math.min(0.45 * sr, CUTOFF_LOW * Math.pow(CUTOFF_SPAN, this.light));
        const g = Math.tan((Math.PI * cutoff) / sr);
        const k = 2 - 1.9 * res;
        this.a1 = 1 / (1 + g * (g + k));
        this.a2 = g * this.a1;
        this.a3 = g * this.a2;
        this.gain = this.light * this.light;
        this.lastLight = this.light;
        this.lastRes = res;
      }
      const out = dbToGain(at(params.output, i));
      const xl = inL ? inL[i] : 0;
      const xr = inR ? inR[i] : 0;
      let yl = xl;
      let yr = xr;
      if (mode !== 1) {
        // A two-pole state-variable lowpass, trapezoidal, so the cutoff can move every sample.
        let v3 = xl - this.ic2L;
        let v1 = this.a1 * this.ic1L + this.a2 * v3;
        let v2 = this.ic2L + this.a2 * this.ic1L + this.a3 * v3;
        this.ic1L = 2 * v1 - this.ic1L;
        this.ic2L = 2 * v2 - this.ic2L;
        yl = v2;
        v3 = xr - this.ic2R;
        v1 = this.a1 * this.ic1R + this.a2 * v3;
        v2 = this.ic2R + this.a2 * this.ic1R + this.a3 * v3;
        this.ic1R = 2 * v1 - this.ic1R;
        this.ic2R = 2 * v2 - this.ic2R;
        yr = v2;
      }
      if (mode !== 2) { yl *= this.gain; yr *= this.gain; }
      outL[i] = yl * out;
      if (outR !== outL) outR[i] = yr * out;
    }
    this.frames += count;
    if (!Number.isFinite(this.ic1L + this.ic2L + this.ic1R + this.ic2R + this.light)) this.reset();
  }
}
