// Extracting a groove from hits (see groove-extract.mjs). The hits are written down by hand here
// rather than detected, which is the point of the split: these are the numbers, and what the
// detector does with real audio is its own test (osc-engine's detect-onsets.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractGroove, fitGrooveGrid, grooveHitsOnGrid, grooveHitsInCycles, grooveHitsFromFile } from './src/groove-extract.mjs';
import { serializeGroove, parseGroove } from './src/groove.mjs';
import { s, timeShift } from './src/signal.mjs';

// A straight 8-slot bar, every hit dead on its slot and equally loud.
const straight8 = Array.from({ length: 8 }, (_, k) => ({ at: k / 8, strength: 1 }));

const shiftsOf = (sig, cycle = 0) =>
  sig.stepsForCycle(cycle).map((st) => {
    const at = cycle + st.start;
    return Number(timeShift(st, sig.noteChannels, at, 1, at, sig.groove).toFixed(10));
  });

test('a loop played dead on the grid extracts as no groove at all', () => {
  const table = extractGroove(straight8, { grid: 8 });
  assert.equal(table.steps, 8);
  assert.deepEqual(table.time, new Array(8).fill(0));
  assert.equal(table.vel, null, 'equally loud hits say nothing about velocity');
  assert.deepEqual(table.slots, new Array(8).fill(1));
});

test('a swung loop extracts the swing that was played', () => {
  // Every offbeat a third of a slot late - the triplet shuffle, measured rather than written.
  const hits = straight8.map((h, k) => (k % 2 ? { ...h, at: h.at + 1 / 3 / 8 } : h));
  const table = extractGroove(hits, { grid: 8 });
  assert.deepEqual(table.time, [0, 0.333, 0, 0.333, 0, 0.333, 0, 0.333]);
  // ...and played back through the engine it moves notes by what was measured - the table's own
  // numbers, which are rounded to where a drawn groove's are (see serializeGroove).
  const played = s('hh*8').swing(1, parseGroove(serializeGroove({ ...table, vel: null })));
  assert.deepEqual(shiftsOf(played), table.time.map((v) => Number((v / 8).toFixed(10))));
});

test('a hit played EARLY belongs to the slot it was aiming at', () => {
  // The last hit is a sixth of a slot early, which puts it inside the previous slot.
  const hits = [...straight8];
  hits[7] = { at: 7 / 8 - 1 / 6 / 8, strength: 1 };
  const table = extractGroove(hits, { grid: 8 });
  assert.equal(table.slots[7], 1, 'counted as slot 7, not as a second reading of slot 6');
  assert.equal(table.slots[6], 1);
  assert.ok(table.time[7] < 0, 'and it reads as early');
  assert.equal(table.time[7], -0.167);
});

test('how hard each slot was hit becomes the velocity row', () => {
  const hits = straight8.map((h, k) => ({ ...h, strength: k % 2 ? 0.5 : 1 }));
  const table = extractGroove(hits, { grid: 8 });
  assert.deepEqual(table.vel, [1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5], 'against the loudest hit in the loop');
  assert.equal(serializeGroove({ ...table, time: table.time }), '0 0 0 0 0 0 0 0 / 1 0.5 1 0.5 1 0.5 1 0.5');
});

test('a slot nothing landed on says nothing, and says how many it was measured from', () => {
  const table = extractGroove([{ at: 0, strength: 1 }, { at: 0.5, strength: 0.4 }], { grid: 8 });
  assert.deepEqual(table.slots, [1, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(table.time, new Array(8).fill(0), 'an unplayed slot moves nothing');
  assert.deepEqual(table.vel, [1, 1, 1, 1, 0.4, 1, 1, 1], 'and leaves velocity alone');
});

test('two bars of the same feel are two readings of one bar, averaged', () => {
  // Slot 1 is late by a third in the first bar and by a quarter in the second.
  const hits = [
    { at: 0, strength: 1 },
    { at: 1 / 8 + 1 / 3 / 8, strength: 1 },
    { at: 1, strength: 1 },
    { at: 1 + 1 / 8 + 1 / 4 / 8, strength: 1 },
  ];
  const table = extractGroove(hits, { grid: 8 });
  assert.equal(table.steps, 8, 'a groove describes one bar however many it was measured over');
  assert.equal(table.slots[1], 2, 'both bars voted on slot 1');
  assert.equal(table.time[1], round3((1 / 3 + 1 / 4) / 2), 'and the feel is where the player tends to put it');
});

test('a quiet ghost note can be left out', () => {
  const hits = [...straight8, { at: 1 / 16, strength: 0.05 }];
  const loud = extractGroove(hits, { grid: 16, minStrength: 0.2 });
  assert.equal(loud.slots[1], 0, 'the ghost is below the floor');
  const all = extractGroove(hits, { grid: 16 });
  assert.equal(all.slots[1], 1, 'and is there without one');
});

test('the grid is fitted from the hits, preferring the coarsest that explains them', () => {
  assert.equal(fitGrooveGrid(straight8), 8, 'straight eighths are eighths, not sixteenths');
  const sixteenths = Array.from({ length: 16 }, (_, k) => ({ at: k / 16, strength: 1 }));
  assert.equal(fitGrooveGrid(sixteenths), 16);
  const triplets = Array.from({ length: 12 }, (_, k) => ({ at: k / 12, strength: 1 }));
  assert.equal(fitGrooveGrid(triplets), 12, 'and a triplet loop reads as 12');
  assert.equal(fitGrooveGrid([]), null, 'nothing to fit');
});

test('a swung loop still fits the grid it was swung on', () => {
  // The offbeats are late, but they are still eighths: a 16-grid would not explain them better.
  const hits = straight8.map((h, k) => (k % 2 ? { ...h, at: h.at + 0.2 / 8 } : h));
  assert.equal(fitGrooveGrid(hits), 8);
});

test('hits too far off a grid to belong to it can be told apart', () => {
  const hits = [{ at: 0, strength: 1 }, { at: 0.07, strength: 1 }, { at: 0.5, strength: 1 }];
  const on = grooveHitsOnGrid(hits, { grid: 4, window: 0.2 });
  assert.deepEqual(on.map((h) => h.at), [0, 0.5], 'the one between slots is not this grid\'s');
});

test('a file read against a tempo puts its hits in bars, anchor and all', () => {
  // Two bars at 120bpm: a bar is 2s, the file is 4s, and it starts a quarter of a second before
  // the first downbeat - a break lifted out of a track rather than cut to the bar.
  const anchorSec = 0.25;
  const seconds = 4.25;
  const atSec = [0.25, 0.75, 2.25, 2.75]; // downbeat, then the "and" of two, in each bar
  const inFile = atSec.map((t) => ({ at: t / seconds, strength: 1 }));
  const inBars = grooveHitsFromFile(inFile, { seconds, bpm: 120, anchorSec });
  assert.deepEqual(inBars.map((h) => Number(h.at.toFixed(6))), [0, 0.25, 1, 1.25]);
  const table = extractGroove(inBars, { grid: 8 });
  assert.deepEqual(table.slots, [2, 0, 2, 0, 0, 0, 0, 0], 'both bars read the same two slots');
  assert.deepEqual(table.time, new Array(8).fill(0), 'and they were played dead on them');
});

test('a hit just before the downbeat it was aiming at is not thrown away', () => {
  const seconds = 2;
  // 10ms early on the downbeat of bar two, with the anchor at the very start.
  const inFile = [{ at: 0, strength: 1 }, { at: (1 - 0.01) / seconds, strength: 1 }];
  const inBars = grooveHitsFromFile(inFile, { seconds, bpm: 240, anchorSec: 0 });
  assert.ok(inBars[1].at < 1, 'it lands before the bar line');
  const table = extractGroove(inBars, { grid: 8 });
  assert.equal(table.slots[0], 2, 'and it still belongs to slot 0');
  assert.ok(table.time[0] < 0, 'as a slot played slightly early');
});

test('positions along a file become positions in bars', () => {
  // A two-bar break: the hit halfway through the file is the downbeat of bar two.
  const inFile = [{ at: 0, strength: 1 }, { at: 0.5, strength: 0.5 }, { at: 0.75, strength: 1 }];
  const inBars = grooveHitsInCycles(inFile, 2);
  assert.deepEqual(inBars.map((h) => h.at), [0, 1, 1.5]);
  assert.deepEqual(inBars.map((h) => h.strength), [1, 0.5, 1], 'and how hard it was hit travels with it');
  // ...so those two downbeats are two readings of slot 0, and the third hit is slot 4 of 8.
  const table = extractGroove(inBars, { grid: 8 });
  assert.deepEqual(table.slots, [2, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(grooveHitsInCycles([0.25], 4).map((h) => h.at), [1], 'a bare number is a hit too');
});

const round3 = (v) => Math.round(v * 1000) / 1000;
