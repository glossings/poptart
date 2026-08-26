'use strict';

// settleSeamDrag - the one seam drag behind DJ mode's stacked regions and the organize window's
// columns. Pure arithmetic, and the arithmetic is the whole feature: a seam that resolves against
// its own last frame instead of the sizes the drag started from folds a region and then starts
// moving the WRONG WAY as it is pushed further (which is what DJ mode's seams did until
// 2026-08-26). What is pinned here is that a push is monotone, that it goes on folding whatever
// is next in its path, and that pulling back unwinds exactly what pushing folded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Lifted out of the browser script the way highlight-grid.test.js lifts its subject out of
// server.js: the function is plain arithmetic with no DOM in it, so it runs as-is.
function loadSettle() {
  const src = fs.readFileSync(path.join(__dirname, 'public/client.js'), 'utf8');
  const at = src.indexOf('function settleSeamDrag(');
  assert.ok(at > 0, 'settleSeamDrag not found in public/client.js - this test needs updating');
  const end = src.indexOf('\n}\n', at) + 3;
  return new Function(`${src.slice(at, end)}; return settleSeamDrag;`)();
}
const settleSeamDrag = loadSettle();

const RAIL = 18;
// Three regions of 400px: the DJ desk's shape (waveforms / decks / mixer), decks hardest to fold.
const MINS = [28, 56, 28];
const START = [100, 200, 100];
const TOTAL = 400;
const drag = (k, want, opts = {}) => settleSeamDrag({
  start: opts.start ?? START,
  fold0: opts.fold0 ?? [false, false, false],
  mins: opts.mins ?? MINS,
  rail: RAIL,
  k,
  want,
  total: opts.total ?? TOTAL,
});

test('a seam trades between its two neighbours, leaving the far one alone', () => {
  const { size, fold } = drag(0, 150);
  assert.deepEqual(size, [150, 150, 100]);
  assert.deepEqual(fold, [false, false, false]);
});

test('the sizes always add up to the total, however far the seam is pushed', () => {
  for (let want = -50; want <= 450; want += 7) {
    for (const k of [0, 1]) {
      const { size } = drag(k, want);
      assert.equal(Math.round(size.reduce((a, b) => a + b, 0)), TOTAL, `k=${k} want=${want}`);
    }
  }
});

test('pushing past a neighbour folds it and hands the squeeze to the next one out', () => {
  const { size, fold } = drag(0, 340); // no room left for the decks at their minimum
  assert.deepEqual(fold, [false, true, false], 'the decks fold, the mixer takes the squeeze');
  assert.equal(size[1], RAIL);
  assert.equal(size[0] + size[1] + size[2], TOTAL);
  assert.ok(size[2] < 100, 'and the mixer is now smaller than it started');
});

test('pushed further still, the far region folds too', () => {
  const { size, fold } = drag(0, 400);
  assert.deepEqual(fold, [false, true, true]);
  assert.deepEqual(size, [TOTAL - 2 * RAIL, RAIL, RAIL], 'the dragged region owns the height');
});

test('the dragged region never goes backwards as the pointer goes forwards', () => {
  // The reported bug: dragging the top seam DOWN past the decks' minimum made the waveforms
  // jump UP. Whatever folds on the way, the region under the pointer only ever grows.
  for (const k of [0, 1]) {
    let prev = -Infinity;
    for (let want = 0; want <= TOTAL; want += 1) {
      const { size } = drag(k, want);
      const led = k === 0 ? size[0] : size[0] + size[1]; // the boundary this seam owns
      assert.ok(led >= prev - 0.001, `k=${k} want=${want}: boundary went from ${prev} to ${led}`);
      prev = led;
    }
  }
});

test('pulling back unfolds in the order the push folded, at the sizes it started with', () => {
  const pushed = drag(0, 400);
  assert.deepEqual(pushed.fold, [false, true, true]);
  // Back the other way through the same gesture (fold0 is the drag's START state throughout).
  assert.deepEqual(drag(0, 340).fold, [false, true, false], 'the far one comes back first');
  assert.deepEqual(drag(0, 150).fold, [false, false, false], 'then the neighbour');
  assert.deepEqual(drag(0, 150).size, [150, 150, 100], 'and every region is where it began');
});

test('a region dragged under its own minimum folds, and its space goes to its neighbour', () => {
  const { size, fold } = drag(0, 10);
  assert.deepEqual(fold, [true, false, false]);
  assert.equal(size[0], RAIL);
  assert.equal(size[1], TOTAL - RAIL - 100, 'the decks take what the waveforms gave up');
});

test('a region folded before the drag stays folded until this seam reaches it', () => {
  const fold0 = [true, false, false];
  const start = [RAIL, 282, 100];
  const { size, fold } = drag(1, 250, { start, fold0 });
  assert.equal(fold[0], true, 'the other seam owns that one');
  assert.equal(size[0], RAIL);
  assert.deepEqual([size[1], size[2]], [232, 150]);
});

test('the same seam works a two-region row (DJ mode with the waveforms unstacked)', () => {
  const two = { start: [200, 100], fold0: [false, false], mins: [56, 28], total: 300 };
  assert.deepEqual(settleSeamDrag({ ...two, rail: RAIL, k: 0, want: 250 }).size, [250, 50]);
  const hard = settleSeamDrag({ ...two, rail: RAIL, k: 0, want: 400 });
  assert.deepEqual(hard.fold, [false, true]);
  assert.deepEqual(hard.size, [300 - RAIL, RAIL]);
});

test('a row too small for anything still leaves the dragged region open', () => {
  // Nothing may end up with every region folded - there would be nothing to look at.
  const tiny = { start: [30, 30, 30], fold0: [false, false, false], mins: MINS, total: 90 };
  const { fold } = settleSeamDrag({ ...tiny, rail: RAIL, k: 0, want: 45 });
  assert.ok(fold.some((f) => !f), 'at least one region is still open');
});
