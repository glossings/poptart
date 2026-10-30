// The Resonator effect: narrow, ringing band-passes tuned to notes, their levels moved by the
// filter bank's picture (dsp/filterbank.mjs) - Shape scrolled across the notes, or rippling.
//
// WHAT IT IS TUNED TO. By default, the track's scale - `.scale()` on the pattern, or the buffer's
// `setscale()`, the key `chord()` reads - with a band on every note of it across the audible
// range. The scheduler hands the scale over as a list on the Scale control ([root, period,
// interval...], the root a MIDI note and the rest semitones, so a tuning off the
// 12-tone grid - 31 steps to the octave, ratios, a .scl file - is tuned exactly), into an option
// slot the way a list of levels goes in. With no scale anywhere, it is tuned to every semitone.
//
// `.fx("Resonator").midi("keys")` tunes it to notes instead: while a track's notes are routed in,
// there is a band on each note that track is holding. A released note's band stops being fed and
// rings out over Decay; its place is taken by the next new note. The scale still lays out the
// picture Shape and Levels are read from - a held note reads it at its own pitch.
//
// Shift transposes every band; Tilt slopes the levels from the lowest band to the highest; Spread
// pans the bands apart (each its own way, the same way every time) and detunes them, up to half
// the way to the next note of the scale (half a semitone for a held note); Decay is how long a
// band rings, which sets how narrow it is.
//
// Translated line for line into native/devices/own/resonator.cc for the desktop, and held to it
// by native-device-parity.test.mjs.

import { defineDevice } from '../descriptor.mjs';
import { at } from '../dsp/control.mjs';
import { AUDIBLE_HIGH, AUDIBLE_LOW, BandBank, ShapeField, listLevel, pitchHz } from '../dsp/filterbank.mjs';
import { fieldSettings, shapeParams } from './filterbank.mjs';

const LN1000 = Math.log(1000);
const PHI = (1 + Math.sqrt(5)) / 2;

/** Where a band sits across the audible range, 0..1 on a log scale - what Tilt slopes along. */
const audiblePos = (freq) => Math.log2(freq / AUDIBLE_LOW) / Math.log2(AUDIBLE_HIGH / AUDIBLE_LOW);

/** Each band's own direction for Spread, -1..1: the same for the same note every time. */
const spreadSign = (x) => {
  const v = x * PHI;
  return 2 * (v - Math.floor(v)) - 1;
};

export const RESONATOR = defineDevice({
  id: 'Resonator',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  processor: 'poptart-resonator',
  description: 'Narrow, ringing band-passes on every note of the track\'s scale - or on the notes another track is holding, with .midi() - their levels moved every sample by Shape and by a pattern of levels.',
  channels: { in: 2, out: 2 },
  notes: true,
  params: [
    ...shapeParams(),
    { id: 'scale', name: 'Scale', default: 0, options: ['chromatic'], takes: 'scale', saved: false, rate: 'k', group: 'Tuning',
      description: 'The scale the bands are on: the track\'s own (.scale(), or setscale() in the buffer) unless a scale name is given here. Chromatic with no scale anywhere.' },
    { id: 'shift', name: 'Shift', min: -24, max: 24, default: 0, unit: 'st', rate: 'k', group: 'Tuning',
      description: 'Transposes every band.' },
    { id: 'tilt', name: 'Tilt', min: -24, max: 24, default: 0, unit: 'dB', rate: 'k', group: 'Tuning',
      description: 'How much louder the top of the audible range is than the bottom, sloping between.' },
    { id: 'spread', name: 'Spread', min: 0, max: 1, default: 0, rate: 'k', group: 'Tuning',
      description: 'Pans the bands apart and detunes them, up to half the way to the next note.' },
    { id: 'decay', name: 'Decay', min: 0.05, max: 10, default: 1, unit: 's', curve: 'pow', curveExp: 2, rate: 'k', group: 'Tuning',
      description: 'How long a band rings. Longer is narrower.' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.5, group: 'Tuning' },
  ],
  panel: { rows: [['Shape', 'Tuning']] },
  figures: [
    {
      id: 'bands',
      kind: 'bands',
      group: 'Shape',
      description: 'Every band at its frequency, as loud as it is being fed right now: Shape as the mode moves it, times Levels, Tilt and each held note\'s velocity.',
      params: { levels: 'levels', shape: 'shape', scale: 'scale' },
      subsumes: ['levels', 'scale'],
    },
  ],
});

export class ResonatorProcessor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.field = new ShapeField();
    this.bank = new BandBank();
    this.tables = { levels: [], scale: [] };
    this.out = [0, 0];
    this.frames = 0;
    this.noteRouted = false;
    this.slots = 0;           // note slots in use, held or ringing out
    this.pending = [];        // [time, note, velocity] not yet reached, oldest first; velocity 0 is an off
    this.pitch = new Float64Array(0);   // the scale's notes this block, lowest first
    this.step = new Float64Array(0);    // and which step of the scale each is
    this.cellCount = 0;
  }

  loadShape(paramId, index, table) {
    if (paramId === 'levels' || paramId === 'scale') this.tables[paramId][index] = table;
  }

  setNoteRoute(on) {
    this.noteRouted = !!on;
    if (!this.noteRouted) {
      this.pending.length = 0;
      this.slots = 0;
    }
  }

  noteOn(note, velocity, time) {
    this.noteRouted = true;
    this.queue(Number.isFinite(time) ? time : 0, note, velocity > 0 ? velocity : 0);
  }

  noteOff(note, time) {
    this.queue(Number.isFinite(time) ? time : 0, note, 0);
  }

  queue(t, note, velocity) {
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1][0] > t) i -= 1;
    this.pending.splice(i, 0, [t, note, velocity]);
  }

  /** A note lands: a band on it, or its band let go. */
  play(note, velocity) {
    const b = this.bank.bands;
    if (velocity <= 0) {
      for (let i = 0; i < this.slots; i++) {
        if (b.note[i] === note && b.held[i] !== 0) b.held[i] = 0;
      }
      return;
    }
    let at = -1;
    for (let i = 0; i < this.slots && at < 0; i++) if (b.note[i] === note) at = i;
    for (let i = 0; i < this.slots && at < 0; i++) if (b.held[i] === 0) at = i;
    if (at < 0) {
      this.bank.ensure(this.slots + 1);
      at = this.slots;
      this.slots += 1;
    }
    const s = this.bank.bands;
    s.note[at] = note;
    s.vel[at] = velocity;
    s.held[at] = 1;
  }

  reset() {
    this.field.reset();
    this.bank.reset();
  }

  /** For the device window: every sounding band's frequency and level (see BandBank#report). */
  report() {
    return { bands: this.bank.report(this.field) };
  }

  /** The scale's notes across the audible range, shifted: the cells, lowest first. */
  layScale(table, shift) {
    let root = 0;
    let period = 12;
    let count = 12;
    if (table && table.length >= 3) {
      root = table[0];
      period = table[1];
      count = table.length - 2;
    }
    const interval = (i) => (table && table.length >= 3 ? table[2 + i] : i);
    const pLo = 69 + 12 * Math.log2(AUDIBLE_LOW / 440);
    const pHi = 69 + 12 * Math.log2(Math.min(AUDIBLE_HIGH, this.sampleRate * 0.5) / 440);
    let n = 0;
    if (period > 0 && count > 0) {
      let lowest = interval(0);
      for (let i = 1; i < count; i++) if (interval(i) < lowest) lowest = interval(i);
      const base = root + shift;
      // Every period of the scale that has a note in range, and each note of it that is.
      for (let o = Math.floor((pLo - base - lowest) / period) - 1; base + o * period + lowest < pHi; o++) {
        for (let i = 0; i < count; i++) {
          const p = base + o * period + interval(i);
          if (!(p >= pLo && p < pHi)) continue;
          if (n >= this.pitch.length) this.growScale(n + 1);
          // In order of pitch, a note sorted in as it comes.
          let j = n;
          while (j > 0 && this.pitch[j - 1] > p) {
            this.pitch[j] = this.pitch[j - 1];
            this.step[j] = this.step[j - 1];
            j -= 1;
          }
          this.pitch[j] = p;
          this.step[j] = o * count + i;
          n += 1;
        }
      }
    }
    this.cellCount = n;
    return { period, count };
  }

  growScale(n) {
    const pitch = new Float64Array(n);
    const step = new Float64Array(n);
    pitch.set(this.pitch);
    step.set(this.step);
    this.pitch = pitch;
    this.step = step;
  }

  /** Where a pitch falls among the cells, as a fractional cell. */
  cellOf(p) {
    const n = this.cellCount;
    if (n <= 1 || p <= this.pitch[0]) return 0;
    if (p >= this.pitch[n - 1]) return n - 1;
    let c = 0;
    while (this.pitch[c + 1] <= p) c += 1;
    return c + (p - this.pitch[c]) / (this.pitch[c + 1] - this.pitch[c]);
  }

  /** The bands and the cells for this block, and again whenever a note lands. */
  configure(params) {
    const sr = this.sampleRate;
    const shift = at(params.shift, 0);
    const tilt = at(params.tilt, 0);
    const spread = Math.min(1, Math.max(0, at(params.spread, 0)));
    const decay = at(params.decay, 0);
    const levelsSlot = Math.round(at(params.levels, 0));
    const levels = levelsSlot >= 1 ? (this.tables.levels[levelsSlot] ?? null) : null;
    const scaleSlot = Math.round(at(params.scale, 0));
    const scale = scaleSlot >= 1 ? (this.tables.scale[scaleSlot] ?? null) : null;
    const { period, count } = this.layScale(scale, shift);
    const n = this.cellCount;
    const set = fieldSettings(params);
    this.field.ensure(n);
    this.field.setup(n, sr, set.mode, set.scroll, set.where, set.speed, set.damping, set.stereo);
    const bank = this.bank;
    const b = bank.bands;
    if (this.noteRouted) {
      bank.count = this.slots;
      const dln = Math.LN2 / 12;
      for (let i = 0; i < this.slots; i++) {
        const p = b.note[i] + shift;
        const sign = spreadSign(b.note[i]);
        const freq = pitchHz(p + spread * sign * 0.5);
        bank.tune(i, freq, LN1000 / (Math.PI * freq * decay), dln, spread * sign, sr);
        b.x[i] = this.cellOf(p);
        const pos = n > 0 ? (b.x[i] + 0.5) / n : 0.5;
        b.amp[i] = b.held[i] !== 0
          ? listLevel(levels, pos) * Math.pow(10, (tilt * (audiblePos(freq) - 0.5)) / 20) * b.vel[i]
          : 0;
      }
      return;
    }
    bank.ensure(n);
    bank.count = n;
    const dln = ((period / count) * Math.LN2) / 12;
    for (let i = 0; i < n; i++) {
      const sign = spreadSign(this.step[i]);
      const up = i < n - 1 ? this.pitch[i + 1] - this.pitch[i] : (i > 0 ? this.pitch[i] - this.pitch[i - 1] : 0);
      const down = i > 0 ? this.pitch[i] - this.pitch[i - 1] : up;
      const half = (sign > 0 ? up : down) / 2;
      const freq = pitchHz(this.pitch[i] + spread * sign * half);
      bank.tune(i, freq, LN1000 / (Math.PI * freq * decay), dln, spread * sign, sr);
      b.x[i] = i;
      b.amp[i] = listLevel(levels, (i + 0.5) / n) * Math.pow(10, (tilt * (audiblePos(freq) - 0.5)) / 20);
    }
  }

  process(inputs, outputs, count, params, _sidechain = null, timeSec = null) {
    const inL = inputs[0];
    const inR = inputs[1] ?? inputs[0];
    const outL = outputs[0];
    const outR = outputs[1] ?? outputs[0];
    const sr = this.sampleRate;
    const start = timeSec ?? this.frames / sr;
    this.configure(params);
    const out = this.out;
    for (let i = 0; i < count; i++) {
      // A note lands on its own sample: the one its time rounds to inside this block.
      if (this.pending.length && Math.round((this.pending[0][0] - start) * sr) <= i) {
        while (this.pending.length && Math.round((this.pending[0][0] - start) * sr) <= i) {
          const [, note, velocity] = this.pending.shift();
          this.play(note, velocity);
        }
        this.configure(params);
      }
      this.field.tick(at(params.shape, i));
      const xl = inL ? inL[i] : 0;
      const xr = inR ? inR[i] : 0;
      this.bank.run(this.field, xl, xr, out);
      const mix = at(params.mix, i);
      outL[i] = xl + (out[0] - xl) * mix;
      if (outR !== outL) outR[i] = xr + (out[1] - xr) * mix;
    }
    this.frames += count;
    if (!this.field.playable() || !this.bank.playable()) this.reset();
  }
}
