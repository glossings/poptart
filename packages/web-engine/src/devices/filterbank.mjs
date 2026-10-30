// The Filterbank effect: band-passes spread evenly across the spectrum, each band's level driven every
// sample by a moving picture - Shape scrolled across the bank, or rippling across it.
//
// The bands divide the range from Low to High into equal shares on a log scale, one band at the
// middle of each. Width is a band's bandwidth as a share of that spacing: at 1 the bands just meet
// and a flat bank is close to the dry tone, below 1 they narrow until each one rings, above it they
// overlap. Shape, the modes, Stereo and Levels are the shared filter bank's (dsp/filterbank.mjs).
//
// Translated line for line into native/devices/own/filterbank.cc for the desktop, and held to it by
// native-device-parity.test.mjs.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { BANK_MODES, BandBank, ShapeField, listLevel } from '../dsp/filterbank.mjs';

/** How far the band count's number box reaches. A count past it plays: the control is open. */
const BANDS_KNOB = 64;

/**
 * The controls every device on the filter bank has, in the order they are listed: Shape and how
 * it moves, and the levels a pattern lays over it. Shared with the Resonator.
 */
export function shapeParams() {
  return [
    { id: 'shape', name: 'Shape', min: 0, max: 1, default: 1, group: 'Shape',
      description: 'The level the bands are driven by. Patch a signal onto it - an lfo, noise, a drawn curve, a MIDI control, audio - and the mode spreads it across the bands.' },
    { id: 'mode', name: 'Mode', default: 0, options: [...BANK_MODES], rate: 'k', group: 'Shape',
      description: 'Scroll moves Shape across the bands as it changes, each band showing it a step later. Ripple strikes the band at Where with Shape and lets the ripples spread, bounce off the ends and die away.' },
    { id: 'scroll', name: 'Scroll', min: -64, max: 64, default: 8, curve: 'sym', curveExp: 2, rate: 'k', group: 'Shape',
      active: { param: 'mode', is: 'scroll' },
      description: 'How fast Shape travels across the bands, in bands per second. Negative runs from the top down.' },
    { id: 'where', name: 'Where', min: 0, max: 1, default: 0.5, rate: 'k', group: 'Shape',
      active: { param: 'mode', is: 'ripple' },
      description: 'Where across the bands Shape strikes, 0 the lowest band and 1 the highest.' },
    { id: 'wavespeed', name: 'Wave speed', min: 0, max: 200, default: 20, curve: 'pow', curveExp: 2, rate: 'k', group: 'Shape',
      active: { param: 'mode', is: 'ripple' },
      description: 'How fast ripples travel, in bands per second.' },
    { id: 'damping', name: 'Damping', min: 0, max: 1, default: 0.1, rate: 'k', group: 'Shape',
      active: { param: 'mode', is: 'ripple' },
      description: 'How much of a ripple is lost as it travels. At 0 ripples bounce between the ends for ever; at 1 they spread out without traveling.' },
    { id: 'stereo', name: 'Stereo', min: 0, max: 1, default: 0, rate: 'k', group: 'Shape',
      description: 'How far the right side moves towards a mirror image of the left: scrolling the other way, or struck at the mirror of Where.' },
    { id: 'levels', name: 'Levels', default: 0, options: ['flat'], takes: 'list', saved: false, rate: 'k', group: 'Shape',
      description: 'A level per band, laid over Shape: one cycle of a pattern spread across the bands from low to high, a rest at 0. With none, every band is at 1.' },
  ];
}

/** The settings the shared field is run with, read once a block. */
export function fieldSettings(params) {
  return {
    mode: Math.min(BANK_MODES.length - 1, Math.max(0, Math.round(at(params.mode, 0)))),
    scroll: at(params.scroll, 0),
    where: at(params.where, 0),
    speed: at(params.wavespeed, 0),
    damping: at(params.damping, 0),
    stereo: at(params.stereo, 0),
  };
}

export const FILTERBANK = defineDevice({
  id: 'Filterbank',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-filterbank',
  description: 'A filter bank: band-passes spread evenly across the spectrum, each band\'s level moved every sample by Shape - scrolled across the bands, or rippling across them - and by a pattern of levels.',
  channels: { in: 2, out: 2 },
  params: [
    ...shapeParams(),
    { id: 'bands', name: 'Bands', min: 1, open: true, uiMax: BANDS_KNOB, default: 16, step: 1, rate: 'k', ui: 'number', group: 'Bands',
      description: 'How many bands.' },
    { id: 'low', name: 'Low', min: 20, max: 20000, default: 80, unit: 'Hz', curve: 'exp', rate: 'k', group: 'Bands',
      description: 'The bottom of the range the bands share.' },
    { id: 'high', name: 'High', min: 20, max: 20000, default: 8000, unit: 'Hz', curve: 'exp', rate: 'k', group: 'Bands',
      description: 'The top of the range the bands share.' },
    { id: 'width', name: 'Width', min: 0.05, max: 4, default: 1, unit: 'x', curve: 'exp', rate: 'k', group: 'Bands',
      description: 'Each band\'s width as a share of the space between bands. Wide shapes the tone; narrow rings.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, group: 'Bands' },
  ],
  panel: { rows: [['Shape', 'Bands']] },
  figures: [
    {
      id: 'bands',
      kind: 'bands',
      group: 'Shape',
      description: 'Every band at its frequency, as loud as it is being fed right now: Shape as the mode moves it, times Levels.',
      params: { levels: 'levels', shape: 'shape', count: 'bands', low: 'low', high: 'high' },
      subsumes: ['levels'],
    },
  ],
});

export class FilterbankProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.field = new ShapeField();
    this.bank = new BandBank();
    this.tables = { levels: [] };
    this.out = [0, 0];
  }

  /** A list of levels, already in its option slot (see the engines' list path). */
  loadShape(paramId, index, table) {
    if (paramId === 'levels') this.tables.levels[index] = table;
  }

  reset() {
    this.field.reset();
    this.bank.reset();
  }

  /** For the device window: every sounding band's frequency and level (see BandBank#report). */
  report() {
    return { bands: this.bank.report(this.field) };
  }

  /** The bands and the cells for this block. */
  configure(params) {
    const sr = this.sampleRate;
    const n = Math.max(1, Math.round(at(params.bands, 0)));
    const lo = at(params.low, 0);
    const hi = at(params.high, 0);
    const width = at(params.width, 0);
    const slot = Math.round(at(params.levels, 0));
    const table = slot >= 1 ? (this.tables.levels[slot] ?? null) : null;
    const set = fieldSettings(params);
    this.field.ensure(n);
    this.field.setup(n, sr, set.mode, set.scroll, set.where, set.speed, set.damping, set.stereo);
    const bank = this.bank;
    bank.ensure(n);
    bank.count = n;
    const span = Math.log(hi / lo);
    const share = Math.abs(span) / n;
    const k = 2 * Math.sinh((width * share) / 2);
    const b = bank.bands;
    for (let i = 0; i < n; i++) {
      bank.tune(i, lo * Math.exp((span * (i + 0.5)) / n), k, share, 0, sr);
      b.x[i] = i;
      b.amp[i] = listLevel(table, (i + 0.5) / n);
    }
  }

  process(inputs, outputs, count, params) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    this.configure(params);
    const out = this.out;
    for (let i = 0; i < count; i++) {
      this.field.tick(at(params.shape, i));
      const xl = inL ? inL[i] : 0;
      const xr = inR ? inR[i] : 0;
      this.bank.run(this.field, xl, xr, out);
      const mix = at(params.mix, i);
      outL[i] = xl + (out[0] - xl) * mix;
      if (outR !== outL) outR[i] = xr + (out[1] - xr) * mix;
    }
    if (!this.field.playable() || !this.bank.playable()) this.reset();
  }
}
