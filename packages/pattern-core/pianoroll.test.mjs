// The pianoroll() builder and its shared string format. The interactive editor (client.js) and
// the playable Sig both go through parse/serialize here, so these pin the format down and prove a
// drawn roll turns into the step grid the scheduler reads - onsets, durations, velocity,
// probability, polyphony, and the grid/len loop model (grid = cells per cycle, len = loop length in
// cells) - plus the multi-line `<len cells>*grid` mini-notation conversion.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePianoRoll,
  serializePianoRoll,
  pianoRollToMini,
  normalizePianoRollSteps,
  PIANOROLL_DEFAULT_STEPS,
} from './src/pianoroll.mjs';
import { pianoroll, note, mini } from './src/signal.mjs';

test('parsePianoRoll: fields, defaults, and empty input', () => {
  assert.deepEqual(parsePianoRoll(''), []);
  assert.deepEqual(parsePianoRoll('   '), []);
  assert.deepEqual(parsePianoRoll('60,0,4'), [{ midi: 60, start: 0, len: 4, vel: 1, prob: 1 }]);
  assert.deepEqual(parsePianoRoll('60,0,4,0.5'), [{ midi: 60, start: 0, len: 4, vel: 0.5, prob: 1 }]);
  assert.deepEqual(parsePianoRoll('60,0,4,0.5,0.25'), [{ midi: 60, start: 0, len: 4, vel: 0.5, prob: 0.25 }]);
});

test('parsePianoRoll: clamps out-of-range fields, rejects malformed tokens', () => {
  assert.deepEqual(parsePianoRoll('200,-3,0,9,9'), [{ midi: 127, start: 0, len: 1, vel: 1, prob: 1 }]);
  assert.throws(() => parsePianoRoll('60,0'), /bad note/);
  assert.throws(() => parsePianoRoll('60,0,4,0.5,0.5,7'), /bad note/);
  assert.throws(() => parsePianoRoll('c,0,4'), /non-numeric/);
});

test('serializePianoRoll: omits defaults, prob forces the vel slot, sorts, round-trips', () => {
  assert.equal(serializePianoRoll([{ midi: 60, start: 0, len: 4, vel: 1, prob: 1 }]), '60,0,4');
  assert.equal(serializePianoRoll([{ midi: 60, start: 0, len: 4, vel: 0.5, prob: 1 }]), '60,0,4,0.5');
  assert.equal(serializePianoRoll([{ midi: 60, start: 0, len: 4, vel: 1, prob: 0.3 }]), '60,0,4,1,0.3');
  const str = '60,0,4 64,0,4,0.5 67,8,8,1,0.3';
  assert.equal(serializePianoRoll(parsePianoRoll(str)), str);
});

test('normalizePianoRollSteps: default, rounding, and rejection', () => {
  assert.equal(normalizePianoRollSteps(undefined), PIANOROLL_DEFAULT_STEPS);
  assert.equal(normalizePianoRollSteps(32), 32);
  assert.equal(normalizePianoRollSteps(15.6), 16);
  assert.throws(() => normalizePianoRollSteps(0), /positive integer/);
  assert.throws(() => normalizePianoRollSteps(-4), /positive integer/);
});

test('pianoRollToMini: multi-line <len cells>*grid, clip lengths, chords', () => {
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,2 64,2,1'), { grid: 4, len: 4 }),
    '`<\n  60:2 ~ 64 ~\n>*4`.as("note:clip")',
  );
  // bare notes (no velocity, no length) use the clearer note(`…`) form
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,1 64,1,1 67,2,1'), { grid: 16, len: 3 }),
    'note(`<\n  60 64 67\n>*16`)',
  );
});

test('pianoRollToMini: velocity + probability fields', () => {
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,1,0.5 64,1,1,1,0.7'), { grid: 4, len: 2 }),
    '`<\n  60:0.5 64?0.3\n>*4`.as("note:vel")',
  );
});

// The whole point of the converter is that what it emits plays the same notes the editor did.
// Rebuild it the way the eval sandbox would (bare string -> mini(); note() -> note()) and compare
// the step grids across several cycles - this exercises the loop threading (len < grid here) and
// caught note() choking on ":vel" tokens. Probability is left out because the builder's rng and
// mini's `?` draw independently (both honor the odds, but not the same coin flips).
test('pianoroll(): playback matches its own mini-notation conversion', () => {
  const str = '60,0,2 64,2,1,0.5 67,5,3';
  const grid = 16;
  const len = 8;
  const pr = pianoroll(str, { grid, len });
  const expr = pianoRollToMini(parsePianoRoll(str), { grid, len });
  const asM = /^`([\s\S]*)`\.as\("([^"]*)"\)$/.exec(expr);
  const noteM = /^note\(`([\s\S]*)`\)$/.exec(expr);
  const rebuilt = asM ? mini(asM[1]).as(asM[2]) : note(noteM[1]);
  // Effective velocity the way the scheduler reads it (matching scheduler.mjs's _velAt): the step's
  // own merged vel wins (what the pianoroll builder bakes in), else the vel note channel (what .as()
  // sets) is sampled at the onset, else 1. Both paths must land on the same value for playback to match.
  const effVel = (sig, s, cycle) => {
    if (typeof s.vel === 'number' && !Number.isNaN(s.vel)) return s.vel;
    const ch = sig.noteChannels?.vel;
    if (ch) {
      const v = ch.sample(cycle + s.start, 1, cycle + s.start);
      if (typeof v === 'number' && !Number.isNaN(v)) return v;
    }
    return 1;
  };
  const norm = (sig, cycle) =>
    sig
      .stepsForCycle(cycle)
      .map((s) => ({ s: +s.start.toFixed(4), e: +s.end.toFixed(4), v: s.value, vel: effVel(sig, s, cycle) }))
      .sort((a, b) => a.s - b.s || a.v - b.v);
  for (const c of [0, 1, 2, 3]) assert.deepEqual(norm(pr, c), norm(rebuilt, c));
});

test('pianoroll(): builds a step grid with fractional onsets, durations, and velocity', () => {
  const steps = pianoroll('60,0,4 64,0,4,0.5 67,8,8', { grid: 16, len: 16 }).stepsForCycle(0);
  assert.deepEqual(
    steps.map((s) => ({ start: s.start, end: s.end, value: s.value, vel: s.vel })),
    [
      { start: 0, end: 0.25, value: 60, vel: 1 },
      { start: 0, end: 0.25, value: 64, vel: 0.5 },
      { start: 0.5, end: 1, value: 67, vel: 1 },
    ],
  );
});

test('pianoroll(): len shorter than grid loops within the cycle', () => {
  const steps0 = pianoroll('60,0,1 64,1,1 67,2,1', { grid: 16, len: 3 }).stepsForCycle(0);
  assert.equal(steps0.length, 16); // 16 onsets in one cycle at a 1/16 grid
  assert.deepEqual(steps0.slice(0, 6).map((s) => s.value), [60, 64, 67, 60, 64, 67]);
  assert.ok(steps0.every((s) => +(s.end - s.start).toFixed(4) === +(1 / 16).toFixed(4)));
  // the loop threads across the bar: cell 16 = loop cell 16 % 3 = 1 -> 64 opens cycle 1
  assert.equal(pianoroll('60,0,1 64,1,1 67,2,1', { grid: 16, len: 3 }).stepsForCycle(1)[0].value, 64);
});

test('pianoroll(): overlapping notes stay distinct steps (polyphony)', () => {
  const steps = pianoroll('60,0,4 64,0,4 67,0,4', { grid: 16, len: 16 }).stepsForCycle(0);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.value).sort((a, b) => a - b), [60, 64, 67]);
  assert.ok(steps.every((s) => s.start === 0 && s.end === 0.25));
});

test('pianoroll(): probability gates a note deterministically per cycle', () => {
  const never = pianoroll('60,0,4,1,0', { grid: 16, len: 16 }); // prob 0 - dropped every cycle
  for (const c of [0, 1, 2, 7, 100]) assert.equal(never.stepsForCycle(c).length, 0);
  const always = pianoroll('60,0,4,1,1', { grid: 16, len: 16 }); // prob 1 - always plays
  for (const c of [0, 1, 2, 7, 100]) assert.equal(always.stepsForCycle(c).length, 1);
  const half = pianoroll('60,0,4,1,0.5', { grid: 16, len: 16 });
  assert.equal(half.stepsForCycle(3).length, half.stepsForCycle(3).length); // stable per cycle
});

test('pianoroll(): a note running past the last cell rings on past the cycle (end > 1)', () => {
  const steps = pianoroll('60,12,8', { grid: 16, len: 16 }).stepsForCycle(0);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].start, 0.75);
  assert.equal(steps[0].end, 1.25); // 12/16 + 8/16
});

test('pianoroll(): grid as a bare-number shorthand, len defaults to a full cycle', () => {
  assert.deepEqual(pianoroll('60,0,4', 8).stepsForCycle(0), pianoroll('60,0,4', { grid: 8, len: 8 }).stepsForCycle(0));
  assert.equal(pianoroll('60,0,4', 8).stepsForCycle(0)[0].end, 0.5); // 4 / 8
});

test('pianoroll(): holds absolute notes - chains with arithmetic and scale', () => {
  const p = pianoroll('60,0,4', { grid: 16, len: 16 });
  assert.equal(p.pitchKind, 'note');
  assert.equal(p.add(12).stepsForCycle(0)[0].value, 72);
  assert.equal(p.scale('C major').stepsForCycle(0)[0].value, 60);
});

test('pianoroll(): a phase inside a cell samples that cell continuously', () => {
  const p = pianoroll('60,0,4', { grid: 16, len: 16 });
  assert.equal(p.sample(0.1, 1, 0.1), 60); // phase 0.1 lands inside the note (0..0.25)
  assert.equal(p.sample(0.5, 1, 0.5), null); // past its end - a rest
});

test('pianoroll(): rejects a non-string first argument', () => {
  assert.throws(() => pianoroll(123), /takes a note string/);
  assert.throws(() => pianoroll(null), /takes a note string/);
});
