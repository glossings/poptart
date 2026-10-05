'use strict';

// The decks' REGIONS toggle and the one thing it is not allowed to do: stop a song that has no
// ending. DJ mode opens with both decks' loop regions off, so a song runs start to end like a
// record - but a song nobody has arranged is one loop over its whole length (pattern-core's
// isWholeSongLoop), and switching that off does not make it play like a record, it makes it stop
// after eight bars at the end of something no one wrote an ending for. That deck loops anyway.
//
// The other half is that the button has to keep meaning what it says: a deliberate press PINS it,
// and nothing re-decides underneath the hand - not the next evaluation, not a clip being painted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// server.js spawns an engine on require, so the functions are read out of the source and handed
// their own dependencies - the trick dj-loop.test.js and dj-midi.test.js use.
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

const DEPS = ['arrangeClocks', 'transport', 'engine', 'mixNotify', 'patternCore'];
const NAMES = ['deckLoopsDefault', 'setDeckLoops'];
// eslint-disable-next-line no-new-func
const makeLoops = new Function(...DEPS, `
  ${grabConst('deckLoopsOn')}
  ${grabConst('deckLoopsPinned')}
  ${NAMES.map(grabFn).join('\n')}
  return { ${NAMES.join(', ')}, deckLoopsOn, deckLoopsPinned };
`);

let ArrangeClock;
let isWholeSongLoop;
test.before(async () => {
  ({ ArrangeClock, isWholeSongLoop } = await import(url.pathToFileURL(path.join(__dirname, '../pattern-core/src/arrange.mjs')).href));
});

// The two shapes the whole thing turns on, as the painter writes them.
const UNARRANGED = [{ name: 'song', start: 0, end: 8 }]; // a fresh arrangement's seeded region
const ARRANGED = [{ name: 'intro', start: 0, end: 8 }, { name: 'break', start: 16, end: 24 }];

/**
 * A deck whose arrangement is `regions` over a song `end` bars long. `regions: null` is a deck with
 * no arrangement at ALL - a song the painter has never been opened on, which nothing gates.
 */
function rig({ regions = UNARRANGED, end = 8 } = {}) {
  const clocks = { a: null, b: null };
  if (regions) {
    clocks.a = new ArrangeClock({ regions, loopsOn: true });
    clocks.a.setEnd(end);
  }
  const api = makeLoops(clocks, null, null, () => {}, { isWholeSongLoop });
  return { ...api, clocks };
}

// --- the default -------------------------------------------------------------------------------

test('DJ mode switches the regions off, except where off would mean "stop at bar 8"', () => {
  const live = rig({ regions: UNARRANGED });
  assert.equal(live.setDeckLoops('a', false, { pinned: false }), true, 'an unarranged song loops through the blanket default');
  const song = rig({ regions: ARRANGED, end: 24 });
  assert.equal(song.setDeckLoops('a', false, { pinned: false }), false, 'and a song carved into parts plays through it');
});

test('a deck with no arrangement at all loops too - nothing is gating it', () => {
  // Nothing writes an _arrange call until the painter is opened, so this is the ordinary state of
  // a song that has never been arranged: every track is the bare loop it is written as.
  const m = rig({ regions: null });
  assert.equal(m.setDeckLoops('a', false, { pinned: false }), true);
});

test('the default only ever comes back ON - it cannot silence an armed region', () => {
  // Which is what makes it safe outside a mix, where loops-on is the whole workflow.
  const m = rig({ regions: ARRANGED, end: 24 });
  assert.equal(m.deckLoopsDefault('a', true, ARRANGED, 24), true);
  assert.equal(m.deckLoopsDefault('a', true, null, 0), true);
});

test('a song whose clips run past its loop is arranged, and plays through', () => {
  // The seeded region left at 8 bars while the parts were painted out to 16: switching this on
  // would loop the first half for the rest of the night and never reach bar 9.
  const m = rig({ regions: UNARRANGED, end: 16 });
  assert.equal(m.setDeckLoops('a', false, { pinned: false }), false);
});

// --- the pin -----------------------------------------------------------------------------------

test('a press of the button is final, and the next evaluation does not argue', () => {
  const m = rig({ regions: UNARRANGED });
  assert.equal(m.setDeckLoops('a', false), false, 'off is off when a performer asks for it');
  assert.equal(m.deckLoopsPinned.a, true);
  // What every eval of this deck's buffer asks from then on (see the arrangement pass).
  assert.equal(m.deckLoopsDefault('a', false, UNARRANGED, 8), false, 'still off, unarranged or not');
});

test('an unpressed deck is re-decided by its arrangement on every evaluation', () => {
  const m = rig({ regions: UNARRANGED });
  assert.equal(m.deckLoopsPinned.a, false, 'nothing has been pressed yet');
  assert.equal(m.deckLoopsDefault('a', false, UNARRANGED, 8), true);
  // ...and carving the song is what makes the toggle mean something, so the answer changes with it.
  assert.equal(m.deckLoopsDefault('a', false, ARRANGED, 24), false);
});

test('applying a default releases an earlier press, so the next song chooses for itself', () => {
  // Leaving DJ mode and clearing a deck both apply one (eject, complete, /api/mix/clear).
  const m = rig({ regions: UNARRANGED });
  m.setDeckLoops('a', false);
  assert.equal(m.deckLoopsPinned.a, true);
  m.setDeckLoops('a', true, { pinned: false });
  assert.equal(m.deckLoopsPinned.a, false);
  assert.equal(m.deckLoopsOn.a, true);
});

test('the toggle reaches the clock it is about, and the desk stream', () => {
  const clocks = { a: null, b: null };
  clocks.a = new ArrangeClock({ regions: ARRANGED, loopsOn: true });
  clocks.a.setEnd(24);
  let notified = 0;
  const api = makeLoops(clocks, null, null, () => { notified += 1; }, { isWholeSongLoop });
  api.setDeckLoops('a', false);
  assert.equal(clocks.a.loopsOn, false, 'the clock stops honoring its regions');
  assert.equal(notified, 1, 'and the deck head hears about it');
});

// --- the wiring ---------------------------------------------------------------------------------

test('the arrangement pass asks for the default, and the deck-clear route lets go of the pin', () => {
  // Checked against the source because both live inside route handlers no test can call: the whole
  // feature is that a deck coming up holding an unarranged song arms ITSELF.
  assert.match(SRC, /const loops = deckLoopsDefault\(deck, deckLoopsOn\[deck\], regions, songEnd\);/,
    'the arrangement pass should decide the toggle from the regions it just read');
  assert.match(SRC, /arrangeClips\[deck\] = null;[\s\S]{0,500}?if \(!deckLoopsPinned\[deck\]\) deckLoopsOn\[deck\] = true;/,
    'and a deck with no arrangement at all should read as looping');
  assert.match(SRC, /'POST \/api\/mix\/clear'[\s\S]*?deckLoopsPinned\[deck\] = false;/,
    'a deck taking a new song should decide again');
  assert.match(SRC, /setDeckLoops\(deck, !!body\?\.on, \{ pinned: body\?\.pin !== false \}\)/,
    'and the route should carry the difference between a press and a default');
});

test('DJ mode opens the decks at the SETTING, and as a default rather than a press', () => {
  // Sending this as a press would pin both decks the moment the mix opens, and no song would
  // ever get to say it has no ending.
  assert.match(CLIENT, /\/api\/arrangeLoops', \{ deck: d, on: regionsOn, pin: false \}/);
  // ...and `regionsOn` is the settings choice, not a constant: the deck heads used to carry a
  // button each, and what replaced them is one answer about how you play (settings -> dj mode).
  assert.match(CLIENT, /const regionsOn = djRegionsMode === 'on';/);
  assert.match(CLIENT, /api\('GET', '\/api\/djRegions'\)/, 'the setting has to be read somewhere');
  assert.match(SRC, /'POST \/api\/djRegions'/, 'and the server has to keep it');
  // The live toggle is the press, and says nothing about pinning. It is {app+l} now rather than
  // a button, but it is the same call.
  assert.match(CLIENT, /\/api\/arrangeLoops', \{ deck, on: !deckLoopsNow\[deck\] \}/);
});

test('the regions choice is off unless it was changed, and anything else reads as off', () => {
  // A hand-edited settings file, or an older one with no such key: the opening position that has
  // always been right for a mix is the one a record plays at.
  assert.match(SRC, /settings\.djRegions === 'on' \? 'on' : 'off'/);
  assert.match(SRC, /body\?\.mode === 'on' \? 'on' : 'off'/);
});
