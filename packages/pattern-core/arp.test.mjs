// .arp() - chords (notes sharing a span) read as a ladder of simultaneous tones, sequenced by an
// index pattern, wrapping by octaves past either end. The index pattern runs at its OWN rate and
// mixes its triggers with the chord's - it is not squeezed into each chord - so a pass per chord is
// spelled by writing one ("0 1 0 1", "[0 1]*2"). Pure pattern math, no scheduler/engine boot (see
// the package's testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, s, sine, irand, pianoroll, resetRandomSeeds } from './src/signal.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);

// This cycle's arpeggiated onsets, in time order.
function onsets(sig, cycle = 0) {
  return sig
    .stepsForCycle(cycle)
    .filter((st) => st.value != null && !st.cont)
    .sort((a, b) => a.start - b.start);
}

const values = (sig, cycle = 0) => onsets(sig, cycle).map((st) => st.value);

// c3 = 36 under this package's c5 = 60 convention.
const C3 = 36, E3 = 40, G3 = 43, F3 = 41, A3 = 45, C4 = 48;

test('arp: indices pick chord tones low to high, wrapping up an octave past the top', () => {
  const sig = note('[c3,e3,g3]').arp('0 1 2 3');
  assert.deepEqual(values(sig), [C3, E3, G3, C3 + 12]);
  const starts = onsets(sig).map((st) => st.start);
  [0, 0.25, 0.5, 0.75].forEach((want, i) => close(starts[i], want));
  // Each index gets a quarter of the chord's span, back to back.
  onsets(sig).forEach((st, i) => close(st.end, (i + 1) / 4));
});

test('arp: the ladder keeps climbing - 4 and 5 are the second and third tones an octave up', () => {
  assert.deepEqual(values(note('[c3,e3,g3]').arp('3 4 5 6')), [C3 + 12, E3 + 12, G3 + 12, C3 + 24]);
});

test('arp: negative indices wrap off the top, an octave down', () => {
  // -1 is the top tone (g3) down an octave, -2 the one below it, -3 the whole chord down an octave.
  assert.deepEqual(values(note('[c3,e3,g3]').arp('-1 -2 -3 -4')), [G3 - 12, E3 - 12, C3 - 12, G3 - 24]);
});

test('arp: the chord is sorted by pitch, whatever order it was written in', () => {
  assert.deepEqual(values(note('[g3,c3,e3]').arp('0 1 2')), [C3, E3, G3]);
});

test('arp: the index pattern is not squeezed into the chord - it keeps its own rate', () => {
  // "0 1" is halves of a cycle, so it picks the low note of the first chord and the middle note of
  // the second: two notes, not a full pass crammed into each chord.
  const sig = note('[c3,e3,g3] [f3,a3,c4]').arp('0 1');
  assert.deepEqual(values(sig), [C3, A3]);
  const starts = onsets(sig).map((st) => st.start);
  [0, 0.5].forEach((want, i) => close(starts[i], want));
});

test('arp: a pass per chord is spelled by writing one', () => {
  const sig = note('[c3,e3,g3] [f3,a3,c4]').arp('0 1 0 1');
  assert.deepEqual(values(sig), [C3, E3, F3, A3]);
  const starts = onsets(sig).map((st) => st.start);
  [0, 0.25, 0.5, 0.75].forEach((want, i) => close(starts[i], want));
});

test('arp: a lone note is a one-note chord - every index is an octave transposition', () => {
  assert.deepEqual(values(note('c3').arp('0 1 2 -1')), [C3, C3 + 12, C3 + 24, C3 - 12]);
  // ...and a two-note melody arps each of its notes separately (they share no span): at the index
  // pattern's own rate that is one index per note, or two apiece written as "0 1 0 1".
  assert.deepEqual(values(note('c3 e3').arp('0 1')), [C3, E3 + 12]);
  assert.deepEqual(values(note('c3 e3').arp('0 1 0 1')), [C3, C3 + 12, E3, E3 + 12]);
});

test('arp: a rest in the index pattern leaves a gap', () => {
  const sig = note('[c3,e3,g3]').arp('0 ~ 2 ~');
  assert.deepEqual(values(sig), [C3, G3]);
  const starts = onsets(sig).map((st) => st.start);
  [0, 0.5].forEach((want, i) => close(starts[i], want));
});

test('arp: a tie in the index pattern holds instead of retriggering', () => {
  const sig = note('[c3,e3,g3]').arp('0 _ 2');
  // Two notes, not three: the tied slot extends the first one instead of striking again.
  assert.deepEqual(values(sig), [C3, G3]);
  assert.equal(sig.stepsForCycle(0).length, 2);
  close(onsets(sig)[0].end, 2 / 3);
});

test('arp: an alternation in the index pattern advances per cycle, as everywhere else', () => {
  // One pick per cycle - it does not advance chord by chord (that was the squeezed reading). Each
  // chord under it retriggers the pick, because a chord change is a trigger of its own.
  const twoChords = note('[c3,e3,g3] [c3,e3,g3]').arp('<0 1>');
  assert.deepEqual(values(twoChords, 0), [C3, C3]);
  assert.deepEqual(values(twoChords, 1), [E3, E3]);
  const wholeCycle = note('[c3,e3,g3]').arp('<0 1>');
  assert.deepEqual(values(wholeCycle, 0), [C3]);
  assert.deepEqual(values(wholeCycle, 1), [E3]);
});

test('arp: a chord held across cycles re-arpeggiates in each, with fresh onsets', () => {
  const sig = note('<[c3,e3,g3]@2>').arp('0 1 2');
  assert.deepEqual(values(sig, 0), [C3, E3, G3]);
  assert.deepEqual(values(sig, 1), [C3, E3, G3]);
  // The held tail's `cont` doesn't survive - each arp note is its own attack.
  assert.equal(sig.stepsForCycle(1).some((st) => st.cont), false);
});

// The notes of a drawn chord rarely have identical lengths (pianoroll carries length as `clip`, so
// each note's step ends where it stops ringing). Reading those as separate one-note chords used to
// run a full pass of the index pattern per note - three arpeggios at once, three highlights.
test('arp: a chord of unequal-length notes is ONE chord, not overlapping arpeggios', () => {
  const ragged = pianoroll('60,0,4 64,0,3 67,0,6', { grid: 16, len: 16 });
  const sig = ragged.arp('0 1 2 3');
  // One ladder, read at the index pattern's own rate: the chord rings until its longest note dies
  // (the 6-cell note = 0.375 of a cycle), which covers the first two index steps. Three separate
  // one-note chords would instead sound three notes at once here.
  assert.deepEqual(values(sig), [60, 64]);
  // Monophonic: no two steps overlap in time.
  const steps = onsets(sig);
  steps.forEach((st, i) => i && assert.ok(st.start >= steps[i - 1].end - 1e-9, 'arp notes overlap'));
  close(steps[0].start, 0);
  close(steps[steps.length - 1].end, 0.375); // the arpeggio stops when the chord does
});

test('arp: an equal-length pianoroll chord arps exactly as a stack does', () => {
  const roll = pianoroll('60,0,4 64,0,4 67,0,4', { grid: 16, len: 16 });
  // A 4-cell chord rings a quarter of a cycle, so a 16th-note index fits four notes inside it.
  const steps = onsets(roll.arp('[0 1 2 3]*4'));
  assert.deepEqual(steps.map((st) => st.value), [60, 64, 67, 72]);
  [0, 0.0625, 0.125, 0.1875].forEach((want, i) => close(steps[i].start, want));
});

test('arp: a note joining a held one re-reads the chord at that onset', () => {
  // A pedal c3 rings the whole cycle; e3 and g3 join halfway.
  const sig = note('[c3, ~ e3, ~ g3]').arp('[0 1]*2');
  const steps = onsets(sig);
  // First half: c3 alone (index 1 = its octave). Second half: the full triad is sounding.
  assert.deepEqual(steps.map((st) => st.value), [C3, C3 + 12, C3, E3]);
  [0, 0.25, 0.5, 0.75].forEach((want, i) => close(steps[i].start, want));
  steps.forEach((st, i) => i && assert.ok(st.start >= steps[i - 1].end - 1e-9, 'arp notes overlap'));
});

test('arp: the pass stops when the chord does, leaving the rest of the span silent', () => {
  // c3 rings for the first quarter of the cycle only - the arpeggio fits there, it doesn't
  // stretch over the silence that follows.
  const steps = onsets(note('c3@1 ~@3').arp('[0 1]*4'));
  assert.deepEqual(steps.map((st) => st.value), [C3, C3 + 12]);
  [0, 0.125].forEach((want, i) => close(steps[i].start, want));
  close(steps[1].end, 0.25);
});

test('arp: a chord ringing past the cycle line is not double-scheduled', () => {
  // The held chord's steps report end = 2 in cycle 0; the pass must stay inside the cycle, since
  // cycle 1 re-arpeggiates the `cont` tail.
  const sig = note('<[c3,e3,g3]@2>').arp('0 1 2');
  sig.stepsForCycle(0).forEach((st) => assert.ok(st.end <= 1 + 1e-9, `step ends at ${st.end}, past the cycle`));
  assert.equal(onsets(sig, 0).length, 3);
  assert.equal(onsets(sig, 1).length, 3);
});

test('arp: a signal with no grid gives one chord tone per chord', () => {
  // A plain number: index 1 = the middle tone, held for the whole chord.
  const sig = note('[c3,e3,g3] [f3,a3,c4]').arp(1);
  assert.deepEqual(values(sig), [E3, A3]);
  close(onsets(sig)[0].end, 0.5);
  // irand() draws per chord (it varies within the cycle, so it's read at each onset, not gridded).
  resetRandomSeeds();
  const rand = note('[c3,e3,g3] [c3,e3,g3]').arp(irand(3));
  const drawn = values(rand);
  assert.equal(drawn.length, 2);
  drawn.forEach((v) => assert.ok([C3, E3, G3].includes(v), `${v} is not a chord tone`));
});

test('arp: degrees arpeggiate as MIDI once .scale() has resolved them', () => {
  assert.deepEqual(values(n('[0,2,4]').scale('C major').arp('0 1 2 3')), [60, 64, 67, 72]);
});

test('arp: chord tones keep their own step data (velocity rides along)', () => {
  const sig = note('[c3,e3,g3]').vel('0.4').arp('0 1 2');
  onsets(sig).forEach((st) => assert.equal(st.vel, 0.4));
});

test('arp: highlight spans cover both the chord tone and the index that chose it', () => {
  const sig = note('[c3,e3,g3]').arp('0 1 2');
  const [first] = onsets(sig);
  // "c3" at chars 1..3 of the chord string, "0" at char 0 of the index string.
  assert.deepEqual(first.locs, [[1, 3], [0, 1]]);
});

test('arp: track metadata carries through', () => {
  const sig = note('[c3,e3,g3]').synth('Vital').gain(0.5).arp('0 1 2');
  assert.equal(sig.instrument, 'Vital');
  assert.ok(sig.channel.gain);
  assert.equal(sig.pitchKind, 'note');
});

test('arp: sample() agrees with the arpeggiated grid', () => {
  const sig = note('[c3,e3,g3]').arp('0 1 2 3');
  [[0.1, C3], [0.3, E3], [0.6, G3], [0.9, C3 + 12]].forEach(([pos, want]) => {
    assert.equal(sig.sample(pos, 1, pos), want);
  });
});

test('arp: needs a step pattern, and comes before .s()', () => {
  assert.throws(() => sine(1).arp('0 1'), /needs a step pattern/);
  assert.throws(() => s('pluck').arp('0 1'), /before \.s\(\)/);
  // The suggested order works: the arpeggio becomes the sampler's repitch line.
  const sig = note('[c3,e3,g3]').arp('0 1 2').s('pluck');
  assert.deepEqual(values(sig.sampler.note), [C3, E3, G3]);
});
