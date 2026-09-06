'use strict';

// The slice editor's grid chop (public/client.js sliceGridMarks): a marker every 1/div OF A
// CYCLE, walked to wherever the file's end falls. The point of the feature - and of these tests -
// is that this is NOT length/div: a file is rarely exactly one measure, even fitted, so the step
// is a division of the cycle converted into a fraction of the file. The cycles the file spans come
// from prFitCycles, whose agreement with the engine is pinned in slice-fit.test.js.

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

// The real constant, read off the source, so the test can't drift from what the panel enforces.
const SLICE_GRID_MAX = Number(/const SLICE_GRID_MAX = (\d+)/.exec(SRC)[1]);
assert.ok(SLICE_GRID_MAX > 0);

// eslint-disable-next-line no-new-func
const sliceGridMarks = new Function('SLICE_GRID_MAX', `${grab('sliceGridMarks')}\nreturn sliceGridMarks;`)(SLICE_GRID_MAX);

test('a fitted file grids in cycles, not file fractions', () => {
  // Fitted to 2 cycles, 1/16 grid: 32 sixteenths, not 16 - the "not length/16" the feature is for.
  const marks = sliceGridMarks(16, 2);
  assert.equal(marks.length, 32);
  for (let k = 0; k < marks.length; k++) {
    assert.ok(Math.abs(marks[k] - k / 32) < 1e-12, `marker ${k} sits on its 32nd of the file`);
  }
});

test('an unfitted file gets true divisions and keeps its tail', () => {
  // 1.03 cycles at 1/16: 16 full sixteenths plus the 0.48-division tail as a 17th slice, every
  // marker on a true sixteenth OF A CYCLE (marker k at k/16 cycles into the audio).
  const cycles = 1.03;
  const marks = sliceGridMarks(16, cycles);
  assert.equal(marks.length, 17);
  for (let k = 0; k < marks.length; k++) {
    assert.ok(Math.abs(marks[k] * cycles - k / 16) < 1e-12, `marker ${k} is ${k}/16 of a cycle in`);
  }
  assert.ok(marks[marks.length - 1] < 1);
});

test('rounding dust off a nearly-fitted file is not promoted to a sliver slice', () => {
  // A 1.001-measure loop wants 16 sixteenths, not 16 and a click.
  assert.equal(sliceGridMarks(16, 1.001).length, 16);
  // ...but a genuine partial tail (half a division and up) keeps its marker.
  assert.equal(sliceGridMarks(16, 1.5).length, 24);
});

test('a file shorter than one division is one slice, not none', () => {
  assert.deepEqual(sliceGridMarks(16, 0.002), [0]);
});

test('an unplayable grid answers null instead of an unwritable set', () => {
  assert.equal(sliceGridMarks(32, SLICE_GRID_MAX), null, 'over the marker cap');
  assert.equal(sliceGridMarks(16, 0), null, 'no length yet');
  assert.equal(sliceGridMarks(16, null), null);
});
