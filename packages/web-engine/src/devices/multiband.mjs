// The Multiband effect: three-band compression, downward and upward at once.
//
// Two crossovers split the signal into low, mid and high; each band is compressed toward its
// own threshold from both directions - loud parts pulled down at the ratio, quiet parts lifted
// toward the threshold by the upward amount - and the bands are summed back. With the upward
// amounts up, deep ratios and fast times that is the sound of a squashed, hyper-present mix
// everybody has heard on a lead; with them down it is an ordinary multiband compressor. The
// amount control scales every gain change at once, so one knob takes it from off to all the way.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { Crossover } from '../dsp/biquad.mjs';
import { DYNAMICS_BLOCKS_PER_ENTRY, History } from '../dsp/history.mjs';
import { Detector, dbOf, gainComputer } from './compressor.mjs';

const BANDS = ['Low', 'Mid', 'High'];

/**
 * The four defaults each band starts on: a low band wants slower times than a high one, because
 * a slow attack on a high band lets the transient of every hat through and a fast one on a low
 * band chases the waveform of the bass itself and distorts it.
 */
const BAND_TIMES = Object.freeze({ Low: [10, 120], Mid: [3, 60], High: [1, 30] });

function compressorBandParams(name) {
  const group = name;
  const id = name.toLowerCase();
  const [attack, release] = BAND_TIMES[name];
  return [
    { id: `${id}.threshold`, name: `${name} Threshold`, min: -60, max: 0, default: -24, unit: 'dB', group },
    { id: `${id}.ratio`, name: `${name} Ratio`, min: 1, max: 20, default: 6, unit: 'x', curve: 'exp', group },
    { id: `${id}.upward`, name: `${name} Upward`, min: 0, max: 1, default: 0.7, group,
      description: 'How far a quiet signal is lifted toward the threshold. Zero is an ordinary downward compressor.' },
    // Its OWN times. One pair for all three bands is the usual shortcut and it is wrong here for
    // the reason a multiband exists at all: the bass and the cymbals are on different time
    // scales, and a setting that follows one of them mangles the other.
    { id: `${id}.attack`, name: `${name} Attack`, min: 0.1, max: 200, default: attack, unit: 'ms', curve: 'exp', rate: 'k', group },
    { id: `${id}.release`, name: `${name} Release`, min: 5, max: 2000, default: release, unit: 'ms', curve: 'exp', rate: 'k', group },
    { id: `${id}.gain`, name: `${name} Gain`, min: -24, max: 24, default: 0, unit: 'dB', group },
  ];
}

export const MULTIBAND = defineDevice({
  id: 'Multiband',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-multiband',
  description: 'Three-band compression that works from both directions: loud parts pulled down, quiet parts lifted up, per band. At its defaults it is the deep upward-and-downward squash; turn the upward amounts down for an ordinary multiband compressor.',
  channels: { in: 2, out: 2 },
  params: [
    { id: 'amount', name: 'Amount', min: 0, max: 1, default: 1, group: 'Global',
      description: 'Scales every gain change at once, from off to the full effect.' },
    { id: 'lowsplit', name: 'Low Split', min: 40, max: 2000, default: 200, unit: 'Hz', curve: 'exp', group: 'Global' },
    { id: 'highsplit', name: 'High Split', min: 500, max: 12000, default: 2500, unit: 'Hz', curve: 'exp', group: 'Global' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, group: 'Global' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Global' },
    ...compressorBandParams('Low'), ...compressorBandParams('Mid'), ...compressorBandParams('High'),
  ],
  // One curve per band, at the head of that band's own controls. Three bands each pulling both
  // ways is six numbers a band, and the curve is the one picture that says what they add up to.
  figures: BANDS.map((name) => ({
    id: `${name.toLowerCase()}.curve`,
    kind: 'transfer',
    group: name,
    // No title: the picture sits under the band's own heading, which has named it already.
    title: '',
    description: 'What comes out of this band for what goes in - down from the threshold, up toward it from below. The dot is where the band is right now.',
    params: {
      threshold: `${name.toLowerCase()}.threshold`,
      ratio: `${name.toLowerCase()}.ratio`,
      upward: `${name.toLowerCase()}.upward`,
      makeup: `${name.toLowerCase()}.gain`,
    },
    drag: { x: 'threshold', y: 'ratio' },
  })),
  panel: { width: 760, rows: [['Global'], ['Low', 'Mid', 'High']] },
});

/** How far below its threshold a band is still lifted: quieter than this is left alone. */
const UPWARD_REACH_DB = 40;

export class MultibandProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Two crossovers per channel: the first takes the low band off, the second splits the rest.
    this.lowX = [new Crossover(sampleRate), new Crossover(sampleRate)];
    this.highX = [new Crossover(sampleRate), new Crossover(sampleRate)];
    this.detectors = BANDS.map(() => new Detector(sampleRate));
    this.split = [new Float64Array(2), new Float64Array(2)];
    this.bands = [new Float64Array(3), new Float64Array(3)];
    this.last = { low: -1, high: -1, attack: [-1, -1, -1], release: [-1, -1, -1] };
    // Per band: the loudest the detector saw this block, and the deepest gain change - what the
    // panel draws on each band's curve.
    this.levels = [-120, -120, -120];
    this.changes = [0, 0, 0];
    // And the last second of each, for the lane beside each curve.
    this.levelHistory = BANDS.map(() => new History(undefined, -120, { per: DYNAMICS_BLOCKS_PER_ENTRY, keep: 'max' }));
    this.changeHistory = BANDS.map(() => new History(undefined, 0, { per: DYNAMICS_BLOCKS_PER_ENTRY, keep: 'min' }));
    this.blockSec = 128 / sampleRate;
    this.sampleRate = sampleRate;
  }

  process(inputs, outputs, count, params) {
    const low = at(params.lowsplit, 0);
    const high = Math.max(low * 1.5, at(params.highsplit, 0));
    if (low !== this.last.low || high !== this.last.high) {
      // Glided across the block: a crossover that jumps steps the whole spectrum at once, which
      // is the loudest zipper of the lot.
      this.lowX[0].setFrequency(low, count); this.lowX[1].follow(this.lowX[0]);
      this.highX[0].setFrequency(high, count); this.highX[1].follow(this.highX[0]);
      this.last.low = low; this.last.high = high;
    }
    // Each band follows its own pair of times.
    for (let b = 0; b < BANDS.length; b++) {
      const id = BANDS[b].toLowerCase();
      const attack = at(params[`${id}.attack`], 0);
      const release = at(params[`${id}.release`], 0);
      if (attack !== this.last.attack[b] || release !== this.last.release[b]) {
        this.detectors[b].setTimes(attack, release);
        this.last.attack[b] = attack;
        this.last.release[b] = release;
      }
    }
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const bandIds = ['low', 'mid', 'high'];
    for (let i = 0; i < count; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      // Split both channels into their three bands.
      this.lowX[0].split(l, this.split[0]);
      this.bands[0][0] = this.split[0][0];
      this.highX[0].split(this.split[0][1], this.split[0]);
      this.bands[0][1] = this.split[0][0];
      this.bands[0][2] = this.split[0][1];
      this.lowX[1].split(r, this.split[1]);
      this.bands[1][0] = this.split[1][0];
      this.highX[1].split(this.split[1][1], this.split[1]);
      this.bands[1][1] = this.split[1][0];
      this.bands[1][2] = this.split[1][1];

      const amount = at(params.amount, i);
      let sumL = 0;
      let sumR = 0;
      if (i === 0) { this.levels.fill(-120); this.changes.fill(0); }
      for (let b = 0; b < 3; b++) {
        const id = bandIds[b];
        const key = Math.max(Math.abs(this.bands[0][b]), Math.abs(this.bands[1][b]));
        const level = dbOf(this.detectors[b].next(key));
        const threshold = at(params[`${id}.threshold`], i);
        const ratio = at(params[`${id}.ratio`], i);
        let change = gainComputer(level, threshold, ratio, 6);
        const upward = at(params[`${id}.upward`], i);
        if (upward > 0 && level < threshold) {
          const below = Math.min(UPWARD_REACH_DB, threshold - level);
          // Lifted by the same law, mirrored: the further below, the more lift, up to the reach,
          // then tapering back to nothing so silence is not raised to the threshold.
          const taper = below >= UPWARD_REACH_DB ? 0 : 1 - below / UPWARD_REACH_DB;
          change += below * (1 - 1 / ratio) * upward * taper;
        }
        if (level > this.levels[b]) this.levels[b] = level;
        if (change < this.changes[b]) this.changes[b] = change;
        const g = dbToGain(change * amount + at(params[`${id}.gain`], i));
        sumL += this.bands[0][b] * g;
        sumR += this.bands[1][b] * g;
      }
      const mix = at(params.mix, i);
      const out = dbToGain(at(params.output, i));
      outL[i] = (l + (sumL - l) * mix) * out;
      if (outR !== outL) outR[i] = (r + (sumR - r) * mix) * out;
    }
    for (let b = 0; b < 3; b++) {
      this.levelHistory[b].push(this.levels[b]);
      this.changeHistory[b].push(this.changes[b]);
    }
    this.blockSec = (count / this.sampleRate) * DYNAMICS_BLOCKS_PER_ENTRY;
    if (!Number.isFinite(outL[count - 1])) {
      for (const x of [...this.lowX, ...this.highX]) x.reset();
    }
    // Checked on their own: a NaN that is gone from the output by the end of the block can
    // still be sitting in a detector, and it stays there.
    for (const d of this.detectors) if (!Number.isFinite(d.env)) d.reset();
  }

  /** Where each band sits on its own curve, and where it has been, for the three pictures the panel draws. */
  report() {
    const meters = {};
    BANDS.forEach((name, b) => {
      meters[`${name.toLowerCase()}.curve`] = {
        inDb: this.levels[b], grDb: this.changes[b],
        history: { inDb: this.levelHistory[b].snapshot(), grDb: this.changeHistory[b].snapshot(), blockSec: this.blockSec },
      };
    });
    return { meters };
  }
}
