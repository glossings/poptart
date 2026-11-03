// The Spring device: the descriptor, and the block processor that drives the tank.
//
// The tank's geometry (decay, length, chirp, transition, modulation, damping, low cut, feedback)
// is set per block, as the Reverb's is, and the transition frequency glides from there. Drive,
// Shake, width, mix and output are read per sample.
//
// Notes routed in with .midi() play it, as they strike the LPG: each note, on its own sample,
// glides the transition frequency to the note's frequency and pings the tank with Shake's burst
// of noise, without its thump, as loud as the note's velocity. A note off changes nothing. While notes are routed
// in, the last note's frequency stands in for the Transition control.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { MAX_FEEDBACK, MAX_LENGTH, MAX_TRANSITION, MIN_TRANSITION, SpringTank } from '../dsp/spring.mjs';

/** Starting points for the preset menu: each the defaults with these controls changed. */
export const SPRING_PRESETS = Object.freeze({
  amp: { decay: 1.6, length: 0.035, chirp: 0.55, damping: 4500, lowcut: 250, mix: 0.25 },
  surf: { decay: 3.5, length: 0.06, chirp: 0.7, drive: 12, damping: 6000, lowcut: 300, mix: 0.45 },
  dub: { decay: 6, length: 0.08, chirp: 0.65, transition: 3000, modulation: 0.5, damping: 2500, lowcut: 120, mix: 0.5 },
  tight: { decay: 0.7, length: 0.025, chirp: 0.5, damping: 7000, lowcut: 300, mix: 0.3 },
  boing: { decay: 4, length: 0.1, chirp: 0.9, transition: 2500, damping: 5000, mix: 0.5 },
  bright: { decay: 2.5, length: 0.045, chirp: 0.6, transition: 5500, damping: 10000, lowcut: 400, mix: 0.35 },
  wobbly: { decay: 3, length: 0.07, chirp: 0.65, modulation: 1, damping: 4000, mix: 0.4 },
  endless: { decay: 12, length: 0.09, chirp: 0.6, transition: 3500, modulation: 0.6, damping: 3000, mix: 0.5, output: -4 },
  falling: { decay: 3, length: 0.06, chirp: -0.7, transition: 3500, damping: 6000, mix: 0.45 },
  laser: { decay: 3, length: 0.08, chirp: -0.95, transition: 3000, damping: 9000, lowcut: 120, mix: 0.5 },
  howl: { decay: 4, length: 0.05, chirp: 0.8, transition: 2200, feedback: 1.15, drive: 12, damping: 3000, mix: 0.5, output: -8 },
  drone: { decay: 12, length: 0.12, chirp: 0.7, transition: 900, feedback: 1, modulation: 0.6, damping: 2000, mix: 0.6, output: -6 },
});

export const SPRING = defineDevice({
  id: 'Spring',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-spring',
  description: 'A spring reverb: two springs whose echoes arrive as chirps, through a driver that saturates. Notes routed in with .midi() tune it and knock it.',
  channels: { in: 2, out: 2 },
  notes: true,
  params: [
    { id: 'decay', name: 'Decay', min: 0.2, max: 12, default: 2.5, unit: 's', curve: 'exp', group: 'Spring',
      description: 'How long the tail takes to fall sixty decibels, below the damping frequency. Above it the tail is shorter.' },
    { id: 'length', name: 'Length', min: 0.015, max: MAX_LENGTH, default: 0.045, unit: 's', curve: 'exp', group: 'Spring',
      description: 'The time between echoes: one round trip of the left spring. The right spring is a little longer.' },
    { id: 'chirp', name: 'Chirp', min: -1, max: 1, default: 0.6, group: 'Spring',
      description: 'How far each echo is spread in time from low to high frequencies. Above 0 the chirps rise; below 0 they fall; at 0 the echoes are not spread.' },
    { id: 'transition', name: 'Transition', min: MIN_TRANSITION, max: MAX_TRANSITION, default: 4300, unit: 'Hz', curve: 'exp', group: 'Spring',
      description: 'The frequency the chirps rise to or fall from. Changing it glides, and bends the echoes already in the springs. With notes routed in with .midi(), each note sets it to the note\'s frequency.' },
    { id: 'feedback', name: 'Feedback', min: 0, max: MAX_FEEDBACK, default: 0, group: 'Spring',
      description: 'The least each trip round the springs keeps, in place of Decay where it is higher. At 1 the tail holds; above 1 it grows until the springs saturate.' },
    { id: 'modulation', name: 'Modulation', min: 0, max: 1, default: 0.25, group: 'Spring',
      description: 'Moves the springs\' delay slowly and at random, by up to 1.5 ms.' },
    { id: 'drive', name: 'Drive', min: 0, max: 24, default: 0, unit: 'dB', group: 'Spring',
      description: 'Gain into the driver, which saturates. The level into the springs stays the same.' },
    { id: 'shake', name: 'Shake', min: 0, max: 1, default: 0, ui: 'button', saved: false, group: 'Spring',
      description: 'Knocks the tank: a thump and a burst of noise into the springs, through the driver. Notes routed in with .midi() ping it with the burst alone, as loud as their velocity.' },
    { id: 'damping', name: 'Damping', min: 500, max: 16000, default: 5000, unit: 'Hz', curve: 'exp', group: 'Tone',
      description: 'Where the tail starts losing its top as it decays.' },
    { id: 'lowcut', name: 'Low Cut', min: 10, max: 2000, default: 180, unit: 'Hz', curve: 'exp', group: 'Tone' },
    { id: 'width', name: 'Width', min: 0, max: 1, default: 1, group: 'Tone',
      description: 'At 1 each spring is on its own side; at 0 both are in the middle.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.35, group: 'Tone' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Tone' },
  ],
  figures: [
    {
      id: 'echoes',
      kind: 'chirps',
      group: 'Spring',
      title: 'echoes',
      description: 'The echoes of one hit, time across and frequency up: each one a chirp, rising to the transition frequency or falling from it, quieter every trip. The faint lines are the full-band chirps. Drag across for the length, up for the transition frequency.',
      params: { decay: 'decay', length: 'length', chirp: 'chirp', transition: 'transition', feedback: 'feedback', damping: 'damping', lowcut: 'lowcut' },
      drag: { x: 'length', y: 'transition' },
    },
  ],
  presets: SPRING_PRESETS,
});

export class SpringProcessor {
  constructor(sampleRate) {
    this.tank = new SpringTank(sampleRate);
    this.wet = new Float64Array(2);
    this.shaking = false; // Shake as the last sample read it
    this.sampleRate = sampleRate;
    this.frames = 0;
    this.noteRouted = false;
    this.noteHz = null;   // the last routed note's frequency, once one has arrived
    this.pending = [];    // [time in seconds, frequency, velocity], soonest first
  }

  reset() {
    this.tank.reset();
  }

  /** A route of notes was set or cleared (see the engine's injectMidi). */
  setNoteRoute(on) {
    this.noteRouted = !!on;
    if (!this.noteRouted) {
      this.pending.length = 0;
      this.noteHz = null;
    }
  }

  /** A note from the routed track: it lands on its own sample, inside the block. */
  noteOn(note, velocity, time) {
    if (!(velocity > 0)) return;
    this.noteRouted = true;
    const t = Number.isFinite(time) ? time : 0;
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1][0] > t) i -= 1;
    this.pending.splice(i, 0, [t, 440 * Math.pow(2, (note - 69) / 12), velocity]);
    if (this.pending.length > 64) this.pending.shift();
  }

  /** A note is a knock and a pitch, not a gate: an off changes nothing. */
  noteOff() {}

  process(inputs, outputs, count, params, _sidechain = null, timeSec = null) {
    const sr = this.sampleRate;
    const start = timeSec ?? this.frames / sr;
    this.frames += count;
    // Every block: the transition frequency glides, so what follows from it moves while it does.
    this.tank.set({
      decay: at(params.decay, 0),
      length: at(params.length, 0),
      chirp: at(params.chirp, 0),
      transition: this.noteRouted && this.noteHz != null ? this.noteHz : at(params.transition, 0),
      modulation: at(params.modulation, 0),
      damping: at(params.damping, 0),
      lowCut: at(params.lowcut, 0),
      feedback: at(params.feedback, 0),
    });

    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const wet = this.wet;
    for (let i = 0; i < count; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const held = at(params.shake, i) >= 0.5;
      const pressed = held && !this.shaking;
      this.shaking = held;
      let level = pressed ? 1 : 0;
      // The notes due by this sample, as a whole sample number from the block's start.
      while (this.pending.length && Math.round((this.pending[0][0] - start) * sr) <= i) {
        const [, hz, velocity] = this.pending.shift();
        this.noteHz = hz;
        this.tank.retune(hz);
        level = Math.max(level, velocity);
      }
      if (level > 0) this.tank.knock(level, pressed);
      this.tank.next((l + r) * 0.5, dbToGain(at(params.drive, i)), wet);
      const width = Math.min(1, Math.max(0, at(params.width, i)));
      const same = (1 + width) * 0.5;
      const cross = (1 - width) * 0.5;
      const wl = wet[0] * same + wet[1] * cross;
      const wr = wet[1] * same + wet[0] * cross;
      const mix = Math.min(1, Math.max(0, at(params.mix, i)));
      const gain = dbToGain(at(params.output, i));
      const ol = (l * (1 - mix) + wl * mix) * gain;
      const or = (r * (1 - mix) + wr * mix) * gain;
      outL[i] = ol;
      if (outR !== outL) outR[i] = or; else outL[i] = (ol + or) * 0.5;
    }
    if (!Number.isFinite(outL[count - 1])) this.tank.reset();
  }
}
