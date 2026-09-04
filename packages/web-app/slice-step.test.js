'use strict';

// Stepping between the files a chain names, in the slice editor (public/client.js).
//
// A slice set holds markers PER SAMPLE, so `[`/`]` over `s("breaks").i("<27 24>")` walks four chop
// maps under one name. What this pins is the state a file the set has never been drawn on comes up
// in: the DETECTOR's chops, at whatever length the file itself lasts - exactly the state a sample
// with no set at all is in. An entry that says nothing has to behave as no entry, or naming a set
// would quietly change what an untouched sample sounds like.
//
// It also pins what does NOT survive the step: the previous file's markers, its fit, its "drawn by
// hand" latch (which stands the sensitivity slider down) and whatever it had to say in the note
// line. Each of those belongs to the file that is going away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

let slicesMod;
test.before(async () => {
  const dir = path.dirname(require.resolve('@poptart/pattern-core'));
  slicesMod = await import(require('node:url').pathToFileURL(path.join(dir, 'slices.mjs')).href);
});

/** The panel's two file-switching functions over a state object, with the rest of it spied on. */
function panel(state) {
  const calls = [];
  const spy = (name) => (...args) => calls.push([name, ...args]);
  // eslint-disable-next-line no-new-func
  const fns = new Function(
    'slicesMod', 'sliceState', 'sliceSay', 'sliceStopAudition', 'sliceSetView', 'sliceSetHand',
    'sliceSyncFit', 'sliceRender', 'sliceLoadSample',
    `${grab('sliceStepFile')}\n${grab('sliceApplyKey')}\nreturn { sliceStepFile, sliceApplyKey };`,
  )(
    slicesMod, state, spy('say'), spy('stopAudition'), spy('setView'), spy('setHand'),
    spy('syncFit'), spy('render'), spy('loadSample'),
  );
  return { ...fns, calls, state };
}

const stateFor = (set, over = {}) => ({
  id: 'break',
  set,
  key: 'breaks/amen.wav',
  positions: [0, 0.5],
  others: {},
  fit: 2,
  hand: true,
  index: 27,
  indices: [27, 24],
  sel: 1,
  lit: [{ k: 0, at: 0.2 }],
  detected: [0, 0.5],
  detectWhy: 'only WAV files can be analyzed',
  file: '/samples/breaks/amen.wav',
  buffer: { duration: 4.8 },
  peaks: {},
  view: { start: 0.2, span: 0.4 },
  ...over,
});

test('stepping to the next file leaves nothing of the last one on screen', () => {
  const p = panel(stateFor({ 'breaks/amen.wav': { fit: 2, marks: [0, 0.5] } }));
  p.sliceStepFile(1);
  assert.equal(p.state.index, 24, 'the next index the chain names');
  // Everything the old file brought with it is gone - not left to be redrawn over the new waveform.
  for (const key of ['file', 'buffer', 'peaks', 'detected']) assert.equal(p.state[key], null, key);
  assert.deepEqual(p.state.positions, []);
  assert.deepEqual(p.state.lit, []);
  assert.equal(p.state.fit, null);
  assert.equal(p.state.sel, 0);
  assert.equal(p.state.detectWhy, '');
  const called = p.calls.map((c) => c[0]);
  // The slider comes back up (this file has not been touched), the note line is cleared, the fit
  // readout re-reads, and the whole thing is fetched again.
  assert.deepEqual(p.calls.find((c) => c[0] === 'setHand'), ['setHand', false]);
  assert.deepEqual(p.calls.find((c) => c[0] === 'say'), ['say', '']);
  assert.deepEqual(p.calls.find((c) => c[0] === 'setView'), ['setView', 0, 1]);
  for (const name of ['stopAudition', 'syncFit', 'render', 'loadSample']) assert.ok(called.includes(name), name);
});

test('stepping wraps round the indices, in both directions', () => {
  const p = panel(stateFor([], { index: 24 }));
  p.sliceStepFile(1);
  assert.equal(p.state.index, 27);
  p.sliceStepFile(-1);
  assert.equal(p.state.index, 24);
});

test('a chain that names one file says so and changes nothing', () => {
  const p = panel(stateFor([], { indices: [27] }));
  p.sliceStepFile(1);
  assert.equal(p.state.index, 27);
  assert.equal(p.state.file, '/samples/breaks/amen.wav', 'nothing was thrown away');
  assert.match(p.calls[0][1], /one file/);
});

test('a file the set has never been drawn on starts on the detector, with no fit', () => {
  // The set has an entry for a DIFFERENT break; this one comes up saying nothing at all, which is
  // what makes the panel show the sample's own transients (positions empty) at its own length.
  const set = { 'breaks/amen.wav': { fit: 2, marks: [0, 0.25, 0.5] } };
  const p = panel(stateFor(set, { key: null, positions: [], fit: null }));
  p.sliceApplyKey(p.state, 'breaks/think.wav');
  assert.deepEqual(p.state.positions, []);
  assert.equal(p.state.fit, null);
  // ...and the break that HAS been drawn on keeps both halves of its entry
  p.sliceApplyKey(p.state, 'breaks/amen.wav');
  assert.deepEqual(p.state.positions, [0, 0.25, 0.5]);
  assert.equal(p.state.fit, 2);
  // The other file's entry rides along untouched either way - editing one break can't disturb another
  p.sliceApplyKey(p.state, 'breaks/think.wav');
  assert.deepEqual(Object.keys(p.state.others), ['breaks/amen.wav']);
});
