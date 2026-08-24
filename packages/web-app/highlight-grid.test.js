'use strict';

// The highlight grid ships two different things per cycle, computed from the same steps the
// scheduler plays: the atom spans to LIGHT, and the track's note GATES. The gates are what a
// note-synced lfo() restarts on engine-side (poptart.scd gates every lfo on the track from
// noteOn/playSample), so the shape editor's playhead counts from them - which means they have to
// be the onsets that will really fire, not everything the grid happens to know about.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// server.js spawns an engine on require, so highlightGrid is read out of the source and given its
// own dependencies - the same trick preset-holds.test.js uses for patternSigs.
function loadHighlightGrid(patternSigs) {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const at = src.indexOf('function highlightGrid(');
  assert.ok(at > 0, 'highlightGrid not found in server.js - this test needs updating');
  let depth = 0;
  let end = src.indexOf('{', at);
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // Stand-ins for the pattern-core helpers (ESM, and not what is under test here): no clip, and a
  // step carries its own shift so the "heard position" path can be exercised.
  const patternCore = {
    stepLocs: (s) => s.locs ?? [],
    soundingEnd: (s) => s.end,
    endEdgeStep: (s) => s,
    timeShift: (s) => s.shift ?? 0,
  };
  // eslint-disable-next-line no-new-func
  return new Function('patternCore', 'patternSigs', `${src.slice(at, end)}; return highlightGrid;`)(patternCore, patternSigs);
}

// A sig whose steps are the same every cycle. `locs` are document-absolute, as the real ones are.
const sigOf = (steps) => ({ stepsForCycle: () => steps, noteChannels: {} });

const gridOf = (sig, subs = []) => {
  const highlightGrid = loadHighlightGrid((s) => [s, ...subs]);
  return highlightGrid(sig, 0, 1000, 0, 2);
};

test('the gates are the track sig\'s own onsets, at the position they are heard', () => {
  const sig = sigOf([
    { start: 0, end: 0.5, value: 'bd', locs: [[10, 12]] },
    { start: 0.5, end: 1, value: 'sd', shift: 0.05, locs: [[13, 15]] }, // swung/nudged
  ]);
  assert.deepEqual(gridOf(sig)[0].gates, [0, 0.55]);
});

test('a rest and a tie are not gates', () => {
  // The same two tests the scheduler makes before it emits a note edge: a rest plays nothing, and
  // a tie is the tail of an onset that already happened.
  const sig = sigOf([
    { start: 0, end: 0.25, value: 'bd', locs: [[10, 12]] },
    { start: 0.25, end: 0.5, value: null, locs: [[13, 15]] },
    { start: 0.5, end: 1, value: 'bd', cont: true, locs: [[16, 18]] },
  ]);
  assert.deepEqual(gridOf(sig)[0].gates, [0]);
});

test('a control pattern lights up but gates nothing', () => {
  // `.param("x", "0 1")` has a step grid of its own and is on screen, so it highlights - but it is
  // not a trigger of anything. What it does to the note structure is already cross-merged into the
  // track sig, so counting its steps too would reset a retriggered lfo() twice as often as the
  // sound does.
  const sig = sigOf([{ start: 0, end: 1, value: 'bd', locs: [[10, 12]] }]);
  const param = sigOf([
    { start: 0, end: 0.5, value: 0, locs: [[20, 21]] },
    { start: 0.5, end: 1, value: 1, locs: [[22, 23]] },
  ]);
  const grid = gridOf(sig, [param]);
  assert.deepEqual(grid[0].gates, [0]);
  assert.equal(grid[0].steps.length, 3); // all three still light
});

test('a note whose source is outside the block still gates', () => {
  // Locations that can't be placed in this block are dropped from the highlight (a prebake-defined
  // pattern, a dynamic string) - but the note sounds, and what sounds gates the modulator.
  const sig = sigOf([{ start: 0.25, end: 1, value: 'bd', locs: [[5000, 5002]] }]);
  const grid = gridOf(sig);
  assert.deepEqual(grid[0].steps, []);
  assert.deepEqual(grid[0].gates, [0.25]);
});

test('a track with no note structure of its own has no gates', () => {
  // A bare modulator track: the scheduler emits no note edges for it either.
  const param = sigOf([{ start: 0, end: 1, value: 0, locs: [[20, 21]] }]);
  const highlightGrid = loadHighlightGrid(() => [param]);
  const grid = highlightGrid({ /* no stepsForCycle */ }, 0, 1000, 0, 1);
  assert.equal(grid[0].gates, undefined);
  assert.equal(grid[0].steps.length, 1);
});

test('every cycle of the window carries its own gates', () => {
  const sig = sigOf([{ start: 0, end: 1, value: 'bd', locs: [[10, 12]] }]);
  const grid = gridOf(sig);
  assert.deepEqual(grid.map((g) => g.cycle), [0, 1]);
  for (const g of grid) assert.deepEqual(g.gates, [0]);
});
