// Slice grids - `.slices(8)` and `.slices("1/4")` - as the pattern side says them: which values
// are grids, what a division is in cycles, and what an event carries. Where a grid cuts a file is
// the engines' (osc-engine's slice-grid.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, mini, _slices, setPatternWarn } from './src/signal.mjs';
import { clearRolls, setRollLayer } from './src/rolls.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { injectLocations } from './src/locations.mjs';
import { DIVISION_LABEL } from './src/mini.mjs';
import { divisionCycles, sliceGridOf, isSliceGridLabel } from './src/slices.mjs';

const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
};

const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

const setAt = (sig, cycle = 0) => sig.sampler.slices.sample(cycle + 0.01, 1, cycle + 0.01);

test('a division label is its length in cycles - a cycle is a bar', () => {
  assert.equal(divisionCycles('1/4'), 0.25);
  assert.equal(divisionCycles('1/8'), 0.125);
  assert.equal(divisionCycles('1/8.'), 0.1875, 'dotted: half as long again');
  assert.equal(divisionCycles('1/16t'), 1 / 24, 'triplet: two thirds');
  assert.equal(divisionCycles('1/16T'), 1 / 24);
  assert.equal(divisionCycles('3/8'), 0.375);
  assert.equal(divisionCycles('1 bar'), 1);
  assert.equal(divisionCycles('2 bars'), 2);
  assert.equal(divisionCycles('main'), null);
  assert.equal(divisionCycles('0/4'), null);
  // Every sync label the devices offer reads as a division.
  for (const label of ['1/32', '1/32T', '1/32.', '1/16', '1/8T', '1/4.', '1/2T', '4 bars']) {
    assert.ok(DIVISION_LABEL.test(label) && divisionCycles(label) > 0, label);
  }
});

test('numbers are counts, divisions are divisions, anything else names a set', () => {
  assert.deepEqual(sliceGridOf(8), { grid: { count: 8 } });
  assert.deepEqual(sliceGridOf('16'), { grid: { count: 16 } });
  assert.deepEqual(sliceGridOf(2.6), { grid: { count: 3 } });
  assert.deepEqual(sliceGridOf('1/4'), { grid: { every: 0.25, label: '1/4' } });
  assert.deepEqual(sliceGridOf(' 1/8. '), { grid: { every: 0.1875, label: '1/8.' } });
  assert.equal(sliceGridOf(0), null);
  assert.equal(sliceGridOf('main'), null);
  assert.equal(isSliceGridLabel('main'), false);
  assert.equal(isSliceGridLabel('8'), true);
  assert.equal(isSliceGridLabel('1/16t'), true);
});

test('.slices(8) puts an even grid on the event', () => {
  fresh();
  assert.deepEqual(setAt(s('breaks').slice(0).slices(8)), { grid: { count: 8 } });
  assert.deepEqual(setAt(s('breaks').slice(0).slices('8')), { grid: { count: 8 } });
});

test('.slices("1/4") puts a division on the event, dotted and triplet included', () => {
  fresh();
  assert.deepEqual(setAt(s('breaks').slices('1/4')), { grid: { every: 0.25, label: '1/4' } });
  assert.deepEqual(setAt(s('breaks').slices('1/8.')), { grid: { every: 0.1875, label: '1/8.' } });
  assert.deepEqual(setAt(s('breaks').slices('1/16t')), { grid: { every: 1 / 24, label: '1/16t' } });
  assert.deepEqual(setAt(s('breaks').slices('2 bars')), { grid: { every: 2, label: '2 bars' } });
});

test('patterns of grids are read per event and add no structure', () => {
  fresh();
  const div = s('breaks').slice('0 1').slices('<1/4 1/8>');
  assert.deepEqual(setAt(div, 0).grid.every, 0.25);
  assert.deepEqual(setAt(div, 1).grid.every, 0.125);
  assert.equal(div.stepsForCycle(0).length, 2, 'the slice pattern\'s two events, not split further');
  const count = s('breaks').slice(0).slices('<8 16>');
  assert.deepEqual(setAt(count, 0), { grid: { count: 8 } });
  assert.deepEqual(setAt(count, 1), { grid: { count: 16 } });
  // The same value is the same object every time, not a fresh one per event.
  assert.equal(setAt(count, 0), setAt(count, 2));
});

test('grids and named sets mix in one pattern, and a named set still resolves', () => {
  fresh();
  _slices('main', { 'breaks/a.wav': [0, 0.5] });
  const sig = s('breaks').slice(0).slices('<main 1/16t 4>');
  assert.deepEqual(setAt(sig, 0), { 'breaks/a.wav': [0, 0.5] });
  assert.deepEqual(setAt(sig, 1), { grid: { every: 1 / 24, label: '1/16t' } });
  assert.deepEqual(setAt(sig, 2), { grid: { count: 4 } });
  assert.deepEqual(setAt(s('breaks').slices('main')), { 'breaks/a.wav': [0, 0.5] });
});

test('a count under 1 warns once and chops on transients', () => {
  fresh();
  const { value, lines } = capture(() => {
    const sig = s('breaks').slice(0).slices(0);
    return [setAt(sig, 0), setAt(sig, 1)];
  });
  assert.deepEqual(value, [null, null]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 or more/);
});

test('the editor\'s transpile reads a .slices() string with divisions whole, and highlights it', () => {
  const out = injectLocations('s("breaks").slices("<1/4 1/16t>")');
  assert.match(out, /\.slices\(mini\("<1\/4 1\/16t>", \d+, 'divisions'\)\)/);
  // ...which is what makes "1/16t" (not mini at all) and "1/4" (1 slowed by 4) mean divisions.
  const sig = mini('<1/4 1/16t>', 19, 'divisions');
  const steps = [0, 1].map((c) => sig.stepsForCycle(c)[0]);
  assert.deepEqual(steps.map((st) => st.value), ['1/4', '1/16t']);
  assert.ok(steps.every((st) => st.loc?.[0] >= 19), 'each step points into the buffer');
  assert.deepEqual(setAt(s('breaks').slices(sig), 1).grid.label, '1/16t');
  // Everywhere else "/" is still the slow operator.
  assert.deepEqual(mini('1/4').stepsForCycle(0).map((st) => st.value), [1]);
});

test('sliceSetAt carries the chain\'s fit on a division, for auditions', () => {
  fresh();
  const engine = new Proxy({ getTime: () => 0 }, { get: (t, p) => (p in t ? t[p] : () => {}) });
  const sch = new Scheduler(engine, { trackId: 'breaks' });
  sch.setPattern(s('breaks').fit(2).slice(0).slices('1/4'));
  assert.deepEqual(sch.sliceSetAt(0), { grid: { every: 0.25, label: '1/4', fit: 2 } });
  sch.setPattern(s('breaks').fit().slice(0).slices('1/4'));
  assert.deepEqual(sch.sliceSetAt(0), { grid: { every: 0.25, label: '1/4', fit: 'auto' } });
  sch.setPattern(s('breaks').slice(0).slices('1/4'));
  assert.deepEqual(sch.sliceSetAt(0), { grid: { every: 0.25, label: '1/4' } }, 'no fit: the engine assumes one');
  sch.setPattern(s('breaks').fit(2).slice(0).slices(8));
  assert.deepEqual(sch.sliceSetAt(0), { grid: { count: 8 } }, 'a count needs no length');
});
