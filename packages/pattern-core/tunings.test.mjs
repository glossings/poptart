// Tunings in scale names (notes.mjs): EDOs and their modes, ratio/cents lists read as Scala reads
// them, Scala files registered by name - and the degree, quantize and inverse math over them.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseScaleName, degreeToMidi, midiToDegree, quantizeToScale, registerTuning, parseScala, scaleSize, scaleParts,
  scaleAtOctave,
} from './src/notes.mjs';
import { n } from './src/signal.mjs';

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);
const steps31 = (name) => parseScaleName(name).intervals.map((iv) => Math.round((iv * 31) / 12));

test('the named modes are unchanged: whole semitones, an octave period, not tuned', () => {
  const s = parseScaleName('f3 minor');
  assert.deepEqual(s.intervals, [0, 2, 3, 5, 7, 8, 10]);
  assert.equal(s.period, 12);
  assert.equal(s.tuned, false);
  assert.equal(quantizeToScale(66, 'c3 major'), 65, 'a 12-tone scale still snaps by pitch class, ties down');
});

test('an EDO is every step of it; a mode of one lands on its nearest steps', () => {
  assert.equal(scaleSize('c3 31edo'), 31);
  near(degreeToMidi(1, 'c3 31edo'), 60 + 12 / 31, 'one step of 31-EDO');
  near(degreeToMidi(31, 'c3 31edo'), 72, 'a period up is an octave');
  // In 31-EDO the nearest steps to the major scale's semitones are meantone major.
  assert.deepEqual(steps31('c3 31edo major'), [0, 5, 10, 13, 18, 23, 28]);
  assert.deepEqual(steps31('c3 31edo 5 5 3 5 5 5 3'), [0, 5, 10, 13, 18, 23, 28], 'the same mode as step counts');
  assert.throws(() => parseScaleName('c3 31edo 5 5 5'), /add up to 15, not 31/);
  for (const spelling of ['31edo', '31-edo', '31tet', '31et']) assert.equal(scaleSize(spelling), 31, spelling);
});

test('a ratio/cents list reads the way a Scala file lists its pitches', () => {
  const ji = 'c3 9/8 5/4 4/3 3/2 5/3 15/8 2/1';
  near(degreeToMidi(2, ji), 60 + 12 * Math.log2(5 / 4), 'a pure major third');
  near(degreeToMidi(7, ji), 72, 'the period');
  // Cents carry a "."; a whole number is a ratio, so cents without one get a pointed message.
  near(degreeToMidi(1, 'c3 386.3 702.0 1200.0'), 63.863, 'cents');
  assert.throws(() => parseScaleName('c3 386.3 702 1200.'), /"702" reads as the ratio 702\/1; for cents write 702.0/);
  assert.equal(scaleSize('c3 1/1 5/4 3/2 2'), 3, 'a written-in unison is dropped, "2" is 2/1');
  // A period other than the octave: the tritave.
  const bp = parseScaleName('c3 27/25 25/21 9/7 7/5 75/49 5/3 9/5 49/25 15/7 7/3 63/25 25/9 3/1');
  near(bp.period, 12 * Math.log2(3), 'the Bohlen-Pierce period');
  near(degreeToMidi(13, 'c3 27/25 25/21 9/7 7/5 75/49 5/3 9/5 49/25 15/7 7/3 63/25 25/9 3/1'), 60 + 12 * Math.log2(3), 'a period up');
});

test('a Scala file parses and registers by name, with or without ".scl"', () => {
  const text = '! meantone.scl\n!\nQuarter-comma meantone\n 3\n!\n 193.157\n 5/4 the third\n 2/1\n';
  const parsed = parseScala(text, 'meantone');
  assert.equal(parsed.description, 'Quarter-comma meantone');
  assert.equal(parsed.intervals.length, 3);
  registerTuning('meantone.scl', text);
  near(degreeToMidi(1, 'd3 meantone.scl'), 62 + 1.93157, 'rooted on d');
  near(degreeToMidi(2, 'c3 meantone'), 60 + 12 * Math.log2(5 / 4), 'by bare name too');
  assert.throws(() => parseScaleName('c3 missing.scl'), /the tuning file "missing.scl" isn't loaded/);
  assert.throws(() => parseScala('just a line', 'x'), /not a Scala file/);
  assert.throws(() => parseScala('desc\n3\n100.0\n', 'x'), /says 3 pitches but lists 1/);
});

test('degrees, the inverse and quantizing work across a tuning, fractions included', () => {
  for (const d of [-9, -1, 0, 4, 17, 40]) assert.equal(midiToDegree(degreeToMidi(d, 'c3 31edo'), 'c3 31edo'), d, `degree ${d}`);
  near(degreeToMidi(0.5, 'c3 31edo'), 60 + 6 / 31, 'halfway between two steps');
  // e3 (64, a tempered third) snaps to the pure third, the nearest pitch in just major.
  near(quantizeToScale(64, 'c3 9/8 5/4 4/3 3/2 5/3 15/8 2/1'), 60 + 12 * Math.log2(5 / 4), 'snapped to 5/4');
  // A degree pattern through a tuning comes out as fractional MIDI notes.
  const notes = n('0 1 2').scale('c3 31edo major').stepsForCycle(0).map((st) => st.value);
  notes.forEach((v, i) => near(v, degreeToMidi(i, 'c3 31edo major'), `step ${i}`));
});

test("a tuning's mode words survive re-rooting (setscale + .sc(octave))", () => {
  assert.equal(scaleParts('d3 31edo major').mode, '31edo major');
  assert.equal(scaleAtOctave('d3 31edo major', 4), 'd4 31edo major');
  assert.equal(scaleParts('31edo').root, 'c');
});

test("a roll keeps a tuning's pitches exactly, and a whole note stays whole", async () => {
  const { parsePianoRoll, serializePianoRoll, pianoRollEventAt } = await import('./src/pianoroll.mjs');
  const text = '60,0,1 63.863,1,1 61.935:2,2,1';
  const notes = parsePianoRoll(text);
  assert.deepEqual(notes.map((nt) => nt.midi), [60, 63.863, 61.935]);
  assert.equal(serializePianoRoll(notes), text, 'the string round-trips unchanged');
  assert.equal(parsePianoRoll('63.86312,0,1')[0].midi, 63.863, 'kept to a thousandth of a semitone');
  assert.equal(pianoRollEventAt(61.9354838, 'note').midi, 61.935, 'a drawn note lands on its lane pitch');
});

test('.ji() tunes each chord to its own lowest note, or every note to a fixed tonic', async () => {
  const { note } = await import('./src/signal.mjs');
  const { justInterval } = await import('./src/harmony.mjs');
  const cents = (sig, c = 0) => sig.stepsForCycle(c).map((st) => st.value);
  const third = 12 * Math.log2(5 / 4), fifth = 12 * Math.log2(3 / 2);
  // A major triad is 4:5:6 over its bass, which stays put; a minor one over a different bass too.
  const [c, e, g] = cents(note('[c3,e3,g3]').ji());
  near(c, 60, 'the bass stays'); near(e, 60 + third, 'a pure third'); near(g, 60 + fifth, 'a pure fifth');
  const [a, cc] = cents(note('<[c3,e3] [a2,c3]>').ji(), 1);
  near(a, 57, 'the next chord keeps its own bass'); near(cc, 57 + 12 * Math.log2(6 / 5), 'a pure minor third');
  // A single note has nothing to be tuned against.
  near(cents(note('e3').ji())[0], 64, 'a lone note is left alone');
  // The 7-limit seventh: 7/4 over the root.
  near(cents(note('[g2,b2,d3,f3]').ji(null, 7))[3], 55 + 12 * Math.log2(7 / 4), 'the harmonic seventh');
  // A fixed tonic, patterned: every note against it, single notes included.
  const melody = cents(note('d3 e3').ji('c3'));
  near(melody[0], 60 + 12 * Math.log2(9 / 8), '9/8 over c3'); near(melody[1], 60 + third, '5/4 over c3');
  near(cents(note('a3').ji('<c3 f3>'), 1)[0], 65 + third, 'the tonic read at the onset');
  // Compound and downward intervals keep their octaves.
  near(justInterval(16), 12 + third, 'a tenth'); near(justInterval(-7), -fifth, 'a fifth down');
});
