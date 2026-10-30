// The Delay effect's feedback clip.
//
// What is fed back goes through a soft clip so a feedback near one saturates rather than running
// away. The clip has to be a clip: continuous, never turning back down as the level rises, and
// out of the way at ordinary levels. One that peaked above its own ceiling and then dropped to it
// put a step in the tail every time a repeat crossed the knee.

import test from 'node:test';
import assert from 'node:assert/strict';

import { clipTail, DelayProcessor } from './src/devices/delay.mjs';

test('the feedback clip rises without a step and never turns back down', () => {
  let last = clipTail(-4);
  for (let x = -4; x <= 4; x += 0.001) {
    const y = clipTail(x);
    assert.ok(y >= last - 1e-12, `the clip falls at ${x.toFixed(3)}: ${last} then ${y}`);
    assert.ok(y - last < 0.0011, `the clip jumps at ${x.toFixed(3)}: ${last} then ${y}`);
    assert.ok(Math.abs(y) <= 1, `the clip reaches ${y} at ${x.toFixed(3)}`);
    last = y;
  }
});

test('the feedback clip leaves ordinary levels alone', () => {
  // Unity slope at zero: a quiet repeat is fed back at the level it was.
  for (const x of [0.001, 0.01, -0.01, 0.1]) {
    assert.ok(Math.abs(clipTail(x) - x) / Math.abs(x) < 0.002, `${x} came back as ${clipTail(x)}`);
  }
  assert.equal(clipTail(0), 0);
  assert.equal(clipTail(10), 1);
  assert.equal(clipTail(-10), -1);
});

// ---- a chain in the feedback loop ----------------------------------------------------------------

const SR = 48000;
const BLOCK = 128;

/**
 * An impulse through a looped Delay whose loop is `chain` (one sample at a time) and comes back a
 * whole block late, as the engines bring it back - the Delay told the way round, `extra` samples
 * of the chain's own included. Returns both output channels.
 */
function loopRun({ time = 0.25, feedback = 0.5, pingpong = 0, extra = 0, chain = (x) => x, seconds = 1.1, told = null } = {}) {
  const d = new DelayProcessor(SR);
  const trip = BLOCK + extra;
  d.setLoop(told ?? trip / SR);
  const params = { sync: [0], time: [time], feedback: [feedback], tone: [20000], pingpong: [pingpong], spread: [0], mix: [1] };
  const frames = Math.ceil(SR * seconds / BLOCK) * BLOCK;
  const out = [new Float32Array(frames), new Float32Array(frames)];
  const sent = [new Float32Array(frames + trip), new Float32Array(frames + trip)];
  for (let at = 0; at < frames; at += BLOCK) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    if (at === 0) { inL[0] = 1; inR[0] = 1; }
    const o = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const send = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // What comes back now went out `trip` samples ago.
    const back = [0, 1].map((ch) => Float32Array.from({ length: BLOCK }, (_, i) => (at + i - trip >= 0 ? sent[ch][at + i - trip] : 0)));
    d.process([inL, inR], o, BLOCK, params, back, 0, [send]);
    for (let ch = 0; ch < 2; ch++) {
      out[ch].set(o[ch], at);
      for (let i = 0; i < BLOCK; i++) sent[ch][at + i] = chain(send[ch][i]);
    }
  }
  return out;
}

// Where the repeats are: each sample above the floor that is louder than both of its neighbors.
const peaksOf = (x, floor = 0.02) => [...x].flatMap((v, i) => (
  Math.abs(v) > floor && Math.abs(v) > Math.abs(x[i - 1] ?? 0) && Math.abs(v) >= Math.abs(x[i + 1] ?? 0) ? [i] : []));

test('with a chain in the loop every repeat lands on the grid: the way round is taken off the time', () => {
  for (const extra of [0, 2400]) {
    const [l] = loopRun({ extra });
    assert.deepEqual(peaksOf(l), [12000, 24000, 36000, 48000], `a way round of ${BLOCK + extra} samples`);
  }
});

test('the chain in the loop is heard on every repeat after the first', () => {
  const [l] = loopRun({ chain: (x) => -x });
  assert.ok(l[12000] > 0, 'the first repeat has not been round the loop');
  assert.ok(l[24000] < 0 && l[36000] > 0, 'each one after has, once more each time');
});

test('ping-pong bounces the repeats that come back between the sides', () => {
  const [l, r] = loopRun({ pingpong: 1 });
  assert.deepEqual(peaksOf(l), [12000, 36000]);
  assert.deepEqual(peaksOf(r), [24000, 48000]);
});

test('a time shorter than the way round is held at it', () => {
  const [l] = loopRun({ time: 0.001, extra: 4672, seconds: 0.5 });
  assert.deepEqual(peaksOf(l).slice(0, 3), [4800, 9600, 14400]);
});

test('without a loop the second output is silent and the return is not heard', () => {
  const d = new DelayProcessor(SR);
  const params = { sync: [0], time: [0.01], feedback: [0.5], tone: [8000], pingpong: [0], spread: [0], mix: [0.5] };
  const plain = new DelayProcessor(SR);
  const send = [new Float32Array(BLOCK).fill(9), new Float32Array(BLOCK).fill(9)];
  for (let b = 0; b < 8; b++) {
    const input = [0, 1].map(() => Float32Array.from({ length: BLOCK }, (_, i) => Math.sin(i + b)));
    const a = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const c = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    d.process(input, a, BLOCK, params, [new Float32Array(BLOCK).fill(1), new Float32Array(BLOCK).fill(1)], 0, [send]);
    plain.process(input, c, BLOCK, params);
    assert.deepEqual(a, c, 'the same as the plain delay, sample for sample');
    assert.ok(send.every((ch) => ch.every((v) => v === 0)));
  }
});
