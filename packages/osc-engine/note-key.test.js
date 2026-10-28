'use strict';

// noteKey and markSounding (engine/notes.js). noteKey: poptart's own devices take a fractional
// note exactly (a tuning, a fractional degree); a plugin takes MIDI, so it gets the nearest key.
// markSounding: what a slot is sounding, filed per note as it starts - the first note on a slot
// makes the slot's list and must still be filed.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');
const { DeviceController } = require('./server/device');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'notes'];

test('noteKey hands a device the exact note and a plugin the nearest key', () => {
  const { E, S } = fakeEngine({ sections: SECTIONS });
  const plugin = { midi: { kind: 'vst' } };
  assert.deepStrictEqual([E.noteKey(plugin, 62.4), E.noteKey(plugin, 62.6), E.noteKey(plugin, 60)], [62, 63, 60]);
  assert.ok([62, 63].every(Number.isInteger));
  const device = new DeviceController(S, { nodeID: 1 }, 0);
  assert.deepStrictEqual([E.noteKey(device, 62.4), E.noteKey(device, 60)], [62.4, 60]);
});

test('the first note on a slot is filed as sounding, and so is the next', () => {
  const { E } = fakeEngine({ sections: SECTIONS });
  const track = { sounding: new Map() };
  const later = E.elapsed() + 60;
  E.markSounding(track, 2, 60, later);
  E.markSounding(track, 2, 64, later);
  E.markSounding(track, 3, 67, later);
  assert.deepStrictEqual([...track.sounding.get(2).keys()].sort(), [60, 64]);
  assert.deepStrictEqual([...track.sounding.get(3).keys()], [67]);
});

test('a note whose end has passed is dropped when the next one is filed', () => {
  const { E } = fakeEngine({ sections: SECTIONS });
  const track = { sounding: new Map() };
  E.markSounding(track, 0, 60, E.elapsed() - 1);
  E.markSounding(track, 0, 62, Infinity);
  assert.deepStrictEqual([...track.sounding.get(0).keys()], [62]);
});
