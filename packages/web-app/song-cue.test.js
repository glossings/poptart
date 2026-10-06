'use strict';

// The cue button on a song deck (server.js's songCue).
//
// One press means two different things depending on where the deck is, and that is deliberate:
// on a PAUSED deck it says "one is here" (it sets the cue point and anchors the beatgrid to it),
// and on a PLAYING deck it says "take me back there". The third case is a deck that has run off
// the end of its file, and it used to be read as the first one - so the press that should take
// you back to the top instead moved the cue point to the very end of the record and threw away
// where the top was. A cue point survives the track running out; that is most of what it is for.
//
// (The play press had exactly this bug and was fixed on 2026-10-04 - see `spent` in songPlayDeck.
// The same rule, in the other gesture.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

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
// Up to the first semicolon, not to the end of the line: these two carry trailing comments, and
// anchoring on the line end walks past them into whatever declaration comes next.
function grabConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [^;\n]*;`, 'm'));
  assert.ok(m, `const ${name} not found in server.js - this test needs updating`);
  return m[0];
}

const DEPS = ['songDecks', 'engine', 'engineError', 'engineTrack', 'SONG_KEYS', 'songPlayheadSec',
  'songSync', 'songBaseRate', 'songPause', 'songArmTimers', 'mixNotify', 'console'];
// eslint-disable-next-line no-new-func
const makeCue = new Function(...DEPS, `
  ${grabConst('SONG_END_EPS_SEC')}
  ${grabConst('SONG_START_LEAD_SEC')}
  ${grabFn('songCue')}
  return { songCue };
`);

const NOW = 500;
const DURATION = 200;

/**
 * One deck holding a file. `pos` is where the playhead is, `playing` whether it is running, and
 * `cueSec` the cue point already set - the thing a press at the end must not destroy.
 */
function rig({ pos = 0, playing = false, cueSec = 12, anchorSec = 12 } = {}) {
  const started = [];
  const paused = [];
  const songDecks = {
    a: {
      duration: DURATION,
      posSec: pos,
      playing,
      cueSec,
      anchorSec,
      cueHeld: false,
      bpm: 120,
      keylock: false,
      rate: 1,
      startSec: 0,
    },
    b: null,
  };
  const engine = {
    getTime: () => NOW,
    songStart: (...args) => started.push(args),
  };
  const api = makeCue(
    songDecks,
    engine,
    null,
    (k) => k,
    { a: 'song:a', b: 'song:b' },
    (deck) => songDecks[deck].posSec,
    { effectiveRate: (base) => base },
    () => 1,
    (deck) => { paused.push(deck); songDecks[deck].playing = false; },
    () => {},
    () => {},
    { log: () => {} },
  );
  return { ...api, deck: songDecks.a, started, paused };
}

test('a press on a paused deck parked somewhere new sets the cue there - and ONLY the cue', () => {
  const m = rig({ pos: 40, cueSec: 12, anchorSec: 8 });
  m.songCue('a', true);
  assert.equal(m.deck.cueSec, 40, 'the hand said play from here');
  // Decoupled 2026-10-06: the cue used to drag the beatgrid anchor with it, so a grid anchored
  // once with care was silently rewritten by the second cue press of the night. The anchor is
  // its own gesture; a cue is where play starts from, nothing more.
  assert.equal(m.deck.anchorSec, 8, 'the beatgrid stays where the anchor gesture put it');
  assert.ok(!m.deck.anchorByHand, 'and the cue is not pretending to be that gesture');
});

test('a press on a deck that has run out goes HOME, keeping the cue point', () => {
  const m = rig({ pos: DURATION, cueSec: 12, anchorSec: 12 });
  m.songCue('a', true);
  assert.equal(m.deck.cueSec, 12, 'the cue point was overwritten with the end of the record');
  assert.equal(m.deck.anchorSec, 12, 'and the beatgrid went with it');
  assert.equal(m.started.length, 1);
  assert.equal(m.started[0][1], 12, 'the preview has to start from the cue, not from the end');
});

test('...and so does a press a hair short of the end, where the deck really stops', () => {
  // songArmEndTimer fades out one release early, so a spent deck is parked a few milliseconds
  // before the duration rather than exactly on it. An exact comparison would miss every real
  // end-of-track, which is the only time this case happens.
  const m = rig({ pos: DURATION - 0.02, cueSec: 12 });
  m.songCue('a', true);
  assert.equal(m.deck.cueSec, 12);
});

test('a press on a playing deck takes it back to the cue, as before', () => {
  const m = rig({ pos: 90, playing: true, cueSec: 12 });
  m.songCue('a', true);
  assert.equal(m.deck.cueSec, 12, 'a playing deck never redefines its cue');
  assert.equal(m.started[0][1], 12);
});

test('releasing the press parks the deck back on the cue', () => {
  const m = rig({ pos: DURATION, cueSec: 12 });
  m.songCue('a', true);
  m.songCue('a', false);
  assert.deepEqual(m.paused, ['a']);
  assert.equal(m.deck.posSec, 12, 'home again - the next play reads posSec for its entry');
  assert.equal(m.deck.cueHeld, false);
});
