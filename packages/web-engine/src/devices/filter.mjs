// The Filter effect: the state-variable and ladder filters, on the chain.
//
// One filter for every instrument rather than one inside each: a synth's own filter is a
// worse copy of this, and an `env()` on this cutoff is the filter envelope any of them wants.
// The cutoff and resonance are read PER SAMPLE when a signal moves them, which is what makes an
// envelope on the cutoff a sweep rather than a staircase - the one thing a stock biquad node
// cannot do, since it retunes at the block rate and was the reason to write this.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain, isMoving } from '../dsp/control.mjs';
import { FILTER_MODES, MultiFilter } from '../dsp/filters.mjs';

export const FILTER = defineDevice({
  id: 'Filter',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-filter',
  description: 'A resonant filter: the classical shapes at three slopes, a driven four-pole ladder, and a comb, an allpass cascade and a formant bank. The cutoff follows a signal at the sample rate, so an envelope on it sweeps.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'mode', name: 'Mode', default: FILTER_MODES.indexOf('lowpass'), options: [...FILTER_MODES], rate: 'k',
      description: 'The numbered modes are slopes in decibels per octave off a state-variable core. The ladder is four poles with a saturated feedback path, so at the same cutoff it sits about six decibels lower at the corner than the plain lowpass does, as a ladder does. Comb tunes a delayed copy of the signal to the cutoff; allpass is a cascade of phase turns summed back, which is a fixed phaser; formant sweeps through five vowels.' },
    { id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, default: 2000, unit: 'Hz', curve: 'exp' },
    { id: 'resonance', name: 'Resonance', min: 0, max: 1, default: 0.2 },
    { id: 'drive', name: 'Drive', min: 1, max: 8, default: 1, unit: 'x',
      description: 'Only the ladder mode is driven; every other mode ignores it.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB' },
  ],
  figures: [
    {
      id: 'response',
      kind: 'response',
      title: 'response',
      description: 'The filter\'s magnitude response at the cutoff and resonance it is set to. Drag across for the cutoff, up for the resonance.',
      params: { mode: 'mode', cutoff: 'cutoff', resonance: 'resonance', drive: 'drive' },
      drag: { x: 'cutoff', y: 'resonance' },
    },
  ],
});

export class FilterProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.filters = [new MultiFilter(sampleRate), new MultiFilter(sampleRate)];
    this.lastMode = -1;
    this.lastCutoff = -1;
    this.lastRes = -1;
    this.lastDrive = -1;
  }

  reset() {
    for (const f of this.filters) f.reset();
  }

  _tune(mode, hz, q, drive) {
    this.filters[0].drive = drive;
    this.filters[0].setCutoff(hz, q, mode);
    this.filters[1].follow(this.filters[0]);
  }

  process(inputs, outputs, count, params) {
    const mode = Math.round(at(params.mode, 0)) | 0;
    // A mode change is a different filter, so its state goes with it: carrying the old one's
    // integrators into a new shape is a click at best and a blow-up at worst. The tuning goes
    // with it too - each mode reads the cutoff into a structure of its own, so a mode picked
    // while the cutoff sits still would otherwise run at whatever its constructor left there
    // (a comb at its default length, a formant bank at 1 kHz) until the cutoff next moved.
    // Invalidating the cutoff rather than tuning here is what the moving branch already does.
    if (mode !== this.lastMode) { this.reset(); this.lastMode = mode; this.lastCutoff = -1; }
    const moving = isMoving(params.cutoff) || isMoving(params.resonance) || isMoving(params.drive);
    if (!moving) {
      const hz = at(params.cutoff, 0);
      const q = at(params.resonance, 0);
      const drive = at(params.drive, 0);
      // Drive is in the comparison because the ladder reads it at tuning time: a stepped drive
      // change over a still cutoff is a change this filter has to hear.
      if (hz !== this.lastCutoff || q !== this.lastRes || drive !== this.lastDrive) this._tune(mode, hz, q, drive);
      this.lastCutoff = hz;
      this.lastRes = q;
      this.lastDrive = drive;
    } else {
      this.lastCutoff = -1;
    }
    // BOTH CHANNELS IN ONE LOOP, which is not a tidiness choice.
    //
    // A channel at a time meant the tuning was recomputed while the left channel ran and the
    // right one then used whatever the last sample of that loop had left behind - one tuning
    // for its entire block. So a swept cutoff was smooth on the left and a staircase on the
    // right, which is the zipper you hear on a stereo track and not on a mono one. Tuned once
    // per SAMPLE here, with both channels reading the same tuning, which is also the cheaper
    // of the two: one tangent a sample rather than one per channel.
    const outL = outputs[0];
    const outR = outputs[1] ?? null;
    const inL = inputs[0] ?? null;
    const inR = inputs[Math.min(1, inputs.length - 1)] ?? inL;
    if (!inL) {
      for (const out of outputs) out.fill(0, 0, count);
      return;
    }
    for (let i = 0; i < count; i++) {
      if (moving) this._tune(mode, at(params.cutoff, i), at(params.resonance, i), at(params.drive, i));
      const mix = at(params.mix, i);
      const gain = dbToGain(at(params.output, i));
      const l = inL[i];
      const wetL = this.filters[0].next(l, mode);
      outL[i] = (l + (wetL - l) * mix) * gain;
      if (outR) {
        const r = inR ? inR[i] : 0;
        const wetR = this.filters[1].next(r, mode);
        outR[i] = (r + (wetR - r) * mix) * gain;
      }
    }
    if (!Number.isFinite(outL[count - 1]) || (outR && !Number.isFinite(outR[count - 1]))) this.reset();
  }
}
