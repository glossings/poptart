// harmony.mjs - chord analysis/naming, diatonic chords, and voicing transforms. Pure table math,
// nothing booted (see the package's testing notes). c3 = 60 throughout.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeChord, chordsForNote, chordVoicings, closeVoicing, diatonicChords, doubleBassOctave,
  drop2, drop3, invertChord, pcName, preferFlats, romanNumeral, shellVoicing, spreadVoicing,
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
  // A root outside the key, and a non-7-note scale, get no numeral.
  assert.equal(analyzeChord([61, 65, 68], 'c major').roman, null);
  assert.equal(analyzeChord([60, 64, 67], 'c pentatonic').roman, null);
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
  assert.deepEqual(chordVoicings([60]), []);
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
