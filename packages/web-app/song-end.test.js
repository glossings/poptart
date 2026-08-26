'use strict';

// The end of a song deck's file.
//
// A pause halts the Phasor and leaves the player holding a frozen sample, which is fine in the
// middle of a track. At the very end it is not: the Phasor is still moving as it arrives there
// and Phasor WRAPS, so the deck jumps from the last sample to frame 0 - a click, then a few ms of
// the track's own beginning. The fix is to fade instead, and to have the fade be OVER by the last
// sample rather than starting at it. So what is pinned here is the arithmetic that puts it there:
// the timer fires one release early, and the moment handed to the engine is worked out when the
// timer is ARMED, so a late event loop cannot drag the fade off the end of the file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// server.js spawns an engine on require, so these are read out of the source and given their own
// dependencies - the same trick highlight-grid.test.js uses for highlightGrid.
const NAMES = ['songPlayheadSec', 'songMarkPaused', 'songEndOfFile', 'songArmEndTimer'];

function loadSongEnd() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const bodies = NAMES.map((name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
    let depth = 0;
    let end = src.indexOf('{', at);
    for (let i = end; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    return src.slice(at, end);
  }).join('\n');
  const rel = src.match(/const SONG_RELEASE_SEC = ([\d.]+);/);
  assert.ok(rel, 'SONG_RELEASE_SEC not found in server.js - this test needs updating');
  // eslint-disable-next-line no-new-func
  const make = new Function('songDecks', 'engine', 'engineTrack', 'SONG_KEYS', 'mixNotify',
    'setTimeout', 'clearTimeout', `
      const SONG_RELEASE_SEC = ${rel[1]};
      ${bodies};
      return { ${NAMES.join(', ')} };
    `);
  return { make, RELEASE: Number(rel[1]) };
}
const { make, RELEASE } = loadSongEnd();

const NOW = 1000; // a fixed engine clock, so every expectation below is exact

// A deck playing `song`, with a fake clock and a fake timer the test fires by hand.
function deck(song) {
  const songDecks = { a: { playing: true, posSec: 0, startSec: NOW, rate: 1, endTimer: null, ...song }, b: null };
  const sent = [];
  const timers = [];
  const api = make(
    songDecks,
    { getTime: () => NOW, songStop: (tid, at) => sent.push({ tid, at }) },
    (key) => `tid:${key}`,
    { a: '#song', b: 'b:#song' },
    () => {},
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    () => {},
  );
  api.deckA = songDecks.a;
  api.sent = sent;
  api.timer = () => timers[timers.length - 1];
  return api;
}

test('the timer fires one release BEFORE the last sample, not at it', () => {
  const d = deck({ duration: 200 });
  d.songArmEndTimer('a');
  assert.equal(d.timer().ms, (200 - RELEASE) * 1000);
});

test('the gate closes one release before the end, so the fade lands on the final sample', () => {
  const d = deck({ duration: 200 });
  d.songArmEndTimer('a');
  d.timer().fn();
  assert.deepEqual(d.sent, [{ tid: 'tid:#song', at: NOW + 200 - RELEASE }]);
});

test('a late event loop still fades at the right sample', () => {
  const d = deck({ duration: 200 });
  d.songArmEndTimer('a');
  // The moment was worked out at arm time, so firing the callback late cannot move it. (The
  // engine's _latency clamps a moment already past to "now" - the worst case, not a wrong one.)
  d.timer().fn();
  assert.equal(d.sent[0].at, NOW + 200 - RELEASE, 'not recomputed from when the timer ran');
});

test('a deck riding faster gets there sooner, in REAL seconds', () => {
  const d = deck({ duration: 200, rate: 2 });
  d.songArmEndTimer('a');
  assert.equal(d.timer().ms, (100 - RELEASE) * 1000);
  d.timer().fn();
  assert.equal(d.sent[0].at, NOW + 100 - RELEASE);
});

test('a mid-file playhead counts only what is left of the file', () => {
  const d = deck({ duration: 200, posSec: 150 });
  d.songArmEndTimer('a');
  assert.equal(d.timer().ms, (50 - RELEASE) * 1000);
});

test('a start still waiting on its quantize adds the wait', () => {
  const d = deck({ duration: 200, startSec: NOW + 3 }); // begins in 3s
  d.songArmEndTimer('a');
  assert.equal(d.timer().ms, (203 - RELEASE) * 1000);
});

test('seeking inside the last release fires at once rather than a negative delay', () => {
  const d = deck({ duration: 200, posSec: 200 - RELEASE / 2 });
  d.songArmEndTimer('a');
  assert.equal(d.timer().ms, 0);
});

test('the end marks the playhead exactly on the duration and stops the deck', () => {
  const d = deck({ duration: 200 });
  d.songArmEndTimer('a');
  d.timer().fn();
  assert.equal(d.deckA.playing, false);
  assert.equal(d.deckA.posSec, 200, 'exactly the end, not a millisecond either side');
  assert.equal(d.deckA.endTimer, null);
});

test('a deck already stopped sends nothing', () => {
  const d = deck({ duration: 200 });
  d.songArmEndTimer('a');
  d.deckA.playing = false; // a stop landed between the arm and the fire
  d.timer().fn();
  assert.deepEqual(d.sent, []);
});

test('a reversed or halted deck arms no end timer at all', () => {
  for (const rate of [0, -1]) {
    const d = deck({ duration: 200, rate });
    d.songArmEndTimer('a');
    assert.equal(d.timer(), undefined, `rate ${rate}`);
  }
});
