// The Ducker effect: a level dip on every beat, shaped like a compressor pumping to a kick,
// without needing the kick.
//
// The dip runs on the transport's clock - the engine tells every device the tempo and where the
// beat falls - so it is on the grid whatever is playing through it. With a sidechain patched in
// it triggers on that signal's transients instead, which is the same shape driven by a real
// kick. Either way the shape is the thing: a curve from the dip's floor back up to full over the
// length set, which is what a sidechain compressor's release does with far less to set.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { curveShape } from '../dsp/adsr.mjs';
import { SYNC_OPTIONS, syncedSeconds } from '../dsp/sync.mjs';

export const DUCKER = defineDevice({
  id: 'Ducker',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-ducker',
  description: 'A level dip on the beat, or on the transients of a sidechained track: the pump of a sidechain compressor, with a shape to draw instead of a detector to fight.',
  channels: { in: 2, out: 2 },
  sidechain: true,
  params: [
    { id: 'sync', name: 'Sync', default: 8, options: [...SYNC_OPTIONS], rate: 'k',
      description: 'How often the dip happens on the clock. Ignored when a sidechain is patched in, which triggers it instead.' },
    { id: 'amount', name: 'Amount', min: 0, max: 1, default: 0.8,
      description: 'How far the level drops at the dip.' },
    { id: 'length', name: 'Length', min: 0.05, max: 1, default: 0.5,
      description: 'How much of the beat the recovery takes, as a share of the sync division - or in seconds times two when a sidechain triggers it.' },
    { id: 'attack', name: 'Attack', min: 0, max: 50, default: 2, unit: 'ms',
      description: 'How long the drop itself takes. A few milliseconds keeps it from clicking.' },
    { id: 'curve', name: 'Curve', min: -8, max: 8, default: 3, step: 0.5, ui: 'number', rate: 'k',
      description: 'The shape of the recovery: positive starts slow and rises fast at the end, which is the classic pump; negative snaps back at once.' },
    { id: 'threshold', name: 'Threshold', min: -60, max: 0, default: -24, unit: 'dB',
      description: 'The level a sidechained signal has to reach to trigger the dip.' },
  ],
});

export class DuckerProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.bpm = 120;
    this.anchorSec = 0;
    this.elapsed = null;      // seconds since the last trigger, or null before the first
    this.gain = 1;
    this.lastBeat = -1;
    this.armed = true;
    this.env = 0;
    this.frames = 0;
  }

  setTempo(bpm, anchorSec = null) {
    this.bpm = bpm;
    if (anchorSec != null) this.anchorSec = anchorSec;
  }

  process(inputs, outputs, count, params, sidechain, timeSec = null) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sync = Math.round(at(params.sync, 0));
    const period = syncedSeconds(sync, this.bpm, 0.5);
    const curve = at(params.curve, 0);
    const keyed = !!(sidechain && sidechain[0]);
    const sr = this.sampleRate;
    const attackK = 1 - Math.exp(-1 / Math.max(1, at(params.attack, 0) * 0.001 * sr));
    const threshold = Math.pow(10, at(params.threshold, 0) / 20);
    const releaseK = 1 - Math.exp(-1 / (0.05 * sr));
    for (let i = 0; i < count; i++) {
      // Where this sample sits on the clock: a trigger fires when the beat index changes.
      if (keyed) {
        const key = Math.abs(sidechain[0][i]);
        this.env += (key - this.env) * (key > this.env ? 0.5 : releaseK);
        if (this.armed && this.env > threshold) { this.elapsed = 0; this.armed = false; }
        if (this.env < threshold * 0.5) this.armed = true;
      } else {
        const t = (timeSec ?? this.frames / sr) - this.anchorSec;
        const beat = Math.floor(t / period);
        if (beat !== this.lastBeat) { this.elapsed = this.lastBeat < 0 ? null : 0; this.lastBeat = beat; }
      }
      this.frames += 1;
      const amount = at(params.amount, i);
      const length = at(params.length, i) * (keyed ? 2 : period);
      let target = 1;
      if (this.elapsed != null) {
        const x = Math.min(1, this.elapsed / Math.max(0.001, length));
        target = 1 - amount * (1 - curveShape(x, curve));
        this.elapsed += 1 / sr;
      }
      // Down at the attack, up at the shape's own pace.
      this.gain += (target - this.gain) * (target < this.gain ? attackK : 1);
      const g = this.gain;
      outL[i] = (inL ? inL[i] : 0) * g;
      if (outR !== outL) outR[i] = (inR ? inR[i] : 0) * g;
    }
  }
}
