// The Looper: a press of Record records the next pass on the Length grid, start and end alike.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues } from './src/descriptor.mjs';
import { LOOPER, LOOPER_CHUNK, LOOPER_LENGTHS, LooperProcessor } from './src/devices/looper.mjs';

const SR = 8000;
const BLOCK = 128;
const BAR = 2 * SR;   // one bar at 120 bpm
/** Past the loop's start by this, a loop is the take alone: the seam's crossfade (10 ms) is over. */
const CLEAR = Math.round(0.02 * SR);
/** The seam's crossfade, in samples. */
const SEAM = Math.round(0.01 * SR);

/** A deterministic noise, so every sample of the input can be told from every other. */
function noise(length, seed = 22222) {
  let x = seed;
  return Float32Array.from({ length }, () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296 - 0.5;
  });
}

/**
 * Runs the looper over `input`. `record` and `clear` are functions of the sample index, handed
 * over per sample as a patched control would be; `timeAt` is where the transport is at a block's
 * first sample, in seconds.
 *
 * Any other parameter may be a number or a function of the sample index. Mix left out - and then it is worked out
 * sample by sample: 0 while the looper records, so a take is the input as it is, and 1
 * otherwise, so what comes out is the loop alone - which is what most of these tests compare
 * against.
 */
function run(input, { record = () => 0, clear = () => 0, timeAt = (at) => at / SR, bpm = 120, fx = null, ...params } = {}) {
  const looper = fx ?? new LooperProcessor(SR);
  looper.setTempo(bpm, 0);
  const auto = !('mix' in params);
  const full = { ...defaultValues(LOOPER), ...params };
  const out = new Float32Array(input.length);
  const block = auto ? 1 : BLOCK;
  for (let at = 0; at < input.length; at += block) {
    const n = Math.min(block, input.length - at);
    const l = input.subarray(at, at + n);
    full.record = Float32Array.from({ length: n }, (_, i) => record(at + i));
    full.clear = Float32Array.from({ length: n }, (_, i) => clear(at + i));
    for (const [id, v] of Object.entries(params)) {
      if (typeof v === 'function') full[id] = Float32Array.from({ length: n }, (_, i) => v(at + i));
    }
    if (auto) full.mix = looper.taking || looper.state ? 0 : 1;
    looper.process([l, l], [out.subarray(at, at + n)], n, full, null, timeAt(at));
  }
  return { out, looper };
}

const between = (from, to) => (i) => (i >= from && i < to ? 1 : 0);

function assertNear(got, want, what, tol = 1e-6) {
  assert.ok(Math.abs(got - want) < tol, `${what}: ${got} is not ${want}`);
}

test('a short press mid-bar records the next bar, from its line to the next', () => {
  const input = noise(5 * BAR);
  // Pressed for 100 samples a third of the way into bar 0: bar 1 is the take.
  const press = Math.round(BAR / 3);
  const { out, looper } = run(input, { record: between(press, press + 100) });
  assert.equal(looper.length, BAR);
  assert.equal(looper.origin, 4);
  assert.equal(looper.loopBeats, 4);
  for (let k = CLEAR; k < BAR - 64; k += 3) {
    assertNear(out[2 * BAR + k], input[BAR + k], `the loop, sample ${k}`);
    assertNear(out[4 * BAR + k], input[BAR + k], `two passes on, sample ${k}`);
  }
});

test('letting go mid-pass does not end it: a recording ends on a line, wherever the release was', () => {
  for (const release of [0.07, 0.31, 0.5, 0.93]) {
    const input = noise(5 * BAR);
    // Held from mid bar 0 to `release` of the way into bar 1: still exactly bar 1.
    const { out, looper } = run(input, { record: between(BAR / 2, BAR + Math.round(release * BAR)) });
    assert.equal(looper.length, BAR, `released ${release} into the pass`);
    for (let k = CLEAR; k < BAR - 64; k += 11) assertNear(out[3 * BAR + k], input[BAR + k], `released ${release} in, sample ${k}`);
  }
});

test('an overdub runs from a line to a line too, however short the press', () => {
  const a = noise(BAR, 1);
  const b = noise(BAR, 2);
  const input = new Float32Array(6 * BAR);
  input.set(a, BAR);
  input.set(b, 3 * BAR);
  // A take of bar 1; a short press in bar 2 overdubs exactly bar 3, at Mix 0.5.
  const record = (i) => ((i >= 0.4 * BAR && i < 0.4 * BAR + 50) || (i >= 2.6 * BAR && i < 2.6 * BAR + 50) ? 1 : 0);
  const fx = new LooperProcessor(SR);
  const { out } = run(input, { fx, record, mix: (i) => (i < 2 * BAR ? (i >= BAR ? 0 : 1) : i >= 3 * BAR && i < 4 * BAR ? 0.5 : 1) });
  for (let k = 128; k < BAR - 128; k += 7) {
    assertNear(out[2 * BAR + k], a[k], `bar 2 is the take alone, sample ${k}`, 1e-5);
    assertNear(out[5 * BAR + k], 0.5 * a[k] + 0.5 * b[k], `after the overdub, half and half, sample ${k}`, 1e-5);
  }
});

test('held through a line, the next pass records too', () => {
  const input = noise(6 * BAR);
  // Held from mid bar 0 to mid bar 2: the take is bar 1, and bar 2 overdubs; bar 3 does not.
  const fx = new LooperProcessor(SR);
  const statuses = [];
  run(input.subarray(0, 4 * BAR), {
    fx, record: between(BAR / 2, 2.5 * BAR),
    mix: (i) => {
      if (i % (BAR / 4) === 0) statuses.push(fx.report().loop.status);
      return 0;
    },
  });
  // Read at the top of each block, before the block's own samples: one step behind the bar.
  assert.deepEqual(statuses, [
    'empty', 'empty', 'empty', 'armed',
    'armed', 'recording', 'recording', 'recording',
    'recording', 'overdub', 'overdub', 'overdub',
    'overdub', 'playing', 'playing', 'playing',
  ]);
});

test('a press within 30 ms after a line counts as on it; a later one waits for the next', () => {
  const input = noise(6 * BAR);
  // 20 ms late: the pass is bar 1. The 20 ms that went by before the press are where the take's
  // run-on goes: what played after it, crossfading into the take where the take starts.
  const late = Math.round(0.02 * SR);
  const { out, looper } = run(input, { record: between(BAR + late, BAR + late + 30) });
  assert.equal(looper.origin, 4);
  assert.equal(looper.length, BAR);
  for (let k = 0; k < late; k++) assertNear(out[3 * BAR + k], input[2 * BAR + k], `the run-on, sample ${k}`);
  for (let k = late + SEAM; k < BAR - 64; k++) assertNear(out[3 * BAR + k], input[BAR + k], `loop sample ${k}`);
  // 50 ms late: it waits for bar 2.
  const slow = Math.round(0.05 * SR);
  const second = run(input, { record: between(BAR + slow, BAR + slow + 30) });
  assert.equal(second.looper.origin, 8);
});

test('Length is the pass: two bars is two bars, from a two-bar line', () => {
  const input = noise(8 * BAR);
  const two = LOOPER_LENGTHS.indexOf('2 bars');
  // Pressed in bar 0: the next two-bar line is bar 2, and the take is bars 2 and 3.
  const { out, looper } = run(input, { record: between(BAR / 2, BAR / 2 + 30), length: two });
  assert.equal(looper.origin, 8);
  assert.equal(looper.loopBeats, 8);
  assert.equal(looper.length, 2 * BAR);
  for (let k = CLEAR; k < 2 * BAR - 64; k += 5) assertNear(out[4 * BAR + k], input[2 * BAR + k], `loop sample ${k}`);
});

test('a loop keeps its length when Length changes; Length is for the next first take', () => {
  const input = noise(8 * BAR);
  const { looper } = run(input, {
    record: (i) => ((i >= 10 && i < 40) || (i >= 3.5 * BAR && i < 3.5 * BAR + 30) ? 1 : 0),
    length: 0,
  });
  assert.equal(looper.length, BAR);
  const fx = looper;
  run(input.subarray(0, 4 * BAR), { fx, length: LOOPER_LENGTHS.indexOf('4 bars'), timeAt: (at) => (8 * BAR + at) / SR });
  assert.equal(fx.length, BAR);
  assert.equal(fx.loopBeats, 4);
});

test('a take many chunks long', () => {
  const input = noise(70 * BAR);
  const { out, looper } = run(input, { record: between(10, 40), length: LOOPER_LENGTHS.indexOf('32 bars') });
  assert.equal(looper.length, 32 * BAR);
  assert.ok(32 * BAR > 3 * LOOPER_CHUNK);
  // Pressed 10 samples after the first line: the take is bars 0 to 31.
  for (let k = CLEAR; k < 32 * BAR - 64; k += 997) {
    assertNear(out[32 * BAR + k], input[k], `first pass, sample ${k}`);
    if (k < 6 * BAR) assertNear(out[64 * BAR + k], input[k], `second pass, sample ${k}`);
  }
});

test('a locked loop stays on the bar when the transport jumps', () => {
  const input = noise(8 * BAR);
  const jump = 0.37 * 2;
  const { out } = run(input, { record: between(0, 30), timeAt: (at) => (at >= 3 * BAR ? at / SR + jump : at / SR) });
  for (let i = 3 * BAR + BLOCK; i < 5 * BAR; i += 97) {
    const k = Math.floor(((i / SR + jump) * SR) % BAR);
    const frac = ((i / SR + jump) * SR) % BAR - k;
    if (k < 64 || k > BAR - 65) continue;
    assertNear(out[i], input[k] + (input[k + 1] - input[k]) * frac, `sample ${i}`, 1e-5);
  }
});

test('with nothing recording, Mix only sets what is heard: the loop is never touched', () => {
  const input = noise(6 * BAR);
  const sweep = (i) => (i < BAR ? 0 : i < 4 * BAR ? Math.abs(((i - BAR) / (1.5 * BAR)) - 1) : 1);
  const { out } = run(input, { record: between(0, 30), mix: sweep });
  for (let k = CLEAR; k < BAR - 64; k += 7) assertNear(out[5 * BAR + k], input[k], `still the take, sample ${k}`, 1e-5);
});

test('Mix crossfades input against loop, and sets how loud the input goes into a first take', () => {
  const input = noise(4 * BAR, 6);
  const k = 2 * BAR + 1234;
  const at = (x) => run(input, { record: between(0, 30), mix: (i) => (i < BAR ? 0 : x) }).out;
  assertNear(at(0)[k], input[k], 'Mix 0 is the input alone');
  assertNear(at(1)[k], input[1234], 'Mix 1 is the loop alone');
  assertNear(at(0.5)[k], 0.5 * input[k] + 0.5 * input[1234], 'half and half in the middle');
  const quiet = run(input, { record: between(0, 30), mix: (i) => (i < BAR ? 0.75 : 1) }).out;
  assertNear(quiet[k], 0.25 * input[1234], 'the take at a quarter');
  assertNear(quiet[BAR / 2], 0.25 * input[BAR / 2], 'heard as it records');
});

test('clear empties the loop, and the next press is a new first take', () => {
  const input = noise(9 * BAR);
  const { out, looper } = run(input, {
    record: (i) => ((i >= 0 && i < 30) || (i >= 4.5 * BAR && i < 4.5 * BAR + 30) ? 1 : 0),
    clear: between(3 * BAR, 3 * BAR + 10),
    length: (i) => (i < 4 * BAR ? 0 : 1),
  });
  for (let i = 3 * BAR + 1; i < 4 * BAR; i++) assert.equal(out[i], 0, `cleared, sample ${i}`);
  // A new take at the new Length: bars 6 and 7.
  assert.equal(looper.length, 2 * BAR);
  assert.equal(looper.origin, 24);
});

test('speed and reverse move the playhead like tape, and never jump it', () => {
  const input = noise(6 * BAR);
  const turn = 2 * BAR + 333;
  const fx = new LooperProcessor(SR);
  run(input.subarray(0, turn), { fx, record: between(0, 30) });
  const params = { ...defaultValues(LOOPER), mix: 1, reverse: 1 };
  const two = new Float32Array(2);
  const live = input.subarray(turn, turn + 2);
  fx.process([live, live], [two], 2, params, null, turn / SR);
  assertNear(two[0], input[turn - 2 * BAR], 'where the loop had got to');
  assertNear(two[1], input[turn - 2 * BAR - 1], 'one sample back');
  const fast = run(input, { record: between(0, 30), speed: 2 }).out;
  // At double speed from the start, bar 1 reads the loop twice over.
  for (let j = 64; j < BAR / 2 - 64; j += 9) assertNear(fast[BAR + j], input[(2 * (BAR + j)) % BAR], `double speed, sample ${j}`, 1e-5);
});

test('the seam is a crossfade: the loop neither steps nor dips where it wraps', () => {
  const tone = Float32Array.from({ length: 6 * BAR }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 233.3 * i / SR));
  const toned = run(tone, { record: between(0, 30) }).out;
  const most = 2 * Math.PI * 233.3 / SR * 0.5 * 1.1;
  for (let i = 3 * BAR - 64; i < 3 * BAR + 2 * SEAM; i++) {
    assert.ok(Math.abs(toned[i] - toned[i - 1]) < most, `a step at ${i - 3 * BAR} from the seam`);
  }
  const input = noise(6 * BAR, 9);
  const { out } = run(input, { record: between(0, 30) });
  const rms = (from, to) => Math.sqrt(out.subarray(from, to).reduce((a, v) => a + v * v, 0) / (to - from));
  const whole = rms(2 * BAR + 500, 3 * BAR - 500);
  for (let at = 3 * BAR - 64; at < 3 * BAR + 2 * SEAM; at += 8) {
    assert.ok(rms(at - 24, at + 24) > 0.75 * whole, `the level dips at ${at - 3 * BAR} from the seam`);
  }
});

test('the report says what the loop is doing', () => {
  const input = noise(4 * BAR);
  const fx = new LooperProcessor(SR);
  assert.equal(fx.report().loop.status, 'empty');
  run(input.subarray(0, BAR / 2), { fx, record: between(100, 130) });
  assert.equal(fx.report().loop.status, 'recording');
  run(input.subarray(0, BAR / 4), { fx, timeAt: (at) => (BAR / 2 + at) / SR });
  assertNear(fx.report().loop.takenBeats, 3, 'three beats taken', 0.01);
  run(input.subarray(0, BAR), { fx, timeAt: (at) => (0.75 * BAR + at) / SR });
  const r = fx.report().loop;
  assert.equal(r.status, 'playing');
  assert.equal(r.beats, 4);
  assertNear(r.seconds, 2, 'a bar at 120', 1e-9);
});

test('a stop plays out the pass the loop is on, then the loop is quiet and kept', () => {
  const input = noise(8 * BAR);
  const silent = new Float32Array(8 * BAR);
  const fx = new LooperProcessor(SR);
  run(input.subarray(0, 2 * BAR + BAR / 4), { fx, record: between(0, 30) });
  fx.setRunning(false);
  const after = run(silent.subarray(0, 2 * BAR), { fx, timeAt: (at) => (2 * BAR + BAR / 4 + at) / SR }).out;
  for (let k = 0; k < 0.75 * BAR - 64; k += 11) assertNear(after[k], input[BAR / 4 + k], `the pass playing out, sample ${k}`);
  for (let k = 0.75 * BAR + 0.01 * SR; k < 2 * BAR; k++) assert.equal(after[k], 0, `quiet, sample ${k}`);
  assert.equal(fx.report().loop.status, 'stopped');
  fx.setRunning(true);
  const back = run(silent.subarray(0, BAR), { fx, timeAt: (at) => (4 * BAR + BAR / 4 + at) / SR }).out;
  for (let k = 0.01 * SR; k < 0.7 * BAR; k += 13) assertNear(back[k], input[BAR / 4 + k], `back on the bar, sample ${k}`);
});

test('a start at a time comes in on that sample, not when it was said', () => {
  const input = noise(4 * BAR);
  const silent = new Float32Array(4 * BAR);
  const fx = new LooperProcessor(SR);
  run(input.subarray(0, BAR), { fx, record: between(0, 30) });
  fx.setRunning(false);
  run(silent.subarray(0, 2 * BAR), { fx, timeAt: (at) => (BAR + at) / SR });
  fx.setRunning(true, 3.5 * BAR / SR);
  const out = run(silent.subarray(0, BAR), { fx, timeAt: (at) => (3 * BAR + at) / SR }).out;
  for (let k = 0; k < BAR / 2; k++) assert.equal(out[k], 0, `still quiet, sample ${k}`);
  assert.ok(out.subarray(BAR / 2 + 0.01 * SR).some((v) => Math.abs(v) > 0.01), 'playing from three and a half bars');
});

test('Record is a button, and neither it nor Clear reaches a saved state', () => {
  const record = LOOPER.params.find((p) => p.id === 'record');
  assert.equal(record.ui, 'button');
  assert.equal(record.saved, false);
  assert.equal(LOOPER.params.find((p) => p.id === 'clear').saved, false);
  assert.ok(!LOOPER.params.some((p) => p.id === 'quantize'));
});
