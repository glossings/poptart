'use strict';

// Who owns the beat grid, and what happens when that deck stops.
//
// A song deck takes the grid when it starts with nothing else sounding: the clock adopts its
// tempo and its bar phase, and everything that starts later locks to it. What was missing was
// the other half - the grid was never handed on. songMasterDeck stayed pointing at a deck whose
// song had been paused, ejected or loaded over, and clockHeldByDesk reads that stale flag: with
// the song gone it stops holding the clock, so the main deck's next setbpm drove the transport
// and re-rated the OTHER deck's synced song underneath it. Loading a third track onto the deck
// nobody was listening to lurched the room's tempo (2026-09-09).
//
// So the grid moves to whoever is still playing to it. The thing that makes that safe, and the
// thing pinned hardest below, is that the handover is SILENT: the tempo does not move (the heir
// is already locked to the clock) and neither does the heir's own rate, because the master rides
// a PINNED tempo ratio and the pin is taken from the ratio the heir is playing at right then.
// Forcing the master's ratio to 1 - which is what the flag used to mean - would double the speed
// of a half-time deck at the instant it inherited.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const songSync = require('./song-sync.js');

// server.js spawns an engine on require, so the grid-ownership functions are read out of the
// source and given their own dependencies - the same trick song-end.test.js and dj-midi.test.js
// use for their corners of the same file.
const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const NAMES = ['songOctave', 'songBaseRate', 'songHandGridOver', 'clockHeldByDesk'];

function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

// eslint-disable-next-line no-new-func
const make = new Function('songDecks', 'transport', 'songSync', 'mixState', 'othersPlaying',
  'songApplyRate', 'master0', 'octave0', `
    let songMasterDeck = master0;
    let songMasterOctave = octave0;
    ${NAMES.map(grabFn).join('\n')}
    return {
      ${NAMES.join(', ')},
      master: () => songMasterDeck,
      octave: () => songMasterOctave,
    };
  `);

/** A desk: `clock` bpm, a song on each deck, and whichever deck currently holds the grid. */
function desk({ clock = 128, a = null, b = null, master = null, octave = 1 } = {}) {
  const songDecks = { a, b };
  const applied = [];
  const api = make(
    songDecks,
    { cps: clock / 240 },
    songSync,
    { tempoOverride: null },
    () => true, // something is always sounding in these fixtures
    (d) => applied.push(d),
    master,
    octave,
  );
  api.decks = songDecks;
  api.applied = applied;
  return api;
}

const song = (bpm, over = {}) => ({ bpm, sync: true, playing: true, syncMult: 'auto', manualRate: 1, ...over });

test('the grid moves to the other deck when the master stops, and the clock stays held', () => {
  const d = desk({ clock: 128, a: song(128), b: song(140), master: 'a' });
  d.decks.a.playing = false; // deck A paused / ejected / loaded over
  assert.equal(d.songHandGridOver('a'), 'b');
  assert.equal(d.master(), 'b');
  // The point of the whole exercise: deck A's next setbpm may only RECORD, because the room is
  // now dancing to deck B.
  assert.equal(d.clockHeldByDesk(), true);
});

test('the handover does not change the heir\'s rate - a half-time deck stays half-time', () => {
  // A 70 bpm record under a 140 clock rides ratio 0.5 and plays at its own speed (rate 1).
  const d = desk({ clock: 140, a: song(140), b: song(70), master: 'a' });
  const before = d.songBaseRate('b');
  assert.equal(before, 1);
  assert.equal(d.songOctave('b'), 0.5);

  d.decks.a.playing = false;
  d.songHandGridOver('a');

  assert.equal(d.master(), 'b');
  assert.equal(d.octave(), 0.5); // pinned to what it was riding, NOT reset to 1
  assert.equal(d.songBaseRate('b'), before); // ...so the record does not change speed
  assert.deepEqual(d.applied, ['b']); // and the rate is re-applied, to prove it is a no-op
});

test('a master that inherited keeps its pinned ratio instead of drifting with the clock', () => {
  // Why the master's ratio is pinned at all: the desk can migrate the clock a long way from
  // where the grid started, and an 'auto' ratio re-picks itself as it goes. That is right for a
  // deck being matched TO the room and wrong for the record the room is matched to.
  const d = desk({ clock: 140, a: song(140), b: song(70), master: 'a' });
  d.decks.a.playing = false;
  d.songHandGridOver('a');

  // The mix rides the clock down to 90 with deck B still holding the grid.
  const migrated = desk({ clock: 90, b: d.decks.b, master: 'b', octave: d.octave() });
  assert.equal(migrated.songOctave('b'), 0.5);
  assert.equal(migrated.songBaseRate('b'), (90 * 0.5) / 70);
  // Reading syncMult instead would have abandoned half-time on the way down and doubled the
  // record's speed mid-migration.
  assert.equal(songSync.syncOctave(90, 70, 'auto'), 1);
});

test('nobody inherits an unusable grid: the clock comes free', () => {
  for (const heir of [
    null, // no song on the other deck at all
    song(140, { playing: false }), // loaded but not playing
    song(140, { sync: false }), // playing free - it has no grid to lend
    song(null), // playing, synced, but nobody knows where its bars are
  ]) {
    const d = desk({ a: song(128), b: heir, master: 'a' });
    d.decks.a.playing = false;
    assert.equal(d.songHandGridOver('a'), null);
    assert.equal(d.master(), null);
    assert.equal(d.octave(), 1);
    assert.equal(d.clockHeldByDesk(), false); // the buffer's own setbpm drives again
    assert.deepEqual(d.applied, []);
  }
});

test('a deck that never held the grid stops without moving it', () => {
  const d = desk({ a: song(128), b: song(140), master: 'a' });
  d.decks.b.playing = false;
  assert.equal(d.songHandGridOver('b'), 'a');
  assert.equal(d.master(), 'a');
  assert.deepEqual(d.applied, []);
});

test('the grid is handed over from every place a deck stops being one that plays', () => {
  // The call sites, not the arithmetic: a pause, a per-deck stop and the end of the file all
  // land in songMarkPaused, and mix/clear, eject and a song loaded over another reach songUnload
  // without passing through it.
  for (const fn of ['songMarkPaused', 'songUnload']) {
    assert.match(grabFn(fn), /songHandGridOver\(deck\)/,
      `${fn} must hand the grid over - a stopped deck cannot keep holding the clock`);
  }
});
