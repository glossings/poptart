// The Compressor effect: a feed-forward compressor with a soft knee and a parallel mix.
//
// The gain is computed in decibels from a peak detector with separate attack and release, the
// two channels linked on the louder of them so the image does not lean. It takes a sidechain:
// with `.audio("kick")` on it the detector listens to that track instead of this one, which is
// the pumping-to-the-kick everybody means by sidechain compression. Written rather than taken
// from the browser's own node so the parameters are positions like every other control's and a
// signal can move the threshold.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { DYNAMICS_BLOCKS_PER_ENTRY, History } from '../dsp/history.mjs';

export const COMPRESSOR = defineDevice({
  id: 'Compressor',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-compressor',
  description: 'A feed-forward compressor with a soft knee, a parallel mix and a sidechain input.',
  channels: { in: 2, out: 2 },
  sidechain: true,
  params: [
    { id: 'threshold', name: 'Threshold', min: -60, max: 0, default: -18, unit: 'dB' },
    { id: 'ratio', name: 'Ratio', min: 1, max: 20, default: 4, unit: 'x', curve: 'exp' },
    { id: 'knee', name: 'Knee', min: 0, max: 24, default: 6, unit: 'dB' },
    { id: 'attack', name: 'Attack', min: 0.1, max: 200, default: 10, unit: 'ms', curve: 'exp' },
    { id: 'release', name: 'Release', min: 5, max: 2000, default: 120, unit: 'ms', curve: 'exp' },
    { id: 'makeup', name: 'Makeup', min: 0, max: 24, default: 0, unit: 'dB' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1,
      description: 'Below one, the uncompressed signal is blended back in: parallel compression.' },
  ],
  figures: [
    {
      id: 'curve',
      kind: 'transfer',
      title: 'transfer',
      description: 'What comes out for what goes in. The dot is where the signal is on it right now. Drag across for the threshold, up for the ratio.',
      params: { threshold: 'threshold', ratio: 'ratio', knee: 'knee', makeup: 'makeup' },
      drag: { x: 'threshold', y: 'ratio' },
    },
  ],
});

/** A linear level in decibels, floored so silence is a number. */
export const dbOf = (x) => 20 * Math.log10(Math.max(1e-9, x));

/**
 * The gain reduction in decibels for a level in decibels, above a threshold with a knee.
 * Shared with the multiband compressor, whose bands are each one of these.
 */
export function gainComputer(levelDb, thresholdDb, ratio, kneeDb) {
  const over = levelDb - thresholdDb;
  if (kneeDb <= 0 || over <= -kneeDb / 2) return over <= 0 ? 0 : over * (1 / ratio - 1);
  if (over >= kneeDb / 2) return over * (1 / ratio - 1);
  const t = over + kneeDb / 2;
  return (1 / ratio - 1) * (t * t) / (2 * kneeDb);
}

/** A peak detector in decibels with one time constant up and another down. */
export class Detector {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.env = 0;
    this.setTimes(10, 100);
  }

  setTimes(attackMs, releaseMs) {
    this.up = 1 - Math.exp(-1 / (Math.max(0.01, attackMs) * 0.001 * this.sampleRate));
    this.down = 1 - Math.exp(-1 / (Math.max(0.01, releaseMs) * 0.001 * this.sampleRate));
  }

  /** Feeds a rectified sample and returns the envelope, both linear. */
  next(x) {
    const k = x > this.env ? this.up : this.down;
    this.env += (x - this.env) * k;
    return this.env;
  }
}

export class CompressorProcessor {
  constructor(sampleRate) {
    this.detector = new Detector(sampleRate);
    this.lastAttack = -1;
    this.lastRelease = -1;
    this.reduction = 0;      // the last gain reduction in dB, for the panel's curve
    this.level = -120;       // and the level the detector was at, which is where on the curve
    // The last second or so of both, one entry a block, for the lane the panel scrolls.
    this.levels = new History(undefined, -120, { per: DYNAMICS_BLOCKS_PER_ENTRY, keep: 'max' });
    this.reductions = new History(undefined, 0, { per: DYNAMICS_BLOCKS_PER_ENTRY, keep: 'min' });
    this.blockSec = 128 / sampleRate;
  }

  process(inputs, outputs, count, params, sidechain) {
    const attack = at(params.attack, 0);
    const release = at(params.release, 0);
    if (attack !== this.lastAttack || release !== this.lastRelease) {
      this.detector.setTimes(attack, release);
      this.lastAttack = attack;
      this.lastRelease = release;
    }
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const keyL = sidechain?.[0] ?? inL;
    const keyR = sidechain?.[1] ?? keyL;
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    let reduction = 0;
    let loudest = -120;
    for (let i = 0; i < count; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const key = Math.max(Math.abs(keyL ? keyL[i] : 0), Math.abs(keyR ? keyR[i] : 0));
      const env = this.detector.next(key);
      const levelDb = dbOf(env);
      if (levelDb > loudest) loudest = levelDb;
      const gr = gainComputer(levelDb, at(params.threshold, i), at(params.ratio, i), at(params.knee, i));
      reduction = Math.min(reduction, gr);
      const g = dbToGain(gr + at(params.makeup, i));
      const mix = at(params.mix, i);
      outL[i] = l + (l * g - l) * mix;
      if (outR !== outL) outR[i] = r + (r * g - r) * mix;
    }
    this.reduction = reduction;
    this.level = loudest;
    this.levels.push(loudest);
    this.reductions.push(reduction);
    this.blockSec = (count / this.detector.sampleRate) * DYNAMICS_BLOCKS_PER_ENTRY;
  }

  /**
   * Where the signal is on the transfer curve, and how far it is being pulled down - the two
   * numbers a compressor's controls do not say on their own - and the recent history of both,
   * for the lane that shows the attack and the release actually happening.
   */
  report() {
    return {
      meters: {
        curve: {
          inDb: this.level, grDb: this.reduction,
          history: { inDb: this.levels.snapshot(), grDb: this.reductions.snapshot(), blockSec: this.blockSec },
        },
      },
    };
  }
}
