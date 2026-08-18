// roll()/pianoroll("<ids>") - the roll registry and the id-pattern form of pianoroll(). Pure
// pattern math against the store; no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { roll, pianoroll, cat, mini, setPatternWarn } from './src/signal.mjs';
import { stepLocs } from './src/mini.mjs';
import { clearRolls, setRollLayer, rollIds, lookupRoll } from './src/rolls.mjs';
import { injectLocations } from './src/locations.mjs';

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

// The eval-time location transpile rewrites pattern-position string literals into mini("…", off).
// roll()'s arguments are an id and drawn note data - neither is mini notation, and wrapping either
// hands pianoroll() a Sig where it wants a string.
test('the location transpile leaves roll() arguments alone', () => {
  for (const code of [
    'roll(0, "60,0,4 64,0,4", { grid: 16 })',
    "roll('chorus', \"72,0,8\", { grid: 32 })",
    'pianoroll("60,0,4", { grid: 16 })',
    'pianoroll("")',
  ]) {
    assert.equal(injectLocations(code, 0), code, code);
  }
});

test('an id pattern IS tagged - the ids are mini notation, and they highlight', () => {
  assert.equal(injectLocations('pianoroll("<0 chorus>")', 0), 'pianoroll(mini("<0 chorus>", 11))');
});

test('a tagged id pattern still resolves, and its steps carry the id that sounded', () => {
  fresh();
  roll(0, '60,0,4', { grid: 16 });
  roll('chorus', '72,0,4', { grid: 16 });
  // What the host actually evaluates after the transpile: the selector arrives as a Sig.
  const p = pianoroll(mini('<0 chorus>', 11));
  assert.deepEqual(values(p, 0), [60]);
  assert.deepEqual(values(p, 1), [72]);
  // Offsets into `pianoroll("<0 chorus>")`: the `0` at 12, then `chorus` at 14..20.
  assert.deepEqual(stepLocs(p.stepsForCycle(0)[0]), [[12, 13]]);
  assert.deepEqual(stepLocs(p.stepsForCycle(1)[0]), [[14, 20]]);
});

test('a synthesized slot adds no spans of its own', () => {
  // cat()/seq() slots are not written by the user, so there is nothing there to light up - the
  // step keeps only the span of the atom inside the option that played.
  fresh();
  const step = cat(mini('10', 0), mini('99', 0)).stepsForCycle(0)[0];
  assert.deepEqual(stepLocs(step), [[0, 2]]);
});

test('a roll definition is marked as one, and stops being marked once it is built on', () => {
  fresh();
  const def = roll(0, '60,0,4', { grid: 16 });
  assert.equal(def.rollDef, '0', 'the host filters definition blocks out of the track list');
  assert.equal(def.fast(2).rollDef, undefined, 'deliberately playing a definition still works');
  assert.equal(pianoroll('<0>').rollDef, undefined, 'a pattern naming rolls is a track like any other');
});
