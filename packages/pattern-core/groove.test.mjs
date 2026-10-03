// Grooves - swing generalized from one number to a per-slot table (see groove.mjs). Two things to
// keep honest: the table's arithmetic, and that generalizing it changed nothing about the swing that
// was already there - a plain .swing() has to come out at the same numbers, not near-enough ones.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, note, pianoroll, timeShift, grooveVelScale, setPatternWarn, _groove, liveGroove, grooveText } from './src/signal.mjs';
import { parsePianoRoll, serializePianoRoll, pianoRollSwingCells, commitPianoRollSwing } from './src/pianoroll.mjs';
import {
  parseGroove,
  serializeGroove,
  grooveSlot,
  grooveTimeAt,
  grooveVelAt,
  grooveIsFlat,
  grooveRef,
  resolveGroove,
  looksLikeGrooveData,
  grooveNameLike,
  GROOVE_PRESETS,
  GROOVE_NAMES,
} from './src/groove.mjs';
import { Scheduler } from './src/scheduler.mjs';

// The shift one step asks for, in cycles - the pattern's groove goes along, as every caller of
// timeShift passes it (the scheduler and the highlighter both).
function shiftOf(sig, stepIndex = 0, cycle = 0) {
  const step = sig.stepsForCycle(cycle)[stepIndex];
  const at = cycle + step.start;
  return timeShift(step, sig.noteChannels, at, 1, at, sig.groove);
}

const shifts = (sig, cycle = 0) =>
  sig.stepsForCycle(cycle).map((_, idx) => Number(shiftOf(sig, idx, cycle).toFixed(10)));

function warningsFrom(fn) {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  try {
    fn();
  } finally {
    setPatternWarn(null);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The table format
// ---------------------------------------------------------------------------------------------

test('a groove is a list of per-slot offsets, and its length is the grid', () => {
  const g = parseGroove('0 1 0 1');
  assert.equal(g.steps, 4);
  assert.deepEqual([...g.time], [0, 1, 0, 1]);
  assert.equal(g.vel, null, 'no velocity row means it says nothing about velocity');
});

test('a velocity row follows a slash, and has to describe the same grid', () => {
  const g = parseGroove('0 1 0 1 / 1 0.8 1 0.8');
  assert.deepEqual([...g.vel], [1, 0.8, 1, 0.8]);
  assert.throws(() => parseGroove('0 1 0 1 / 1 0.8'), /same grid/);
  assert.throws(() => parseGroove('0 1 / 1 1 / 1 1'), /two with velocities/);
});

test('commas read the same as spaces, and junk says which slot it choked on', () => {
  assert.deepEqual([...parseGroove('0, 0.5, 0, 0.5').time], [0, 0.5, 0, 0.5]);
  assert.throws(() => parseGroove('0 late 0'), /bad offset "late"/);
  assert.throws(() => parseGroove(''), /at least one slot/);
});

test('a table round-trips through its text, and drops a velocity row that does nothing', () => {
  const text = '0 0.333 0 0.333';
  assert.equal(serializeGroove(parseGroove(text)), text);
  assert.equal(serializeGroove(parseGroove('0 1 / 1 1')), '0 1', 'all-1 velocities are no velocities');
  assert.equal(serializeGroove(parseGroove('0 1 / 1 0.5')), '0 1 / 1 0.5');
});

test('a name is told from a table by whether it has letters in it', () => {
  assert.ok(grooveNameLike('clave16'));
  assert.ok(grooveNameLike('my-feel'));
  assert.ok(!grooveNameLike('0 1 0 1'), 'a table is not a name');
  assert.ok(!grooveNameLike('<0 0.33>'), 'nor is a pattern of amounts');
  assert.ok(looksLikeGrooveData('0 1 0 1'));
  assert.ok(!looksLikeGrooveData('clave16'));
});

test('a flat groove is one that moves nothing and touches no velocity', () => {
  assert.ok(grooveIsFlat(parseGroove('0 0 0 0')));
  assert.ok(grooveIsFlat(parseGroove('0')));
  assert.ok(!grooveIsFlat(parseGroove('0 0.1')));
  assert.ok(!grooveIsFlat(parseGroove('0 0 / 1 0.5')), 'a velocity-only groove still does something');
});

// ---------------------------------------------------------------------------------------------
// Reading a slot
// ---------------------------------------------------------------------------------------------

test('a position reads the slot it falls IN, so finer notes ride with their slot', () => {
  const g = parseGroove('0 1 0 1'); // quarters
  assert.equal(grooveSlot(g, 0), 0);
  assert.equal(grooveSlot(g, 0.25), 1);
  assert.equal(grooveSlot(g, 0.3), 1, 'a sixteenth inside the slot belongs to the slot');
  assert.equal(grooveTimeAt(g, 0.3), 1);
  assert.equal(grooveTimeAt(g, 0), 0);
});

test('slot boundaries that floating point cannot hit exactly still land right', () => {
  // 1/8 * 8 is 0.9999999999999999 as often as it is 1, which is why the slot index is taken with an
  // epsilon. Every eighth of a 8-slot table has to read its own slot and not the one before it.
  const g = parseGroove('0 1 0 1 0 1 0 1');
  for (let k = 0; k < 8; k++) assert.equal(grooveSlot(g, k / 8), k, `slot ${k}`);
  for (let k = 0; k < 16; k++) assert.equal(grooveSlot(g, k / 16), Math.floor(k / 2), `sixteenth ${k}`);
});

test('a position at or past the end of the cycle wraps, as an event END edge does', () => {
  const g = parseGroove('0 1 0 1');
  assert.equal(grooveSlot(g, 1), 0, 'the next cycle\'s downbeat is slot 0 again');
  assert.equal(grooveSlot(g, 1.25), 1);
  assert.equal(grooveSlot(g, -0.25), 3, 'and a position before the cycle reads from the end');
});

test('velocity reads 1 where the table says nothing', () => {
  assert.equal(grooveVelAt(parseGroove('0 1'), 0.5), 1);
  assert.equal(grooveVelAt(parseGroove('0 1 / 1 0.6'), 0.5), 0.6);
});

// ---------------------------------------------------------------------------------------------
// References and resolution
// ---------------------------------------------------------------------------------------------

test('a name is carried as a name and resolved when it is read', () => {
  const ref = grooveRef('clave16');
  assert.equal(ref.name, 'clave16');
  assert.equal(ref.time, null, 'not resolved where the pattern was built');
  assert.equal(resolveGroove(ref).steps, 16, 'resolved when something reads it');
  // A preset name is no different - so a groove saved under one shadows it rather than losing to
  // whichever was known first.
  assert.equal(grooveRef('swing8').time, null);
});

test('a table is its own answer, from text or from a list', () => {
  assert.deepEqual([...resolveGroove(grooveRef('0 1 0 1')).time], [0, 1, 0, 1]);
  assert.deepEqual([...resolveGroove(grooveRef([0, 0.5])).time], [0, 0.5]);
  assert.deepEqual([...grooveRef({ time: [0, 0.2], vel: [1, 0.9] }).vel], [1, 0.9]);
  assert.equal(resolveGroove(null), null);
});

test('every groove that ships can be read, and none of them is flat', () => {
  for (const name of GROOVE_NAMES) {
    const table = resolveGroove(grooveRef(name));
    assert.ok(table, `${name} resolves`);
    assert.equal(table.steps, parseGroove(GROOVE_PRESETS[name]).steps);
    if (name !== 'straight') assert.ok(!grooveIsFlat(table), `${name} does something`);
    for (const v of table.time) assert.ok(Math.abs(v) <= 1, `${name} stays within a slot's worth`);
  }
  assert.ok(grooveIsFlat(resolveGroove(grooveRef('straight'))), 'except the one whose job is nothing');
});

// ---------------------------------------------------------------------------------------------
// What it does to a pattern
// ---------------------------------------------------------------------------------------------

test('a groove displaces the slots its table displaces, and only those', () => {
  const hats = s('hh*8').swing(1, [0, 1, 0, 1, 0, 1, 0, 1]);
  // Eight slots, the odd ones a whole slot's worth - clamped to half, since past that they would
  // land on the onbeat after them.
  assert.deepEqual(shifts(hats), [0, 1 / 16, 0, 1 / 16, 0, 1 / 16, 0, 1 / 16].map((x) => Number(x.toFixed(10))));
});

test('the amount is the DEPTH on the table, so the same groove comes in at any strength', () => {
  const at = (depth) => shiftOf(s('hh*8').swing(depth, [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5]), 1);
  assert.equal(at(1).toFixed(10), (0.5 / 8).toFixed(10), 'depth 1 is the table as it was written');
  assert.equal(at(0.5).toFixed(10), (0.25 / 8).toFixed(10), 'and half of it is half as far');
  assert.equal(at(0), 0, 'depth 0 is straight, whatever the table says');
});

test('what clamps is the depth times the value, not either on its own', () => {
  // Half a slot is as far as a slot can move - past that it has swapped places with the slot after
  // it - and that has to hold however the distance was asked for.
  const full = (table, depth) => shiftOf(s('hh*8').swing(depth, table), 1);
  const alt = (v) => [0, v, 0, v, 0, v, 0, v];
  assert.equal(full(alt(1), 1).toFixed(10), (0.5 / 8).toFixed(10), 'a whole slot asked for, half given');
  assert.equal(full(alt(2), 0.2).toFixed(10), (0.4 / 8).toFixed(10), 'a big value at a small depth is under the stop');
  assert.equal(full(alt(2), 0.5).toFixed(10), (0.5 / 8).toFixed(10), '...and the same value deeper reaches it');
  assert.equal(full(alt(-1), 1).toFixed(10), (-0.5 / 8).toFixed(10), 'and it holds going early too');
});

test('a groove is exactly the swing it generalizes - the two-slot table, at the same numbers', () => {
  // The compatibility claim the whole design rests on: the alternating table AT a grid has to give
  // what .swing(amount, grid) gives, slot for slot.
  for (const grid of [8, 16]) {
    const table = Array.from({ length: grid }, (_, k) => k % 2);
    for (const amount of [1 / 3, 0.2, 0.5, -0.1]) {
      assert.deepEqual(
        shifts(s('hh*16').swing(amount, table)),
        shifts(s('hh*16').swing(amount, grid)),
        `swing(${amount}, ${grid})`,
      );
    }
  }
});

test('a groove can move onbeats too, which is the whole point of having a table', () => {
  // Nothing a plain swing can say: slot 0 late and slot 1 early.
  const g = s('hh*4').swing(1, [0.2, -0.2, 0.2, -0.2]);
  assert.deepEqual(shifts(g), [0.2 / 4, -0.2 / 4, 0.2 / 4, -0.2 / 4].map((x) => Number(x.toFixed(10))));
});

test('a coarser slot left at zero keeps its notes on the beat while finer ones move', () => {
  // The "unswung up to this level" reading: quarters land on slots 0, 4, 8, 12 of a 16 table, so
  // zeroing those leaves them dead on however hard the sixteenths between them are pushed.
  const table = Array.from({ length: 16 }, (_, k) => (k % 4 === 0 ? 0 : 1));
  const quarters = s('hh*4').swing(0.4, table);
  assert.deepEqual(shifts(quarters), [0, 0, 0, 0]);
  const sixteenths = shifts(s('hh*16').swing(0.4, table));
  assert.deepEqual(sixteenths.filter((_, k) => k % 4 === 0), [0, 0, 0, 0], 'the quarters of the same line');
  for (const k of [1, 2, 3, 5]) assert.equal(sixteenths[k].toFixed(10), (0.4 / 16).toFixed(10));
});

test('a groove brings its own subdivision, so swinggrid has nothing left to say', () => {
  const g = s('hh*8').swinggrid(4).swing(1, [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.equal(g.noteChannels.swinggrid, undefined, 'the stale grid is cleared, not left to disagree');
  assert.deepEqual(shifts(g), shifts(s('hh*8').swing(1, [0, 1, 0, 1, 0, 1, 0, 1])));
});

test('nudge still sums with a groove, so a printed groove can be swung again', () => {
  const both = s('hh*8').nudge(0.05).swing(1 / 3, [0, 1, 0, 1, 0, 1, 0, 1]);
  const stepWidth = 1 / 8;
  assert.equal(shiftOf(both, 0).toFixed(10), (0.05 * stepWidth).toFixed(10));
  assert.equal(shiftOf(both, 1).toFixed(10), (0.05 * stepWidth + 1 / 24).toFixed(10));
});

test('a groove does not move the pattern - only the emitted times', () => {
  const straight = s('hh*8');
  const swung = s('hh*8').swing(1, 'metric16');
  assert.deepEqual(swung.stepsForCycle(0).map((x) => x.start), straight.stepsForCycle(0).map((x) => x.start));
  assert.deepEqual(swung.stepsForCycle(0).map((x) => x.end), straight.stepsForCycle(0).map((x) => x.end));
});

// ---------------------------------------------------------------------------------------------
// The builder's readings and its advice
// ---------------------------------------------------------------------------------------------

test('a name on its own is that groove at full depth', () => {
  assert.deepEqual(shifts(s('hh*16').swing('clave16')), shifts(s('hh*16').swing(1, 'clave16')));
  assert.equal(s('hh*16').swing('clave16').groove.name, 'clave16');
});

test('a numeric string is still the patterned amount it always was', () => {
  const alternating = s('hh*8').swing('<0 0.5>');
  assert.equal(alternating.groove, null, 'no groove was read out of an amount');
  assert.deepEqual(shifts(alternating, 0), new Array(8).fill(0));
  assert.deepEqual(shifts(alternating, 1), [0, 1 / 16, 0, 1 / 16, 0, 1 / 16, 0, 1 / 16].map((x) => Number(x.toFixed(10))));
});

test('a string of numbers in the grid position is still a patterned subdivision', () => {
  // Grooves took over the grid position, and this is what they must not have taken with them: the
  // subdivision has always accepted a pattern, and only a NAME reads as a groove.
  const patterned = s('hh*16').swing(0.5, '<8 16>');
  assert.equal(patterned.groove, null, 'no groove was read out of a subdivision');
  assert.deepEqual(shifts(patterned, 0), shifts(s('hh*16').swing(0.5, 8)), 'eighths on the first bar');
  assert.deepEqual(shifts(patterned, 1), shifts(s('hh*16').swing(0.5, 16)), 'sixteenths on the second');
  // ...including one written as a plain string, which is the shape that would silently have become a
  // one-slot groove of 16 - half a cycle of displacement on every event.
  assert.deepEqual(shifts(s('hh*16').swing(0.25, '16')), shifts(s('hh*16').swing(0.25, 16)));
});

test('the depth is patternable like any amount', () => {
  const g = s('hh*8').swing('<0 1>', [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(shifts(g, 0), new Array(8).fill(0), 'straight bar');
  assert.equal(shifts(g, 1)[1].toFixed(10), (1 / 16).toFixed(10), 'swung bar');
});

test('a depth of 1 is an ordinary thing to ask for and says nothing', () => {
  // The half-a-slot stop is about an OFFSET. Under a groove the amount is a depth on the table's
  // own values, so the out-of-range advice has to stay out of the way.
  assert.deepEqual(warningsFrom(() => s('hh*8').swing(1, 'swing8')), []);
  assert.deepEqual(warningsFrom(() => s('hh*8').swing('clave16')), []);
  // ...and it is still there for the plain reading it belongs to.
  assert.match(warningsFrom(() => s('hh*8').swing(4))[0], /AMOUNT comes first/);
});

test('a groove nothing defines warns once and plays straight', () => {
  const said = warningsFrom(() => {
    const g = s('hh*8').swing('nosuchgroove');
    assert.deepEqual(shifts(g), new Array(8).fill(0), 'straight, not silent');
    shifts(g, 1); // read again: the warning is per name, not per event
  });
  assert.equal(said.length, 1);
  assert.match(said[0], /no groove called "nosuchgroove"/);
  assert.match(said[0], /clave16/, 'and says what there is');
});

test('a groove needs a step pattern, like every time control', () => {
  assert.throws(() => note('c3').fast(2).constructor.prototype.swing.call({}, 1, 'swing8'), /step pattern|Cannot/);
});

// ---------------------------------------------------------------------------------------------
// What the engine is actually told
// ---------------------------------------------------------------------------------------------

function timedEngine(now = 0) {
  const played = [];
  const base = {
    getTime: () => now,
    playSample: (trackId, pack, cfg, onSec, offSec) => played.push({ pack, onSec, offSec, vel: cfg?.vel }),
    noteOn: (trackId, midi, vel, atSec) => played.push({ midi, vel, onSec: atSec }),
    noteOff: (trackId, midi, atSec) => {
      const open = [...played].reverse().find((e) => e.midi === midi && e.offSec === undefined);
      if (open) open.offSec = atSec;
    },
  };
  return { played, engine: new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => {}) }) };
}

function play(sig, { cycles = 1, cps = 1, now = 0 } = {}) {
  const { played, engine } = timedEngine(now);
  const sch = new Scheduler(engine, { trackId: 'tops', cps });
  sch.setPattern(sig);
  for (let c = 0; c < cycles; c++) sch._scheduleNoteEdges(c, c + 1, now);
  return played;
}

test('the engine is handed a groove the same way it is handed a swing', () => {
  const byTable = play(s('hh*8').swing(1 / 3, [0, 1, 0, 1, 0, 1, 0, 1]));
  const bySwing = play(s('hh*8').swing(1 / 3, 8));
  assert.equal(byTable.length, 8);
  assert.deepEqual(byTable, bySwing);
});

test('a groove warps both edges, so consecutive notes still meet', () => {
  // The reason both edges are read at their own positions: an event whose end lands on the next
  // onset has to move that end by whatever the next event moves by, or it rings into it.
  const played = play(s('hh*8').swing(0.4, 'metric16'));
  assert.equal(played.length, 8);
  for (let k = 0; k < 7; k++) {
    assert.equal(played[k].offSec.toFixed(10), played[k + 1].onSec.toFixed(10), `event ${k} stops where ${k + 1} starts`);
    assert.ok(played[k].offSec > played[k].onSec, 'and sounds for a positive length of time');
  }
});

test('a line on one repeated pitch under a groove does not cut itself off', () => {
  const played = play(note('c2*16').swing(1, 'clave16'));
  assert.equal(played.length, 16);
  for (let k = 0; k < 15; k++) {
    assert.ok(played[k].offSec <= played[k + 1].onSec, `note ${k} is released before note ${k + 1} sounds`);
  }
});

test('an ungrooved pattern is timed exactly as before', () => {
  // The feature has to be free when nobody asked for it, and a groove at depth 0 is nobody asking.
  const plain = play(note('c3 e3 g3').vel('1 0.5 0.8'));
  assert.deepEqual(play(note('c3 e3 g3').vel('1 0.5 0.8').swing(0, 'clave16')), plain);
});

// ---------------------------------------------------------------------------------------------
// A groove on a ROLL
//
// The roll has its own swing controls, so it has to be able to carry a table too - and a roll played
// BY NAME reaches the track through a selector join that keeps events and drops channels, which is
// why the table rides on the events as well (see buildPianoroll's stamps).
// ---------------------------------------------------------------------------------------------

test('a roll swings by a table the same way a pattern does', () => {
  const notes = '60,0,1 60,1,1 60,2,1 60,3,1';
  const byTable = shifts(pianoroll(notes, { grid: 4, swing: 1, groove: [0, 0.5, 0, 0.5] }));
  const bySwing = shifts(pianoroll(notes, { grid: 4, swing: 0.5, swinggrid: 4 }));
  assert.deepEqual(byTable, bySwing, 'the two-slot table at depth 1 is the swing it generalizes');
});

test("a roll's groove rides on its events, so playing it by name keeps the feel", () => {
  const roll = pianoroll('60,0,1 60,1,1 60,2,1 60,3,1', { grid: 4, swing: 1, groove: [0, 0.5, 0, 0.5] });
  const stamped = roll.stepsForCycle(0);
  assert.ok(stamped.every((st) => st.groove), 'every event carries the table');
  assert.ok(stamped.every((st) => st.swing === 1), 'and the depth beside it');
  // Read with NO channels at all - which is what a selector join leaves - and the feel survives.
  const bare = stamped.map((st) => Number(timeShift(st, {}, st.start, 1, st.start).toFixed(10)));
  assert.deepEqual(bare, shifts(roll), 'the stamp alone plays it the same');
});

test('a .swing() on the track replaces a roll\'s groove rather than losing to it', () => {
  const roll = pianoroll('60,0,1 60,1,1 60,2,1 60,3,1', { grid: 4, swing: 1, groove: [0, 0.5, 0, 0.5] });
  const over = roll.swing(0.25, 4);
  assert.ok(over.stepsForCycle(0).every((st) => !('groove' in st)), 'the stamped table is taken off');
  assert.deepEqual(shifts(over), shifts(pianoroll('60,0,1 60,1,1 60,2,1 60,3,1', { grid: 4 }).swing(0.25, 4)));
});

test('a roll with a groove is not held to half a slot in its own opts - the product is', () => {
  // The depth is a multiplier on the table, so a depth of 2 on a small value is a real request.
  const a = shifts(pianoroll('60,0,1 60,1,1', { grid: 2, swing: 2, groove: [0, 0.1] }));
  const b = shifts(pianoroll('60,0,1 60,1,1', { grid: 2, swing: 1, groove: [0, 0.2] }));
  assert.deepEqual(a, b, 'depth 2 on 0.1 is depth 1 on 0.2');
});

test('the roll editor computes the same cell offsets the builder plays', () => {
  const table = parseGroove('0 0.4 0.2 0.4');
  for (const depth of [1, 0.5, -0.5]) {
    const cells = [0, 1, 2, 3].map((c) => Number(pianoRollSwingCells(c, { grid: 4, swing: depth, groove: table }).toFixed(10)));
    // The builder works in cycles, the editor in cells: one cell of a 4-grid is a quarter cycle.
    const played = shifts(pianoroll('60,0,1 60,1,1 60,2,1 60,3,1', { grid: 4, swing: depth, groove: table }));
    assert.deepEqual(cells, played.map((v) => Number((v * 4).toFixed(10))), `depth ${depth}`);
  }
});

test('committing a groove writes the offsets it was playing into the notes', () => {
  const table = parseGroove('0 0.4 0 0.4');
  const notes = parsePianoRoll('60,0,1 60,1,1 60,2,1 60,3,1');
  const before = shifts(pianoroll('60,0,1 60,1,1 60,2,1 60,3,1', { grid: 4, swing: 1, groove: table }));
  commitPianoRollSwing(notes, { grid: 4, len: 4, swing: 1, groove: table });
  // The swing can now go back to zero and the roll plays identically - the whole promise of commit.
  const after = shifts(pianoroll(serializePianoRoll(notes), { grid: 4 }));
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------------------------
// The velocity row
// ---------------------------------------------------------------------------------------------

const velsOf = (sig) => play(sig).map((e) => (e.vel === undefined ? undefined : Number(e.vel.toFixed(10))));

// The multiplier itself, at one slot - what "leaves velocity alone" has to be asked of directly: the
// synth path defaults an unset velocity to 1 before the engine sees it, so a played note can't tell
// "untouched" from "set to full".
const scaleAt = (sig, stepIndex) => {
  const step = sig.stepsForCycle(0)[stepIndex];
  return grooveVelScale(step, sig.noteChannels, step.start, 1, step.start, sig.groove);
};

test('a groove with no velocity row leaves velocity completely alone', () => {
  const sig = note('c3*4').swing(1, 'swing8');
  for (let k = 0; k < 4; k++) assert.equal(scaleAt(sig, k), 1, `slot ${k} is untouched`);
  assert.deepEqual(velsOf(note('c3*4').vel(0.5).swing(1, 'swing8')), [0.5, 0.5, 0.5, 0.5]);
});

test('a velocity row scales what vel says, rather than replacing it', () => {
  const sig = note('c3*4').vel(0.5).swing(1, { time: [0, 0, 0, 0], vel: [1, 0.5, 1, 0.5] });
  assert.deepEqual(velsOf(sig), [0.5, 0.25, 0.5, 0.25]);
});

test('with no vel of its own the row is the velocity, read against a full one', () => {
  const sig = note('c3*4').swing(1, { time: [0, 0, 0, 0], vel: [1, 0.6, 1, 0.6] });
  assert.deepEqual(velsOf(sig), [1, 0.6, 1, 0.6]);
});

test('the two depths are independent - turning the timing down leaves the accents alone', () => {
  // The whole reason they are separate numbers: a groove you want to hear the accents of, played
  // nearly straight, is an ordinary thing to ask for.
  const table = { time: [0, 0.4], vel: [1, 0.5] };
  for (const depth of [1, 0.5, 0.1]) {
    assert.deepEqual(velsOf(note('c3*2').swing(depth, table)), [1, 0.5], `accents as drawn at depth ${depth}`);
  }
  // ...and the timing really is moving by different amounts underneath that.
  assert.notEqual(shifts(note('c3*2').swing(1, table))[1], shifts(note('c3*2').swing(0.5, table))[1]);
});

test('a swing amount of zero is the whole groove off, accents included', () => {
  // The one place they are not independent, and the important one: switching a groove off must not
  // leave half of it playing.
  const none = note('c3*2').swing(0, { time: [0, 1], vel: [1, 0.5] });
  assert.equal(scaleAt(none, 1), 1);
  assert.deepEqual(shifts(none), [0, 0]);
});

test('.swingvel() turns the accents down on their own', () => {
  const table = { time: [0, 1], vel: [1, 0.5] };
  const timingOnly = note('c3*2').swing(1, table).swingvel(0);
  assert.equal(scaleAt(timingOnly, 1), 1, 'no accents at all');
  assert.notEqual(shifts(timingOnly)[1], 0, 'but the timing still moves');
  assert.deepEqual(velsOf(note('c3*2').swing(1, table).swingvel(0.5)), [1, 0.75], 'half of the way from 1 to 0.5');
});

test('a velocity row can push an accent above what was written, but never below zero', () => {
  assert.deepEqual(velsOf(note('c3*2').vel(0.5).swing(1, { time: [0, 0], vel: [1, 2] })), [0.5, 1]);
  // An accent depth big enough to take the multiplier past zero stops at silence rather than
  // inverting - a note at velocity 0 is then dropped as any silent note is, which is why this is read
  // off the multiplier rather than off what the engine was told.
  const far = note('c3*2').vel(0.5).swing(1, { time: [0, 0], vel: [1, 0.5] }).swingvel(4);
  assert.equal(scaleAt(far, 1), 0);
  assert.deepEqual(velsOf(far), [0.5], 'the silent one never reaches the engine');
});

test('a roll carries its velocity row through the stamp, like its timing', () => {
  const sig = pianoroll('60,0,1 60,1,1', { grid: 2, swing: 1, groove: '0 0 / 1 0.5' });
  assert.deepEqual(velsOf(sig), [1, 0.5]);
});

// ---------------------------------------------------------------------------------------------
// Grooves saved by name
// ---------------------------------------------------------------------------------------------

test('a groove filed under a name is playable by it', () => {
  _groove('mine', '0 0.5 0 0.5');
  assert.deepEqual(shifts(s('hh*4').swing(1, 'mine')), shifts(s('hh*4').swing(1, [0, 0.5, 0, 0.5])));
  assert.equal(grooveText('mine'), '0 0.5 0 0.5');
});

test('a definition is found below the pattern that names it, because names resolve at read time', () => {
  const sig = s('hh*4').swing(1, 'later'); // nothing called "later" exists yet
  assert.deepEqual(shifts(sig), [0, 0, 0, 0], 'it plays straight meanwhile');
  _groove('later', '0 0.5 0 0.5');
  assert.deepEqual(shifts(sig), shifts(s('hh*4').swing(1, [0, 0.5, 0, 0.5])), 'and picks it up with no re-eval');
});

test('a groove of your own shadows a built-in of the same name', () => {
  const asShipped = shifts(s('hh*8').swing(1, 'swing8'));
  _groove('swing8', '0 -0.5 0 -0.5 0 -0.5 0 -0.5'); // the same shape pushed early instead of late
  const asRedefined = shifts(s('hh*8').swing(1, 'swing8'));
  assert.notDeepEqual(asRedefined, asShipped);
  assert.deepEqual(asRedefined, shifts(s('hh*8').swing(1, [0, -0.5, 0, -0.5, 0, -0.5, 0, -0.5])));
});

test('a velocity row survives being filed and read back', () => {
  _groove('accents', '0 0.25 / 1 0.7');
  assert.deepEqual(velsOf(note('c3*2').swing(1, 'accents')), [1, 0.7]);
  assert.equal(grooveText('accents'), '0 0.25 / 1 0.7');
});

test('filing the same name twice says so - once, and not during a drag', () => {
  const again = warningsFrom(() => {
    _groove('twice', '0 1');
    _groove('twice', '0 0.5');
  });
  assert.equal(again.length, 1, 'the second definition is reported');
  assert.match(again[0], /twice/);
  const quiet = warningsFrom(() => {
    liveGroove('twice', '0 0.4');
    liveGroove('twice', '0 0.3');
  });
  assert.deepEqual(quiet, [], 'a lane being dragged re-files it on every frame and says nothing');
  assert.equal(grooveText('twice'), '0 0.3', 'and the last one is what plays');
});

test('a groove id has to be a name a pattern could say', () => {
  assert.throws(() => _groove('two words', '0 1'), /one plain word/);
  assert.throws(() => _groove('0.5', '0 1'), /one plain word/);
  assert.throws(() => _groove({}, '0 1'), /number or a name/);
});

test('bad numbers are reported against the definition, not against every pattern naming it', () => {
  assert.throws(() => _groove('bad', '0 banana'), /\[groove\]/);
});

test('a definition is not a track, so a block of them plays nothing', () => {
  const def = _groove('inert', '0 1');
  assert.equal(def.isDef, 'inert');
  assert.deepEqual(play(def), []);
});
