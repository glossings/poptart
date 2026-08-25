// Two performance decks share the definition registries (rolls/shapes/presets/packs) and the
// global scale, but each deck's evaluation must only clear and refill ITS OWN definitions -
// evaluating one song while the other plays must not silence the other's rolls (see web-app's
// server.js: setDefOwner is set around each deck's eval). Pure store math, no scheduler.

import test from 'node:test';
import assert from 'node:assert/strict';

import { clearRolls, restoreRolls, setRollLayer, setDefOwner, adoptDefs } from './src/rolls.mjs';
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
  assert.ok(had.roll.has('bassroll'), 'the clear hands back what it took, for the restore transaction');
  assert.ok(!had.roll.has('kickroll'), "the clear must not take the other deck's definitions");
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

test('both decks defining one name warns with the cross-deck wording, and the later wins', () => {
  fresh();
  assert.equal(registerRoll('verse', { deck: 'a' }), null, 'a fresh name registers silently');
  setDefOwner('b');
  const warning = registerRoll('verse', { deck: 'b' });
  assert.match(warning, /defined by both decks/, 'the warning names the real conflict, not "defined twice"');
  assert.deepEqual(lookupRoll('verse'), { deck: 'b' }, 'the later definition wins for both');

  // Within ONE deck, a duplicate keeps the original wording.
  const dup = registerRoll('verse', { deck: 'b', again: true });
  assert.match(dup, /defined twice/);
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
