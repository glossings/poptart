// The EQ effect: four bands, each any biquad response, drawn as one curve.
//
// Four is enough for a mix and few enough to draw: a low shelf, two peaks and a high shelf by
// default, every one switchable to any of the eight responses. The panel draws the summed
// magnitude from the same coefficients the bands filter with (see figures.mjs), and a band is
// dragged on the picture by its own handle.

import { defineDevice } from '../descriptor.mjs';
import { at, dbToGain } from '../dsp/control.mjs';
import { BIQUAD_TYPES, Biquad } from '../dsp/biquad.mjs';

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
    { id: `band${n}.freq`, name: `Band ${n} Freq`, min: 20, max: 20000, default: d.hz, unit: 'Hz', curve: 'exp', group },
    { id: `band${n}.gain`, name: `Band ${n} Gain`, min: -24, max: 24, default: d.gain, unit: 'dB', group,
      description: 'Read by the peak and shelf types; the cut and pass types ignore it.' },
    { id: `band${n}.q`, name: `Band ${n} Q`, min: 0.1, max: 12, default: d.q, curve: 'exp', group },
  ];
}

const figureParams = {};
for (let n = 1; n <= EQ_BANDS; n++) {
  figureParams[`type${n}`] = `band${n}.type`;
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
  description: 'A four-band parametric equalizer. Each band takes any of eight responses, and the summed curve is drawn from the coefficients that filter.',
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
    this.bands = Array.from({ length: EQ_BANDS }, () => [new Biquad(), new Biquad()]);
    this.last = new Float64Array(EQ_BANDS * 4).fill(-1);
  }

  reset() {
    for (const pair of this.bands) for (const b of pair) b.reset();
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
      const k = n * 4;
      if (type !== this.last[k] || hz !== this.last[k + 1] || gain !== this.last[k + 2] || q !== this.last[k + 3]) {
        // A type change is a different filter rather than a move, so it lands at once: gliding
        // between two unrelated responses passes through shapes that are neither.
        if (type !== this.last[k]) this.bands[n][0].set(type, hz, gain, q, this.sampleRate);
        else this.bands[n][0].glideTo(type, hz, gain, q, this.sampleRate, count);
        this.bands[n][1].follow(this.bands[n][0]);
        this.last[k] = type; this.last[k + 1] = hz; this.last[k + 2] = gain; this.last[k + 3] = q;
      }
    }
    for (let ch = 0; ch < outputs.length; ch++) {
      const out = outputs[ch];
      const input = inputs[Math.min(ch, inputs.length - 1)];
      if (!input) { out.fill(0, 0, count); continue; }
      const c = Math.min(ch, 1);
      for (let i = 0; i < count; i++) {
        let x = input[i];
        for (let n = 0; n < EQ_BANDS; n++) x = this.bands[n][c].next(x);
        out[i] = x * dbToGain(at(params.output, i));
      }
      if (!Number.isFinite(out[count - 1])) for (let n = 0; n < EQ_BANDS; n++) this.bands[n][c].reset();
    }
  }
}
