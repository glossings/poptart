// harmony.mjs - chord analysis/naming, diatonic chords, and voicing transforms. Pure table math,
// nothing booted (see the package's testing notes). c3 = 60 throughout.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeChord, chordsForNote, chordVoicings, closeVoicing, diatonicChords, doubleBassOctave,
  centerVoicing, drop2, drop3, extendedChordsOnNote, invertChord, pcName, preferFlats, romanNumeral,
  shellVoicing, spreadVoicing, chordIntervals, chordExtension, rotateVoices, invertVoices, spreadVoices,
  voicingVoices, leadVoices,
} from './src/harmony.mjs';

const C3 = 60, E3 = 64, G3 = 67, A3 = 69, B3 = 71;

// ---------------------------------------------------------------------------------------------
// analyzeChord
// ---------------------------------------------------------------------------------------------

test('analyze: root-position triads and sevenths get their plain names', () => {
  assert.equal(analyzeChord([60, 64, 67]).name, 'C');
  assert.equal(analyzeChord([60, 63, 67]).name, 'Cm');
  assert.equal(analyzeChord([55, 59, 62, 65]).name, 'G7');
  assert.equal(analyzeChord([60, 64, 67, 71]).name, 'Cmaj7');
  assert.equal(analyzeChord([59, 62, 65]).name, 'Bdim');
  assert.equal(analyzeChord([60, 64, 68]).name, 'Caug');
  assert.equal(analyzeChord([60, 65, 67]).name, 'Csus4');
  assert.equal(analyzeChord([60, 67]).name, 'C5');
  assert.equal(analyzeChord([60, 64, 67]).inversion, 0);
});

test('analyze: inversions read as slash chords, counting chord tones below the root', () => {
  const first = analyzeChord([64, 67, 72]);
  assert.equal(first.name, 'C/E');
  assert.equal(first.inversion, 1);
  const second = analyzeChord([55, 60, 64]);
  assert.equal(second.name, 'C/G');
  assert.equal(second.inversion, 2);
});

test('analyze: A-C-E-G is Am7 over A but C6 over C - the bass picks the root', () => {
  assert.equal(analyzeChord([57, 60, 64, 67]).name, 'Am7');
  assert.equal(analyzeChord([60, 64, 67, 69]).name, 'C6');
});

test('analyze: a symmetric dim7 takes the bass note as root', () => {
  assert.equal(analyzeChord([60, 63, 66, 69]).name, 'Cdim7');
  assert.equal(analyzeChord([63, 66, 69, 72]).name, 'Ebdim7'.replace('Eb', 'D#')); // sharps by default
});

test('analyze: octaves alone and empty input name nothing', () => {
  assert.equal(analyzeChord([60, 72]), null);
  assert.equal(analyzeChord([60]), null);
  assert.equal(analyzeChord([]), null);
  assert.equal(analyzeChord(null), null);
});

test('analyze: duplicate and unsorted input analyzes the same', () => {
  assert.equal(analyzeChord([67, 60, 64, 72, 60]).name, 'C');
});

test('analyze: the scale picks flat vs sharp spelling', () => {
  assert.equal(analyzeChord([68, 72, 75], 'f minor').name, 'Ab');
  assert.equal(analyzeChord([68, 72, 75], 'e major').name, 'G#');
  assert.equal(analyzeChord([68, 72, 75]).name, 'G#'); // no scale -> sharps
});

test('analyze: roman numerals in key', () => {
  assert.equal(analyzeChord([55, 59, 62, 65], 'c major').roman, 'V7');
  assert.equal(analyzeChord([62, 65, 69], 'c major').roman, 'ii');
  assert.equal(analyzeChord([59, 62, 65], 'c major').roman, 'vii°');
  assert.equal(analyzeChord([59, 62, 65, 69], 'c major').roman, 'viiø7');
  assert.equal(analyzeChord([68, 72, 75], 'f minor').roman, 'III');
  // The bare numeral drops the quality tail but keeps identity markers.
  assert.equal(analyzeChord([55, 59, 62, 65], 'c major').numeral, 'V');
  assert.equal(analyzeChord([59, 62, 65, 69], 'c major').numeral, 'viiø');
  assert.equal(analyzeChord([59, 62, 65], 'c major').numeral, 'vii°');
  assert.equal(analyzeChord([60, 64, 67, 71], 'c major').numeral, 'I');
  // A root outside the key, and a non-7-note scale, get no numeral.
  assert.equal(analyzeChord([61, 65, 68], 'c major').roman, null);
  assert.equal(analyzeChord([60, 64, 67], 'c pentatonic').roman, null);
});

test('analyze: extended qualities - 11ths, 13ths, six-nine', () => {
  assert.equal(analyzeChord([55, 59, 62, 65, 69, 72]).name, 'G11'); // G B D F A C
  assert.equal(analyzeChord([62, 65, 69, 72, 76, 79]).name, 'Dm11'); // D F A C E G
  assert.equal(analyzeChord([55, 59, 62, 65, 69, 76]).name, 'G13'); // G B D F A E - no 11th, still a 13th
  assert.equal(analyzeChord([55, 59, 62, 65, 69, 76], 'c major').roman, 'V13');
  assert.equal(analyzeChord([60, 62, 64, 67, 69]).name, 'C6/9'); // C D E G A
  assert.equal(analyzeChord([60, 64, 67, 71, 74, 77, 81]).name, 'Cmaj13'); // the whole scale, stacked
});

test('extendedChordsOnNote: diatonic 9/11/13 rooted on the note, unnamed stacks dropped', () => {
  const onC = extendedChordsOnNote(C3, 'c major');
  assert.deepEqual(onC.map((c) => [c.kind, c.name]), [['9th', 'Cmaj9'], ['11th', 'Cmaj11'], ['13th', 'Cmaj13']]);
  for (const c of onC) assert.equal(c.midis[0], C3); // the drawn note stays the root
  const onG = extendedChordsOnNote(55, 'c major');
  assert.deepEqual(onG.map((c) => c.name), ['G9', 'G11', 'G13']);
  assert.deepEqual(onG.map((c) => c.roman), ['V9', 'V11', 'V13']);
  const onD = extendedChordsOnNote(62, 'c major');
  assert.deepEqual(onD.map((c) => c.name), ['Dm9', 'Dm11', 'Dm13']);
  // iii's diatonic stacks all carry the b9 - nothing nameable, nothing offered.
  assert.deepEqual(extendedChordsOnNote(E3, 'c major'), []);
});

// ---------------------------------------------------------------------------------------------
// diatonicChords / chordsForNote
// ---------------------------------------------------------------------------------------------

test('diatonic: C major yields the seven triads with their numerals', () => {
  const chords = diatonicChords('c major');
  assert.deepEqual(chords.map((c) => c.name), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
  assert.deepEqual(chords.map((c) => c.roman), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  assert.deepEqual(chords[0].midis, [C3, E3, G3]);
});

test('diatonic: sevenths', () => {
  const chords = diatonicChords('c major', { sevenths: true });
  assert.deepEqual(chords.map((c) => c.name), ['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7b5']);
  assert.deepEqual(chords.map((c) => c.roman), ['Imaj7', 'ii7', 'iii7', 'IVmaj7', 'V7', 'vi7', 'viiø7']);
});

test('diatonic: minor key triads', () => {
  assert.deepEqual(diatonicChords('a minor').map((c) => c.name), ['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
});

test('chordsForNote: every offered chord literally contains the held note', () => {
  const chords = chordsForNote(E3, 'c major');
  assert.deepEqual(chords.map((c) => c.role), ['root', '3rd', '5th']);
  assert.deepEqual(chords.map((c) => c.name), ['Em', 'C', 'Am']);
  assert.deepEqual(chords[0].midis, [E3, G3, B3]);
  assert.deepEqual(chords[1].midis, [C3, E3, G3]);
  assert.deepEqual(chords[2].midis, [57, C3, E3]);
  for (const c of chords) assert.ok(c.midis.includes(E3), `${c.name} should contain e3`);
  assert.deepEqual(chords.map((c) => c.degree), [2, 0, 5]);
});

test('chordsForNote: sevenths add the 7th role', () => {
  const chords = chordsForNote(E3, 'c major', { sevenths: true });
  assert.equal(chords.length, 4);
  assert.equal(chords[3].role, '7th');
  assert.equal(chords[3].name, 'Fmaj7');
  assert.ok(chords[3].midis.includes(E3));
});

test('chordsForNote: an out-of-key note quantizes to its nearest degree first (ties down)', () => {
  const chords = chordsForNote(61, 'c major'); // c#3 - equidistant, keeps C
  assert.equal(chords[0].name, 'C');
  assert.deepEqual(chords[0].midis, [C3, E3, G3]);
});

// ---------------------------------------------------------------------------------------------
// voicing transforms
// ---------------------------------------------------------------------------------------------

test('invert: up moves the bottom note an octave up, n-1 times returns the chord an octave up', () => {
  assert.deepEqual(invertChord([C3, E3, G3], 1), [E3, G3, 72]);
  assert.deepEqual(invertChord([C3, E3, G3], 2), [G3, 72, 76]);
  assert.deepEqual(invertChord([C3, E3, G3], 3), [72, 76, 79]);
  assert.deepEqual(invertChord([C3, E3, G3], -1), [55, C3, E3]);
  assert.deepEqual(invertChord([C3, E3, G3], 0), [C3, E3, G3]);
});

test('close: folds every pitch class into the octave above the bass', () => {
  assert.deepEqual(closeVoicing([60, 67, 76]), [60, 64, 67]);
  assert.deepEqual(closeVoicing([60, 64, 67]), [60, 64, 67]); // already close
  assert.deepEqual(closeVoicing([48, 60, 64, 67]), [48, 52, 55]); // doubling folds away
  assert.deepEqual(closeVoicing([60, 72]), [60, 72]); // octaves stay a chord
});

test('drop 2 / drop 3: the named voice from the top falls an octave', () => {
  assert.deepEqual(drop2([60, 64, 67, 71]), [55, 60, 64, 71]);
  assert.deepEqual(drop3([60, 64, 67, 71]), [52, 60, 67, 71]);
  assert.equal(drop2([60, 64]), null);
  assert.equal(drop3([60, 64, 67]), null);
});

test('spread: every second voice above the bass rises an octave', () => {
  assert.deepEqual(spreadVoicing([60, 64, 67]), [60, 67, 76]);
  assert.equal(spreadVoicing([60, 64]), null);
});

test('shell: root, 3rd and 7th - and null when the chord has no 7th to shell onto', () => {
  assert.deepEqual(shellVoicing([60, 64, 67, 71]), [60, 64, 71]);
  assert.deepEqual(shellVoicing([57, 60, 64, 67]), [57, 60, 67]); // Am7: A C G
  assert.equal(shellVoicing([60, 64, 67]), null);
  assert.equal(shellVoicing([60, 62]), null);
});

test('doubleBassOctave prepends the bass an octave down', () => {
  assert.deepEqual(doubleBassOctave([C3, E3, G3]), [48, C3, E3, G3]);
});

test('centerVoicing: whole-octave shift toward the reference mean, ties downward', () => {
  assert.deepEqual(centerVoicing([67, 72, 76], [C3, E3, G3]), [55, C3, E3]); // 2nd inv drops in place
  assert.deepEqual(centerVoicing([E3, G3, 72], [C3, E3, G3]), [E3, G3, 72]); // 1st inv is already closest
  assert.deepEqual(centerVoicing([C3, E3, G3], [C3, E3, G3]), [C3, E3, G3]);
});

test('chordVoicings: names what applies, skips no-ops and inapplicable ops', () => {
  const list = chordVoicings([C3, E3, G3]);
  const names = list.map((v) => v.name);
  assert.ok(names.includes('inversion 1'));
  assert.ok(names.includes('inversion 2'));
  assert.ok(names.includes('spread'));
  assert.ok(names.includes('bass octave'));
  assert.ok(!names.includes('close')); // already close - offering it says nothing
  assert.ok(!names.includes('drop 3')); // needs 4 voices
  assert.ok(!names.includes('shell (3 & 7)')); // no 7th
  const inv1 = list.find((v) => v.name === 'inversion 1');
  assert.deepEqual(inv1.midis, [E3, G3, 72]);
  // Inversions stay centered on the original chord - inversion 2 lands BELOW it, not two up.
  const inv2 = list.find((v) => v.name === 'inversion 2');
  assert.deepEqual(inv2.midis, [55, C3, E3]);
  assert.deepEqual(chordVoicings([60]), []);
});

test('chordVoicings: two roads to one voicing offer it once', () => {
  // C3 A3 F4 - an open F/C: closing it and centering its 2nd cycle both give C-F-A.
  const list = chordVoicings([60, 69, 77]);
  assert.deepEqual(list.find((v) => v.name === 'close')?.midis, [60, 65, 69]);
  assert.equal(list.find((v) => v.name === 'inversion 2'), undefined);
  const keys = list.map((v) => v.midis.join(','));
  assert.equal(new Set(keys).size, keys.length, 'no duplicate voicings offered');
});

// ---------------------------------------------------------------------------------------------
// spelling helpers
// ---------------------------------------------------------------------------------------------

test('preferFlats: written accidental wins, else the key signature decides', () => {
  assert.equal(preferFlats('f minor'), true); // 4 flats
  assert.equal(preferFlats('e major'), false); // 4 sharps
  assert.equal(preferFlats('bb major'), true);
  assert.equal(preferFlats('f# major'), false);
  assert.equal(preferFlats('d dorian'), false); // relative major C
  assert.equal(preferFlats('g dorian'), true); // relative major F
  assert.equal(preferFlats('d min'), true); // alias resolves - relative major F
  assert.equal(preferFlats(null), false);
});

test('pcName spells both ways', () => {
  assert.equal(pcName(8), 'G#');
  assert.equal(pcName(8, true), 'Ab');
  assert.equal(pcName(0, true), 'C');
});

test('romanNumeral exposed standalone for chords built elsewhere', () => {
  assert.equal(romanNumeral(7, { symbol: '7', intervals: [0, 4, 7, 10] }, 'c major'), 'V7');
  assert.equal(romanNumeral(7, { symbol: '7', intervals: [0, 4, 7, 10] }, null), null);
});

// ---------------------------------------------------------------------------------------------
// Chord building and voice-wise voicing (the pattern methods' theory)
// ---------------------------------------------------------------------------------------------

test('chordIntervals: dictionary symbols, words for the numeric ones, and aliases', () => {
  assert.deepEqual(chordIntervals('m9'), [0, 2, 3, 7, 10]);
  assert.deepEqual(chordIntervals('dom7'), [0, 4, 7, 10]);
  assert.deepEqual(chordIntervals('maj'), [0, 4, 7]);
  assert.deepEqual(chordIntervals('M7'), chordIntervals('maj7'));
  assert.deepEqual(chordIntervals('dom13'), [0, 2, 4, 7, 9, 10]); // played without the 11th
  assert.deepEqual(chordIntervals('power'), [0, 7]);
  assert.equal(chordIntervals('7'), null); // a number means an extension, not a quality
  assert.equal(chordIntervals('m99'), null);
});

test('chordExtension: odd numbers stack thirds, 6 adds the sixth, the rest are null', () => {
  assert.deepEqual(chordExtension(5), [0, 2, 4]);
  assert.deepEqual(chordExtension(7), [0, 2, 4, 6]);
  assert.deepEqual(chordExtension(13), [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(chordExtension(6), [0, 2, 4, 5]);
  assert.deepEqual(chordExtension(1), [0]);
  assert.equal(chordExtension(4), null);
  assert.equal(chordExtension(0), null);
});

test('rotateVoices: on a close chord it is the inversion; voices keep their order', () => {
  assert.deepEqual(rotateVoices([C3, E3, G3], 1), [E3, G3, C3 + 12]);
  assert.deepEqual(rotateVoices([C3, E3, G3], -1), [G3 - 12, C3, E3]);
  assert.deepEqual(rotateVoices([C3, E3, G3], 3), [C3 + 12, E3 + 12, G3 + 12]);
});

test('rotateVoices: a drop-2 rotates to the drop-2 of the next inversion', () => {
  const cmaj7 = [C3, E3, G3, B3];
  const next = rotateVoices(drop2(cmaj7), 1);
  assert.deepEqual([...next].sort((a, b) => a - b), drop2(invertChord(cmaj7, 1)));
});

test('invertVoices: inverts and stays centered where the chord was', () => {
  assert.deepEqual(invertVoices([C3, E3, G3], 1), [C3 + 12, E3, G3]); // the C went up
  assert.deepEqual(invertVoices([C3, E3, G3], 2), [C3, E3, G3 - 12]); // the G went down
  assert.deepEqual(invertVoices([C3, E3, G3], 0), [C3, E3, G3]);
});

test('spreadVoices: outer voices move by octaves from the middle, pitch classes kept', () => {
  assert.deepEqual(spreadVoices([C3, E3, G3], 1), [C3 - 12, E3, G3 + 12]);
  assert.deepEqual(spreadVoices([C3, E3, G3, B3], 1), [C3 - 12, E3, G3, B3 + 12]);
  assert.deepEqual(spreadVoices([C3, E3, G3, B3], 2), [C3 - 24, E3 - 12, G3 + 12, B3 + 24]);
  assert.deepEqual(spreadVoices([C3, E3, G3], 0), [C3, E3, G3]);
});

test('voicingVoices: voice by voice, null for a dropped voice, undefined for an unknown name', () => {
  assert.deepEqual(voicingVoices([C3, E3, G3, B3], 'drop2'), [C3, E3, G3 - 12, B3]);
  assert.deepEqual(voicingVoices([C3, E3, G3, B3], 'drop3'), [C3, E3 - 12, G3, B3]);
  assert.deepEqual(voicingVoices([C3, E3, G3, B3], 'open'), [C3, E3 + 12, G3, B3 + 12]);
  assert.deepEqual(voicingVoices([C3, G3, E3 + 12], 'close'), [C3, G3, E3]);
  assert.deepEqual(voicingVoices([C3, E3, C3 + 12], 'close'), [C3, E3, null]);
  assert.deepEqual(voicingVoices([C3, E3, G3, B3 - 1, 74], 'shell'), [C3, E3, null, B3 - 1, null]);
  assert.deepEqual(voicingVoices([C3, E3, G3], 'drop3'), [C3, E3, G3]); // doesn't apply: unchanged
  assert.equal(voicingVoices([C3, E3, G3], 'wide'), undefined);
});

test('leadVoices: with nothing before, the chord as written', () => {
  assert.deepEqual(leadVoices([C3, E3, G3]), [C3, E3, G3]);
});

test('leadVoices: keeps common tones and moves the rest by steps', () => {
  // C major -> F major: C stays, E -> F, G -> A (second inversion of F).
  assert.deepEqual([...leadVoices([65, 69, 72], [C3, E3, G3])].sort((a, b) => a - b), [C3, 65, A3]);
  // C major -> G major: G stays, C -> B, E -> D.
  assert.deepEqual([...leadVoices([55, 59, 62], [C3, E3, G3])].sort((a, b) => a - b), [59, 62, G3]);
});

test('leadVoices: home holds the chords near it', () => {
  const led = leadVoices([C3, E3, G3], null, 84);
  assert.ok(Math.abs(led.reduce((s, m) => s + m, 0) / 3 - 84) <= 6, `${led} not near 84`);
});

test('leadVoices: a voicing keeps its shape - only inversions and octaves are tried', () => {
  const spread = spreadVoices([65, 69, 72], 1); // F A C spread an octave each way
  const led = leadVoices(spread, [C3, E3, G3 + 12]);
  const gaps = (a) => { const s = [...a].sort((x, y) => x - y); return [s[1] - s[0], s[2] - s[1]]; };
  const shapes = [0, 1, 2].map((k) => gaps(rotateVoices(spread, k)).join());
  assert.ok(shapes.includes(gaps(led).join()), `${led} is not a rotation of ${spread}`);
});
