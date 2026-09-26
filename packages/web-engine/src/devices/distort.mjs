// The Distort effect: a set of curves, and any curve drawn by hand, behind one set of controls.
//
// This is version 2. Version 1 (0.2.0) had nine curves and a cheby-only Harmonic knob; this one
// rebuilt the diode, added twelve curves and curves you draw, and shares one Character knob
// across them. At the default character its first nine curves null against version 1's, the
// diode and the level correction aside. Version 1 is not kept: nothing in a song can pin a device
// version yet, so a frozen copy would only have been code nobody could reach.
//
// The shape of the device is the argument. Separate effects would each need their own
// drive, bias, tone, mix and output, and comparing two of them would mean editing the chain
// instead of turning a knob - so they are one device with a mode, exactly the way the filter
// modes are one filter. Bit crushing and downsampling used to be modes here and are not: they
// are not curves, they ignore oversampling, and they needed three controls the other modes had
// no use for. They are their own device now (see crush.mjs).

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain, isMoving } from '../dsp/control.mjs';
import { DcBlocker, OnePole } from '../dsp/filters.mjs';
import { Oversampler } from '../dsp/oversample.mjs';
import { ASYMMETRIC, SHAPER_INDEX, SHAPER_MODES, TAKES_CHARACTER, autoGainFor, characterStep, chebyHarmonic, shape } from '../dsp/shapers.mjs';

/** How many drawn curves the device holds at once, past the ones it ships with. */
const SHAPE_SLOTS = 8;

/** How long a change of curve takes to crossfade, in seconds: long enough not to click. */
const CURVE_FADE_SEC = 0.01;


/**
 * The one extra control, shared by every curve that has something to vary - so whatever drives it
 * goes on driving it when the curve changes. Hidden on the curves that ignore it.
 */
const CHARACTER = { id: 'character', name: 'Character', min: 0, max: 1, default: 0.5, group: 'Shape',
  active: { param: 'mode', is: [...TAKES_CHARACTER] },
  description: 'What varies in this curve: a knee, an asymmetry, a harmonic, the shape of a stair, the hardness of a wrap. The middle is the classic setting.' };

export const DISTORT = defineDevice({
  id: 'Distort',
  kind: 'fx',
  version: 2,
  license: 'AGPL-3.0-only',
  processor: 'poptart-distort',
  description: 'Waveshaping with fifteen curves or one you draw, oversampled, with a tone control and a dry/wet.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'mode', name: 'Mode', default: 0, options: [...SHAPER_MODES], capacity: SHAPER_MODES.length + SHAPE_SLOTS,
      takes: 'shape', rate: 'k', group: 'Shape',
      description: 'The curve: one of these, or one you draw. Input across, output up.' },
    { id: 'drive', name: 'Drive', min: 0, max: 48, default: 6, unit: 'dB', curve: 'pow', curveExp: 2, group: 'Shape',
      description: 'Level into the curve. Most of the change is in the first twelve decibels, which is half the knob\'s travel.' },
    { id: 'bias', name: 'Bias', min: -1, max: 1, default: 0, group: 'Shape',
      description: 'Pushes the signal off center before shaping, so a symmetric curve makes even harmonics. The offset is removed afterwards.' },
    CHARACTER,
    { id: 'tone', name: 'Tone', min: 200, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', group: 'Out' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, group: 'Out' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Out' },
    { id: 'oversample', name: 'Oversample', default: 1, options: ['1x', '2x', '4x'], rate: 'k', group: 'Out',
      description: 'Runs the curve at a higher rate, so harmonics above the audible range are filtered off rather than folding back down.' },
    { id: 'autogain', name: 'Auto Gain', min: 0, max: 1, default: 1, ui: 'toggle', rate: 'k', group: 'Out',
      description: 'Holds the level steady as the drive goes up, so turning it up is a change of shape rather than of volume.' },
  ],
  figures: [
    {
      id: 'curve',
      kind: 'shaper',
      group: 'Shape',
      // No title: the curve's own name heads the picture, in the control that picks it.
      description: 'What comes out for what goes in, at this drive and bias, with the auto gain applied. The lit stretch is where the signal is on it. Beside it, the harmonics the curve makes, second to eighth. Drag up for the drive.',
      params: { mode: 'mode', drive: 'drive', bias: 'bias', character: 'character', autogain: 'autogain' },
      drag: { y: 'drive' },
      // The mode control belongs ON the picture of the curve, where there is room for its name and
      // the draw button - squeezed into a knob cell underneath it was the one control that matters
      // most on the device and the hardest to read. As the Wavetable's table heads its picture.
      subsumes: ['mode'],
    },
  ],
  panel: { width: 640, rows: [['Shape', 'Out']] },
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
    // Drawn curves by mode index, as the engine sampled them (see loadShape).
    this.tables = [];
    // A change of curve, fading in: the one before (its mode, table and gain) and how far the
    // fade has to go, in samples.
    this.fadeLen = Math.max(1, Math.round(CURVE_FADE_SEC * sampleRate));
    this.fadeFrom = null;
    this.fadeLeft = 0;
    this.lastCurve = null;
    // How much of the DC blocker's output is in the signal, 0..1 (see process).
    this.dcMix = 0;
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
    // The loudest input sample of the last block, for the picture: where on the curve the signal
    // is. Read before the drive, on the curve's own input axis.
    this.peak = 0;
  }

  reset() {
    for (const c of this.channels) c.reset();
    this.comp = -1;
  }

  /** Keeps a drawn curve in a mode slot, for the mode control to pick. */
  loadShape(paramId, index, table) {
    if (paramId !== 'mode' || !table?.length) return false;
    this.tables[Math.max(0, Math.round(index))] = table;
    return true;
  }

  /**
   * Renders one block.
   *
   * `params` holds the current control values by descriptor id; the a-rate ones may be numbers
   * or per-sample buffers, which is how an AudioWorklet hands them over and how a signal
   * patched into one arrives.
   */
  process(inputs, outputs, count, params) {
    let mode = Math.round(at(params.mode, 0)) | 0;
    // A drawn slot whose table has not arrived yet keeps the curve before it. The table comes by
    // message and the control by automation, and the automation can land first: played empty, the
    // slot was a hard clip for a block - a crack, and every harmonic at once - on every pick.
    const named = SHAPER_MODES.length;
    if (mode >= named && !this.tables[mode] && this.lastCurve) mode = this.lastCurve.mode;
    // 1x, 2x, 4x by option index; anything else is the setting that costs nothing.
    const factorIndex = Math.round(at(params.oversample, 0));
    const factor = factorIndex >= 2 ? 4 : factorIndex === 1 ? 2 : 1;
    const autogain = at(params.autogain, 0) >= 0.5;
    // The character, read per sample so an lfo on it moves the curve smoothly.
    const extraAt = (i) => at(params.character, i);

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
    const extraAtStart = extraAt(count - 1);
    const driveEnd = driveMoving ? driveGain[count - 1] : driveStill;
    const table = mode >= named ? (this.tables[mode] ?? null) : null;
    const compTo = autogain ? autoGainFor(mode, driveEnd, biasAtStart, extraAtStart, table) : 1;
    if (this.comp < 0) this.comp = compTo;
    // A different curve from last block's - another mode, or a drawn one redrawn into its slot -
    // fades in rather than cutting over. Its gain is set outright, and the outgoing curve keeps its
    // own inside the blend, so the level does not jump either.
    // The same for a character that moves a curve in whole steps (cheby's harmonic, the stair
    // count): the outgoing curve is played at the character it had.
    const step = characterStep(mode, extraAtStart);
    const last = this.lastCurve;
    if (last && (last.mode !== mode || last.table !== table || last.step !== step)) {
      this.fadeFrom = { mode: last.mode, table: last.table, comp: this.comp, character: last.character };
      this.fadeLeft = this.fadeLen;
      this.comp = compTo;
    }
    this.lastCurve = { mode, table, step, character: extraAtStart };

    // Only the curves that actually leave an offset get a DC blocker: it is a 20 Hz high-pass,
    // and on a curve that needs none it took a decibel off a 41 Hz bass and turned its phase. An
    // even Chebyshev harmonic needs one - it maps silence to minus one - and so does a drawn curve,
    // which may not pass through zero.
    const chebyN = chebyHarmonic(extraAtStart);
    const needsDc = (ASYMMETRIC[mode] ?? true) || biasAtStart !== 0
      || (mode === SHAPER_INDEX.cheby && chebyN % 2 === 0);
    // The blocker runs on every sample, and its OUTPUT fades in and out as the
    // curve needs it. Switched in cold, it came back from wherever it had last been and stepped by
    // the offset it was tracking; warm and faded, it lands without a click.
    const dcFrom = this.dcMix;
    const dcTo = needsDc ? 1 : 0;
    const dcStep = dcTo === dcFrom ? 0 : (dcTo - dcFrom) / this.fadeLen;

    const toneHz = at(params.tone, 0);
    if (toneHz !== this.lastTone) {
      for (const c of this.channels) c.tone.glideTo(toneHz, count);
      this.lastTone = toneHz;
    }

    // One curve for the block, shared by both channels: it reads the controls by sample index.
    const curve = (() => {
      const now = (v, i) => shape(v, mode, driveAt(i), at(params.bias, i), extraAt(i), table);
      // The auto gain is applied INSIDE the curve, per input sample, rather than to what
      // comes out of the oversampler: that output lags its input by the filter's delay, so at a
      // change of curve the last few samples the old curve shaped came out under the new curve's
      // gain - a step, and at 2x a clearly audible one. In here each sample carries the gain of the
      // curve that shaped it.
      const from = this.fadeLeft > 0 ? this.fadeFrom : null;
      const done = this.fadeLen - this.fadeLeft;
      const fadeLen = this.fadeLen;
      const gainFrom = this.comp;
      const gainStep = (compTo - gainFrom) / Math.max(1, count);
      const gained = (v, i) => now(v, i) * (gainFrom + gainStep * i);
      return from
        ? (v, i) => {
          const t = Math.min(1, (done + i) / fadeLen);
          // A stepped character fades from the setting it had; otherwise the outgoing curve follows
          // the knob like the incoming one.
          const character = characterStep(from.mode, from.character) === null ? extraAt(i) : from.character;
          const was = shape(v, from.mode, driveAt(i), at(params.bias, i), character, from.table) * from.comp;
          return was + (gained(v, i) - was) * t;
        }
        : gained;
    })();

    let peak = 0;
    for (let ch = 0; ch < outputs.length; ch++) {
      const out = outputs[ch];
      const input = inputs[Math.min(ch, inputs.length - 1)];
      const c = this.channels[Math.min(ch, this.channels.length - 1)];
      c.ensure(count);

      if (!input) { out.fill(0, 0, count); continue; }
      for (let i = 0; i < count; i++) {
        c.dry[i] = input[i];
        const a = Math.abs(input[i]);
        if (a > peak) peak = a;
      }
      c.over.setFactor(factor);
      c.over.process(c.dry, c.scratch, count, curve);

      for (let i = 0; i < count; i++) {
        let wet = c.scratch[i];
        // A biased curve leaves an offset behind. It is inaudible on its own and costs headroom
        // on everything after it, so it comes off here rather than being somebody else's problem.
        const blocked = c.dc.next(wet);
        const k = dcStep === 0 ? dcFrom : Math.min(1, Math.max(0, dcFrom + dcStep * (i + 1)));
        wet += (blocked - wet) * k;
        if (toneHz < 19999) wet = c.tone.next(wet);
        const mix = Math.min(1, Math.max(0, at(params.mix, i)));
        const gain = dbToGain(at(params.output, i));
        out[i] = (c.dry[i] * (1 - mix) + wet * mix) * gain;
      }
      c.settle(out[count - 1]);
    }
    // After both channels, so the pair are corrected by the same ramp and fade the same way.
    this.comp = compTo;
    if (this.fadeLeft > 0) this.fadeLeft = Math.max(0, this.fadeLeft - count);
    if (dcStep !== 0) this.dcMix = Math.min(1, Math.max(0, dcFrom + dcStep * count));
    this.peak = Number.isFinite(peak) ? Math.min(1, peak) : 0;
  }

  /**
   * What the auto gain is doing, in decibels, for the meter on the panel - a correction that is
   * invisible is a correction nobody can tell from a quiet distortion - and how loud the input
   * is, so the picture can light the part of the curve the signal is on.
   */
  report() {
    return { meters: { autogain: this.comp > 0 ? 20 * Math.log10(this.comp) : 0, level: this.peak } };
  }
}
