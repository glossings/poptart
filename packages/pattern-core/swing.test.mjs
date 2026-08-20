// Swing and nudge - the time controls. Both are ordinary keys on the event (see Sig#noteChannels)
// applied where it is EMITTED rather than by rewriting the pattern, so what these tests keep honest
// is the split: the grid never moves, the timestamps do. Pure pattern math plus one mocked engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, n, note, mini, sine, nudge, swing, swinggrid, timeShift, setPatternWarn } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

// The shift one step of a pattern asks for, in cycles - what the scheduler and the highlighter both
// read. Steps are indexed within the cycle, as stepsForCycle returns them.
function shiftOf(sig, stepIndex = 0, cycle = 0) {
  const step = sig.stepsForCycle(cycle)[stepIndex];
  const at = cycle + step.start;
  return timeShift(step, sig.noteChannels, at, 1, at);
}

// Every step's shift for one cycle, rounded off the floating-point fuzz that exact fractions carry.
const shifts = (sig, cycle = 0) =>
  sig.stepsForCycle(cycle).map((_, idx) => Number(shiftOf(sig, idx, cycle).toFixed(10)));

const starts = (sig, cycle = 0) => sig.stepsForCycle(cycle).map((x) => x.start);

// Warnings a builder emitted, with the console sink put back afterwards.
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
// swing: the offbeats of a grid move, and nothing else does
// ---------------------------------------------------------------------------------------------

test('swing delays the offbeats of its grid and leaves the onbeats alone', () => {
  const hats = s('hh*8').swing(1 / 3);
  // Eight eighths, alternating: slots 0, 2, 4, 6 are onbeats and stay put.
  assert.deepEqual(shifts(hats), [0, 1 / 24, 0, 1 / 24, 0, 1 / 24, 0, 1 / 24].map((x) => Number(x.toFixed(10))));
});

test('the amount is a fraction of one slot, so 1/3 is the triplet feel', () => {
  // A triplet shuffle puts the offbeat two thirds of the way through the quarter: an eighth is
  // 1/8 of a cycle, a third of that is 1/24, and 1/8 + 1/24 = 1/6 = two thirds of a quarter.
  assert.equal(shiftOf(s('hh*8').swing(1 / 3), 1).toFixed(10), (1 / 24).toFixed(10));
  const step = s('hh*8').swing(1 / 3).stepsForCycle(0)[1];
  assert.equal((step.start + shiftOf(s('hh*8').swing(1 / 3), 1)).toFixed(10), (1 / 6).toFixed(10));
  // Half a slot is the maximum: the offbeat lands exactly on the downbeat that follows it.
  assert.equal(shiftOf(s('hh*8').swing(0.5), 1).toFixed(10), (1 / 16).toFixed(10));
});

test('swing does not move the pattern - only the emitted times', () => {
  const straight = s('hh*8');
  const swung = s('hh*8').swing(1 / 3);
  assert.deepEqual(starts(swung), starts(straight), 'the grid is untouched');
  assert.deepEqual(
    swung.stepsForCycle(0).map((x) => x.end),
    straight.stepsForCycle(0).map((x) => x.end),
    'so are the step ends - what changes is where the event is played, not how long it is',
  );
});

test('the grid swing swings is swinggrid, 8 slots by default', () => {
  // On a 16-slot grid every other SIXTEENTH is late, so all four sixteenths of a quarter differ.
  assert.deepEqual(shifts(s('hh*4').swing(0.25, 16)), [0, 0, 0, 0], 'quarters land on even 16th slots');
  const sixteenths = s('hh*16').swing(0.25, 16);
  assert.deepEqual(shifts(sixteenths).slice(0, 4), [0, 1 / 64, 0, 1 / 64].map((x) => Number(x.toFixed(10))));
  // The second argument is the swinggrid channel, so it can also be set on its own.
  assert.deepEqual(shifts(s('hh*16').swing(0.25).swinggrid(16)), shifts(sixteenths));
});

test('a note inside a swung slot rides along with the slot it belongs to', () => {
  // Sixteenths under an EIGHTH-note swing: the two in the late half of each pair both move, which
  // is what "shuffle the eighths" means - the sixteenths are not re-divided, they follow.
  const sixteenths = s('hh*16').swing(1 / 3, 8);
  assert.deepEqual(shifts(sixteenths).slice(0, 4), [0, 0, 1 / 24, 1 / 24].map((x) => Number(x.toFixed(10))));
});

test('a bare .swing() is the triplet shuffle', () => {
  assert.deepEqual(shifts(s('hh*8').swing()), shifts(s('hh*8').swing(1 / 3)));
});

test('swing amount can be patterned, and reads per event', () => {
  const alternating = s('hh*8').swing('<0 0.5>');
  assert.deepEqual(shifts(alternating, 0), new Array(8).fill(0), 'straight bar');
  assert.deepEqual(shifts(alternating, 1), [0, 1 / 16, 0, 1 / 16, 0, 1 / 16, 0, 1 / 16].map((x) => Number(x.toFixed(10))));
});

// ---------------------------------------------------------------------------------------------
// nudge: one event's own offset
// ---------------------------------------------------------------------------------------------

test('nudge is a fraction of the event\'s own step width', () => {
  assert.equal(shiftOf(s('bd').nudge(0.1), 0).toFixed(10), (0.1).toFixed(10), 'one step a cycle wide');
  assert.equal(shiftOf(s('bd*4').nudge(0.1), 0).toFixed(10), (0.025).toFixed(10), 'a quarter-cycle step');
  assert.equal(shiftOf(s('bd*4').nudge(-0.1), 0).toFixed(10), (-0.025).toFixed(10), 'negative plays early');
});

test('nudge and swing sum rather than replacing each other', () => {
  // What makes committing a groove to per-event nudges something you can do halfway.
  const both = s('hh*8').swing(1 / 3).nudge(0.05);
  const stepWidth = 1 / 8;
  assert.equal(shiftOf(both, 0).toFixed(10), (0.05 * stepWidth).toFixed(10), 'onbeat: nudge only');
  assert.equal(shiftOf(both, 1).toFixed(10), (0.05 * stepWidth + 1 / 24).toFixed(10), 'offbeat: both');
});

test('an out-of-range constant clamps, and says so', () => {
  const said = warningsFrom(() => {
    assert.equal(shiftOf(s('bd').nudge(3), 0), 0.5, 'clamped to half a step');
    assert.equal(shiftOf(s('hh*8').swing(4), 1).toFixed(10), (0.5 / 8).toFixed(10), 'clamped to half a slot');
  });
  assert.equal(said.length, 2, 'one line each, and nothing on the console');
  assert.match(said[0], /more than half a step/);
  assert.match(said[1], /AMOUNT comes first/, 'the Strudel habit swing(4) gets told what to write');
  assert.match(said[1], /\.swing\(1\/3, 4\)/, 'and the number it passed is offered as the grid');
});

test('swing that has nothing to move says so, and names the grid that would', () => {
  // A pattern written in quarters is untouched by an eighth-note grid. That is correct - it is what
  // keeps the kick of a stacked kit still - but silently doing nothing is how a control looks broken.
  const said = warningsFrom(() => s('bd hh sd hh').swing(1 / 3));
  assert.equal(said.length, 1);
  assert.match(said[0], /nothing to move/);
  assert.match(said[0], /\.swing\(1\/3, 4\)/, 'the quarter grid the pattern is actually written on');
  // Nothing to say when swing does move something, when it is deliberately off, or when the grid
  // was named - and a stacked kit is the case that must stay quiet AND stay still.
  assert.deepEqual(warningsFrom(() => s('hh*8').swing(1 / 3)), []);
  assert.deepEqual(warningsFrom(() => s('bd hh sd hh').swing(1 / 3, 4)), []);
  assert.deepEqual(warningsFrom(() => s('bd*4').swing(0)), []);
  assert.deepEqual(warningsFrom(() => s('<bd*4 hh*8>').swing(1 / 3)), [], 'offbeats in the other cycle');
  const kit = s('hh*8, bd*4').swing(1 / 3);
  assert.deepEqual(warningsFrom(() => s('hh*8, bd*4').swing(1 / 3)), []);
  const kicks = kit.stepsForCycle(0).map((step, idx) => [step.value, shiftOf(kit, idx)]).filter(([v]) => v === 'bd');
  assert.equal(kicks.length, 4);
  for (const [, shift] of kicks) assert.equal(shift, 0, 'the kick of a stacked kit never moves');
});

test('a swept value clamps silently - a sweep reaching its stops is not a mistake', () => {
  assert.deepEqual(warningsFrom(() => s('hh*8').swing(sine().range(0, 4))), []);
  assert.deepEqual(warningsFrom(() => s('hh*8').swing(1 / 3)), []);
});

// ---------------------------------------------------------------------------------------------
// The controls behave like every other control
// ---------------------------------------------------------------------------------------------

test('nudge rides on .as() tokens, per event, with the other fields', () => {
  // Empty fields keep their defaults, so one token can carry a nudge and the rest carry none.
  const sig = mini('36 38::0.04 36 38').as('note:vel:nudge');
  assert.deepEqual(shifts(sig), [0, 0.04 * 0.25, 0, 0], 'only the token that asked for it moves');
});

test('a per-token nudge still swings', () => {
  const track = mini('36 38::0.04 36 38').as('note:vel:nudge').swing(0.5, 4);
  // Step 1 is an offbeat of the quarter grid: its own nudge plus half a quarter-slot.
  assert.equal(shiftOf(track, 1).toFixed(10), (0.04 * 0.25 + 0.5 / 4).toFixed(10));
});

test('the notes of one chord can be splayed apart by their own nudges', () => {
  // Two steps at the same onset: a channel sampled at that time could only answer once, so the
  // per-step split in .as() is what lets them differ (the same reason vel/clip are split there).
  const sig = mini('[36:1:0,43:1:0.2]').as('note:vel:nudge');
  assert.deepEqual(shifts(sig), [0, 0.2]);
});

test('as an operand a time control aims at its channel, like every other', () => {
  assert.equal(shiftOf(s('bd').add(nudge(0.25)), 0), 0.25, 'unset nudge is 0, so 0 + 0.25');
  assert.equal(shiftOf(s('bd').nudge(0.1).add(nudge(0.1)), 0).toFixed(10), (0.2).toFixed(10));
  assert.equal(shiftOf(s('hh*8').add(swing(0.5)), 1).toFixed(10), (1 / 16).toFixed(10));
  // swinggrid's resting value is the default grid, so multiplying it doubles the subdivision.
  assert.equal(shiftOf(s('hh*16').swing(0.5).mul(swinggrid(2)), 1).toFixed(10), (0.5 / 16).toFixed(10));
});

test('a time control at the head of a chain triggers, like vel does', () => {
  const track = nudge('0 0.1 0 0.1').s('bd');
  assert.equal(track.stepsForCycle(0).length, 4, 'the control\'s grid is the trigger');
  assert.deepEqual(shifts(track), [0, 0.1 * 0.25, 0, 0.1 * 0.25]);
});

test('a time control survives a later pitch swap, as a note channel must', () => {
  const track = n('0 2').nudge(0.1).note('f3 g3');
  assert.equal(shiftOf(track, 0).toFixed(10), (0.05).toFixed(10), 're-merged onto the fresh grid');
});

// ---------------------------------------------------------------------------------------------
// What the engine is actually told
// ---------------------------------------------------------------------------------------------

// Engine that records the times it is handed. cps 1 means one cycle per second, so a cycle
// position and a timestamp are the same number and the arithmetic below stays readable.
function timedEngine(now = 0) {
  const played = [];
  const base = {
    getTime: () => now,
    playSample: (trackId, pack, cfg, onSec, offSec) => played.push({ pack, onSec, offSec }),
    noteOn: (trackId, midi, vel, atSec) => played.push({ midi, onSec: atSec }),
    // Pairs with the note still open on that pitch. On one repeated pitch that is the whole point:
    // the engine has a single voice there, so an off landing after the next on would cut it short.
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

test('the engine is handed the shifted time, and the whole event moves together', () => {
  const straight = play(s('hh*4'));
  const late = play(s('hh*4').nudge(0.2));
  assert.equal(straight.length, 4);
  for (let k = 0; k < 4; k++) {
    const moved = late[k].onSec - straight[k].onSec;
    assert.equal(moved.toFixed(10), (0.2 * 0.25).toFixed(10), 'onset moves by a fifth of a step');
    assert.equal(
      (late[k].offSec - straight[k].offSec).toFixed(10),
      moved.toFixed(10),
      'and the end moves with it, so the note keeps its length',
    );
  }
});

test('swing warps both edges of the event, not just its onset', () => {
  // A default (clip 1) note ends exactly where the next begins. Under swing each edge follows the
  // bend it sits on, so consecutive events still meet: the onbeat stretches into the late offbeat
  // and the offbeat gives that time back. Shifting whole events instead would have every onbeat
  // ring a third of a slot INTO the offbeat after it.
  const played = play(s('hh*8').swing(1 / 3));
  assert.equal(played.length, 8);
  for (let k = 0; k < 7; k++) {
    assert.equal(
      played[k].offSec.toFixed(10),
      played[k + 1].onSec.toFixed(10),
      `event ${k} stops exactly where event ${k + 1} starts`,
    );
  }
  const lengths = played.map((x) => Number((x.offSec - x.onSec).toFixed(10)));
  assert.equal(lengths[0].toFixed(10), (1 / 8 + 1 / 24).toFixed(10), 'onbeat stretches into the late offbeat');
  assert.equal(lengths[1].toFixed(10), (1 / 8 - 1 / 24).toFixed(10), 'offbeat gives that time back');
});

test('a swung line on one repeated pitch does not cut itself off', () => {
  // The case that made the two-edge warp necessary: a garage bassline is one note, and the engine
  // has a single voice per pitch - a noteOff landing after the next noteOn silences it partway.
  const played = play(note('c2*8').swing(1 / 3));
  assert.equal(played.length, 8);
  for (let k = 0; k < 7; k++) {
    assert.ok(
      played[k].offSec <= played[k + 1].onSec,
      `note ${k} is released by the time note ${k + 1} sounds (${played[k].offSec} > ${played[k + 1].onSec})`,
    );
    assert.ok(played[k].offSec > played[k].onSec, 'and it sounds for a positive length of time');
  }
});

test('a uniform nudge still translates the whole event', () => {
  // Both edges get the same shift when the shift is the same everywhere, so nothing is stretched.
  const played = play(s('hh*4').nudge(0.2));
  const straight = play(s('hh*4'));
  for (let k = 0; k < 4; k++) {
    assert.equal(
      (played[k].offSec - played[k].onSec).toFixed(10),
      (straight[k].offSec - straight[k].onSec).toFixed(10),
      'same length as unshifted',
    );
  }
});

test('a late shift has no limit - swing, shuffle and every traditional groove only ever delay', () => {
  // Half a slot at a very slow tempo is hundreds of milliseconds later than the grid, and nothing
  // about the lookahead cares: the timestamp is simply further away.
  const [first, second] = play(s('hh*2').swing(0.5, 2), { cps: 0.25 });
  assert.equal(((second.onSec - first.onSec) * 1000).toFixed(3), (3000).toFixed(3), '2s slot + 1s of swing');
});

test('an early shift is clamped to what can still be scheduled, and says so once', () => {
  // The event is at cycle 0 and the clock reads 0, so there is no room at all to move earlier;
  // the note plays as soon as it can be played rather than at a timestamp already in the past.
  const said = warningsFrom(() => {
    const played = play(s('bd').nudge(-0.5), { now: 0 });
    assert.ok(played[0].onSec >= 0, 'never scheduled in the past');
    assert.ok(played[0].onSec <= 0.01, 'and no later than it has to be');
  });
  assert.equal(said.length, 1, 'once, not once per event');
  assert.match(said[0], /early nudge/);
});

test('an early shift within the budget is passed through exactly', () => {
  // 5ms early on an event a full cycle away is nowhere near the lookahead.
  const now = 0;
  const played = play(s('bd*4').nudge(-0.02), { now });
  const straight = play(s('bd*4'), { now });
  for (let k = 1; k < 4; k++) {
    assert.equal((played[k].onSec - straight[k].onSec).toFixed(10), (-0.02 * 0.25).toFixed(10));
  }
});

test('an unshifted pattern is timed exactly as before', () => {
  // The whole feature has to be free when nobody asked for it: same numbers, not near-enough ones.
  const plain = play(note('c3 e3 g3').vel('1 0.5 0.8'));
  const alsoPlain = play(note('c3 e3 g3').vel('1 0.5 0.8').nudge(0));
  assert.deepEqual(alsoPlain, plain);
});
