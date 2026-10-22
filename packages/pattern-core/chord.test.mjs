// .chord() / .inv() / .voicing() / .spread() / .lead() - building chords on a pattern's notes and
// re-voicing them. Pure pattern math, no scheduler/engine boot (see the package's testing notes).
// Arguments go in as mini("...", 0), the way the editor hands them over.
//
// NOTE: the global scale is module state; the one test that needs it unset runs first.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, mini, s, setPatternWarn } from './src/signal.mjs';
import { setGlobalScale } from './src/notes.mjs';
import { invertVoices } from './src/harmony.mjs';

// This cycle's chords: [start, [pitches low to high]] per onset.
function chords(sig, cycle = 0) {
  const by = new Map();
  for (const st of sig.stepsForCycle(cycle)) {
    if (st.value == null) continue;
    const key = Math.round(st.start * 1e6) / 1e6;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(st.value);
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([start, vs]) => [start, vs.sort((a, b) => a - b)]);
}
const firstChord = (sig, cycle = 0) => chords(sig, cycle)[0][1];

function warnings(fn) {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  try {
    return { result: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
}

test('chord(7) with no key anywhere warns once and builds in the default key', () => {
  const { result, lines } = warnings(() => note('c3').chord(mini('7', 0)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\.chord\(\) with a number/);
  assert.deepEqual(firstChord(result), [60, 64, 67, 71]);
});

test('chord: a quality builds on every note, the note as root', () => {
  setGlobalScale('c3 major');
  assert.deepEqual(chords(note('c3 a2').chord(mini('m9', 0))), [
    [0, [60, 62, 63, 67, 70]],
    [0.5, [57, 59, 60, 64, 67]],
  ]);
  assert.deepEqual(firstChord(note('c3').chord(mini('dom7', 0))), [60, 64, 67, 70]);
});

test('chord: a number stacks the key - sevenths on I ii V in C major', () => {
  setGlobalScale('c3 major');
  assert.deepEqual(chords(n('0 1 4').sc().chord(mini('7', 0))).map(([, c]) => c), [
    [60, 64, 67, 71], // Cmaj7
    [62, 65, 69, 72], // Dm7
    [67, 71, 74, 77], // G7
  ]);
});

test('chord: no argument is the triad; on degrees it adds degrees for a later .sc()', () => {
  setGlobalScale('c3 major');
  assert.deepEqual(chords(n('0 1').chord().sc()).map(([, c]) => c), [[60, 64, 67], [62, 65, 69]]);
});

test("chord: a number follows the pattern's own .scale() over setscale()", () => {
  setGlobalScale('c3 major');
  assert.deepEqual(firstChord(n('0').scale('a2 minor').chord(mini('7', 0))), [57, 60, 64, 67]);
});

test('chord: patterned per onset, a rest plays the root alone', () => {
  const sig = note('c3').chord(mini('<m maj7 ~>', 0));
  assert.deepEqual(firstChord(sig, 0), [60, 63, 67]);
  assert.deepEqual(firstChord(sig, 1), [60, 64, 67, 71]);
  assert.deepEqual(firstChord(sig, 2), [60]);
});

test('chord: chord tones light the root and the quality that built them', () => {
  const steps = note(mini('c3', 0)).chord(mini('m7', 10)).stepsForCycle(0);
  assert.equal(steps.length, 4);
  for (const st of steps) assert.deepEqual(st.locs, [[0, 2], [10, 12]]);
});

test('chord: an unknown name warns and plays the triad in key', () => {
  setGlobalScale('c3 major');
  const { result, lines } = warnings(() => note('c3').chord(mini('m99', 0)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"m99"\) is not a chord/);
  assert.deepEqual(firstChord(result), [60, 64, 67]);
});

test('chord: a quality on scale degrees warns and stacks the key instead', () => {
  const { result, lines } = warnings(() => n('0').chord(mini('m7', 0)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /scale degrees/);
  assert.deepEqual(firstChord(result), [0, 2, 4]);
});

test('chord methods on a sampler pattern warn and keep playing', () => {
  const { result, lines } = warnings(() => s('pluck').n('0 2').chord(mini('m7', 0)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /before \.s\(\)/);
  assert.ok(result.sampler);
});

test('inv: inverts in place, patterned per chord', () => {
  const sig = note('[c3,e3,g3]').inv(mini('<0 1 2 -1>', 0));
  assert.deepEqual(firstChord(sig, 0), [60, 64, 67]);
  assert.deepEqual(firstChord(sig, 1), [64, 67, 72]);
  assert.deepEqual(firstChord(sig, 2), [55, 60, 64]);
  assert.deepEqual(firstChord(sig, 3), [55, 60, 64]);
});

test('inv: on scale degrees warns and leaves the pattern alone', () => {
  const { result, lines } = warnings(() => n('[0,2,4]').inv(mini('1', 0)));
  assert.equal(lines.length, 1);
  assert.deepEqual(firstChord(result), [0, 2, 4]);
});

test('voicing: drop2, and an inversion of it is still a drop2', () => {
  const dropped = note('[c3,e3,g3,b3]').voicing(mini('drop2', 0));
  assert.deepEqual(firstChord(dropped), [55, 60, 64, 71]);
  assert.deepEqual(firstChord(dropped.inv(mini('1', 0))), [59, 64, 67, 72]);
});

test('voicing: an unknown name warns and leaves the chords as written', () => {
  const { result, lines } = warnings(() => note('[c3,e3,g3]').voicing(mini('wide', 0)));
  assert.equal(lines.length, 1);
  assert.deepEqual(firstChord(result), [60, 64, 67]);
});

test('voicing: shell drops the 5th', () => {
  assert.deepEqual(firstChord(note('[c3,e3,g3,bb3]').voicing(mini('shell', 0))), [60, 64, 70]);
});

test('spread: widens by octaves from the middle', () => {
  assert.deepEqual(firstChord(note('[c3,e3,g3]').spread(mini('1', 0))), [48, 64, 79]);
});

test('voices keep their own lengths through a re-voicing', () => {
  // A drawn chord with ragged lengths: the voice that moves takes its own end with it.
  const ends = { 60: 1, 64: 0.5, 67: 0.25 };
  const base = note('[c3,e3,g3]');
  const ragged = base.stepsForCycle(0).map((st) => ({ ...st, end: ends[st.value] }));
  const sig = Object.assign(Object.create(Object.getPrototypeOf(base)), base, { stepsForCycle: () => ragged });
  const steps = sig.inv(mini('1', 0)).stepsForCycle(0);
  const endOf = (v) => steps.find((st) => st.value === v).end;
  assert.equal(endOf(72), 1); // c3 moved up an octave, kept its length
  assert.equal(endOf(64), 0.5);
  assert.equal(endOf(67), 0.25);
});

test('lead: a ii-V-I moves by steps, common tones held', () => {
  setGlobalScale('c3 major');
  const sig = n('<1 4 0>').sc().chord(mini('7', 0)).lead();
  const seq = [0, 1, 2].map((c) => firstChord(sig, c));
  for (let i = 1; i < seq.length; i++) {
    const moved = seq[i].reduce((sum, m, v) => sum + Math.abs(m - seq[i - 1][v]), 0);
    assert.ok(moved <= 4, `${seq[i - 1]} -> ${seq[i]} moved ${moved}`);
  }
});

test('lead: the same cycle asked twice, or out of order, plays the same chords', () => {
  const sig = note('<c3 a2 f2 g2>').chord(mini('maj7', 0)).lead();
  const later = firstChord(sig, 7);
  for (let c = 0; c < 7; c++) firstChord(sig, c);
  assert.deepEqual(firstChord(sig, 7), later);
});

test('lead: an anchor holds the chords near it', () => {
  const sig = note('<c3 f3 g3 c4>').chord(mini('maj', 0)).lead(mini('c5', 0));
  for (let c = 0; c < 4; c++) {
    const ch = firstChord(sig, c);
    const mean = ch.reduce((s, m) => s + m, 0) / ch.length;
    assert.ok(Math.abs(mean - 84) <= 6, `${ch} strays from c5`);
  }
});

test('lead then inv: inv offsets from the voicing lead chose', () => {
  const led = note('<c3 f3>').chord(mini('maj', 0)).lead();
  const [a, b, c] = firstChord(led, 1);
  assert.deepEqual(firstChord(led.inv(mini('1', 0)), 1), invertVoices([a, b, c], 1).sort((x, y) => x - y));
});

test('lead: single notes are left alone', () => {
  assert.deepEqual(chords(note('c3 g4').lead()).map(([, c]) => c), [[60], [79]]);
});
