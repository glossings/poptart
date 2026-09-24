// The Distort effect: nine curves behind one set of controls.
//
// The shape of the device is the argument. Nine separate effects would each need their own
// drive, bias, tone, mix and output, and comparing two of them would mean editing the chain
// instead of turning a knob - so they are one device with a mode, exactly the way the filter
// modes are one filter. Bit crushing and downsampling used to be modes here and are not: they
// are not curves, they ignore oversampling, and they needed three controls the other modes had
// no use for. They are their own device now (see crush.mjs).

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain, isMoving } from '../dsp/control.mjs';
import { DcBlocker, OnePole } from '../dsp/filters.mjs';
import { Oversampler } from '../dsp/oversample.mjs';
import { ASYMMETRIC, SHAPER_INDEX, SHAPER_MODES, autoGainFor, shape } from '../dsp/shapers.mjs';

export const DISTORT = defineDevice({
  id: 'Distort',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-distort',
  description: 'Waveshaping with nine curves, oversampled, with a tone control and a dry/wet.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'mode', name: 'Mode', default: 0, options: [...SHAPER_MODES], rate: 'k', group: 'Shape' },
    { id: 'drive', name: 'Drive', min: 0, max: 48, default: 6, unit: 'dB', curve: 'pow', curveExp: 2, group: 'Shape',
      description: 'Level into the curve. Everything interesting happens between the curve and this, and most of it in the first twelve decibels, which is where the knob spends half its travel.' },
    { id: 'bias', name: 'Bias', min: -1, max: 1, default: 0, group: 'Shape',
      description: 'Pushes the signal off center before shaping, which is how a symmetric curve is made to produce even harmonics. The offset it leaves behind is removed afterwards.' },
    { id: 'tone', name: 'Tone', min: 200, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', group: 'Out' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, group: 'Out' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Out' },
    { id: 'oversample', name: 'Oversample', default: 1, options: ['1x', '2x', '4x'], rate: 'k', group: 'Out',
      description: 'Runs the curve at a higher rate so the harmonics it makes above the audible range are filtered off instead of folding back down.' },
    { id: 'autogain', name: 'Auto Gain', min: 0, max: 1, default: 1, ui: 'toggle', rate: 'k', group: 'Out',
      description: 'Holds the level steady as the drive goes up, so turning it up is a change of shape rather than of volume.' },
    { id: 'harmonic', name: 'Harmonic', min: 1, max: 8, default: 2, step: 1, rate: 'k', group: 'Shape',
      description: 'Read by the cheby mode: which harmonic it adds. Two is an octave up, three an octave and a fifth.' },
  ],
  figures: [
    {
      id: 'autogain',
      kind: 'meter',
      group: 'Out',
      title: 'auto gain',
      description: 'How much the auto gain is taking off, or putting back, to hold the level as the drive moves.',
      params: { amount: 'autogain' },
      range: [-36, 12],
    },
  ],
});

/** One channel's state. A stereo device holds two of these, so the channels never share history. */
class Channel {
  constructor(sampleRate, maxBlock) {
    this.over = new Oversampler(maxBlock);
    this.dc = new DcBlocker(sampleRate);
    this.tone = new OnePole(sampleRate);
    this.scratch = new Float64Array(maxBlock);
    this.dry = new Float64Array(maxBlock);
  }

  /**
   * A NaN in the input - a modulator dividing by zero somewhere upstream - would otherwise sit
   * in the DC blocker and the tone filter for ever, and everything after it would be NaN for
   * the rest of the page. Checked once per block on the way out.
   */
  settle(lastOut) {
    if (!Number.isFinite(lastOut)) this.reset();
  }

  reset() {
    this.over.reset();
    this.dc.reset();
    this.tone.reset();
  }

  ensure(count) {
    if (this.scratch.length < count) {
      this.scratch = new Float64Array(count);
      this.dry = new Float64Array(count);
    }
  }
}

export class DistortProcessor {
  constructor(sampleRate, maxBlock = 256) {
    this.sampleRate = sampleRate;
    this.channels = [new Channel(sampleRate, maxBlock), new Channel(sampleRate, maxBlock)];
    this.lastTone = -1;
    // The drive in linear gain, per sample, for a block where something is moving it: one
    // power per input sample here rather than one per OVERSAMPLED sample inside the curve.
    this.driveGain = new Float64Array(maxBlock);
    // Where the auto-gain correction stands. Measured once a block (probing the curve per sample
    // would be sixty-four shapes per sample), and therefore a STAIRCASE if it were applied as it
    // is - which is what a drive knob being dragged sounded like: the drive itself glides, and
    // the correction undoing it jumped at the block rate. Ramped across the block instead.
    this.comp = -1;
  }

  reset() {
    for (const c of this.channels) c.reset();
    this.comp = -1;
  }

  /**
   * Renders one block.
   *
   * `params` holds the current control values by descriptor id; the a-rate ones may be numbers
   * or per-sample buffers, which is how an AudioWorklet hands them over and how a signal
   * patched into one arrives.
   */
  process(inputs, outputs, count, params) {
    const mode = Math.round(at(params.mode, 0)) | 0;
    // 1x, 2x, 4x by option index; anything else is the setting that costs nothing.
    const factorIndex = Math.round(at(params.oversample, 0));
    const factor = factorIndex >= 2 ? 4 : factorIndex === 1 ? 2 : 1;
    const autogain = at(params.autogain, 0) >= 0.5;
    const harmonic = Math.round(at(params.harmonic, 0));

    // The drive in linear gain: once for the block when it is still, once per input sample when
    // it moves. Either way the curve reads a number rather than taking a power per call, which
    // at 4x oversampling would be four powers per sample per channel.
    const driveMoving = isMoving(params.drive);
    if (this.driveGain.length < count) this.driveGain = new Float64Array(count);
    const driveGain = this.driveGain;
    const driveStill = dbToGain(at(params.drive, 0));
    if (driveMoving) for (let i = 0; i < count; i++) driveGain[i] = dbToGain(params.drive[i]);
    const driveAt = (i) => (driveMoving ? driveGain[i] : driveStill);

    // The compensation is measured from where the controls END this block, and reached from
    // where the last block left it - so a drive being dragged is corrected along a ramp rather
    // than in block-sized steps.
    const biasAtStart = at(params.bias, 0);
    const extraAtStart = harmonic;
    const driveEnd = driveMoving ? driveGain[count - 1] : driveStill;
    const compTo = autogain ? autoGainFor(mode, driveEnd, biasAtStart, extraAtStart) : 1;
    if (this.comp < 0) this.comp = compTo;
    const compFrom = this.comp;
    const compStep = (compTo - compFrom) / Math.max(1, count);

    // Only the curves that actually leave an offset get a DC blocker. Running one over the
    // crush and downsample modes would turn their flat held steps into slopes. A Chebyshev
    // polynomial of EVEN order is one of the curves that does: it maps silence to minus one,
    // so at the default harmonic the mode would otherwise park its output at half scale.
    const needsDc = (ASYMMETRIC[mode] ?? false) || biasAtStart !== 0
      || (mode === SHAPER_INDEX.cheby && harmonic % 2 === 0);

    const toneHz = at(params.tone, 0);
    if (toneHz !== this.lastTone) {
      for (const c of this.channels) c.tone.glideTo(toneHz, count);
      this.lastTone = toneHz;
    }

    // One curve for the block, shared by both channels: it reads the controls by sample index.
    const curve = (v, i) => shape(v, mode, driveAt(i), at(params.bias, i), harmonic);

    for (let ch = 0; ch < outputs.length; ch++) {
      const out = outputs[ch];
      const input = inputs[Math.min(ch, inputs.length - 1)];
      const c = this.channels[Math.min(ch, this.channels.length - 1)];
      c.ensure(count);

      if (!input) { out.fill(0, 0, count); continue; }
      for (let i = 0; i < count; i++) c.dry[i] = input[i];

      c.over.setFactor(factor);
      c.over.process(c.dry, c.scratch, count, curve);

      for (let i = 0; i < count; i++) {
        let wet = c.scratch[i] * (compFrom + compStep * i);
        // A biased curve leaves an offset behind. It is inaudible on its own and costs headroom
        // on everything after it, so it comes off here rather than being somebody else's problem.
        if (needsDc) wet = c.dc.next(wet);
        if (toneHz < 19999) wet = c.tone.next(wet);
        const mix = Math.min(1, Math.max(0, at(params.mix, i)));
        const gain = dbToGain(at(params.output, i));
        out[i] = (c.dry[i] * (1 - mix) + wet * mix) * gain;
      }
      c.settle(out[count - 1]);
    }
    // After both channels, so the pair are corrected by the same ramp.
    this.comp = compTo;
  }

  /**
   * What the auto gain is doing, in decibels, for the meter on the panel. A correction that is
   * invisible is a correction nobody can tell from a quiet distortion.
   */
  report() {
    return { meters: { autogain: this.comp > 0 ? 20 * Math.log10(this.comp) : 0 } };
  }
}
