// The Overdrive effect: distortion applied to one region of the spectrum and nothing else.
//
// The signal is split at two corners - a highpass under the region, a lowpass over it - and only
// what lies between is driven; what lies outside passes clean and is added back. That is what
// keeps a driven bass from turning to mud below and fizz above, and it is what the region
// controls are for. A dynamics control compresses the region before the drive, so the grit is
// steady across a part rather than only on its loudest notes.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { BIQUAD_TYPES, Biquad } from '../dsp/biquad.mjs';
import { OnePole } from '../dsp/filters.mjs';
import { Detector } from './compressor.mjs';

export const OVERDRIVE = defineDevice({
  id: 'Overdrive',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-overdrive',
  description: 'Overdrive on one region of the spectrum: what lies between the two corners is driven, and what lies outside passes clean.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'low', name: 'Low', min: 20, max: 20000, default: 80, unit: 'Hz', curve: 'exp', group: 'Region',
      description: 'The bottom of the driven region.' },
    { id: 'high', name: 'High', min: 20, max: 20000, default: 4000, unit: 'Hz', curve: 'exp', group: 'Region',
      description: 'The top of the driven region.' },
    { id: 'drive', name: 'Drive', min: 0, max: 48, default: 12, unit: 'dB', curve: 'pow', curveExp: 2, group: 'Drive' },
    { id: 'tone', name: 'Tone', min: 200, max: 20000, default: 6000, unit: 'Hz', curve: 'exp', group: 'Drive',
      description: 'A lowpass on the driven region after the curve.' },
    { id: 'dynamics', name: 'Dynamics', min: 0, max: 1, default: 0.3, group: 'Drive',
      description: 'Compresses the region before it is driven, so quiet notes are driven as hard as loud ones.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, group: 'Drive' },
  ],
  figures: [
    {
      id: 'region',
      kind: 'band',
      group: 'Region',
      title: 'region',
      description: 'The driven region of the spectrum. Drag either edge.',
      params: { low: 'low', high: 'high' },
      drag: { x: 'low' },
    },
  ],
  panel: { width: 640, rows: [['Region', 'Drive']] },
});

const LOWPASS = BIQUAD_TYPES.indexOf('lowpass');
const HIGHPASS = BIQUAD_TYPES.indexOf('highpass');

/** One channel: the region's two corners, the level detector, the tone. */
class DriveChannel {
  constructor(sampleRate) {
    this.hp = new Biquad();
    this.lp = new Biquad();
    this.tone = new OnePole(sampleRate);
    this.detector = new Detector(sampleRate);
    this.detector.setTimes(5, 80);
  }

  reset() { this.hp.reset(); this.lp.reset(); this.tone.reset(); }
}

export class OverdriveProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.channels = [new DriveChannel(sampleRate), new DriveChannel(sampleRate)];
    this.last = { low: -1, high: -1, tone: -1 };
  }

  process(inputs, outputs, count, params) {
    const low = at(params.low, 0);
    const high = Math.max(low, at(params.high, 0));
    const tone = at(params.tone, 0);
    if (low !== this.last.low || high !== this.last.high || tone !== this.last.tone) {
      for (const c of this.channels) {
        // Glided across the block: the driven region is what this device is FOR, so its two
        // corners are dragged about constantly and a per-block jump is heard on every drag.
        c.hp.glideTo(HIGHPASS, low, 0, Math.SQRT1_2, this.sampleRate, count);
        c.lp.glideTo(LOWPASS, high, 0, Math.SQRT1_2, this.sampleRate, count);
        c.tone.glideTo(tone, count);
      }
      this.last = { low, high, tone };
    }
    for (let ch = 0; ch < outputs.length; ch++) {
      const out = outputs[ch];
      const input = inputs[Math.min(ch, inputs.length - 1)];
      if (!input) { out.fill(0, 0, count); continue; }
      const c = this.channels[Math.min(ch, 1)];
      for (let i = 0; i < count; i++) {
        const x = input[i];
        const region = c.lp.next(c.hp.next(x));
        const rest = x - region;
        // The dynamics: a gentle upward lift on the region toward a fixed level.
        const dyn = at(params.dynamics, i);
        const env = c.detector.next(Math.abs(region));
        const lift = dyn > 0 ? Math.pow(Math.max(1e-4, env) / 0.25, -0.7 * dyn) : 1;
        const drive = dbToGain(at(params.drive, i));
        const driven = Math.tanh(region * Math.min(lift, 16) * drive) / Math.tanh(Math.min(drive, 4) * 0.5 + 0.5);
        const wet = c.tone.next(driven) * 0.7 + rest;
        const mix = at(params.mix, i);
        out[i] = x + (wet - x) * mix;
      }
      if (!Number.isFinite(out[count - 1])) c.reset();
    }
  }
}
