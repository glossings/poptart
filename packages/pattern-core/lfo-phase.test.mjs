// Where a modulator's phase is counted FROM. A synced rate (rate: 0.25) counts cycles off the
// transport grid, so its pass starts on cycles 0, 4, 8 - a position in the music rather than
// whenever the process booted. A free one ("0.5hz") counts seconds and ignores the grid, which is
// the whole of what asking for Hz means. The JS value, the phase the scheduler anchors the native
// modulator to, and anything drawing a playhead all read that one count (lfoPhaseCount).

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, saw, sine, lfo, lfoPhaseCount } from './src/signal.mjs';
import { Scheduler, Transport } from './src/scheduler.mjs';

function mockEngine(now = 0) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => now },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

const withLfo = (l) => note('c').synth('X').param('Cutoff', l);

// saw is the shape that reads as its own phase (unipolar = phase), so a sample IS the phase.

test('a synced rate starts its pass on the cycle grid', () => {
  const cps = 0.5;
  const at = (cycle) => saw(0.25).sample(cycle / cps, cps, cycle);
  // rate 0.25: one pass per four cycles, beginning on 0, 4, 8 - not wherever the clock started.
  assert.equal(at(0), 0);
  assert.equal(at(1), 0.25);
  assert.equal(at(2), 0.5);
  assert.equal(at(4), 0);
  assert.equal(at(9), 0.25);
});

test('a synced modulator reads the cycle position, not the second it is sampled at', () => {
  // The same cycle position at two wildly different wall-clock times - a session started now and
  // one started a year ago - is the same point in the shape. This is the bug the shape editor's
  // playhead was showing: an epoch-counted phase is a different phase every session.
  const cps = 0.5;
  const a = sine(0.25).sample(1e9, cps, 2.5);
  const b = sine(0.25).sample(1e9 + 12345.678, cps, 2.5);
  assert.equal(a, b);
  assert.equal(saw(0.25).sample(1e9, cps, 2.5), 0.625); // 2.5 cycles into a 4-cycle pass
});

test('a Hz rate counts seconds and ignores the grid', () => {
  // "0.5hz" is the way to ask for a modulator the tempo does not touch, so it stays on the clock.
  assert.equal(saw('0.5hz').sample(1, 0.5, 999), 0.5);
  assert.equal(saw('0.5hz').sample(3, 0.5, 0), 0.5);
  assert.equal(saw('2hz').sample(0.25, 0.5, 0), 0.5);
});

test('phase offsets the count in both units', () => {
  assert.equal(saw({ rate: 1, phase: 0.25 }).sample(0, 1, 0), 0.25);
  assert.equal(saw({ rate: '1hz', phase: 0.25 }).sample(0, 1, 0), 0.25);
  assert.equal(lfoPhaseCount({ rateCycles: 0.25, phaseCycles: 0.5 }, 0, 0.5, 2), 1);
});

test('the count falls back to seconds x cps when there is no cycle position', () => {
  // Plenty of internal reads sample in the cycle domain with cps 1 and no pos (see mini's
  // samplers) - the fallback has to land on the same number those reads meant.
  assert.equal(saw(0.25).sample(2, 1, undefined), 0.5);
});

test('the phase anchor sends the cycle-aligned phase, whatever the clock reads', () => {
  const now = 1e9 + 3.7; // a wall clock a long way from zero, as a real one is
  const { engine, argsTo } = mockEngine(now);
  const transport = new Transport(() => engine.getTime(), { cps: 0.5 });
  const sch = new Scheduler(engine, { trackId: 't', transport });
  sch.setPattern(withLfo(lfo('pluck', { rate: 0.25 })));

  sch._anchorLFOs(now); // the tick's nowSec; the anchor lands a lookahead later
  const [args] = argsTo('anchorParamLFO');
  const targetSec = args[4];
  const cycle = transport.cycleAt(targetSec);
  assert.equal(args[3], ((cycle * 0.25) % 1 + 1) % 1);
  // ...which is emphatically NOT what counting the epoch would have produced.
  assert.notEqual(args[3], ((targetSec * 0.25 * 0.5) % 1 + 1) % 1);
});

test('a shape swap re-bases the anchor to the swap cycle', () => {
  const now = 1e9 + 3.7;
  const { engine, argsTo } = mockEngine(now);
  const transport = new Transport(() => engine.getTime(), { cps: 1 });
  const sch = new Scheduler(engine, { trackId: 't', transport });
  sch.setPattern(withLfo(lfo('<pluck swell>', { rate: 2 })));

  sch._scheduleShapeSwaps(0, 2); // swaps at cycles 0 and 1; the last one is the origin
  sch._anchorLFOs(now);
  const [args] = argsTo('anchorParamLFO');
  const since = transport.cycleAt(args[4]) - 1;
  assert.equal(args[3], ((since * 2) % 1 + 1) % 1);
});
