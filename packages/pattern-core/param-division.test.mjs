// A tempo division given to .param() is that option's label, not mini notation.
//
// The editor hands a .param() value over as mini("1/8.", …), and mini reads "1/8." as 1 slowed
// by 8: the number 1, which a Sync control takes as option 1, a 1/32. A dotted-eighth delay played
// as a 53 ms comb (hit live, 2026-10-30). "1 bar" was two steps, 1 and "bar".

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, mini } from './src/signal.mjs';
import { injectLocations } from './src/locations.mjs';

/** What one .param() value plays over two cycles. */
const plays = (value) => {
  const sig = n('0').fx('Delay').param('Sync', value);
  const { sig: v } = Object.values(sig.paramSignals)[0];
  return [0, 1].map((c) => v.stepsForCycle(c).map((s) => s.value));
};

test('a division written whole is its label', () => {
  for (const label of ['1/8.', '1/16T', '1/4', '1 bar', '4 bars']) {
    assert.deepEqual(plays(label), [[label], [label]], `"${label}" as written`);
  }
  assert.equal(n('0').fx('Delay').param('Sync', '1/8.').paramSignals['1:Sync'].sig.sample(0.5, 1), '1/8.');
});

test('the editor leaves a division as written, and mini("1/8.") still reads as the label', () => {
  assert.equal(injectLocations('x.param("Sync", "1/16T")'), 'x.param("Sync", "1/16T")');
  assert.equal(injectLocations('x.param("Delay", "Sync", "1 bar")'), 'x.param("Delay", "Sync", "1 bar")');
  assert.match(injectLocations('x.param("Sync", "<0 7>")'), /mini\("<0 7>"/);
  assert.deepEqual(plays(mini('1/8.', 12)), [['1/8.'], ['1/8.']]);
});

test('a pattern stays a pattern, and quoted labels pattern', () => {
  assert.deepEqual(plays('<0.2 0.8>'), [[0.2], [0.8]]);
  assert.deepEqual(plays("<'1/8.' '1 bar'>"), [['1/8.'], ['1 bar']]);
});
