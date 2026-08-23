// Sig#bite: remix a pattern by chopping it into a grid of bites and re-ordering them with an
// index pattern. The source is laid out over a len-aligned window (grid bites per cycle, len
// cycles - 8 x 4 by default), each index event jumps the playhead to bite v and rolls forward for
// the event's span, a bite strikes the notes whose ONSETS it covers, and every struck note keeps
// the duration it was written with. Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, s, mini, sine, irand, setPatternWarn } from './src/signal.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const sounding = (sig, cycle) => sig.stepsForCycle(cycle).filter((st) => st.value != null);
const struck = (sig, cycle) => sounding(sig, cycle).filter((st) => !st.cont);
const valuesAt = (sig, cycle) => struck(sig, cycle).map((st) => st.value);

// The identity index for a grid x len window: "<0 1 2 .. grid*len-1>*grid".
const identityIndex = (grid, len) => `<${[...Array(grid * len).keys()].join(' ')}>*${grid}`;

// ---------------------------------------------------------------------------------------------
// identity: the default 8x4 window recovers the original pattern
// ---------------------------------------------------------------------------------------------

test('the identity index recovers the pattern exactly (default grid 8, len 4)', () => {
  const src = n('0 1 2 3 4 5 6 7');
  const bitten = src.bite(identityIndex(8, 4));
  for (let c = 0; c < 8; c++) {
    const want = src.stepsForCycle(c).filter((st) => st.value != null);
    const got = struck(bitten, c);
    assert.equal(got.length, want.length, `cycle ${c} note count`);
    for (let i = 0; i < want.length; i++) {
      near(got[i].start, want[i].start, `cycle ${c} note ${i} start`);
      near(got[i].end, want[i].end, `cycle ${c} note ${i} end`);
      assert.equal(got[i].value, want[i].value, `cycle ${c} note ${i} value`);
    }
  }
});

test('the window is the CURRENT len-block, so the source keeps evolving under an identity', () => {
  // One note per cycle, an 8-cycle alternation - longer than the 4-cycle window. With a frozen
  // window cycle 5 would replay cycle 1's note; the rolling len-block plays cycle 5's own.
  const src = n('<0 1 2 3 4 5 6 7>');
  const bitten = src.bite('<0 1 2 3>', { grid: 1, len: 4 });
  for (let c = 0; c < 8; c++) {
    assert.deepEqual(valuesAt(bitten, c), [c], `cycle ${c} plays its own note`);
  }
});

// ---------------------------------------------------------------------------------------------
// remixing
// ---------------------------------------------------------------------------------------------

test('re-ordering the bites re-orders the notes', () => {
  const bitten = n('0 1 2 3').bite('<3 2 1 0>*4', { grid: 4, len: 1 });
  assert.deepEqual(valuesAt(bitten, 0), [3, 2, 1, 0]);
  const starts = struck(bitten, 0).map((st) => st.start);
  [0, 0.25, 0.5, 0.75].forEach((want, i) => near(starts[i], want, `note ${i} start`));
});

test('a long index event rolls the playhead on through following bites', () => {
  // Two half-cycle events on an 8-grid: "0" plays bites 0-3, "4" plays bites 4-7.
  const rolled = n('0 1 2 3 4 5 6 7').bite('0 4', { grid: 8, len: 1 });
  assert.deepEqual(valuesAt(rolled, 0), [0, 1, 2, 3, 4, 5, 6, 7]);
  // "0 0" replays the first half twice.
  const doubled = n('0 1 2 3 4 5 6 7').bite('0 0', { grid: 8, len: 1 });
  assert.deepEqual(valuesAt(doubled, 0), [0, 1, 2, 3, 0, 1, 2, 3]);
});

test('a fractional index starts that far into the bite', () => {
  // Playhead starts at 0.5/8 of the cycle and rolls a whole cycle: the onsets it covers are
  // notes 1..7 (each half a bite early in the output) and the NEXT cycle's note 0 at the end.
  const bitten = n('0 1 2 3 4 5 6 7').bite('0.5', { grid: 8, len: 1 });
  assert.deepEqual(valuesAt(bitten, 0), [1, 2, 3, 4, 5, 6, 7, 0]);
  near(struck(bitten, 0)[0].start, 1 / 8 - 1 / 16, 'first covered onset lands half a bite early');
});

test('indices wrap mod grid*len, so -1 is the last bite of the window', () => {
  const bitten = n('0 1 2 3').bite('-1', { grid: 4, len: 1 });
  // src 0.75 rolling one cycle: note 3, then the next cycle's notes 0 1 2.
  assert.deepEqual(valuesAt(bitten, 0), [3, 0, 1, 2]);
});

test('a rest in the index pattern is a gap', () => {
  const bitten = n('0 1 2 3').bite('0 ~ 2 ~', { grid: 4, len: 1 });
  assert.deepEqual(valuesAt(bitten, 0), [0, 2]);
  const starts = struck(bitten, 0).map((st) => st.start);
  near(starts[0], 0, 'first bite at 0');
  near(starts[1], 0.5, 'second bite at the half');
});

test('a bare number config is the grid', () => {
  // grid 4: "0" plays bites 0-1 (notes 0,1); "1" jumps to src 0.25 and covers onsets .25/.5.
  const bitten = n('0 1 2 3').bite('0 1', 4);
  assert.deepEqual(valuesAt(bitten, 0), [0, 1, 1, 2]);
});

// ---------------------------------------------------------------------------------------------
// durations: notes keep what they were written with
// ---------------------------------------------------------------------------------------------

test('a bite covering no onset is silent - a mid-note landing does not re-strike', () => {
  // Note 0 holds through bites 0 AND 1; the identity stays a true identity (no double strike),
  // and biting bite 1 alone plays nothing.
  const src = n('0@2 1 2');
  assert.deepEqual(valuesAt(src.bite('<0 1 2 3>*4', { grid: 4, len: 1 }), 0), [0, 1, 2]);
  assert.deepEqual(valuesAt(src.bite('1 ~ ~ ~', { grid: 4, len: 1 }), 0), []);
});

test('a struck note keeps its full written duration, ringing past the next bite', () => {
  const bitten = n('0@2 1 2').bite('1 0 3 2', { grid: 4, len: 1 });
  const got = struck(bitten, 0);
  // bite 1 covers no onset; bite 0 strikes the held note at 0.25 for its full half-cycle.
  assert.deepEqual(got.map((st) => st.value), [0, 2, 1]);
  near(got[0].start, 0.25, 'held note struck at the second quarter');
  near(got[0].end, 0.75, 'and rings its written half cycle');
});

test('a note ringing past the cycle line keeps its full end and re-reports as a cont tail', () => {
  const bitten = n('0@2 1 2').bite('3 3 3 0', { grid: 4, len: 1 });
  const rung = struck(bitten, 0).find((st) => st.value === 0);
  near(rung.start, 0.75, 'struck at the last quarter');
  near(rung.end, 1.25, 'origin step carries the full duration past the cycle');
  const tail = sounding(bitten, 1).find((st) => st.cont && st.value === 0);
  assert.ok(tail, 'next cycle reports the still-ringing part');
  near(tail.start, 0, 'tail opens the cycle');
  near(tail.end, 0.25, 'tail is the remaining quarter');
});

// ---------------------------------------------------------------------------------------------
// sample(), controls, highlighting
// ---------------------------------------------------------------------------------------------

test('sample() agrees with the step grid', () => {
  const bitten = n('0 1 2 3').bite('<3 2 1 0>*4', { grid: 4, len: 1 });
  for (const [pos, want] of [[0.1, 3], [0.3, 2], [0.6, 1], [0.9, 0]]) {
    assert.equal(bitten.sample(pos, 1, pos), want, `sample at ${pos}`);
  }
});

test('merged note channels travel with their notes', () => {
  const bitten = n('0 1 2 3').vel('1 .8 .6 .4').bite('<3 2 1 0>*4', { grid: 4, len: 1 });
  const got = struck(bitten, 0);
  assert.deepEqual(got.map((st) => st.value), [3, 2, 1, 0]);
  assert.deepEqual(got.map((st) => st.vel), [0.4, 0.6, 0.8, 1]);
});

test('sampler patterns bite like note patterns, config riding along', () => {
  const bitten = s('a b c d').i('0 1 2 3').bite('<3 2 1 0>*4', { grid: 4, len: 1 });
  const got = struck(bitten, 0);
  assert.deepEqual(got.map((st) => st.value), ['d', 'c', 'b', 'a']);
  assert.deepEqual(got.map((st) => st.cfg.index), [3, 2, 1, 0]);
  // the remapped index signal reads the same value at each output onset
  for (const st of got) {
    assert.equal(bitten.sampler.index.sample(st.start, 1, st.start), st.cfg.index, `index at ${st.start}`);
  }
});

test('carried channel controls read through the playhead jumps', () => {
  // A pre-bite gain pattern follows its notes: at output onset 0 the playhead sits at src 0.75.
  const bitten = n('0 1 2 3').gain('1 .8 .6 .4').bite('<3 2 1 0>*4', { grid: 4, len: 1 });
  const gain = bitten.channel.gain;
  for (const [pos, want] of [[0, 0.4], [0.25, 0.6], [0.5, 0.8], [0.75, 1]]) {
    assert.equal(gain.sample(pos, 1, pos), want, `gain at ${pos}`);
  }
});

test('emitted notes light both the source atom and the index atom that chose it', () => {
  const bitten = n('0 1 2 3').bite('<3 2 1 0>*4', { grid: 4, len: 1 });
  for (const st of struck(bitten, 0)) {
    assert.ok(st.locs && st.locs.length >= 2, 'both spans carried');
  }
});

// ---------------------------------------------------------------------------------------------
// index signals without an honest grid
// ---------------------------------------------------------------------------------------------

test('irand as the index draws one bite per grid slot, deterministically', () => {
  const bitten = n('0 1 2 3 4 5 6 7').bite(irand(32));
  for (const c of [0, 1, 5]) {
    const got = struck(bitten, c);
    assert.equal(got.length, 8, `cycle ${c} has one strike per slot`);
    assert.ok(got.every((st) => st.value >= 0 && st.value < 8), 'values are source notes');
    assert.deepEqual(valuesAt(bitten, c), valuesAt(bitten, c), `cycle ${c} stable across re-queries`);
  }
});

// ---------------------------------------------------------------------------------------------
// warnings and errors
// ---------------------------------------------------------------------------------------------

test('an unusable constant config warns and falls back to the defaults', () => {
  const warned = [];
  setPatternWarn((line) => warned.push(line));
  try {
    n('0 1 2 3').bite('0', { grid: 0 });
    n('0 1 2 3').bite('0', { len: -1 });
    n('0 1 2 3').bite('0', { grdi: 8 });
  } finally {
    setPatternWarn(null);
  }
  assert.ok(warned.some((l) => l.includes('grid')), 'bad grid warned');
  assert.ok(warned.some((l) => l.includes('len')), 'bad len warned');
  assert.ok(warned.some((l) => l.includes("'grdi'")), 'unknown key warned');
});

test('.bite() without a step pattern, or without indices, says what it needs', () => {
  assert.throws(() => sine().bite('0'), /needs a step pattern/);
  assert.throws(() => n('0 1').bite(), /takes an index pattern/);
});
