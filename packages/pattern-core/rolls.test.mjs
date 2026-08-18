// roll()/pianoroll("<ids>") - the roll registry and the id-pattern form of pianoroll(). Pure
// pattern math against the store; no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { roll, pianoroll, mini, setPatternWarn } from './src/signal.mjs';
import { clearRolls, setRollLayer, rollIds, lookupRoll } from './src/rolls.mjs';

// Each test owns the store: the buffer layer is rebuilt per evaluation in the real host too.
const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
};

const values = (sig, cycle) => sig.stepsForCycle(cycle).map((s) => s.value);
const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

test('pianoroll("<a b>") alternates the rolls the ids name', () => {
  fresh();
  roll(0, '60,0,4', { grid: 16 });
  roll('chorus', '67,0,4', { grid: 16 });
  const p = pianoroll('<0 chorus>');
  assert.deepEqual(values(p, 0), [60]);
  assert.deepEqual(values(p, 1), [67]);
  assert.deepEqual(values(p, 2), [60]);
});

test('numeric and named ids live in one namespace', () => {
  fresh();
  roll(0, '60,0,4', { grid: 16 });
  roll(12, '62,0,4', { grid: 16 });
  roll('verse', '64,0,4', { grid: 16 });
  assert.deepEqual(values(pianoroll('<0 12 verse>'), 1), [62]);
  assert.deepEqual(values(pianoroll('<0 12 verse>'), 2), [64]);
});

test('an id pattern is the whole mini language, not just alternation', () => {
  fresh();
  roll(0, '60,0,4', { grid: 16 }); // sounds at phase 0
  roll(1, '62,8,4', { grid: 16 }); // sounds at phase 0.5
  // "0 1" splits the cycle: the first roll's onset falls in the first half, the second's in the
  // second half, so both are heard where they already were.
  assert.deepEqual(values(pianoroll('0 1'), 0), [60, 62]);
  assert.deepEqual(values(pianoroll('~ 1'), 0), [62], 'a rest is a slot of silence');
});

test('resolution is lazy, so definitions may sit below the pattern that names them', () => {
  fresh();
  const p = pianoroll('<0>'); // built first - nothing is registered yet
  roll(0, '60,0,4', { grid: 16 });
  assert.deepEqual(values(p, 0), [60]);
});

test('drawn notes and an id pattern are told apart by shape', () => {
  fresh();
  roll(0, '67,0,4', { grid: 16 });
  assert.deepEqual(values(pianoroll('60,0,4', { grid: 16 }), 0), [60], 'a note token stays notes');
  assert.deepEqual(values(pianoroll('0'), 0), [67], 'a bare word is an id');
  assert.deepEqual(pianoroll('').stepsForCycle(0), [], 'an empty roll is still an empty roll');
});

test('an unknown id plays silence and says so once', () => {
  fresh();
  const { value: p, lines } = capture(() => {
    const pat = pianoroll('<nope nope>');
    pat.stepsForCycle(0);
    pat.stepsForCycle(1);
    pat.stepsForCycle(2);
    return pat;
  });
  assert.deepEqual(p.stepsForCycle(0), []);
  assert.equal(lines.length, 1, 'one line per unknown id, not one per cycle');
  assert.match(lines[0], /no roll called "nope"/);
});

test('options on an id-pattern call are ignored, with a warning', () => {
  fresh();
  roll(0, '60,0,4', { grid: 16 });
  const { lines } = capture(() => pianoroll('<0>', { grid: 32 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /takes grid\/len\/start from each roll\(\) definition/);
});

test('clearRolls() drops the buffer layer and leaves prebake standing', () => {
  fresh();
  setRollLayer('prebake');
  roll('library', '60,0,4', { grid: 16 });
  setRollLayer('buffer');
  roll(0, '62,0,4', { grid: 16 });

  clearRolls('buffer');
  assert.equal(lookupRoll('0'), null, 'a deleted buffer definition stops being playable');
  assert.ok(lookupRoll('library'), 'prebake is a library, not part of the buffer');
});

test('a buffer definition shadows a prebake one of the same id', () => {
  fresh();
  setRollLayer('prebake');
  roll('bass', '36,0,4', { grid: 16 });
  setRollLayer('buffer');
  roll('bass', '48,0,4', { grid: 16 });
  assert.deepEqual(values(pianoroll('<bass>'), 0), [48]);

  clearRolls('buffer');
  assert.deepEqual(values(pianoroll('<bass>'), 0), [36], 'the library shows through again');
});

test('rollIds() lists what is playable, buffer first, without duplicates', () => {
  fresh();
  setRollLayer('prebake');
  roll('bass', '36,0,4', { grid: 16 });
  roll('pad', '60,0,4', { grid: 16 });
  setRollLayer('buffer');
  roll('bass', '48,0,4', { grid: 16 });
  assert.deepEqual(rollIds(), [
    { id: 'bass', layer: 'buffer' },
    { id: 'pad', layer: 'prebake' },
  ]);
});

test('redefining an id in one buffer warns - one of the two would never play', () => {
  fresh();
  roll(0, '60,0,4', { grid: 16 });
  const { lines } = capture(() => roll(0, '62,0,4', { grid: 16 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /defined twice/);
  assert.deepEqual(values(pianoroll('<0>'), 0), [62], 'the later definition wins');
});

test('an id has to be something pianoroll("<...>") can say', () => {
  fresh();
  assert.throws(() => roll('two words', '60,0,4'), /one plain word/);
  assert.throws(() => roll('<x>', '60,0,4'), /one plain word/);
  assert.throws(() => roll(null, '60,0,4'), /takes a number or a name/);
});

test('a roll pattern is note-valued, so .scale() knows what it holds', () => {
  fresh();
  roll(0, '60,0,4', { grid: 16 });
  assert.equal(pianoroll('<0>').pitchKind, 'note');
});

test('roll() returns the roll, so a definition can also be played directly', () => {
  fresh();
  const r = roll(0, '60,0,4', { grid: 16 });
  assert.deepEqual(values(r, 0), [60]);
  assert.equal(lookupRoll('0'), r);
});
