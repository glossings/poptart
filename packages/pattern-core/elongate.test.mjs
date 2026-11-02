// .elongate(): each step held for a number of steps, the line growing past the cycle; lengths
// taken one per step; a length changed as it plays heard from the next step on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { n, note, mini, Sig, withPressWindow, Scheduler, Transport } from './src/index.mjs';

const r3 = (x) => Math.round(x * 1000) / 1000;
// Every onset in cycles [from, to) as [position, value], chords as one entry per note.
function onsets(sig, from, to) {
  const out = [];
  for (let c = from; c < to; c++) {
    for (const s of sig.stepsForCycle(c)) if (!s.cont && s.value != null) out.push([r3(c + s.start), s.value]);
  }
  return out;
}
// A scheduler's read of the window [from, to).
const scheduled = (from, to, fn) => withPressWindow({ deck: 'a', from, to, posAt: (c) => c }, fn);
// A pattern of lengths read off text that can change under it, as a slider row's is.
function liveLengths(text) {
  const live = { text };
  const sig = new Sig(() => null, { stepsForCycle: (c) => mini(live.text).stepsForCycle(c) });
  return { live, sig };
}

test('each step is held for its length, pushing the ones after it later', () => {
  const sig = n('0 2 4 7').elongate('1 4 1 2');
  assert.deepEqual(onsets(sig, 0, 4), [
    [0, 0], [0.25, 2], [1.25, 4], [1.5, 7],
    [2, 0], [2.25, 2], [3.25, 4], [3.5, 7],
  ]);
  const held = sig.stepsForCycle(0).find((s) => s.value === 2);
  assert.equal(r3(held.end - held.start), 1, 'a quarter held four steps rings a whole cycle');
  const tail = sig.stepsForCycle(1)[0];
  assert.deepEqual([tail.value, tail.cont, r3(tail.end)], [2, true, 0.25], 'and carries into the next cycle as a tail');
});

test('lengths are taken one per step, so a shorter row drifts against the notes', () => {
  // Three notes, two lengths: the pattern comes round after three cycles.
  const sig = n('0 1 2').elongate('1 2');
  assert.deepEqual(onsets(sig, 0, 3).map(([, v]) => v), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(onsets(sig, 0, 3).map(([at]) => at), [0, 0.333, 1, 1.333, 2, 2.333]);
  assert.deepEqual(onsets(sig, 3, 4), [[3, 0], [3.333, 1]]);
});

test('a rest is a step of its own and is held like a note', () => {
  const sig = n('0 ~ 2 ~').elongate('2 1 1 3');
  // 0 for two, the rest for one, 2 for one, the rest for three.
  assert.deepEqual(onsets(sig, 0, 3), [[0, 0], [0.75, 2], [1.75, 0], [2.5, 2]]);
});

test('a chord is one step', () => {
  const sig = n('[0,4] 7').elongate('3 1');
  assert.deepEqual(onsets(sig, 0, 2), [[0, 0], [0, 4], [1.5, 7]]);
});

test('a length that is not a positive number is 1; a single number holds every step', () => {
  assert.deepEqual(onsets(n('0 1').elongate('0 -2'), 0, 1), [[0, 0], [0.5, 1]]);
  assert.deepEqual(onsets(n('0 1').elongate(2), 0, 2), [[0, 0], [1, 1]]);
});

test('the lengths of the cycle a step comes from are the ones it takes', () => {
  // Cycle 0's two steps take 1s, cycle 1's take 3s.
  assert.deepEqual(onsets(n('0 1').elongate('<1 3>'), 0, 4), [[0, 0], [0.5, 1], [1, 0], [2.5, 1]]);
});

test('the lengths light up with the notes they hold', () => {
  const sig = n(mini('0 1', 100)).elongate(mini('2 1', 200));
  const first = sig.stepsForCycle(0)[0];
  assert.deepEqual(first.locs, [[100, 101], [200, 201]]);
});

test('a length changed as it plays is heard from the next step on, without a jump', () => {
  const { live, sig: lengths } = liveLengths('1 1 1 1');
  const sig = n('0 1 2 3').elongate(lengths);
  assert.deepEqual(scheduled(0, 1, () => onsets(sig, 0, 1)), [[0, 0], [0.25, 1], [0.5, 2], [0.75, 3]]);
  // At cycle 1, step 1 becomes four long. Counted from 0 with the new lengths, cycle 1 would be
  // well into the second pass; instead the line carries on from 0 and holds the 1.
  live.text = '1 4 1 1';
  assert.deepEqual(scheduled(1, 2, () => onsets(sig, 1, 3)), [[1, 0], [1.25, 1], [2.25, 2], [2.5, 3], [2.75, 0]]);
  // What was sent stays: cycle 0 still reads as it played.
  assert.deepEqual(onsets(sig, 0, 1), [[0, 0], [0.25, 1], [0.5, 2], [0.75, 3]]);
});

test('the step sounding when a length changes keeps the length it started with', () => {
  const { live, sig: lengths } = liveLengths('1 4');
  const sig = n('0 1').elongate(lengths);
  scheduled(0, 1, () => sig.stepsForCycle(0));
  // The 1 started at 0.5 to ring two cycles; shortening it now does not cut it.
  live.text = '1 1';
  assert.deepEqual(scheduled(1, 2, () => onsets(sig, 1, 4)), [[2.5, 0], [3, 1], [3.5, 0]]);
});

test('reads that are not the scheduler never move the line', () => {
  const { live, sig: lengths } = liveLengths('1 1');
  const sig = n('0 1').elongate(lengths);
  scheduled(0, 1, () => sig.stepsForCycle(0));
  assert.deepEqual(onsets(sig, 1, 2), [[1, 0], [1.5, 1]]);
  live.text = '3 1';
  assert.deepEqual(onsets(sig, 1, 2), [[1, 0], [1.5, 1]], 'a display read keeps what it had');
  assert.deepEqual(scheduled(1, 2, () => onsets(sig, 1, 3)), [[1, 0], [2.5, 1]], 'the scheduler takes the change');
});

test('playing from the start again plays the lengths as they are now', () => {
  const { live, sig: lengths } = liveLengths('1 1');
  const sig = n('0 1').elongate(lengths);
  scheduled(0, 1, () => sig.stepsForCycle(0));
  scheduled(1, 2, () => sig.stepsForCycle(1));
  live.text = '3 1';
  assert.deepEqual(scheduled(0, 1, () => onsets(sig, 0, 3)), [[0, 0], [1.5, 1], [2, 0]]);
});

test('the scheduler sends the line as it plays, a length changed mid-play heard from the next step', () => {
  const sent = [];
  const engine = {
    getTime: () => 0,
    createTrack() {}, loadInstrument() {}, loadEffect() {}, unloadEffect() {}, setParam() {},
    noteOn: (_t, nn, _v, at) => sent.push([r3(at), nn]),
    noteOff: () => {},
  };
  const { live, sig: lengths } = liveLengths('1 1 1 1');
  const sig = note('c3 d3 e3 f3').elongate(lengths);
  sig.instrument = 'X';
  sig.fxChain = [];
  sig.channel = {};
  const transport = new Transport(engine.getTime, { cps: 1, paused: true });
  transport.startAt(0, 0);
  const sch = new Scheduler(engine, { transport, trackId: 't', deck: 'a' });
  sch.setPattern(sig);
  const play = (from, to) => {
    for (let c = from; c < to - 1e-9; c += 0.05) sch._scheduleNoteEdges(c, c + 0.05, 0);
  };
  play(0, 1.3);
  live.text = '1 1 4 1'; // during d3, which started at 1.25: e3 is the next step to take it
  play(1.3, 3);
  assert.deepEqual(sent, [
    [0, 60], [0.25, 62], [0.5, 64], [0.75, 65],
    [1, 60], [1.25, 62], [1.5, 64], [2.5, 65],
    [2.75, 60],
  ]);
  transport.dispose();
});
