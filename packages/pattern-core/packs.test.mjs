// _pack()/sp("<ids>") - the named sample pack registry. A pack is data (a list of paths) filed
// under a name, not a Sig; the engine turns it into buffers (see osc-engine's defineSamplePacks).
// Pure registry math here: no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { _pack, sp, setPatternWarn } from './src/signal.mjs';
import { clearRolls, restoreRolls, setRollLayer, lookupPack, packIds } from './src/rolls.mjs';

const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
};
const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

test('_pack files a list of paths under a name, in the order given', () => {
  fresh();
  _pack('kit', ['drums/kick.wav', '/abs/snare.wav', 'hats']);
  assert.deepEqual(lookupPack('kit'), { files: ['drums/kick.wav', '/abs/snare.wav', 'hats'] });
  assert.deepEqual(packIds(), [{ id: 'kit', layer: 'buffer' }]);
});

test('a single string, an empty list and blanks are all tolerated', () => {
  fresh();
  _pack('one', 'a.wav');
  _pack('none');
  _pack('gappy', ['', ' b.wav ', null]);
  assert.deepEqual(lookupPack('one').files, ['a.wav']);
  assert.deepEqual(lookupPack('none').files, []);
  assert.deepEqual(lookupPack('gappy').files, ['b.wav']);
});

test('a definition is marked as such and plays nothing', () => {
  fresh();
  const sig = _pack('kit', ['a.wav']);
  assert.equal(sig.isDef, 'kit');
  assert.equal(sig.stepsForCycle?.(0).length ?? 0, 0);
});

test('ids are one plain word - anything sp("<...>") could not say is refused', () => {
  fresh();
  assert.throws(() => _pack('two words', []), /one plain word/);
  assert.throws(() => _pack('a:b', []), /one plain word/);
  assert.throws(() => _pack({}, []), /number or a name/);
  _pack(0, ['a.wav']);
  assert.deepEqual(packIds().map((p) => p.id), ['0']);
});

test('defining a name twice in one layer warns, and the later one wins', () => {
  fresh();
  const { lines } = capture(() => {
    _pack('kit', ['a.wav']);
    _pack('kit', ['b.wav']);
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /sample pack "kit" is defined twice/);
  assert.deepEqual(lookupPack('kit').files, ['b.wav']);
});

test('the buffer layer shadows prebake, and clearing the buffer uncovers it again', () => {
  fresh();
  setRollLayer('prebake');
  _pack('kit', ['lib.wav']);
  setRollLayer('buffer');
  _pack('kit', ['mine.wav']);
  assert.deepEqual(lookupPack('kit').files, ['mine.wav']);
  assert.deepEqual(packIds(), [{ id: 'kit', layer: 'buffer' }]);
  const had = clearRolls('buffer');
  assert.deepEqual(lookupPack('kit').files, ['lib.wav']);
  assert.deepEqual(packIds(), [{ id: 'kit', layer: 'prebake' }]);
  restoreRolls(had, 'buffer');
  assert.deepEqual(lookupPack('kit').files, ['mine.wav']);
});

test('sp() is a sampler whose step values are pack names', () => {
  const p = sp('kit <kit2 kit3>');
  assert.equal(p.samplerKind, 'named');
  assert.deepEqual(p.stepsForCycle(0).map((s) => s.value), ['kit', 'kit2']);
  assert.deepEqual(p.stepsForCycle(1).map((s) => s.value), ['kit', 'kit3']);
});
