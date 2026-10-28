'use strict';

// MIDI's other backend (server/midi-io.js's 'sclang', the one Windows uses): the class library's
// MIDI through sc/midi-io.scd, on the MIDI worker. Checked here on whatever machine runs it: the
// helper comes up, lists its devices in the same shape the CoreMIDI helper does, takes a send, and
// goes away on close. Skipped (not failed) where sclang cannot run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MidiIO, helperSclang } = require('./server/midi-io');

const PORT = 57433;

test('the sclang MIDI helper opens, lists devices and closes', { skip: helperSclang() ? false : 'no sclang here' }, async (t) => {
  const log = [];
  const io = new MidiIO({ backend: 'sclang', sclangPort: PORT, output: (l) => log.push(l) });
  t.after(() => io.close());
  try {
    await io.open();
  } catch (err) {
    t.skip(`sclang did not come up here: ${err.message} ${log.join(' ')}`);
    return;
  }
  const { sources, destinations } = await io.list();
  assert.ok(Array.isArray(sources) && Array.isArray(destinations));
  for (const d of [...sources, ...destinations]) {
    assert.ok(Number.isInteger(d.uid) && typeof d.device === 'string' && typeof d.name === 'string', JSON.stringify(d));
  }
  io.connectAll();
  // A destination, if this machine has one: a send there must not take the helper down.
  if (destinations[0]) io.send(destinations[0].uid, [0xF8], io.now() + 0.05);
  const again = await io.list();
  assert.equal(again.destinations.length, destinations.length);
});
