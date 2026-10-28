// The controls that used to stop at a fixed number and now have no top (descriptor.mjs's open
// controls): the Wavetable's tables, Distort's drawn curves, the Convolver's responses, the
// Granular's samples and windows, and every synth's voice count. What is pinned here is that a
// song written before keeps sounding the same: each value it can hold - a label, an index, a
// count, and a 0..1 position written for a count back when the count had a top - resolves to
// what it resolved to then, under the old ranges (tables 64, curves 8 past the named ones,
// responses 32, samples 32, voices 16 / 12 / 8).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { argToValue, denormalize, findParam, normalize, valueToArg } from './src/descriptor.mjs';
import { WAVETABLE } from './src/devices/wavetable.mjs';
import { NOISE } from './src/devices/noise.mjs';
import { FMSYNTH as FM } from './src/devices/fmsynth.mjs';
import { GRANULAR } from './src/devices/granular.mjs';
import { DISTORT } from './src/devices/distort.mjs';
import { CONVOLVER } from './src/devices/builtins.mjs';

/** What a `.param()` argument meant on a control before it was open: the old rules, the old top. */
function oldArg(param, arg, top) {
  if (param.options) {
    if (typeof arg === 'string') {
      const i = param.options.findIndex((o) => o.toLowerCase() === arg.trim().toLowerCase());
      if (i >= 0) return i;
      const n = Number(arg);
      return Number.isInteger(n) && n >= 0 && n <= top ? n : null;
    }
    return Math.min(top, Math.max(0, Math.round(Number(arg))));
  }
  const t = Math.min(1, Math.max(0, Number(arg)));
  return Math.min(top, Math.max(param.min, Math.round(param.min + (top - param.min) * t)));
}

/** What the old write-back wrote for a count: its position across the old range. */
const oldWritten = (param, count, top) => String(Number(((count - param.min) / (top - param.min)).toPrecision(4)));

const COUNTS = [[WAVETABLE, 16], [NOISE, 16], [FM, 12], [GRANULAR, 8]];
const ENUMS = [[WAVETABLE, 'osc1.table', 63], [WAVETABLE, 'osc2.table', 63], [DISTORT, 'mode', null], [CONVOLVER, 'ir', 31], [GRANULAR, 'sample', 31], [GRANULAR, 'window', null]];

test('a voice count written the old way, as a position, plays the voices it played then', () => {
  for (const [device, top] of COUNTS) {
    const voices = findParam(device, 'voices');
    assert.equal(voices.open, true, `${device.id}'s voices have no top`);
    assert.equal(voices.legacyMax, top, `${device.id}'s voices remember the range they had`);
    // Every count the old range could hold, as the old write-back wrote it - except the top
    // itself, written "1", which now means one voice (see below).
    for (let count = voices.min; count < top; count++) {
      const written = oldWritten(voices, count, top);
      assert.equal(argToValue(voices, Number(written)), oldArg(voices, Number(written), top), `${device.id}: "${written}"`);
      assert.equal(argToValue(voices, Number(written)), count, `${device.id}: "${written}" is ${count} voices`);
    }
    // Positions typed by hand, between the steps.
    for (const t of [0.1, 0.25, 0.33, 0.5, 0.75, 0.9, 0.999]) assert.equal(argToValue(voices, t), oldArg(voices, t, top), `${device.id}: ${t}`);
    // 0 is the fewest either way.
    assert.equal(argToValue(voices, 0), oldArg(voices, 0, top));
  }
});

test('a voice count is the count now, past where the knob reaches, and written back as the count', () => {
  for (const [device] of COUNTS) {
    const voices = findParam(device, 'voices');
    for (const n of [1, 2, 8, 24, 128, 500]) {
      assert.equal(argToValue(voices, n), n);
      assert.equal(valueToArg(voices, n), String(n));
      // The engine carries it as a position past 1 where it is past the knob, and back intact.
      assert.equal(denormalize(voices, normalize(voices, n)), n);
    }
  }
});

test('an enum that takes files resolves every old value as it did, and takes indexes past the old top', () => {
  for (const [device, id, oldTop] of ENUMS) {
    const param = findParam(device, id);
    assert.equal(param.open, true, `${device.id} ${id} has no top`);
    const top = oldTop ?? param.options.length + 7; // the named entries and eight drawn ones
    for (const label of param.options) assert.equal(argToValue(param, label), oldArg(param, label, top), `${device.id} ${id}: "${label}"`);
    for (let i = 0; i <= top; i++) {
      assert.equal(argToValue(param, i), oldArg(param, i, top), `${device.id} ${id}: ${i}`);
      assert.equal(argToValue(param, String(i)), oldArg(param, String(i), top), `${device.id} ${id}: "${i}"`);
      // And a preset's value - real units, an index - is carried intact whatever the list's length.
      assert.equal(denormalize(param, normalize(param, i)), i);
    }
    assert.equal(argToValue(param, top + 40), top + 40, 'past the old top is a slot like any other');
  }
});
