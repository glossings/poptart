// Two performance decks each have their OWN definitions (rolls/shapes/presets/packs/...): songs
// name things the same way - nearly every one has a Serum preset called `bass` - so one deck's
// evaluation must neither clear nor replace the other deck's, and a name must mean what the
// deck asking defined (see web-app's server.js: setDefOwner is set around each deck's eval).
// Pure store math plus the two readers that bit: a playing deck's preset and its named roll.

import test from 'node:test';
import assert from 'node:assert/strict';

import { clearRolls, restoreRolls, setRollLayer, setDefOwner, adoptDefs, defScope, defScopeOf } from './src/rolls.mjs';
import { _preset, _roll, pianoroll, resolvePreset } from './src/signal.mjs';
import { registerRoll, lookupRoll } from './src/rolls.mjs';
import { setGlobalScale, globalScale } from './src/notes.mjs';

const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
  setDefOwner('a');
};

test("clearing one deck's definitions leaves the other deck's standing", () => {
  fresh();
  registerRoll('kickroll', { deck: 'a' });
  setDefOwner('b');
  registerRoll('bassroll', { deck: 'b' });

  const had = clearRolls('buffer', 'b');
  assert.equal(lookupRoll('bassroll'), null, "deck b's definition should be cleared");
  assert.deepEqual(lookupRoll('kickroll'), { deck: 'a' }, "deck a's definition must survive deck b's eval");
  restoreRolls(had, 'buffer', 'b');
  assert.deepEqual(lookupRoll('bassroll'), { deck: 'b' }, 'the clear hands back what it took, for the restore transaction');
});

test('an owner-scoped restore undoes exactly that clear - a throwing eval leaves both decks intact', () => {
  fresh();
  registerRoll('kickroll', { deck: 'a' });
  setDefOwner('b');
  registerRoll('bassroll', { deck: 'b', v: 1 });

  // Deck b re-evaluates: clears its own, registers a replacement... then the eval throws.
  const had = clearRolls('buffer', 'b');
  registerRoll('bassroll', { deck: 'b', v: 2 });
  registerRoll('padroll', { deck: 'b' });
  restoreRolls(had, 'buffer', 'b');

  assert.deepEqual(lookupRoll('bassroll'), { deck: 'b', v: 1 }, 'the pre-eval definition is back');
  assert.equal(lookupRoll('padroll'), null, "the failed eval's new definition is gone");
  assert.deepEqual(lookupRoll('kickroll'), { deck: 'a' }, "deck a's definition never moved");
});

test('both decks defining one name is two definitions - each deck keeps its own, silently', () => {
  fresh();
  assert.equal(registerRoll('verse', { deck: 'a' }), null, 'a fresh name registers silently');
  setDefOwner('b');
  assert.equal(registerRoll('verse', { deck: 'b' }), null, "the other song's verse is not a clash");
  assert.deepEqual(lookupRoll('verse', defScopeOf('a')), { deck: 'a' }, "deck a's verse is deck a's");
  assert.deepEqual(lookupRoll('verse', defScopeOf('b')), { deck: 'b' }, "deck b's verse is deck b's");

  // Within ONE deck, a duplicate is still worth a line.
  const dup = registerRoll('verse', { deck: 'b', again: true });
  assert.match(dup, /defined twice/);
});

// The 2026-10-06 freeze: every song has a Serum preset called `bass`, so loading a second song
// re-filed the playing song's `bass` with the incoming program, and the playing deck's scheduler
// pushed it into its live plugin - a state reload mid-set.
test("loading a song never hands its presets to the deck that is playing", () => {
  fresh();
  _preset('bass', 'Serum 2', 'PLAYING-SONG-PROGRAM');
  setDefOwner('b');
  clearRolls('buffer', 'b'); // the incoming deck's eval
  _preset('bass', 'Serum 2', 'INCOMING-SONG-PROGRAM');
  setDefOwner('a');
  assert.equal(resolvePreset('bass', 'Serum 2', defScopeOf('a')).state, 'PLAYING-SONG-PROGRAM');
  assert.equal(resolvePreset('bass', 'Serum 2', defScopeOf('b')).state, 'INCOMING-SONG-PROGRAM');
});

test("a named roll plays its own deck's notes, whoever defined the name last", () => {
  fresh();
  _roll('chorus', '60,0,4', { grid: 16 });
  const playingA = pianoroll('<chorus>'); // built in deck a's eval - captures deck a's scope
  setDefOwner('b');
  clearRolls('buffer', 'b');
  _roll('chorus', '72,0,4', { grid: 16 });
  const playingB = pianoroll('<chorus>');
  setDefOwner('a');
  const notes = (sig) => sig.stepsForCycle(0).map((st) => st.value);
  assert.deepEqual(notes(playingA), [60], "deck a's chorus was not clobbered by deck b's");
  assert.deepEqual(notes(playingB), [72]);

  // And clearing deck b (a load onto it) leaves deck a's chorus playing.
  clearRolls('buffer', 'b');
  assert.deepEqual(notes(playingA), [60]);
});

test('complete-mix: promoted patterns keep reading their definitions after the scope moves', () => {
  fresh();
  setDefOwner('b');
  _roll('drop', '48,0,4', { grid: 16 });
  const promoted = pianoroll('<drop>');
  setDefOwner('a');
  clearRolls('buffer', 'a');
  adoptDefs('b', 'a');
  clearRolls('buffer', 'b'); // the next song loads onto the emptied deck
  assert.deepEqual(promoted.stepsForCycle(0).map((st) => st.value), [48]);
  assert.equal(defScope(), defScopeOf('a'));
});

test('a clear with no owner still empties the whole layer (single-deck flows unchanged)', () => {
  fresh();
  registerRoll('one', 1);
  setDefOwner('b');
  registerRoll('two', 2);
  clearRolls('buffer');
  assert.equal(lookupRoll('one'), null);
  assert.equal(lookupRoll('two'), null);
});

test('setGlobalScale(null) clears the key - what entering a deck that never set one does', () => {
  setGlobalScale('F minor');
  assert.equal(globalScale(), 'F minor');
  assert.equal(setGlobalScale(null), null);
  assert.equal(globalScale(), null);
});

test("adoptDefs re-attributes the promoted deck's definitions (complete-mix)", () => {
  fresh();
  registerRoll('oldsong', { deck: 'a' });
  setDefOwner('b');
  registerRoll('newsong', { deck: 'b' });

  // Complete-mix: the outgoing song's definitions go, the incoming song's become the main deck's.
  clearRolls('buffer', 'a');
  adoptDefs('b', 'a');
  assert.equal(lookupRoll('oldsong'), null);
  assert.deepEqual(lookupRoll('newsong'), { deck: 'b' }, 'the promoted definition is still playable');

  // ...and the NEXT main-deck eval treats it as its own: an owner-'a' clear now takes it.
  setDefOwner('a');
  clearRolls('buffer', 'a');
  assert.equal(lookupRoll('newsong'), null, "the adopted definition clears with deck a's next eval");
});
