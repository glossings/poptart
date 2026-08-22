// _roll()/pianoroll("<ids>") - the roll registry and the id-pattern form of pianoroll(). Pure
// pattern math against the store; no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { _roll, pianoroll, cat, mini, setPatternWarn, timeShift } from './src/signal.mjs';
import { stepLocs } from './src/mini.mjs';
import { clearRolls, restoreRolls, setRollLayer, rollIds, lookupRoll } from './src/rolls.mjs';
import { injectLocations } from './src/locations.mjs';

// Each test owns the store: the buffer layer is rebuilt per evaluation in the real host too.
const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
};

const values = (sig, cycle) => sig.stepsForCycle(cycle).map((s) => s.value);
// Exact fractions carry floating-point fuzz; every timing assertion here is rounded the same way.
const round10 = (x) => Number(x.toFixed(10));
// What each step of one cycle asks to be moved by, in cycles - what the scheduler and the
// highlighter both read (see timeShift). Reads the stamps on the events AND the pattern's channels,
// which is the whole point: a named roll only has the former.
const shifts = (sig, cycle = 0) =>
  sig.stepsForCycle(cycle).map((st) => round10(timeShift(st, sig.noteChannels, cycle + st.start, 1, cycle + st.start)));
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
  _roll(0, '60,0,4', { grid: 16 });
  _roll('chorus', '67,0,4', { grid: 16 });
  const p = pianoroll('<0 chorus>');
  assert.deepEqual(values(p, 0), [60]);
  assert.deepEqual(values(p, 1), [67]);
  assert.deepEqual(values(p, 2), [60]);
});

test('numeric and named ids live in one namespace', () => {
  fresh();
  _roll(0, '60,0,4', { grid: 16 });
  _roll(12, '62,0,4', { grid: 16 });
  _roll('verse', '64,0,4', { grid: 16 });
  assert.deepEqual(values(pianoroll('<0 12 verse>'), 1), [62]);
  assert.deepEqual(values(pianoroll('<0 12 verse>'), 2), [64]);
});

test('an id pattern is the whole mini language, not just alternation', () => {
  fresh();
  _roll(0, '60,0,4', { grid: 16 }); // sounds at phase 0
  _roll(1, '62,8,4', { grid: 16 }); // sounds at phase 0.5
  // "0 1" splits the cycle: the first roll's onset falls in the first half, the second's in the
  // second half, so both are heard where they already were.
  assert.deepEqual(values(pianoroll('0 1'), 0), [60, 62]);
  assert.deepEqual(values(pianoroll('~ 1'), 0), [62], 'a rest is a slot of silence');
});

test('resolution is lazy, so definitions may sit below the pattern that names them', () => {
  fresh();
  const p = pianoroll('<0>'); // built first - nothing is registered yet
  _roll(0, '60,0,4', { grid: 16 });
  assert.deepEqual(values(p, 0), [60]);
});

test('drawn notes and an id pattern are told apart by shape', () => {
  fresh();
  _roll(0, '67,0,4', { grid: 16 });
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
  _roll(0, '60,0,4', { grid: 16 });
  const { lines } = capture(() => pianoroll('<0>', { grid: 32 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /takes grid\/len\/start from each roll\(\) definition/);
});

test('clearRolls() drops the buffer layer and leaves prebake standing', () => {
  fresh();
  setRollLayer('prebake');
  _roll('library', '60,0,4', { grid: 16 });
  setRollLayer('buffer');
  _roll(0, '62,0,4', { grid: 16 });

  clearRolls('buffer');
  assert.equal(lookupRoll('0'), null, 'a deleted buffer definition stops being playable');
  assert.ok(lookupRoll('library'), 'prebake is a library, not part of the buffer');
});

// Clearing the buffer layer is a TRANSACTION, because an evaluation can fail after it. The host
// clears the registry, rebuilds it from the buffer, and applies nothing at all if a block doesn't
// parse - while the tracks it built last time go on playing, resolving their definitions by name
// every cycle. Handing the old contents back is what keeps a typo from silencing them.
test('clearRolls hands back what it took, so a failed evaluation can put it straight back', () => {
  fresh();
  _roll(0, '60,0,4', { grid: 16 });
  const playing = pianoroll('<0>'); // built last evaluation, still being queried each cycle

  const had = clearRolls('buffer');
  assert.deepEqual(capture(() => values(playing, 0)).value, [], 'cleared, it has nothing to play');

  _roll(0, '67,0,4', { grid: 16 }); // half a rebuild, then the evaluation throws
  restoreRolls(had);
  assert.deepEqual(values(playing, 0), [60], 'the definitions are the ones it was playing before');
});

test('a buffer definition shadows a prebake one of the same id', () => {
  fresh();
  setRollLayer('prebake');
  _roll('bass', '36,0,4', { grid: 16 });
  setRollLayer('buffer');
  _roll('bass', '48,0,4', { grid: 16 });
  assert.deepEqual(values(pianoroll('<bass>'), 0), [48]);

  clearRolls('buffer');
  assert.deepEqual(values(pianoroll('<bass>'), 0), [36], 'the library shows through again');
});

test('rollIds() lists what is playable, buffer first, without duplicates', () => {
  fresh();
  setRollLayer('prebake');
  _roll('bass', '36,0,4', { grid: 16 });
  _roll('pad', '60,0,4', { grid: 16 });
  setRollLayer('buffer');
  _roll('bass', '48,0,4', { grid: 16 });
  assert.deepEqual(rollIds(), [
    { id: 'bass', layer: 'buffer' },
    { id: 'pad', layer: 'prebake' },
  ]);
});

test('redefining an id in one buffer warns - one of the two would never play', () => {
  fresh();
  _roll(0, '60,0,4', { grid: 16 });
  const { lines } = capture(() => _roll(0, '62,0,4', { grid: 16 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /defined twice/);
  assert.deepEqual(values(pianoroll('<0>'), 0), [62], 'the later definition wins');
});

test('an id has to be something pianoroll("<...>") can say', () => {
  fresh();
  assert.throws(() => _roll('two words', '60,0,4'), /one plain word/);
  assert.throws(() => _roll('<x>', '60,0,4'), /one plain word/);
  assert.throws(() => _roll(null, '60,0,4'), /takes a number or a name/);
});

test('a roll pattern is note-valued, so .scale() knows what it holds', () => {
  fresh();
  _roll(0, '60,0,4', { grid: 16 });
  assert.equal(pianoroll('<0>').pitchKind, 'note');
});

test('_roll() returns the roll, so a definition can also be played directly', () => {
  fresh();
  const r = _roll(0, '60,0,4', { grid: 16 });
  assert.deepEqual(values(r, 0), [60]);
  assert.equal(lookupRoll('0'), r);
});

// The eval-time location transpile rewrites pattern-position string literals into mini("…", off).
// _roll()'s arguments are an id and drawn note data - neither is mini notation, and wrapping either
// hands pianoroll() a Sig where it wants a string.
test('the location transpile leaves _roll() arguments alone', () => {
  for (const code of [
    '_roll(0, "60,0,4 64,0,4", { grid: 16 })',
    "_roll('chorus', \"72,0,8\", { grid: 32 })",
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
  _roll(0, '60,0,4', { grid: 16 });
  _roll('chorus', '72,0,4', { grid: 16 });
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
  const def = _roll(0, '60,0,4', { grid: 16 });
  assert.equal(def.isDef, '0', 'the host filters definition blocks out of the track list');
  assert.equal(def.fast(2).isDef, undefined, 'deliberately playing a definition still works');
  assert.equal(pianoroll('<0>').isDef, undefined, 'a pattern naming rolls is a track like any other');
});

// A named roll that sets the sample-index channel, played through the id form. Nothing on the
// pianoroll("…") call has to say so: the index rides on each event the definition contributes
// (step.cfg), so the join carries it through to whatever sampler the pattern ends in - which is
// what lets one call alternate a roll that picks files and one that plays pitches.
test('pianoroll("<ids>") carries a roll\'s i channel through to the sampler', () => {
  fresh();
  _roll('hits', '24:0,0,4 24:3,8,4', { grid: 16, mode: 'index' });
  const steps = pianoroll('hits').s('breaks').stepsForCycle(0);
  assert.deepEqual(steps.map((s) => s.cfg.index), [0, 3]);
  assert.deepEqual(steps.map((s) => s.value), ['breaks', 'breaks']);
  // ...and a roll that sets no index leaves the channel alone on the cycles it holds
  _roll('line', '60,0,4', { grid: 16 });
  const mixed = pianoroll('<hits line>').s('breaks');
  assert.deepEqual(mixed.stepsForCycle(0).map((s) => s.cfg.index), [0, 3]);
  assert.deepEqual(mixed.stepsForCycle(1).map((s) => s.cfg.note), [60]);
  assert.equal(mixed.stepsForCycle(1)[0].cfg.index, undefined);
});

// The evaluation ORDER this laziness demands. A buffer puts its patterns at the top and the
// definitions the editor writes in a block at the foot, so a cycle built while the evaluation is
// still working down the buffer asks the registry for a name it has not reached yet. /api/evaluate
// therefore runs every block first and builds cycles only afterwards (see its dry-run pass) -
// without that, an ordinary `pianoroll("disco")` reported itself undefined on every evaluation, on
// a name defined two lines below it that played perfectly.
test('a name asked for before its definition warns - which is why cycles are built last', () => {
  fresh();
  const early = capture(() => {
    const pat = pianoroll('disco'); // the pattern block, evaluated first...
    pat.stepsForCycle(0); // ...and asked for a cycle before the foot of the buffer ran
  });
  assert.match(early.lines.join('\n'), /no roll called "disco"/);
  // and it names the call that is actually bound - `roll` is deliberately not (INTERNAL_BUILDERS)
  assert.match(early.lines.join('\n'), /_roll\("disco", \.\.\.\)/);

  fresh();
  const inOrder = capture(() => {
    _roll('disco', '19,1,1,0.8 19:7,10,1,0.8 19:16,12,3,0.8', { grid: 16, len: 16, mode: 'index' });
    return pianoroll('disco').s('dstab').stepsForCycle(0);
  });
  assert.deepEqual(inOrder.lines, [], 'nothing to report once the definition has been evaluated');
  assert.deepEqual(inOrder.value.map((st) => st.cfg.index), [0, 7, 16]);
  assert.deepEqual(inOrder.value.map((st) => st.value), ['dstab', 'dstab', 'dstab']);
});

// ---------------------------------------------------------------------------------------------
// A named roll's own swing
//
// A roll's swing is set on the panel and written into its definition. It reaches the track through
// selectorJoin, which carries a slot's child EVENTS but not its channels - one channel bundle can't
// answer for every roll a `<a b>` might name - so the builder stamps the swing onto the events as
// well. Without that a named roll played dead straight and only the panel's commit button (which
// writes per-note nudges, and those are stamped) appeared to work.
// ---------------------------------------------------------------------------------------------

test('a roll played by NAME keeps its own swing', () => {
  fresh();
  const eighths = '60,0,1 60,1,1 60,2,1 60,3,1 60,4,1 60,5,1 60,6,1 60,7,1';
  const opts = { grid: 8, len: 8, swing: 1 / 3 };
  const inline = pianoroll(eighths, opts);
  _roll('swung', eighths, opts);
  _roll('straight', eighths, { grid: 8, len: 8 });

  // The same offbeat shift either way round: a third of an eighth-note slot, in cycles.
  assert.deepEqual(shifts(pianoroll('swung')), shifts(inline));
  assert.deepEqual(shifts(pianoroll('swung')), [0, 1 / 24, 0, 1 / 24, 0, 1 / 24, 0, 1 / 24].map(round10));
  // ...and a straight roll is still straight, so nothing is stamped on a roll that says nothing.
  assert.deepEqual(shifts(pianoroll('straight')), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a swung roll names its division, so the stamp is not read against the default 8', () => {
  fresh();
  // Sixteenths on a 16-grid: swinging them is what the roll means, and the generic swing default
  // (eighths) would move a quite different set of onsets.
  const str = Array.from({ length: 16 }, (_, k) => `60,${k},1`).join(' ');
  _roll('sixteenths', str, { grid: 16, len: 16, swing: 0.25 });
  const got = shifts(pianoroll('sixteenths'));
  assert.deepEqual(got, Array.from({ length: 16 }, (_, k) => (k % 2 ? round10(0.25 / 16) : 0)));
});

test('a .swing() on the TRACK still replaces a named roll\'s own', () => {
  fresh();
  const eighths = '60,0,1 60,1,1 60,2,1 60,3,1 60,4,1 60,5,1 60,6,1 60,7,1';
  _roll('swung', eighths, { grid: 8, len: 8, swing: 1 / 3 });
  // Setting a control clears that field off the events first (see crossMerge), so the track's
  // number wins over the stamp exactly as it wins over a channel.
  assert.deepEqual(shifts(pianoroll('swung').swing(0.5, 8)), [0, 1 / 16, 0, 1 / 16, 0, 1 / 16, 0, 1 / 16].map(round10));
});
