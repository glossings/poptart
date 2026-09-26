// The Phaser effect: a chain of first-order allpasses swept together, mixed back with the dry.
//
// Each allpass turns the phase through half a cycle around its corner; summed with the dry
// signal, every pair of stages makes one notch, and the LFO sweeps the corners up and down the
// spectrum together. Feedback from the end of the chain to its start sharpens the notches into
// the resonant, vowel-like sweep a phaser is known for.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { lfoValue } from '../dsp/moddelay.mjs';
import { SYNC_OPTIONS, syncedHz } from '../dsp/sync.mjs';

const MAX_STAGES = 12;

export const PHASER = defineDevice({
  id: 'Phaser',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-phaser',
  description: 'A phaser: up to twelve allpass stages swept by an LFO, with feedback for sharper notches.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'stages', name: 'Stages', min: 2, max: MAX_STAGES, default: 6, step: 2, rate: 'k', ui: 'number',
      description: 'Every two stages make one notch.' },
    { id: 'rate', name: 'Rate', min: 0.02, max: 10, default: 0.4, unit: 'Hz', curve: 'exp',
      active: { param: 'sync', is: 'free' } },
    { id: 'sync', name: 'Sync', default: 0, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'A division of the beat overrides the rate and follows the tempo.' },
    { id: 'center', name: 'Center', min: 100, max: 8000, default: 1000, unit: 'Hz', curve: 'exp',
      description: 'The middle of the sweep.' },
    { id: 'depth', name: 'Depth', min: 0, max: 1, default: 0.7,
      description: 'How far the sweep reaches either side of the center, up to three octaves.' },
    { id: 'feedback', name: 'Feedback', min: -0.9, max: 0.9, default: 0.4 },
    { id: 'spread', name: 'Spread', min: 0, max: 1, default: 0.5,
      description: 'How far the right channel\'s sweep sits behind the left\'s.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.5 },
  ],
  figures: [
    {
      id: 'sweep',
      kind: 'sweep',
      title: 'sweep',
      description: 'Where the notches sit over one cycle of the LFO, left and right apart by the spread, and where the sweep is now. Drag up for the depth.',
      params: { rate: 'rate', depth: 'depth', center: 'center', sync: 'sync', spread: 'spread' },
      drag: { y: 'depth' },
    },
  ],
});

/** One channel's chain of first-order allpasses and its feedback sample. */
class Chain {
  constructor() {
    this.z = new Float64Array(MAX_STAGES);
    this.fb = 0;
  }

  reset() { this.z.fill(0); this.fb = 0; }

  /** Runs a sample through `stages` allpasses with coefficient `a`. */
  next(x, stages, a, feedback) {
    let v = x + this.fb * feedback;
    for (let s = 0; s < stages; s++) {
      const y = -a * v + this.z[s];
      this.z[s] = v + a * y;
      v = y;
    }
    this.fb = Math.tanh(v);
    return v;
  }
}

export class PhaserProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.chains = [new Chain(), new Chain()];
    this.phase = 0;
    this.bpm = 120;
  }

  setTempo(bpm) { this.bpm = bpm; }

  process(inputs, outputs, count, params) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sync = Math.round(at(params.sync, 0));
    const stages = Math.max(2, Math.min(MAX_STAGES, Math.round(at(params.stages, 0) / 2) * 2));
    const sr = this.sampleRate;
    for (let i = 0; i < count; i++) {
      this.phase += syncedHz(sync, this.bpm, at(params.rate, i)) / sr;
      if (this.phase >= 1) this.phase -= 1;
      const center = at(params.center, i);
      const octaves = 3 * at(params.depth, i);
      const feedback = at(params.feedback, i);
      const spread = at(params.spread, i) * 0.5;
      const mix = at(params.mix, i);
      // The sweep is in octaves around the center, so it covers the same musical range at any
      // center, and the allpass coefficient comes from the swept corner.
      const hzL = center * Math.pow(2, octaves * (lfoValue(this.phase, 0) * 2 - 1));
      const hzR = center * Math.pow(2, octaves * (lfoValue(this.phase + spread, 0) * 2 - 1));
      const aL = coefficient(hzL, sr);
      const aR = coefficient(hzR, sr);
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const wetL = this.chains[0].next(l, stages, aL, feedback);
      const wetR = this.chains[1].next(r, stages, aR, feedback);
      outL[i] = l + (wetL - l) * mix;
      if (outR !== outL) outR[i] = r + (wetR - r) * mix;
    }
    if (!Number.isFinite(outL[count - 1])) for (const c of this.chains) c.reset();
  }

  /** Where the LFO is, so the picture's playhead follows the sound. */
  report() {
    return { phase: this.phase };
  }
}

/** The first-order allpass coefficient whose phase turns through a quarter cycle at `hz`. */
function coefficient(hz, sampleRate) {
  const f = Math.min(sampleRate * 0.45, Math.max(10, hz));
  const t = Math.tan((Math.PI * f) / sampleRate);
  return (1 - t) / (1 + t);
}
