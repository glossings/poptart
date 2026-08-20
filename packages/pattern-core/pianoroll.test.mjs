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
  clipOverlaps,
  normalizePianoRollSteps,
  normalizePianoRollMode,
  pianoRollEventAt,
  noteIndex,
  rescalePianoRoll,
  regridPianoRoll,
  retimePianoRoll,
  duplicatePianoRollLoop,
  PIANOROLL_DEFAULT_STEPS,
  PIANOROLL_DEFAULT_NOTE,
  PIANOROLL_DEFAULT_INDEX,
} from './src/pianoroll.mjs';
import { pianoroll, note, n, i, vel, mini, s, channelAt, soundingEnd } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

test('parsePianoRoll: fields, defaults, and empty input', () => {
  assert.deepEqual(parsePianoRoll(''), []);
  assert.deepEqual(parsePianoRoll('   '), []);
  assert.deepEqual(parsePianoRoll('60,0,4'), [{ midi: 60, index: 0, start: 0, len: 4, vel: 1, prob: 1, mute: false }]);
  assert.deepEqual(parsePianoRoll('60,0,4,0.5'), [{ midi: 60, index: 0, start: 0, len: 4, vel: 0.5, prob: 1, mute: false }]);
  assert.deepEqual(parsePianoRoll('60,0,4,0.5,0.25'), [{ midi: 60, index: 0, start: 0, len: 4, vel: 0.5, prob: 0.25, mute: false }]);
  // the pitch field carries the sample index behind a ":" when it isn't the default
  assert.deepEqual(parsePianoRoll('24:3,0,4'), [{ midi: 24, index: 3, start: 0, len: 4, vel: 1, prob: 1, mute: false }]);
  assert.deepEqual(parsePianoRoll('!60:2,0,4,0.5'), [{ midi: 60, index: 2, start: 0, len: 4, vel: 0.5, prob: 1, mute: true }]);
});

test('parsePianoRoll: clamps out-of-range fields, rejects malformed tokens', () => {
  assert.deepEqual(parsePianoRoll('200,-3,0,9,9'), [{ midi: 127, index: 0, start: 0, len: 1, vel: 1, prob: 1, mute: false }]);
  assert.deepEqual(parsePianoRoll('60:-2,0,4'), [{ midi: 60, index: 0, start: 0, len: 4, vel: 1, prob: 1, mute: false }]);
  assert.throws(() => parsePianoRoll('60,0'), /bad note/);
  assert.throws(() => parsePianoRoll('60,0,4,0.5,0.5,7'), /bad note/);
  assert.throws(() => parsePianoRoll('c,0,4'), /non-numeric/);
});

// The `!` marker is the muted (Live-deactivated) note: still in the roll, never sounding.
test('parsePianoRoll / serializePianoRoll: the ! mute marker round-trips', () => {
  assert.deepEqual(parsePianoRoll('!60,0,4'), [{ midi: 60, index: 0, start: 0, len: 4, vel: 1, prob: 1, mute: true }]);
  // it rides in front of every other field, and the rest of the token parses exactly as it would
  assert.deepEqual(parsePianoRoll('!60,0,4,0.5,0.25'), [{ midi: 60, index: 0, start: 0, len: 4, vel: 0.5, prob: 0.25, mute: true }]);
  assert.equal(serializePianoRoll([{ midi: 60, start: 0, len: 4, vel: 1, prob: 1, mute: true }]), '!60,0,4');
  assert.equal(serializePianoRoll([{ midi: 60, start: 0, len: 4, vel: 0.5, prob: 1, mute: true }]), '!60,0,4,0.5');
  const str = '!60,0,4 64,0,4,0.5 !67,8,8,1,0.3';
  assert.equal(serializePianoRoll(parsePianoRoll(str)), str);
  assert.throws(() => parsePianoRoll('!60,0'), /bad note/);
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

const nt = (midi, start, len, extra = {}) => ({ midi, start, len, vel: 1, prob: 1, ...extra });
// what the roll would write out: hidden notes are held in the editor only, never in the code
const sounding = (notes) => serializePianoRoll(notes.filter((n) => !n.hidden));

test('clipOverlaps: the note on top keeps its length; the one under it gives way', () => {
  // short note dropped into the middle of a long one (so it is later in the array): the long one
  // ends exactly where the short one starts
  const long = nt(60, 0, 8);
  const short = nt(60, 4, 1);
  assert.equal(sounding(clipOverlaps([long, short])), '60,0,4 60,4,1');
  assert.equal(long.full, 8); // ...but it still knows how long it was drawn

  // the other way round - a long note moved on top of a short one - the long note is NOT shortened;
  // the short one is buried and drops out of the roll
  const under = nt(60, 5, 2);
  const over = nt(60, 4, 4);
  clipOverlaps([under, over]);
  assert.equal(over.len, 4);
  assert.equal(under.hidden, true);
  assert.equal(sounding([under, over]), '60,4,4');

  // other lanes are chords, not clashes; a note butting up against the next is already fine
  const held = nt(60, 0, 8);
  const chord = nt(64, 4, 1);
  const after = nt(60, 8, 1);
  clipOverlaps([held, chord, after]);
  assert.equal(held.len, 8);
  assert.deepEqual([held.hidden, chord.hidden, after.hidden], [false, false, false]);
});

test('clipOverlaps: everything comes back when the note on top moves away', () => {
  const long = nt(60, 0, 8);
  const short = nt(60, 4, 1);
  const roll = [long, short];
  clipOverlaps(roll);
  assert.equal(long.len, 4);

  short.start = 6; // nudged right - the long note reclaims the cells it lost
  clipOverlaps(roll);
  assert.equal(long.len, 6);

  short.midi = 67; // dragged off the lane entirely - back to its full drawn length
  clipOverlaps(roll);
  assert.equal(long.len, 8);

  // a note buried under a moved one is only hidden, so it returns intact when that one leaves
  const buried = nt(60, 4, 2);
  const mover = nt(60, 3, 6);
  const roll2 = [buried, mover];
  clipOverlaps(roll2);
  assert.equal(buried.hidden, true);
  mover.midi = 72;
  clipOverlaps(roll2);
  assert.equal(buried.hidden, false);
  assert.equal(sounding(roll2), '72,3,6 60,4,2'); // (serialize sorts by onset)
});

test('clipOverlaps: two notes on one cell - the later one takes it, the other hides', () => {
  const oldOne = nt(60, 0, 4);
  const newOne = nt(60, 0, 1);
  clipOverlaps([oldOne, newOne]);
  assert.equal(sounding([oldOne, newOne]), '60,0,1');
  assert.equal(oldOne.hidden, true);
  assert.equal(oldOne.full, 4); // still whole underneath - move the new one off and it returns
});

test('clipOverlaps: a parsed roll adopts its written lengths, and re-clipping is idempotent', () => {
  const roll = parsePianoRoll('60,0,4 60,4,1');
  assert.equal(sounding(clipOverlaps(roll)), '60,0,4 60,4,1');
  assert.equal(sounding(clipOverlaps(clipOverlaps(roll))), '60,0,4 60,4,1');
  assert.deepEqual(roll.map((n) => n.full), [4, 1]);
});

// Muting is a switch on one note, not an edit to the ones around it: the lane has to look exactly
// the same afterwards, or unmuting couldn't put it back.
test('clipOverlaps: a muted note still holds its lane', () => {
  const long = nt(60, 0, 8);
  const short = nt(60, 4, 1, { mute: true });
  clipOverlaps([long, short]);
  assert.equal(long.len, 4); // clipped by the muted note, exactly as by a sounding one
  const buried = nt(60, 4, 2);
  const cover = nt(60, 3, 6, { mute: true });
  clipOverlaps([buried, cover]);
  assert.equal(buried.hidden, true);
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

// In a key the roll converts to DEGREES, so re-keying the patch moves the notes. The octave rides
// on `.sc()` rather than on the numbers, which keeps every degree non-negative.
test('pianoRollToMini: scale mode writes n degrees plus .sc(octave)', () => {
  // f3 = 41 is the root of "F minor" at octave 3, so the lowest note drawn is degree 0; ab3 (44)
  // is the minor third, degree 2; c4 (48) the fifth, degree 4.
  assert.equal(
    pianoRollToMini(parsePianoRoll('41,0,1 44,1,1 48,2,1'), { grid: 4, len: 3, scale: 'F minor' }),
    'n(`<\n  0 2 4\n>*4`).sc(3)',
  );
  // ...and with the other fields in play it's the same `.as()` form with `n` in the pitch slot.
  assert.equal(
    pianoRollToMini(parsePianoRoll('41,0,2,0.5 48,2,1'), { grid: 4, len: 4, scale: 'F minor' }),
    '`<\n  0:0.5:2 ~ 4 ~\n>*4`.as("n:vel:clip").sc(3)',
  );
  // No scale: unchanged, absolute MIDI numbers.
  assert.equal(
    pianoRollToMini(parsePianoRoll('41,0,1'), { grid: 4, len: 1 }),
    'note(`<\n  41\n>*4`)',
  );
});

test('pianoRollToMini: scale mode rounds out-of-key notes to the nearest degree', () => {
  // 42 (f#3) is not in F minor, and sits a semitone above degree 0 and a semitone below degree 1;
  // the tie resolves downward, exactly as quantizeToScale rounds.
  assert.equal(
    pianoRollToMini(parsePianoRoll('41,0,1 42,1,1'), { grid: 4, len: 2, scale: 'F minor' }),
    'n(`<\n  0 0\n>*4`).sc(3)',
  );
});

// Compared as the scheduler hears them, through the shared channel readers: velocity, and the span
// the note SOUNDS for. A roll and its conversion carry a note's length differently - the builder
// gives the step its real width, the mini round-trip a fixed-width cell plus a `clip` key (the
// `<…>*grid` cells can't be any other width) - and it's the sounding span, not the step, that has
// to agree.
const soundsLike = (sig, cycle) =>
  sig
    .stepsForCycle(cycle)
    .map((s) => {
      const at = cycle + s.start;
      return {
        s: +s.start.toFixed(4),
        e: +soundingEnd(s, sig.noteChannels, at, 1, at).toFixed(4),
        v: s.value,
        vel: channelAt('vel', s, sig.noteChannels, at, 1, at) ?? 1,
      };
    })
    .sort((a, b) => a.s - b.s || a.v - b.v);

/** An emitted expression, rebuilt the way the eval sandbox would: a bare template literal is mini. */
const rebuildMini = (expr) =>
  // eslint-disable-next-line no-new-func
  new Function('mini', 'note', 'n', `return ${expr.replace(/^`([\s\S]*?)`/, 'mini(`$1`)')};`)(mini, note, n);

// The whole point of the converter is that what it emits plays the same notes the editor did - and
// that holds however the fields were split between the cells and the control calls, which is a
// rewrite of the pattern's shape rather than just of its text. This also exercises the loop
// threading (len < grid here) and caught note() choking on ":vel" tokens. Probability is left out
// because the builder's rng and mini's `?` draw independently (both honor the odds, but not the
// same coin flips).
test('pianoroll(): playback matches its own mini-notation conversion', () => {
  const cases = [
    ['60,0,2 64,2,1,0.5 67,5,3', 16, 8], // every field varies: the whole .as("note:vel:clip") token
    ['60,0,2 64,2,2 67,5,2', 16, 8], // one length throughout -> .clip(2)
    ['60,0,2,0.5 64,2,1,0.5 67,5,3,0.5', 16, 8], // one velocity throughout -> .vel(0.5)
    ['60,0,1 60,2,2 60,5,3', 16, 8], // one pitch throughout -> .note(60), the cells keeping clip
    ['60,0,4,0.5 60,4,4,0.5', 8, 8], // nothing varies at all: the pitch stays in the cells
  ];
  for (const [str, grid, len] of cases) {
    const pr = pianoroll(str, { grid, len });
    const rebuilt = rebuildMini(pianoRollToMini(parsePianoRoll(str), { grid, len }));
    for (const c of [0, 1, 2, 3]) assert.deepEqual(soundsLike(rebuilt, c), soundsLike(pr, c), str);
  }
});

// A column of identical `:0.5`s says nothing per cell, so a field the whole window agrees on is
// lifted onto its own control call - where it can be edited once - and the cells keep only what
// actually varies.
test('pianoRollToMini: a field every note agrees on is lifted onto a control call', () => {
  // One length throughout: the cells go back to bare pitches and the length rides on .clip().
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,2 64,1,2 67,2,2'), { grid: 4, len: 4 }),
    'note(`<\n  60 64 67 ~\n>*4`).clip(2)',
  );
  // One velocity throughout, same idea.
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,1,0.5 64,1,1,0.5'), { grid: 4, len: 2 }),
    'note(`<\n  60 64\n>*4`).vel(0.5)',
  );
  // One PITCH throughout - a drum lane, or a repeated note - leaves the varying fields in the
  // cells behind a .as() that no longer has a pitch slot at all.
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,2,0.5 60,2,3,0.5'), { grid: 4, len: 4 }),
    '`<\n  2 ~ 3 ~\n>*4`.as("clip").note(60).vel(0.5)',
  );
  // In a key it's the degree that lifts out, ahead of the .sc() that reads it.
  assert.equal(
    pianoRollToMini(parsePianoRoll('41,0,2,0.5 41,2,4,1'), { grid: 4, len: 4, scale: 'F minor' }),
    '`<\n  0.5:2 ~ 1:4 ~\n>*4`.as("vel:clip").n(0).sc(3)',
  );
  // Nothing varies at all: the cells are still the rhythm, so the pitch stays in them and only the
  // other fields lift out.
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,2,0.5 60,2,2,0.5'), { grid: 4, len: 4 }),
    'note(`<\n  60 ~ 60 ~\n>*4`).vel(0.5).clip(2)',
  );
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

// A muted note is drawn but switched off: it never reaches the step grid, and the notes around it
// play as if it weren't there. Unmuting is only ever a `!` coming off the token.
test('pianoroll(): a muted note is silent, and the rest of the roll is unchanged', () => {
  const steps = pianoroll('!60,0,4 64,0,4 67,8,8', { grid: 16, len: 16 }).stepsForCycle(0);
  assert.deepEqual(steps.map((s) => s.value), [64, 67]);
  // muting every note is silence, not an error - the panel can write this state
  assert.deepEqual(pianoroll('!60,0,4 !64,0,4', { grid: 16, len: 16 }).stepsForCycle(0), []);
  // and it plays identically to the same roll with the muted note simply removed
  assert.deepEqual(
    pianoroll('!60,0,4 64,0,4 67,8,8', { grid: 16, len: 16 }).stepsForCycle(2),
    pianoroll('64,0,4 67,8,8', { grid: 16, len: 16 }).stepsForCycle(2),
  );
});

// →♪ writes down what the roll PLAYS, and mini-notation has no spelling for a switched-off note.
test('pianoRollToMini: muted notes are left out', () => {
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,1 !64,1,1 67,2,1'), { grid: 16, len: 3 }),
    'note(`<\n  60 ~ 67\n>*16`)',
  );
  // a muted note is also not a reason to emit the vel/clip fields, nor to pick the octave
  assert.equal(
    pianoRollToMini(parsePianoRoll('!41,0,2,0.5 48,2,1'), { grid: 4, len: 4, scale: 'F minor' }),
    'n(`<\n  ~ ~ 4 ~\n>*4`).sc(3)',
  );
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

// Typing `pianoroll()` to open the editor - or clearing every note out of it - has to be an empty
// roll, not an error: the panel writes the code back on each edit, so any state it can produce must
// evaluate. Empty means silence, all the way through to the notes the scheduler would send.
test('pianoroll(): an empty roll is silence, not an error', () => {
  for (const p of [pianoroll(), pianoroll(''), pianoroll('   '), pianoroll('', { grid: 32, len: 3 })]) {
    assert.equal(p.pitchKind, 'note');
    for (const c of [0, 1, 5]) assert.deepEqual(p.stepsForCycle(c), []);
    assert.equal(p.sample(0, 1, 0), null);
  }
  assert.equal(pianoRollToMini([], { grid: 4, len: 4 }), 'note(`<\n  ~ ~ ~ ~\n>*4`)');
});

test('pianoroll(): an empty roll schedules no notes', () => {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const sch = new Scheduler(engine, { trackId: 'roll' });
  sch.setPattern(pianoroll().synth('Serum 2'));
  sch._scheduleNoteEdges(0, 4);
  assert.equal(calls.filter((c) => c.method === 'noteOn').length, 0);
});


// ------------------------------------------------------------------ the loop window ({ start })
// The playing window is `len` cells from `start`, and cell `start` is the pattern's first beat -
// so a window dragged half way into the roll plays the notes it covers, from its own left edge.

test('pianoroll(): start opens the loop window part way into the roll', () => {
  const str = '60,0,1 64,2,1 67,3,1';
  const steps = pianoroll(str, { grid: 4, len: 2, start: 2 }).stepsForCycle(0);
  // cells 2,3 are the window; cell 2 sounds first, and the note at cell 0 is outside it
  assert.deepEqual(steps.map((s) => ({ start: s.start, value: s.value })), [
    { start: 0, value: 64 },
    { start: 0.25, value: 67 },
    { start: 0.5, value: 64 },
    { start: 0.75, value: 67 },
  ]);
  // and it is exactly the same music as the same two notes drawn at the top of the roll
  assert.deepEqual(steps, pianoroll('64,0,1 67,1,1', { grid: 4, len: 2 }).stepsForCycle(0));
});

test('pianoroll(): a window that starts mid-bar threads across the cycle like any other', () => {
  const p = pianoroll('60,2,1 64,3,1 67,4,1', { grid: 4, len: 3, start: 2 });
  assert.deepEqual(p.stepsForCycle(0).map((s) => s.value), [60, 64, 67, 60]);
  // cell 4 of cycle 1 is window cell (4 mod 3) = 1 -> the note drawn at roll cell 3
  assert.equal(p.stepsForCycle(1)[0].value, 64);
});

test('pianoRollToMini: the window is what gets written, from its own left edge', () => {
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,1 64,2,1 67,3,1'), { grid: 4, len: 2, start: 2 }),
    'note(`<\n  64 67\n>*4`)',
  );
  // a note outside the window doesn't sound, so it isn't written - not even as a rest's worth of length
  assert.equal(
    pianoRollToMini(parsePianoRoll('60,0,4 72,6,1'), { grid: 4, len: 4, start: 2 }),
    'note(`<\n  ~ ~ ~ ~\n>*4`)',
  );
});

// ------------------------------------------------------------------ the editor's roll-wide edits

test('rescalePianoRoll: notes keep their span in time, rounding when it must', () => {
  const notes = parsePianoRoll('60,0,4 64,4,2');
  rescalePianoRoll(notes, 4); // a 1/4 grid re-meshed as 1/16: every cell becomes four
  assert.equal(serializePianoRoll(notes), '60,0,16 64,16,8');
  rescalePianoRoll(notes, 1 / 4); // and back
  assert.equal(serializePianoRoll(notes), '60,0,4 64,4,2');
  // coarsening can't take a note below a single cell
  const short = parsePianoRoll('60,3,1');
  rescalePianoRoll(short, 1 / 4);
  assert.equal(serializePianoRoll(short), '60,1,1');
});

// ×2 / ÷2 with a selection: only those notes move, and they spread from the first of them, so the
// phrase keeps the beat it starts on.
test('rescalePianoRoll: an anchor holds one cell still while the rest spread from it', () => {
  const phrase = parsePianoRoll('60,4,1 64,6,1 67,8,2');
  rescalePianoRoll(phrase, 2, 4); // stretched about its own first onset
  assert.equal(serializePianoRoll(phrase), '60,4,2 64,8,2 67,12,4');
  rescalePianoRoll(phrase, 0.5, 4);
  assert.equal(serializePianoRoll(phrase), '60,4,1 64,6,1 67,8,2');
  // halving a phrase that is already all single cells can only round them together - the caller's
  // clipOverlaps settles that, it isn't an error here
  const tight = parsePianoRoll('60,4,1 60,5,1 60,6,1');
  rescalePianoRoll(tight, 0.5, 4);
  assert.deepEqual(tight.map((n) => n.start), [4, 5, 5]);
});

test('regridPianoRoll: a finer grid plays the same music', () => {
  const roll = { notes: parsePianoRoll('60,0,1 64,1,1'), grid: 4, len: 4, start: 1 };
  const next = regridPianoRoll(roll, 16);
  assert.deepEqual(next, { grid: 16, len: 16, start: 4 });
  assert.equal(serializePianoRoll(roll.notes), '60,0,4 64,4,4');
  // the drawn (unclipped) length moves with it, so the overlap rule resolves the same way
  assert.deepEqual(roll.notes.map((n) => n.full), [4, 4]);
  // the notes sound at the same times as before
  const before = pianoroll('60,0,1 64,1,1', { grid: 4, len: 4, start: 1 }).stepsForCycle(0);
  const after = pianoroll(serializePianoRoll(roll.notes), { ...next }).stepsForCycle(0);
  assert.deepEqual(after, before);
});

test('retimePianoRoll: the grid carries the stretch, leaving the cells (and len) alone', () => {
  const roll = { notes: parsePianoRoll('60,0,4'), grid: 16, len: 16, start: 0 };
  assert.deepEqual(retimePianoRoll(roll, 0.5), { grid: 32, len: 16, start: 0 }); // half as long
  assert.equal(serializePianoRoll(roll.notes), '60,0,4'); // ...losslessly: nothing moved
  assert.deepEqual(retimePianoRoll({ ...roll, grid: 32 }, 2), { grid: 16, len: 16, start: 0 }); // and back
  // one bar of 1/16 notes really does become half a bar
  const whole = pianoroll('60,0,16', { grid: 16, len: 16 }).stepsForCycle(0)[0];
  const half = pianoroll('60,0,16', { grid: 32, len: 16 }).stepsForCycle(0)[0];
  assert.equal(whole.end - whole.start, 1);
  assert.equal(half.end - half.start, 0.5);
});

test('retimePianoRoll: a grid that cannot take it moves the notes instead', () => {
  const roll = { notes: parsePianoRoll('60,1,1 64,3,2'), grid: 3, len: 3, start: 1 };
  assert.deepEqual(retimePianoRoll(roll, 2), { grid: 3, len: 6, start: 2 }); // 3/2 is not a grid
  assert.equal(serializePianoRoll(roll.notes), '60,2,2 64,6,4');
});

test('duplicatePianoRollLoop: the window repeats after itself at twice the length', () => {
  const roll = { notes: parsePianoRoll('60,0,2 64,2,2'), grid: 4, len: 4, start: 0 };
  const { copies, len } = duplicatePianoRollLoop(roll);
  assert.equal(len, 8);
  assert.equal(serializePianoRoll(copies), '60,4,2 64,6,2');
  // the doubled roll plays the one-bar phrase twice
  const doubled = pianoroll(serializePianoRoll([...roll.notes, ...copies]), { grid: 4, len: 8 });
  assert.deepEqual(doubled.stepsForCycle(0).map((s) => s.value), [60, 64]);
  assert.deepEqual(doubled.stepsForCycle(1).map((s) => s.value), [60, 64]);
});

test('duplicatePianoRollLoop: only what the window plays is repeated', () => {
  const roll = { notes: parsePianoRoll('60,0,1 64,4,1 67,9,1'), grid: 4, len: 4, start: 4 };
  const { copies, len } = duplicatePianoRollLoop(roll);
  assert.equal(len, 8);
  assert.equal(serializePianoRoll(copies), '64,8,1'); // the notes outside the window stay put
});

// ---------------------------------------------------------------------------------------------
// The sample-index channel. Every event carries a pitch AND an index - two channels of one event -
// and the roll's `mode` only says which of them the editor's vertical axis is showing. Playback
// reads both whichever mode the roll is in, so switching modes is a change of view and nothing
// else: that is what makes the drawn timings shared between the two.
// ---------------------------------------------------------------------------------------------

test('normalizePianoRollMode: index, and everything else is the note axis', () => {
  assert.equal(normalizePianoRollMode('index'), 'index');
  assert.equal(normalizePianoRollMode(' INDEX '), 'index');
  assert.equal(normalizePianoRollMode('note'), 'note');
  assert.equal(normalizePianoRollMode(undefined), 'note'); // every roll written before index mode
  assert.equal(normalizePianoRollMode('pitch'), 'note'); // a typo opens the keyboard, and warns
});

// The one thing the two modes disagree about: which channel a freshly drawn note sets, and what
// the other one is left at.
test('pianoRollEventAt: the drawn channel takes the row, the other its default', () => {
  assert.deepEqual(pianoRollEventAt(60, 'note'), { midi: 60, index: PIANOROLL_DEFAULT_INDEX });
  assert.deepEqual(pianoRollEventAt(3, 'index'), { midi: PIANOROLL_DEFAULT_NOTE, index: 3 });
  assert.deepEqual(pianoRollEventAt(-5, 'index'), { midi: PIANOROLL_DEFAULT_NOTE, index: 0 });
  assert.equal(noteIndex({ midi: 60 }), PIANOROLL_DEFAULT_INDEX); // a note from before the channel
});

// The string is the same string in both modes, so a roll can be switched between them without a
// single note being rewritten - the whole point of keeping the two channels on one event.
test('serializePianoRoll: the index rides on the pitch field, and only when it is set', () => {
  assert.equal(serializePianoRoll(parsePianoRoll('60,0,4')), '60,0,4');
  assert.equal(serializePianoRoll(parsePianoRoll('24:3,0,1 24:0,2,1')), '24:3,0,1 24,2,1');
  // both channels set, plus the fields behind them
  assert.equal(serializePianoRoll(parsePianoRoll('!67:5,4,2,0.5,0.25')), '!67:5,4,2,0.5,0.25');
});

// A lane is a pitch AND an index, so an overlap only resolves between events that really are the
// same event twice. Keyed on the visible axis instead, switching modes would silently delete notes.
test('clipOverlaps: two files struck at one pitch and onset are not an overlap', () => {
  const stack = clipOverlaps(parsePianoRoll('24:0,0,4 24:3,0,4'));
  assert.deepEqual(stack.map((nt) => [nt.len, !!nt.hidden]), [[4, false], [4, false]]);
  // ...but the same file twice at one pitch still gives way, exactly as before
  const same = clipOverlaps(parsePianoRoll('24:3,0,4 24:3,0,4'));
  assert.deepEqual(same.map((nt) => !!nt.hidden), [true, false]);
  // and a pitch line drawn with no indices at all resolves as it always did
  const line = clipOverlaps(parsePianoRoll('60,0,8 60,4,2'));
  assert.deepEqual(line.map((nt) => nt.len), [4, 2]);
});

// The index goes to each event's `i` channel, per event (step.cfg, which the scheduler reads ahead
// of the channel). A roll that sets no index says nothing about the channel at all, so a later
// .i() on it means exactly what it always meant.
test('pianoroll(): the drawn index rides on every event', () => {
  const steps = pianoroll('24:0,0,2 24:3,4,1,0.5', { grid: 8, len: 8 }).stepsForCycle(0);
  assert.deepEqual(steps.map((st) => st.cfg), [{ index: 0 }, { index: 3 }]);
  assert.deepEqual(steps.map((st) => st.value), [24, 24]); // c2 - a sample plays as recorded
  assert.deepEqual(steps.map((st) => [st.start, st.end, st.vel]), [[0, 0.25, 1], [0.5, 0.625, 0.5]]);
  // a stack is several files struck together - one onset, an index each, which is exactly why the
  // index rides on the event rather than being sampled off a channel at the shared onset
  const stack = pianoroll('24:0,0,1 24:2,0,1 24:5,0,1', { grid: 8 }).stepsForCycle(0);
  assert.deepEqual(stack.map((st) => st.cfg.index).sort((a, b) => a - b), [0, 2, 5]);
  assert.ok(stack.every((st) => st.start === 0));
  // a roll of plain pitches leaves the channel alone
  assert.ok(pianoroll('60,0,2 64,4,1', { grid: 8 }).stepsForCycle(0).every((st) => st.cfg === undefined));
});

// mode is EDITOR metadata: it picks the panel's axis and touches nothing that sounds.
test('pianoroll(): the mode changes no sound', () => {
  const str = '60:2,0,2 67:5,4,1,0.5';
  for (const c of [0, 1, 2]) {
    assert.deepEqual(
      pianoroll(str, { grid: 8, len: 8, mode: 'index' }).stepsForCycle(c),
      pianoroll(str, { grid: 8, len: 8 }).stepsForCycle(c),
    );
  }
});

// The index has to survive becoming a sampler - that is the whole chain the channel exists for.
test('pianoroll(): the drawn index carries through .s()', () => {
  const steps = pianoroll('24:0,0,1 24:3,2,1', { grid: 4 }).s('breaks').stepsForCycle(0);
  assert.deepEqual(steps.map((st) => st.value), ['breaks', 'breaks']);
  assert.deepEqual(steps.map((st) => st.cfg.index), [0, 3]);
  assert.deepEqual(steps.map((st) => st.cfg.note), [24, 24]); // repitched to native speed, as drawn
  // an explicit .i() afterwards is the later word. A patterned one stamps its own value onto each
  // event; a plain number has no grid to stamp from, so it takes the drawn index back OFF them and
  // is sampled off the channel at each onset instead.
  const patterned = pianoroll('24:0,0,1 24:3,2,1', { grid: 4 }).s('breaks').i('7 7').stepsForCycle(0);
  assert.deepEqual(patterned.map((st) => st.cfg.index), [7, 7]);
  const flat = pianoroll('24:0,0,1 24:3,2,1', { grid: 4 }).s('breaks').i(7);
  assert.deepEqual(flat.stepsForCycle(0).map((st) => st.cfg.index), [undefined, undefined]);
  assert.equal(flat.sampler.index.sample(0, 1, 0), 7);
});

// →♪ writes down every channel the roll actually sets, and leaves out the ones it doesn't: `i` on
// its own where only files vary, both fields where both do, and neither where the roll is a plain
// melody. The index never lifts onto a control call - .i() needs a sampler, and this expression is
// written where the pianoroll() call was, before the .s().
test('pianoRollToMini: the i channel is written whenever it is set', () => {
  // only files vary: the pitch is the default throughout, so no note field at all
  assert.equal(
    pianoRollToMini(parsePianoRoll('24:0,0,1 24:3,1,1 24:1,2,1'), { grid: 4, len: 4, mode: 'index' }),
    'i(`<\n  0 3 1 ~\n>*4`)',
  );
  // both channels set - the case that used to lose one of them. A token whose trailing fields are
  // all defaults still trims them, so the first note here is a bare `60` meaning "file 0".
  assert.equal(
    pianoRollToMini(parsePianoRoll('60:0,0,1 67:3,1,1'), { grid: 4, len: 2 }),
    '`<\n  60 67:3\n>*4`.as("note:i")',
  );
  // ...and with vel too, in field order
  assert.equal(
    pianoRollToMini(parsePianoRoll('60:0,0,1 67:3,1,1,0.5'), { grid: 4, len: 2 }),
    '`<\n  60 67:3:0.5\n>*4`.as("note:i:vel")',
  );
  // one index throughout: it stays in the cells (there is nowhere to lift it to) while vel varies
  assert.equal(
    pianoRollToMini(parsePianoRoll('24:2,0,1,0.5 24:2,1,1,0.9'), { grid: 4, len: 2, mode: 'index' }),
    '`<\n  2:0.5 2:0.9\n>*4`.as("i:vel")',
  );
  // an index is not a pitch, so a scale can't be written into one
  assert.equal(
    pianoRollToMini(parsePianoRoll('24:0,0,1 24:3,1,1'), { grid: 4, len: 2, mode: 'index', scale: 'F minor' }),
    'i(`<\n  0 3\n>*4`)',
  );
  // a plain melody writes no i field, exactly as it did before the channel existed
  assert.equal(pianoRollToMini(parsePianoRoll('60,0,1 64,1,1'), { grid: 4, len: 2 }), 'note(`<\n  60 64\n>*4`)');
});

/** The emitted expression, rebuilt as the eval sandbox would - a bare template literal is mini. */
const rebuildIndexMini = (expr) =>
  // eslint-disable-next-line no-new-func
  new Function('mini', 'i', 'note', `return ${expr.replace(/^`([\s\S]*?)`/, 'mini(`$1`)')};`)(mini, i, note);

/** What a sampler track actually fires: when, for how long, how loud, and out of which file. */
const indexSteps = (sig, cycle) =>
  sig
    .stepsForCycle(cycle)
    .map((st) => {
      const at = cycle + st.start;
      return {
        s: +st.start.toFixed(4),
        e: +soundingEnd(st, sig.noteChannels, at, 1, at).toFixed(4),
        i: st.cfg?.index ?? 0,
        note: st.cfg?.note ?? 24,
        vel: channelAt('vel', st, sig.noteChannels, at, 1, at) ?? 1,
      };
    })
    .sort((a, b) => a.s - b.s || a.i - b.i);

// ...and what it writes plays what the roll played, which is the only promise →♪ makes.
test('pianoroll(): an index roll plays its own mini-notation conversion', () => {
  const cases = [
    ['24:0,0,1 24:3,2,1', 4, 4, 'index'],
    ['24:0,0,2 24:3,2,1,0.5 24:1,5,3', 8, 8, 'index'],
    ['24:2,0,1,0.5 24:2,3,1,0.9', 4, 4, 'index'], // one file throughout, velocity varying
    ['60:0,0,1 67:3,2,1', 4, 4, 'note'], // both channels at once
  ];
  for (const [str, grid, len, mode] of cases) {
    const drawn = pianoroll(str, { grid, len, mode }).s('breaks');
    const rebuilt = rebuildIndexMini(pianoRollToMini(parsePianoRoll(str), { grid, len, mode })).s('breaks');
    for (const c of [0, 1, 2]) assert.deepEqual(indexSteps(rebuilt, c), indexSteps(drawn, c), `${str} @${c}`);
  }
});

// .as("i") is the written form of the same thing, and what an index roll converts to.
test('as(): the i field rides on the event and survives .s()', () => {
  const steps = mini('<0 3>*2').as('i').s('breaks').stepsForCycle(0);
  assert.deepEqual(steps.map((st) => st.cfg.index), [0, 3]);
  assert.deepEqual(steps.map((st) => st.value), ['breaks', 'breaks']);
  // with no pitch field every present token fires the default note, as .as("vel") does
  assert.deepEqual(mini('<0 3>*2').as('i').stepsForCycle(0).map((st) => st.value), [24, 24]);
  // alongside a pitch, both land on the same event
  const both = mini('<60:3 67:5>*2').as('note:i').s('breaks').stepsForCycle(0);
  assert.deepEqual(both.map((st) => [st.cfg.note, st.cfg.index]), [[60, 3], [67, 5]]);
  assert.throws(() => mini('0').as('idx'), /unknown field "idx"/);
});

// A sampler pattern is where the index channel normally lives; the drawn roll and the written
// control have to land on the same events.
test('pianoroll(): a drawn index agrees with s().i()', () => {
  const drawn = pianoroll('24:0,0,1 24:3,1,1 24:1,2,1 24:5,3,1', { grid: 4, mode: 'index' }).s('breaks');
  assert.deepEqual(indexSteps(drawn, 0), indexSteps(s('breaks*4').i('0 3 1 5'), 0));
});

// The bug this channel first ran into: a head control that picks up a note channel on the way to
// its sound has to KEEP being a control, or .s() reads its values as pitches - `i("0 12 6")` played
// the pack's first file transposed to nothing instead of three different files.
test('a head control survives .vel()/.clip() on its way to .s()', () => {
  const steps = i('<0 12 6>*3').vel(0.8).s('dstab').stepsForCycle(0);
  assert.deepEqual(steps.map((st) => st.value), ['dstab', 'dstab', 'dstab']);
  assert.deepEqual(steps.map((st) => st.cfg.index), [0, 12, 6]);
  assert.deepEqual(steps.map((st) => st.cfg.note), [24, 24, 24]); // not 0/12/6 read as pitches
  // it is exactly the method form, which is what "head position" promises
  assert.deepEqual(
    indexSteps(i('<0 12 6>*3').vel(0.8).s('dstab'), 0),
    indexSteps(s('dstab*3').i('0 12 6').vel(0.8), 0),
  );
  // ...and the same holds for the note controls in head position
  assert.deepEqual(vel('<1 0.5>*2').clip(2).s('bd').stepsForCycle(0).map((st) => st.value), ['bd', 'bd']);
});
