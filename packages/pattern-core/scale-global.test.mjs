// The global scale - setscale()'s state (notes.mjs) and the .sc() shorthand that reads it. Pure
// pattern math, no scheduler/engine boot (see testing notes).
//
// NOTE: the global scale is module state, so these run in declaration order and the "nothing set
// yet" case has to come first - nothing clears it once set.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, mini, setPatternWarn } from './src/signal.mjs';
import {
  setGlobalScale, globalScale, scaleParts, scaleAtOctave, degreeToMidi, DEFAULT_SCALE,
} from './src/notes.mjs';

const values = (sig, cycle = 0) => sig.stepsForCycle(cycle).filter((st) => st.value != null).map((st) => st.value);

// Collects everything warnUser() says while `fn` runs.
function warnings(fn) {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  try {
    fn();
  } finally {
    setPatternWarn(null);
  }
  return lines;
}

test('.sc() with no setscale() warns and keeps playing in the default scale', () => {
  assert.equal(globalScale(), null);
  let out;
  const said = warnings(() => { out = n("0 2 4").sc(); });
  assert.equal(said.length, 1);
  assert.match(said[0], /setscale/);
  assert.deepEqual(values(out), [0, 2, 4].map((d) => degreeToMidi(d, DEFAULT_SCALE)));
});

test('setGlobalScale stores the name and rejects a bad one', () => {
  assert.equal(setGlobalScale('F minor'), 'F minor');
  assert.equal(globalScale(), 'F minor');
  assert.throws(() => setGlobalScale('F bogolydian'), /unknown scale/);
  assert.equal(globalScale(), 'F minor', 'a rejected name leaves the old one in force');
});

test('.sc() on a degree pattern is .scale(<the global scale>)', () => {
  setGlobalScale('F minor');
  assert.deepEqual(values(n("0 2 4").sc()), values(n("0 2 4").scale('F minor')));
});

test('.sc() on a note pattern quantizes into the global scale, like .scale()', () => {
  setGlobalScale('C major');
  // f#4 (54) is out of key and bends down to f4 (53); the others already belong.
  assert.deepEqual(values(note("c4 e4 f#4").sc()), [48, 52, 53]);
});

test('.sc(octave) re-roots the scale - the same thing as naming the octave in .scale()', () => {
  setGlobalScale('F minor');
  assert.deepEqual(values(n("0 2 4").sc(3)), values(n("0 2 4").scale('f3 minor')));
  // bare .sc() leaves the root where setscale put it (octave 5 unless the name said otherwise)
  assert.deepEqual(values(n("0").sc()), values(n("0").sc(5)));
  setGlobalScale('f3 minor');
  assert.deepEqual(values(n("0").sc()), values(n("0").sc(3)));
});

test('.sc() reads through a constant Sig octave (the editor transpiles "3" into one)', () => {
  setGlobalScale('F minor');
  assert.deepEqual(values(n("0 2 4").sc(mini('3'))), values(n("0 2 4").scale('f3 minor')));
});

test('a patterned octave transposes by whole octaves per cycle', () => {
  setGlobalScale('C major');
  const sig = n("0 2").sc("<3 4>");
  assert.deepEqual(values(sig, 0), values(n("0 2").scale('c3 major')));
  assert.deepEqual(values(sig, 1), values(n("0 2").scale('c4 major')));
});

test('scaleParts / scaleAtOctave split and rebuild a scale name', () => {
  assert.deepEqual(scaleParts('F minor'), { root: 'F', octave: null, mode: 'minor' });
  assert.deepEqual(scaleParts('bb3:mixolydian'), { root: 'bb', octave: 3, mode: 'mixolydian' });
  assert.deepEqual(scaleParts('dorian'), { root: 'c', octave: null, mode: 'dorian' }); // rootless -> C
  assert.equal(scaleAtOctave('F minor', 3), 'F3 minor');
  assert.equal(scaleAtOctave('bb3 mixolydian', 6), 'bb6 mixolydian');
});
