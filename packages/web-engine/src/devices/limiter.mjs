// The Limiter effect: a brickwall peak limiter with lookahead.
//
// The signal is delayed by the lookahead and the gain is the smallest the window ahead needs to
// stay under the ceiling, smoothed toward it over that same window - so a peak is already being
// turned down when it arrives, and nothing above the ceiling gets through. The release is the
// only time constant to set; the attack IS the lookahead.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { DYNAMICS_BLOCKS_PER_ENTRY, History } from '../dsp/history.mjs';

/** The lookahead, in seconds. Two milliseconds is under a hundred samples: inaudible as latency. */
const LOOKAHEAD_SEC = 0.002;

export const LIMITER = defineDevice({
  id: 'Limiter',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-limiter',
  description: 'A brickwall limiter with two milliseconds of lookahead: nothing crosses the ceiling.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'gain', name: 'Gain', min: -12, max: 24, default: 0, unit: 'dB',
      description: 'Level into the limiter. Push it to make things louder; the ceiling holds.' },
    { id: 'ceiling', name: 'Ceiling', min: -24, max: 0, default: -0.3, unit: 'dB' },
    { id: 'release', name: 'Release', min: 5, max: 1000, default: 80, unit: 'ms', curve: 'exp' },
  ],
  // The same picture a compressor draws, with no ratio to bend it: a wall at the ceiling, the
  // signal's level laid against it, and how much is being held back. A limiter with no picture
  // is a device whose one job cannot be seen happening.
  figures: [
    {
      id: 'curve',
      kind: 'transfer',
      title: '',
      description: 'What comes out for what goes in: everything above the ceiling is held to it. The dot is where the signal is on it right now, after the gain.',
      params: { threshold: 'ceiling', pregain: 'gain' },
    },
  ],
});

export class LimiterProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.look = Math.max(1, Math.round(sampleRate * LOOKAHEAD_SEC));
    const size = this.look + 1;
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.need = new Float32Array(size);     // the gain each delayed sample needs
    this.pos = 0;
    this.gain = 1;
    this.reduction = 0;
    this.level = -120;       // the loudest the input reached this block, after the gain, in dB
    this.levels = new History(undefined, -120, { per: DYNAMICS_BLOCKS_PER_ENTRY, keep: 'max' });
    this.reductions = new History(undefined, 0, { per: DYNAMICS_BLOCKS_PER_ENTRY, keep: 'min' });
    this.blockSec = 128 / sampleRate;
  }

  process(inputs, outputs, count, params) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const look = this.look;
    const size = look + 1;
    const attackK = 1 - Math.exp(-1 / (look * 0.5));
    let reduction = 1;
    let loudest = 0;
    for (let i = 0; i < count; i++) {
      const pre = dbToGain(at(params.gain, i));
      const ceiling = dbToGain(at(params.ceiling, i));
      const releaseK = 1 - Math.exp(-1 / (at(params.release, i) * 0.001 * this.sampleRate));
      const l = (inL ? inL[i] : 0) * pre;
      const r = (inR ? inR[i] : 0) * pre;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      if (peak > loudest) loudest = peak;
      // Where this sample goes into the delay, and the gain it will need when it comes out.
      this.bufL[this.pos] = l;
      this.bufR[this.pos] = r;
      this.need[this.pos] = peak > ceiling ? ceiling / peak : 1;
      // The smallest gain anything in the window needs: what the output must already be at.
      let target = 1;
      for (let k = 0; k < size; k++) if (this.need[k] < target) target = this.need[k];
      // Down fast enough to be there by the time the peak arrives, back up at the release.
      this.gain += (target - this.gain) * (target < this.gain ? attackK : releaseK);
      const g = Math.min(this.gain, target);
      const read = (this.pos + 1) % size;
      outL[i] = this.bufL[read] * g;
      if (outR !== outL) outR[i] = this.bufR[read] * g;
      this.pos = read;
      if (g < reduction) reduction = g;
    }
    this.reduction = reduction;
    this.level = loudest > 1e-6 ? 20 * Math.log10(loudest) : -120;
    this.levels.push(this.level);
    this.reductions.push(reduction < 1 ? 20 * Math.log10(reduction) : 0);
    this.blockSec = (count / this.sampleRate) * DYNAMICS_BLOCKS_PER_ENTRY;
  }

  /** Where the signal is and how much is being held back, for the picture, and the last second of both. */
  report() {
    return {
      meters: {
        curve: {
          inDb: this.level, grDb: this.reduction < 1 ? 20 * Math.log10(this.reduction) : 0,
          history: { inDb: this.levels.snapshot(), grDb: this.reductions.snapshot(), blockSec: this.blockSec },
        },
      },
    };
  }
}
