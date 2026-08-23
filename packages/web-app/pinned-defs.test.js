'use strict';

// The ★ library file (see pinned-defs.js): one definition per line, found again by kind and name.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePinned, upsertPinned, removePinned, HEADER } = require('./pinned-defs.js');

test('an empty file gets the header, then one definition per line', () => {
  const a = upsertPinned('', { kind: 'roll', id: 'bass', code: '_roll("bass", "36,0,4", { grid: 8 })' });
  assert.ok(a.startsWith(HEADER));
  assert.ok(a.endsWith('_roll("bass", "36,0,4", { grid: 8 })\n'));
  const b = upsertPinned(a, { kind: 'pack', id: 'kit', code: '_pack("kit", ["drums/kick.wav", "/abs/snare, 02.wav"])' });
  assert.deepEqual(parsePinned(b).map((e) => [e.kind, e.id]), [['roll', 'bass'], ['pack', 'kit']]);
});

test('pinning a name again replaces its line in place', () => {
  let t = upsertPinned('', { kind: 'shape', id: 'swell', code: '_shape("swell", "0,0 1,1")' });
  t = upsertPinned(t, { kind: 'roll', id: 'bass', code: '_roll("bass", "36,0,4")' });
  t = upsertPinned(t, { kind: 'shape', id: 'swell', code: '_shape("swell", "0,0 0.5,1 1,0")' });
  const got = parsePinned(t);
  assert.deepEqual(got.map((e) => e.code), ['_shape("swell", "0,0 0.5,1 1,0")', '_roll("bass", "36,0,4")']);
});

test('presets are keyed by plugin as well as name, like the registry', () => {
  let t = upsertPinned('', { kind: 'preset', id: 'disco', scope: 'ValhallaDelay', code: '_preset("disco", "ValhallaDelay", "@aaaa")' });
  t = upsertPinned(t, { kind: 'preset', id: 'disco', scope: 'Serum 2', code: '_preset("disco", "Serum 2", "@bbbb")' });
  assert.equal(parsePinned(t).length, 2);
  t = removePinned(t, { kind: 'preset', id: 'disco', scope: 'Serum 2' });
  assert.deepEqual(parsePinned(t).map((e) => e.scope), ['ValhallaDelay']);
});

test('removing takes the whole line and leaves everything else alone', () => {
  const hand = `${HEADER}// mine\n_roll("a", "1,0,1")\nconst x = 1\n_pack("k", ["a.wav"])\n`;
  const t = removePinned(hand, { kind: 'roll', id: 'a' });
  assert.equal(t, `${HEADER}// mine\nconst x = 1\n_pack("k", ["a.wav"])\n`);
  assert.equal(removePinned(t, { kind: 'roll', id: 'nope' }), t);
});

test('numeric ids, indented lines and a definition that is not alone are handled', () => {
  const text = `  _roll(0, "60,0,4")\nlead: _roll("x", "1,0,1").synth("Serum 2")\n_pack("kit", ["a.wav"]) // tail comment\n`;
  const got = parsePinned(text);
  assert.deepEqual(got.map((e) => e.id), ['0', 'kit']); // the chained one is code, not an entry
  assert.equal(got[0].code, '_roll(0, "60,0,4")');
});

test('only a real definition of the right kind and name can be pinned', () => {
  assert.throws(() => upsertPinned('', { kind: 'roll', id: 'bass', code: '_roll("lead", "1,0,1")' }), /one _roll\("bass"/);
  assert.throws(() => upsertPinned('', { kind: 'roll', id: 'bass', code: '_roll("bass", "1,0,1")\n_roll("b", "1,0,1")' }));
  assert.throws(() => upsertPinned('', { kind: 'track', id: 'x', code: 'x' }), /only rolls/);
  assert.throws(() => upsertPinned('', { kind: 'roll', id: 'bass', code: '_roll("bass", "1,0,1").synth("x")' }));
});
