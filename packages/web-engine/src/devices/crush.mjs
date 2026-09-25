// The Crush effect: bit depth and sample rate, thrown away on purpose.
//
// This used to be two of Distort's eleven modes, and it did not belong there. Every other mode
// in that device is a CURVE - a function of the sample in front of it, oversampled so the
// harmonics it invents land above the audible range instead of folding back down. These two are
// the opposite of that: they exist to throw information away, folding is the whole point, and
// oversampling one undoes it. Sharing a window meant three controls that most of the modes
// ignored, a drive knob that meant something different here, and an oversample switch with an
// asterisk on it. Two devices, each of which means what it says.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { OnePole } from '../dsp/filters.mjs';

/**
 * The top of the rate control, where the hold is switched off rather than run at this rate.
 * A hold at 24 kHz is not transparent anywhere: at 48 kHz it holds every other sample, at 44.1
 * kHz it holds some and not others, and at 96 kHz it holds four at a time - so the top of the
 * range means "not held at all", the same at every sample rate.
 */
const RATE_TOP = 24000;

export const CRUSH = defineDevice({
  id: 'Crush',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-crush',
  description: 'Bit depth and sample rate reduction: quantize the level, hold the signal at a lower rate, or both.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'bits', name: 'Bits', min: 1, max: 16, default: 8, unit: 'bit', group: 'Digital',
      description: 'How many levels the signal is rounded to. Sixteen is transparent; under six is the sound of the rounding.' },
    { id: 'rate', name: 'Rate', min: 100, max: RATE_TOP, default: RATE_TOP, unit: 'Hz', curve: 'exp', group: 'Digital',
      description: 'The rate the signal is held at. Everything above half of it folds back down as the aliasing this device is for. At the top of the range the signal is not held at all.' },
    { id: 'jitter', name: 'Jitter', min: 0, max: 1, default: 0, group: 'Digital',
      description: 'Wobbles the hold rate, which smears the aliasing into noise instead of leaving it as tones.' },
    { id: 'tone', name: 'Tone', min: 200, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', group: 'Out',
      description: 'A lowpass after the damage, for taking the top off what the folding put there.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, group: 'Out' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Out' },
  ],
});

/** One channel: what it is holding, how far through the hold it is, and the tone filter after. */
class CrushChannel {
  constructor(sampleRate) {
    this.tone = new OnePole(sampleRate);
    this.hold = 0;
    this.phase = 0;
    this.seed = 2463534242;
  }

  reset() {
    this.tone.reset();
    this.hold = 0;
    this.phase = 0;
  }

  /** The jitter's random walk. Per channel, so the two sides decorrelate and it reads as noise. */
  random() {
    let x = this.seed;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }
}

export class CrushProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.channels = [new CrushChannel(sampleRate), new CrushChannel(sampleRate)];
    this.lastTone = -1;
  }

  reset() {
    for (const c of this.channels) c.reset();
    this.lastTone = -1;
  }

  process(inputs, outputs, count, params) {
    const toneHz = at(params.tone, 0);
    if (toneHz !== this.lastTone) {
      for (const c of this.channels) c.tone.glideTo(toneHz, count);
      this.lastTone = toneHz;
    }

    for (let ch = 0; ch < outputs.length; ch++) {
      const out = outputs[ch];
      const input = inputs[Math.min(ch, inputs.length - 1)];
      const c = this.channels[Math.min(ch, this.channels.length - 1)];
      if (!input) { out.fill(0, 0, count); continue; }

      for (let i = 0; i < count; i++) {
        const dry = input[i];
        // Sample and hold. The phase carries across blocks, so the held rate is steady rather
        // than restarting every hundred and twenty-eight samples. At the top of the range, or at
        // a rate the context already runs at, every sample is taken as it comes and only the bit
        // depth is applied.
        const target = Math.max(1, at(params.rate, i));
        let take = true;
        if (target < RATE_TOP && target < this.sampleRate) {
          const jitter = Math.min(1, Math.max(0, at(params.jitter, i)));
          c.phase += (target * (1 - jitter * 0.5 * c.random())) / this.sampleRate;
          take = c.phase >= 1;
          if (take) c.phase -= Math.floor(c.phase);
        }
        if (take) {
          // Levels either side of zero. Using 2^bits - 1 as the step count overshoots full
          // scale by half a step at the very top, which is a quiet click on every peak.
          const bits = Math.max(1, Math.min(16, at(params.bits, i)));
          const levels = Math.pow(2, bits - 1);
          const clamped = dry < -1 ? -1 : dry > 1 ? 1 : dry;
          c.hold = Math.round(clamped * levels) / levels;
        }
        // No DC blocker, deliberately: it would turn the flat held steps into slopes, which is
        // exactly the character this device exists for.
        let wet = c.hold;
        if (toneHz < 19999) wet = c.tone.next(wet);
        const mix = Math.min(1, Math.max(0, at(params.mix, i)));
        out[i] = (dry * (1 - mix) + wet * mix) * dbToGain(at(params.output, i));
      }
      if (!Number.isFinite(out[count - 1])) c.reset();
    }
  }
}
