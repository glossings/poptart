// The Flanger effect: a very short modulated delay with feedback, for the comb that sweeps.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { ModDelay } from '../dsp/moddelay.mjs';
import { SYNC_OPTIONS, syncedHz } from '../dsp/sync.mjs';

export const FLANGER = defineDevice({
  id: 'Flanger',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-flanger',
  description: 'A flanger: a delay of a few milliseconds swept by an LFO and fed back on itself, for a comb filter that moves.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'rate', name: 'Rate', min: 0.02, max: 10, default: 0.25, unit: 'Hz', curve: 'exp',
      active: { param: 'sync', is: 'free' } },
    { id: 'sync', name: 'Sync', default: 0, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'A division of the beat overrides the rate and follows the tempo.' },
    { id: 'depth', name: 'Depth', min: 0, max: 10, default: 3, unit: 'ms' },
    { id: 'delay', name: 'Delay', min: 0.1, max: 12, default: 1.5, unit: 'ms',
      description: 'The shortest the delay gets. The comb\'s first notch sits at half the sample rate over this.' },
    { id: 'feedback', name: 'Feedback', min: -0.95, max: 0.95, default: 0.5,
      description: 'Negative feedback moves the notches to the peaks and back.' },
    { id: 'spread', name: 'Spread', min: 0, max: 1, default: 0.5,
      description: 'How far the right channel\'s sweep sits behind the left\'s.' },
    { id: 'shape', name: 'Shape', default: 0, options: ['sine', 'triangle'], rate: 'k' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.5 },
  ],
  figures: [
    {
      id: 'sweep',
      kind: 'sweep',
      title: 'sweep',
      description: 'The delay each copy is read at over one cycle of the LFO, left and right apart by the spread. Drag up for the depth.',
      params: { rate: 'rate', depth: 'depth', delay: 'delay', sync: 'sync', spread: 'spread', shape: 'shape' },
      drag: { y: 'depth' },
    },
  ],
});

export class FlangerProcessor {
  constructor(sampleRate) {
    this.delay = new ModDelay(sampleRate, 0.03);
    this.bpm = 120;
    this.wet = [0, 0];
  }

  setTempo(bpm) { this.bpm = bpm; }

  process(inputs, outputs, count, params) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sync = Math.round(at(params.sync, 0));
    const shape = Math.round(at(params.shape, 0));
    const wet = this.wet;
    for (let i = 0; i < count; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      this.delay.next(l, r, wet, {
        baseSec: at(params.delay, i) * 0.001,
        depthSec: at(params.depth, i) * 0.001,
        rateHz: syncedHz(sync, this.bpm, at(params.rate, i)),
        spread: at(params.spread, i),
        feedback: at(params.feedback, i),
        shape,
      });
      const mix = at(params.mix, i);
      outL[i] = l + (wet[0] - l) * mix;
      if (outR !== outL) outR[i] = r + (wet[1] - r) * mix;
    }
    if (!Number.isFinite(outL[count - 1])) this.delay.reset();
  }

  /** Where the LFO is, so the picture's playhead follows the sound. */
  report() {
    return { phase: this.delay.phase };
  }
}
