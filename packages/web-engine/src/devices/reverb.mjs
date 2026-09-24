// The Reverb device: the descriptor, and the block processor that drives the FDN.
//
// Decay is in SECONDS - an RT60, the time the tail takes to fall by sixty decibels - rather than
// a 0..1 "amount". It is the one control people already have a feel for, it survives the size
// control changing the network's delay lengths underneath it, and it is a physical unit like
// every other time in poptart.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { OnePole } from '../dsp/filters.mjs';
import { Reverb } from '../dsp/reverb.mjs';

export const REVERB = defineDevice({
  id: 'Reverb',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-reverb',
  description: 'An algorithmic reverb: diffusing allpasses into a damped feedback delay network.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'decay', name: 'Decay', min: 0.05, max: 30, default: 2, unit: 's', curve: 'exp', group: 'Room',
      description: 'How long the tail takes to fall by sixty decibels, measured below the damping frequency. Above it the tail is shorter, as a room\'s is, so a bright hit fades sooner than the number says.' },
    { id: 'size', name: 'Size', min: 0.05, max: 1, default: 0.7, group: 'Room',
      description: 'Scales the delay network, so a small room and a hall differ in more than their decay time.' },
    { id: 'predelay', name: 'Predelay', min: 0, max: 0.25, default: 0.01, unit: 's', group: 'Room' },
    { id: 'modulation', name: 'Modulation', min: 0, max: 1, default: 0.2, group: 'Room',
      description: 'Moves the delay lengths slowly, which breaks up the ringing a still network develops.' },
    { id: 'damping', name: 'Damping', min: 200, max: 20000, default: 6000, unit: 'Hz', curve: 'exp', group: 'Tone',
      description: 'Where the tail starts losing its top as it decays. Lower is a softer room.' },
    { id: 'lowcut', name: 'Low Cut', min: 10, max: 2000, default: 120, unit: 'Hz', curve: 'exp', group: 'Tone' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.3, group: 'Tone' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Tone' },
  ],
});

export class ReverbProcessor {
  constructor(sampleRate, maxBlock = 256) {
    this.reverb = new Reverb(sampleRate);
    this.wetL = new Float32Array(maxBlock);
    this.wetR = new Float32Array(maxBlock);
    this.silence = new Float32Array(maxBlock);
    this.toneL = new OnePole(sampleRate);
    this.toneR = new OnePole(sampleRate);
    this.last = {};
  }

  reset() {
    this.reverb.reset();
  }

  ensure(count) {
    if (this.wetL.length < count) {
      this.wetL = new Float32Array(count);
      this.wetR = new Float32Array(count);
      this.silence = new Float32Array(count);
    }
  }

  process(inputs, outputs, count, params) {
    this.ensure(count);
    // The network's geometry is set per block. These are room controls, not modulation targets:
    // moving a delay length per sample is a pitch shift, not a change of room.
    const want = {
      decay: at(params.decay, 0),
      size: at(params.size, 0),
      damping: at(params.damping, 0),
      preDelay: at(params.predelay, 0),
      lowCut: at(params.lowcut, 0),
      modulation: at(params.modulation, 0),
    };
    let changed = false;
    for (const k of Object.keys(want)) if (this.last[k] !== want[k]) { changed = true; break; }
    if (changed) {
      this.reverb.set(want);
      this.last = want;
    }

    const inL = inputs[0] ?? this.silence;
    const inR = inputs[1] ?? inL;
    this.reverb.process(inL, inR, this.wetL, this.wetR, count);

    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    for (let i = 0; i < count; i++) {
      const mix = Math.min(1, Math.max(0, at(params.mix, i)));
      const gain = dbToGain(at(params.output, i));
      const l = (inL[i] * (1 - mix) + this.wetL[i] * mix) * gain;
      const r = (inR[i] * (1 - mix) + this.wetR[i] * mix) * gain;
      outL[i] = l;
      if (outR !== outL) outR[i] = r; else outL[i] = (l + r) * 0.5;
    }
  }
}
