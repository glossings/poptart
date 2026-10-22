// Which sample a sampler track plays, read without playing it (sample-source.mjs) - what the track
// list names beside s("psyhyp:9").fit(). It has to resolve exactly as the scheduler dispatches.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, sp, se, sr, n } from './src/signal.mjs';
import { sampleSourcesOf, fittedCycles } from './src/sample-source.mjs';

test('the index suffix names the file, an explicit .i() beats it, and .fit() rides along', () => {
  assert.deepEqual(sampleSourcesOf(s('psyhyp:9').fit()), [{ ref: 'psyhyp', index: 9, fit: 'auto' }]);
  assert.deepEqual(sampleSourcesOf(s('psyhyp:9').i(2)), [{ ref: 'psyhyp', index: 2, fit: null }]);
  assert.deepEqual(sampleSourcesOf(s('loop').fit(4)), [{ ref: 'loop', index: 0, fit: 4 }]);
});

test('the sources come in the order they first sound, each once, across the cycles asked for', () => {
  assert.deepEqual(sampleSourcesOf(s('bd ~ sd:3 bd')).map((x) => `${x.ref}:${x.index}`), ['bd:0', 'sd:3']);
  assert.deepEqual(sampleSourcesOf(s('<breaks:1 breaks:2>'), { cycles: 2 }).map((x) => x.index), [1, 2]);
  assert.deepEqual(sampleSourcesOf(s('<breaks:1 breaks:2>'), { cycles: 1 }).map((x) => x.index), [1]);
});

test('each source kind is spelled the way the engine resolves it', () => {
  assert.equal(sampleSourcesOf(sp('kit:2'))[0].ref, 'sp:kit');
  assert.equal(sampleSourcesOf(se('kick'))[0].ref, 'file:kick');
  assert.equal(sampleSourcesOf(sr('take:1'))[0].ref, 'rec:take:1'); // one file: its ":" is part of the name
  assert.deepEqual(sampleSourcesOf(n('0 2')), []); // not a sampler
});

test("a fitted length is the engine's: the given cycles, or the nearest power of two", () => {
  // 7.2 s at 2 s a cycle is 3.6 cycles as recorded
  assert.equal(fittedCycles(7.2, 2, null), 3.6);
  assert.equal(fittedCycles(7.2, 2, 'auto'), 4);
  assert.equal(fittedCycles(4.8, 2, 'auto'), 2); // 2.4 -> 2
  assert.equal(fittedCycles(7.2, 2, 8), 8);
  assert.equal(fittedCycles(null, 2, 'auto'), null);
});
