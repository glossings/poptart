'use strict';

// `mute all` - every gate on one deck out in a single gesture, the blank canvas a mix is built
// into. There is no state to it and nothing to release, so what is worth pinning is its edges:
// that it takes out the stems that exist WHEN IT IS PRESSED and nothing else (a stem evaled
// afterwards is new work, and new work is meant to be heard); that it reaches only its own deck,
// swap mode included, since emptying deck A must not throw all of deck B in; and that a solo
// running on the deck is ended rather than left holding a snapshot that would undo the whole
// gesture the moment the solo was dismissed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// server.js spawns an engine on require, so the desk functions are read out of the source and
// given their own dependencies - the same trick highlight-grid.test.js uses for highlightGrid.
const NAMES = ['mixSetFader', 'mixGateSet', 'mixSoloEnd', 'mixGateAll'];

function loadMixDesk() {
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
  // eslint-disable-next-line no-new-func
  return new Function('mixState', 'deckOfKey', 'mixKeys', 'engine', 'engineTrack', `
    ${bodies};
    return { ${NAMES.join(', ')} };
  `);
}
const makeDesk = loadMixDesk();

// A desk with `keys` as its stems, each at fader 1 unless `faders` says otherwise. `live` is what
// the engine actually holds - the thing an ear would hear - kept apart from mixState.perTrack so
// a test can tell "remembered" (what a re-eval re-applies) from "applied".
function desk(keys, faders = {}) {
  const mixState = {
    swap: false,
    solo: { a: new Set(), b: new Set() },
    soloPrev: { a: null, b: null },
    perDeck: { a: new Map(), b: new Map() },
    perTrack: new Map(),
    xf: -1,
    faders: { a: 1, b: 1 },
  };
  const live = new Map();
  const stems = [...keys];
  for (const k of stems) {
    live.set(k, faders[k] ?? 1);
    if (k in faders) mixState.perTrack.set(k, new Map([['fader', faders[k]]]));
  }
  const api = makeDesk(
    mixState,
    (key) => (key.startsWith('b:') ? 'b' : 'a'),
    function* mixKeys() { yield* stems; },
    { setParam: (tid, slot, name, value) => live.set(tid, value) },
    (key) => key,
  );
  // A stem written after the gesture: born at the synthdef's 1 with no perTrack entry - what
  // mixBirthFor produces for a label the desk has never seen (server.js's DJ_NEUTRAL.fader).
  api.evalStem = (key) => {
    stems.push(key);
    live.set(key, 1);
  };
  api.heard = () => Object.fromEntries([...live].sort());
  api.state = mixState;
  return api;
}

const BOTH = ['bd', 'hats', 'bass', 'b:bd', 'b:pad'];

test('every stem on the deck goes out, and only that deck', () => {
  const d = desk(BOTH);
  assert.deepEqual(d.mixGateAll('a').sort(), ['bass', 'bd', 'hats']);
  assert.deepEqual(d.heard(), {
    bass: 0, bd: 0, hats: 0, 'b:bd': 1, 'b:pad': 1,
  });
});

test('deck B empties without touching deck A', () => {
  const d = desk(BOTH);
  d.mixGateAll('b');
  assert.deepEqual(d.heard(), {
    bass: 1, bd: 1, hats: 1, 'b:bd': 0, 'b:pad': 0,
  });
});

test('a song deck is a stem like any other', () => {
  const d = desk(['bd', '#song']);
  d.mixGateAll('a');
  assert.deepEqual(d.heard(), { '#song': 0, bd: 0 });
});

test('the gates are RECORDED out, so a re-eval brings them back out', () => {
  const d = desk(['bd', 'hats']);
  d.mixGateAll('a');
  // mixBirthFor reads perTrack: this is what a re-evaled stem is born wearing.
  assert.equal(d.state.perTrack.get('bd').get('fader'), 0);
  assert.equal(d.state.perTrack.get('hats').get('fader'), 0);
});

test('only the stems available at the time - a stem evaled afterwards is heard', () => {
  const d = desk(['bd', 'hats']);
  d.mixGateAll('a');
  d.evalStem('lead'); // new work, onto the blank canvas
  assert.deepEqual(d.heard(), { bd: 0, hats: 0, lead: 1 });
});

test('a running solo is ended, not left to undo the gesture', () => {
  const d = desk(['bd', 'hats', 'bass'], { bass: 0.4 });
  // The solo gesture as /api/mix/solo performs it: snapshot, then everything but `bd` out.
  d.state.soloPrev.a = new Map([['bd', 1], ['hats', 1], ['bass', 0.4]]);
  d.state.solo.a.add('bd');
  for (const k of ['bd', 'hats', 'bass']) d.mixSetFader(k, k === 'bd' ? 1 : 0);

  d.mixGateAll('a');
  assert.equal(d.state.solo.a.size, 0);
  assert.equal(d.state.soloPrev.a, null, 'no snapshot left to restore the deck from');
  assert.deepEqual(d.heard(), { bass: 0, bd: 0, hats: 0 });
});

test('pressing it on an already-empty deck changes nothing', () => {
  const d = desk(['bd', 'hats']);
  d.mixGateAll('a');
  d.mixGateAll('a');
  assert.deepEqual(d.heard(), { bd: 0, hats: 0 });
});

test('a deck with no stems is not an error', () => {
  const d = desk(['b:pad']);
  assert.deepEqual(d.mixGateAll('a'), []);
  assert.deepEqual(d.heard(), { 'b:pad': 1 });
});
