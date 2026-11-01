// The EQ effect: four bands, each any biquad response, drawn as one curve.
//
// Four is enough for a mix and few enough to draw: a low shelf, two peaks and a high shelf by
// default, every one switchable to any of the eight responses. The panel draws the summed
// magnitude from the same coefficients the bands filter with (see figures.mjs), and a band is
// dragged on the picture by its own handle.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { BIQUAD_SLOPES, BIQUAD_TYPES, Biquad, MAX_SECTIONS, biquadSections } from '../dsp/biquad.mjs';

export const EQ_BANDS = 4;

const DEFAULTS = [
  { type: 'lowshelf', hz: 120, gain: 0, q: 0.7 },
  { type: 'peak', hz: 500, gain: 0, q: 1 },
  { type: 'peak', hz: 2500, gain: 0, q: 1 },
  { type: 'highshelf', hz: 8000, gain: 0, q: 0.7 },
];

function bandParams(n) {
  const d = DEFAULTS[n - 1];
  const group = `Band ${n}`;
  return [
    { id: `band${n}.type`, name: `Band ${n} Type`, default: BIQUAD_TYPES.indexOf(d.type), options: [...BIQUAD_TYPES], rate: 'k', group },
    { id: `band${n}.slope`, name: `Band ${n} Slope`, default: 0, options: [...BIQUAD_SLOPES], rate: 'k', group,
      description: 'Decibels per octave. Read by the cut and shelf types; the peak, band, notch and allpass types ignore it.' },
    { id: `band${n}.freq`, name: `Band ${n} Freq`, min: 20, max: 20000, default: d.hz, unit: 'Hz', curve: 'exp', group },
    { id: `band${n}.gain`, name: `Band ${n} Gain`, min: -24, max: 24, default: d.gain, unit: 'dB', group,
      description: 'Read by the peak and shelf types; the cut and pass types ignore it.' },
    { id: `band${n}.q`, name: `Band ${n} Q`, min: 0.1, max: 12, default: d.q, curve: 'exp', group },
  ];
}

const figureParams = {};
for (let n = 1; n <= EQ_BANDS; n++) {
  figureParams[`type${n}`] = `band${n}.type`;
  figureParams[`slope${n}`] = `band${n}.slope`;
  figureParams[`freq${n}`] = `band${n}.freq`;
  figureParams[`gain${n}`] = `band${n}.gain`;
  figureParams[`q${n}`] = `band${n}.q`;
}

export const EQ = defineDevice({
  id: 'EQ',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-eq',
  description: 'A four-band parametric equalizer. Each band takes any of eight responses, the cuts and shelves at 12 to 96 dB per octave, and the summed curve is drawn from the coefficients that filter.',
  channels: { in: 2, out: 2 },
  params: [
    ...bandParams(1), ...bandParams(2), ...bandParams(3), ...bandParams(4),
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Output' },
  ],
  figures: [
    {
      id: 'curve',
      kind: 'eq',
      bands: EQ_BANDS,
      title: 'response',
      description: 'The summed response of the four bands. Drag a band\'s handle across for its frequency and up for its gain.',
      params: figureParams,
    },
  ],
  panel: { width: 760, rows: [['Band 1', 'Band 2', 'Band 3', 'Band 4', 'Output']] },
});

export class EqProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Each band is a cascade of up to MAX_SECTIONS biquads per channel, `sections[n]` of them in use.
    this.bands = Array.from({ length: EQ_BANDS }, () => [0, 1].map(() => Array.from({ length: MAX_SECTIONS }, () => new Biquad())));
    this.sections = new Int32Array(EQ_BANDS).fill(1);
    this.last = new Float64Array(EQ_BANDS * 5).fill(-1);
  }

  reset() {
    for (const pair of this.bands) for (const chain of pair) for (const b of chain) b.reset();
  }

  process(inputs, outputs, count, params) {
    // Recomputed once a block when a band's settings changed, and WALKED there across the block
    // rather than jumping (see Biquad#glideTo). Four bands of coefficients per sample is not
    // affordable; four bands stepping a hundred and fifty times a second is the buzz that rides
    // every sweep, and a band being dragged on the curve is swept continuously.
    for (let n = 0; n < EQ_BANDS; n++) {
      const type = Math.round(at(params[`band${n + 1}.type`], 0));
      const hz = at(params[`band${n + 1}.freq`], 0);
      const gain = at(params[`band${n + 1}.gain`], 0);
      const q = at(params[`band${n + 1}.q`], 0);
      const slope = Math.round(at(params[`band${n + 1}.slope`], 0));
      const k = n * 5;
      if (type !== this.last[k] || hz !== this.last[k + 1] || gain !== this.last[k + 2] || q !== this.last[k + 3] || slope !== this.last[k + 4]) {
        // A type or slope change is a different filter rather than a move, so it lands at once:
        // gliding between two unrelated responses passes through shapes that are neither.
        const jump = type !== this.last[k] || slope !== this.last[k + 4];
        const sections = biquadSections(type, slope);
        // Sections coming into use start from silence, not from whatever they last held.
        for (let s = this.sections[n]; s < sections; s++) { this.bands[n][0][s].reset(); this.bands[n][1][s].reset(); }
        this.sections[n] = sections;
        for (let s = 0; s < sections; s++) {
          const left = this.bands[n][0][s];
          const right = this.bands[n][1][s];
          if (jump) left.setSection(type, hz, gain, q, sections, s, this.sampleRate);
          else left.glideToSection(type, hz, gain, q, sections, s, this.sampleRate, count);
          right.follow(left);
        }
        this.last[k] = type; this.last[k + 1] = hz; this.last[k + 2] = gain; this.last[k + 3] = q; this.last[k + 4] = slope;
      }
    }
    for (let ch = 0; ch < outputs.length; ch++) {
      const out = outputs[ch];
      const input = inputs[Math.min(ch, inputs.length - 1)];
      if (!input) { out.fill(0, 0, count); continue; }
      const c = Math.min(ch, 1);
      for (let i = 0; i < count; i++) {
        let x = input[i];
        for (let n = 0; n < EQ_BANDS; n++) {
          const chain = this.bands[n][c];
          for (let s = 0; s < this.sections[n]; s++) x = chain[s].next(x);
        }
        out[i] = x * dbToGain(at(params.output, i));
      }
      if (!Number.isFinite(out[count - 1])) for (let n = 0; n < EQ_BANDS; n++) for (const b of this.bands[n][c]) b.reset();
    }
  }
}
