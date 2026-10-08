'use strict';

// The decks' performance loop: a player's loop button, plus the two that halve and double its
// length. Both kinds of deck loop, by two different mechanisms, and this is where the part that
// is the SAME for both lives - where the window starts, how long it is, and what the length
// buttons do to one that is already running.
//
// The two mechanisms are checked at their own ends: the clock HOLD a livecoded deck loops by is
// pinned in pattern-core's arrange.test.mjs (and exercised here through the real class), and the
// song deck's scheduled wrap is engine work no test can hear. What is left - and what gets a
// loop wrong in practice - is the arithmetic: a loop that starts half a beat off the grid, or a
// 4-bar loop that is four bars of the CLOCK rather than four bars of the record.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// server.js spawns an engine on require, so the functions are read out of the source and handed
// their own dependencies - the trick dj-midi.test.js and dj-fx.test.js use.
function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  const end = SRC.indexOf('\n}\n', at);
  assert.ok(end > at, `could not find the end of ${name} in server.js`);
  return SRC.slice(at, end + 3);
}
function grabConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm'));
  assert.ok(m, `const ${name} not found in server.js - this test needs updating`);
  return m[0];
}

const DEPS = ['mixState', 'songDecks', 'arrangeClocks', 'transport', 'engine', 'songSync',
  'songGridBpm', 'songPlayheadSec', 'songArmTimers', 'mixNotify'];
const NAMES = ['deckLoopRung', 'deckLoopWindow', 'deckLoopFit', 'deckLoopApply', 'deckLoopBeatLen',
  'deckLoopLive', 'deckLoopSet', 'deckLoopState'];
// eslint-disable-next-line no-new-func
const makeLoop = new Function(...DEPS, `
  const clockOf = () => transport; // every deck on the room's clock (see deck-clock.test.js for the rest)
  ${grabConst('DECK_LOOP_BEATS')}
  ${grabConst('DECK_LOOP_DEFAULT_BEATS')}
  ${NAMES.map(grabFn).join('\n')}
  return { ${NAMES.join(', ')}, DECK_LOOP_BEATS, DECK_LOOP_DEFAULT_BEATS };
`);

let ArrangeClock;
test.before(async () => {
  ({ ArrangeClock } = await import(url.pathToFileURL(path.join(__dirname, '../pattern-core/src/arrange.mjs')).href));
});

const NOW = 1000;

/**
 * A desk with one deck set up. `song` makes it a deck holding a FILE (bpm, where the playhead is,
 * whether it quantizes); without it the deck plays CODE and gets a real ArrangeClock at `cycle`.
 */
function rig({ song = null, cycle = 0, regions = [], loopsOn = false, beats, end = 64 } = {}) {
  const armed = [];
  const mixState = { deckLoop: { a: { beats: beats ?? 16 }, b: { beats: 16 } } };
  const songDecks = { a: null, b: null };
  if (song) {
    songDecks.a = {
      bpm: 'bpm' in song ? song.bpm : 120, // an explicit null is a track with no tempo at all
      anchorSec: song.anchorSec ?? 0,
      quantize: song.quantize !== false,
      posSec: song.pos ?? 0,
      loop: null,
      playing: true,
    };
  }
  const arrangeClocks = {
    a: song ? null : new ArrangeClock({ end, regions, loopsOn }),
    b: null,
  };
  const api = makeLoop(
    mixState,
    songDecks,
    arrangeClocks,
    { paused: false, cycleAt: () => cycle },
    { getTime: () => NOW },
    { BEATS_PER_CYCLE: 4 },
    (deck) => (songDecks[deck]?.bpm ?? 0),
    (deck) => songDecks[deck]?.posSec ?? 0,
    (deck) => armed.push(deck),
    () => {},
  );
  return { ...api, mixState, songDecks, arrangeClocks, armed };
}

// --- the length ladder -------------------------------------------------------------------------

test('a loop is four bars until it is told otherwise', () => {
  const m = rig({ song: { bpm: 120 } });
  assert.equal(m.DECK_LOOP_DEFAULT_BEATS, 16, 'sixteen beats is four bars');
  assert.equal(m.deckLoopApply('a', { on: true }).beats, 16);
});

test('halving and doubling walk the ladder and stop at its ends', () => {
  const m = rig({ song: { bpm: 120 } });
  const beats = () => m.deckLoopApply('a', {}).beats;
  assert.equal(m.deckLoopApply('a', { scale: 0.5 }).beats, 8, 'two bars');
  assert.equal(m.deckLoopApply('a', { scale: 2 }).beats, 16);
  assert.equal(m.deckLoopApply('a', { scale: 2 }).beats, 32);
  for (let i = 0; i < 6; i++) m.deckLoopApply('a', { scale: 2 });
  assert.equal(beats(), 64, 'the top rung holds rather than running away');
  for (let i = 0; i < 12; i++) m.deckLoopApply('a', { scale: 0.5 });
  assert.equal(beats(), 0.25, 'and so does the bottom one');
});

test('a length that is not a rung lands on the nearest one', () => {
  const m = rig({ song: { bpm: 120 } });
  assert.equal(m.deckLoopRung(5), 4);
  assert.equal(m.deckLoopRung(0.3), 0.25);
  assert.equal(m.deckLoopRung(1000), 64);
  assert.equal(m.deckLoopRung('nonsense'), 16, 'and nonsense lands on the default');
});

test('a scale that is neither half nor double is refused rather than guessed at', () => {
  const m = rig({ song: { bpm: 120 } });
  assert.throws(() => m.deckLoopApply('a', { scale: 3 }), /scale must be 2 or 0.5/);
});

// --- where the window falls, on a deck holding a file -------------------------------------------

test('a song deck loops in beats of its OWN tempo, from the beat it is in', () => {
  // 128bpm: a beat is 0.46875s, a bar 1.875s. The playhead is 10.1s in - a little past a beat.
  const m = rig({ song: { bpm: 128, pos: 10.1 } });
  const got = m.deckLoopApply('a', { on: true });
  const beat = 60 / 128;
  assert.ok(Math.abs(got.from - Math.floor(10.1 / beat) * beat) < 1e-9, 'it starts at the beat, not at the finger');
  assert.ok(got.from <= 10.1 && got.from > 10.1 - beat, 'the beat it is IN, not the next one');
  assert.ok(Math.abs((got.to - got.from) - 16 * beat) < 1e-9, 'four bars of the RECORD');
});

test('the beatgrid anchor is what the beats are counted from', () => {
  // A track whose first downbeat is 0.2s in: every loop edge sits on that grid, not on 0.
  const m = rig({ song: { bpm: 120, pos: 5.05, anchorSec: 0.2 } });
  const got = m.deckLoopApply('a', { on: true });
  const beat = 0.5;
  assert.ok(Math.abs(((got.from - 0.2) / beat) % 1) < 1e-9, `${got.from} is off the anchored grid`);
  assert.ok(got.from <= 5.05);
});

test('quantize off takes the playhead exactly, as it does everywhere else', () => {
  const m = rig({ song: { bpm: 120, pos: 5.07, quantize: false } });
  assert.equal(m.deckLoopApply('a', { on: true }).from, 5.07);
});

test('a track with no tempo says so rather than looping something arbitrary', () => {
  const m = rig({ song: { bpm: null, pos: 4 } });
  assert.throws(() => m.deckLoopApply('a', { on: true }), /no tempo/);
  assert.equal(m.deckLoopState('a').on, false, 'and no loop is left half-armed');
});

test('arming a loop on a song deck re-arms its timers, which is what schedules the wrap', () => {
  const m = rig({ song: { bpm: 120, pos: 4 } });
  m.deckLoopApply('a', { on: true });
  assert.deepEqual(m.armed, ['a']);
  assert.ok(m.songDecks.a.loop, 'and the window is on the deck for the timer to read');
  m.deckLoopApply('a', { on: false });
  assert.equal(m.songDecks.a.loop, null);
  assert.deepEqual(m.armed, ['a', 'a'], 'ending one re-arms them too - the wrap has to be called off');
});

// --- where the window falls, on a deck playing code ---------------------------------------------

test('a livecoded deck loops in cycles, and the clock is what holds it', () => {
  const m = rig({ cycle: 9.3 });
  const got = m.deckLoopApply('a', { on: true });
  assert.equal(got.from, 9.25, 'floored to the beat - a quarter of a cycle');
  assert.equal(got.to, 9.25 + 4, 'four bars is four cycles');
  assert.deepEqual(m.arrangeClocks.a.hold, { start: 9.25, end: 13.25 });
  assert.equal(m.arrangeClocks.a.posAt(13.3), 9.3, 'and the clock really does go round');
});

test('a livecoded deck loops with its written regions switched off', () => {
  // Which is how the desk runs: DJ mode opens with the regions disarmed.
  const m = rig({ cycle: 4, regions: [{ name: 'A', start: 0, end: 2 }], loopsOn: false });
  m.deckLoopApply('a', { on: true });
  assert.equal(m.arrangeClocks.a.posAt(9), 5, 'held in the window');
  assert.equal(m.arrangeClocks.a.loopsOn, false, 'and the regions switch is untouched');
});

test('a deck with neither a song nor a clock has nothing to loop, and says so', () => {
  const m = rig({ cycle: 0 });
  m.arrangeClocks.a = null;
  assert.throws(() => m.deckLoopApply('a', { on: true }), /nothing to loop/);
});

// --- the buttons, against a loop that is already running -----------------------------------------

test('the loop button toggles against the deck, not against a flag of its own', () => {
  const m = rig({ song: { bpm: 120, pos: 4 } });
  assert.equal(m.deckLoopApply('a', { on: true }).on, true);
  assert.equal(m.deckLoopState('a').on, true);
  assert.equal(m.deckLoopApply('a', { on: false }).on, false);
  assert.equal(m.deckLoopLive('a'), null);
});

test('resizing a RUNNING loop keeps its start - the music does not jump', () => {
  const m = rig({ song: { bpm: 120, pos: 4 } });
  const armed = m.deckLoopApply('a', { on: true });
  const halved = m.deckLoopApply('a', { scale: 0.5 });
  assert.equal(halved.from, armed.from, 'the top of the loop stays put');
  assert.equal(halved.beats, 8);
  assert.ok(Math.abs((halved.to - halved.from) - 8 * 0.5) < 1e-9);
  const doubled = m.deckLoopApply('a', { scale: 2 });
  assert.equal(doubled.from, armed.from);
  assert.ok(Math.abs((doubled.to - doubled.from) - 16 * 0.5) < 1e-9);
  assert.equal(doubled.on, true, 'and it is still looping throughout');
});

test('resizing with nothing running only picks the length of the next one', () => {
  const m = rig({ song: { bpm: 120, pos: 4 } });
  assert.equal(m.deckLoopApply('a', { scale: 2 }).on, false, 'a length button does not start a loop');
  assert.equal(m.deckLoopState('a').beats, 32);
  const armed = m.deckLoopApply('a', { on: true });
  assert.ok(Math.abs((armed.to - armed.from) - 32 * 0.5) < 1e-9, 'which is the length it then uses');
});

test('the length outlives the loop, so the next press is the length you left it at', () => {
  const m = rig({ song: { bpm: 120, pos: 4 } });
  m.deckLoopApply('a', { on: true });
  m.deckLoopApply('a', { scale: 0.5 });
  m.deckLoopApply('a', { on: false });
  assert.equal(m.deckLoopState('a').beats, 8);
  assert.equal(m.deckLoopApply('a', { on: true }).beats, 8);
});

// --- what the deck head writes on the label ------------------------------------------------------

test('a length reads as the bars or beats a musician would count', () => {
  const at = CLIENT.indexOf('function deckLoopLabel(');
  assert.ok(at > 0, 'deckLoopLabel not found in public/client.js - this test needs updating');
  // eslint-disable-next-line no-new-func
  const deckLoopLabel = new Function(`${CLIENT.slice(at, CLIENT.indexOf('\n}\n', at) + 3)}\nreturn deckLoopLabel;`)();
  assert.equal(deckLoopLabel(16), '4 bars');
  assert.equal(deckLoopLabel(4), '1 bar');
  assert.equal(deckLoopLabel(2), '2 beats');
  assert.equal(deckLoopLabel(1), '1 beat');
  assert.equal(deckLoopLabel(0.5), '1/2 beat');
  assert.equal(deckLoopLabel(0.25), '1/4 beat');
  assert.equal(deckLoopLabel(0), '', 'nothing to say about no length at all');
});

// --- a loop cannot be longer than the music ----------------------------------------------------
//
// A clock hold holds the song inside its window whatever is written there, including nothing. The
// rig above gives the deck a 64-cycle arrangement, which is why every test so far could ask for
// four bars and get them - on the one-bar pattern somebody actually livecodes, the four-bar
// default put three bars of silence inside the loop.

test('a four-bar loop on a one-bar pattern loops the bar', () => {
  const m = rig({ cycle: 0, end: 1 });
  const got = m.deckLoopApply('a', { on: true });
  assert.deepEqual([got.from, got.to], [0, 1], 'the window ran past the end of the arrangement');
  assert.deepEqual(m.arrangeClocks.a.hold, { start: 0, end: 1 });
  // ...and the music really does come round every bar rather than once every four.
  assert.equal(m.arrangeClocks.a.posAt(1), 0);
  assert.equal(m.arrangeClocks.a.posAt(2.5), 0.5);
});

test('a window that would hang off the end is slid back inside the music', () => {
  // Pressing loop near the end of a two-bar arrangement: a two-bar loop is still available, it
  // just cannot start where the playhead is.
  const m = rig({ cycle: 1.5, end: 2, beats: 8 }); // 8 beats = 2 cycles
  const got = m.deckLoopApply('a', { on: true });
  assert.deepEqual([got.from, got.to], [0, 2]);
});

test('a loop shorter than the arrangement still starts where the playhead is', () => {
  const m = rig({ cycle: 5.25, end: 64, beats: 4 }); // one bar, in a long arrangement
  const got = m.deckLoopApply('a', { on: true });
  assert.deepEqual([got.from, got.to], [5.25, 6.25], 'a loop that fits must not be moved');
});

test('doubling a livecoded loop stops at the arrangement rather than off the end of it', () => {
  const m = rig({ cycle: 0, end: 2, beats: 4 });
  m.deckLoopApply('a', { on: true });
  const got = m.deckLoopApply('a', { scale: 2 }); // 1 bar -> 2 bars, which is all there is
  assert.deepEqual([got.from, got.to], [0, 2]);
  const again = m.deckLoopApply('a', { scale: 2 }); // ...and asking for 4 still gives 2
  assert.deepEqual([again.from, again.to], [0, 2]);
});

test('a deck with no arrangement length is left alone', () => {
  // Nothing to measure against: the window is whatever was asked for, as before.
  const m = rig({ cycle: 0, end: 0 });
  assert.deepEqual(m.deckLoopFit('a', 2, 4), { from: 2, to: 6 });
});

test('a song deck is unaffected - its loop is in seconds of the record', () => {
  const m = rig({ song: { bpm: 120, pos: 10 }, beats: 16 });
  const got = m.deckLoopApply('a', { on: true });
  assert.equal(got.to - got.from, 8, 'four bars at 120bpm is eight seconds, whatever an arrangement does');
});
