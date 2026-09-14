// The envelope panel's reads and code edits (samplerctl.mjs) - pure string in, edits out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readSamplerControls, samplerControlEdits, formatCtl } from './src/samplerctl.mjs';

const apply = (code, res) => {
  let out = code;
  for (const e of [...res.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
};
const set = (code, label, values) => apply(code, samplerControlEdits(code, label, values));

test('unset controls read as the engine defaults', () => {
  const r = readSamplerControls('kick: s("bd")\n', 'kick');
  assert.deepEqual([r.attack.value, r.decay.value, r.sustain.value, r.release.value], [0, 0, 1, 0]);
  assert.deepEqual([r.begin.value, r.end.value, r.loop.value, r.envscale.value], [0, 1, 0, 1]);
  assert.equal(r.attack.set, false);
  assert.equal(r.fit, null);
  assert.equal(readSamplerControls('kick: s("bd")\n', 'snare'), null);
});

test('literals, adsr positions and patterns are told apart', () => {
  const code = 'hats: s("oh").adsr(0.01, 0.2).release(rand().range(0, 0.1)).sustain(0).envscale(dur())\n';
  const r = readSamplerControls(code, 'hats');
  assert.deepEqual(r.attack, { value: 0.01, set: true, patterned: false });
  assert.deepEqual(r.decay, { value: 0.2, set: true, patterned: false });
  assert.equal(r.sustain.value, 0);
  assert.equal(r.release.patterned, true);
  assert.equal(r.release.text, 'rand().range(0, 0.1)');
  assert.equal(r.envscale.patterned, true);
});

test('the later spelling of a stage wins', () => {
  assert.equal(readSamplerControls('x: s("a").attack(0.5).adsr(0.1)', 'x').attack.value, 0.1);
  assert.equal(readSamplerControls('x: s("a").adsr(0.1).attack(0.5)', 'x').attack.value, 0.5);
});

test('bare loop switches mean 1, and fit reads as auto, a number or a pattern', () => {
  const r = readSamplerControls('x: s("a").loop().loopdir().fit()', 'x');
  assert.equal(r.loop.value, 1);
  assert.equal(r.loopdir.value, 1);
  assert.equal(r.loopwrap.value, 0);
  assert.equal(r.fit, 'auto');
  assert.equal(readSamplerControls('x: s("a").fit(2)', 'x').fit, 2);
  assert.equal(readSamplerControls('x: s("a").fit("<1 2>")', 'x').fit, '"<1 2>"');
});

test('commented-out calls are not the chain', () => {
  const code = 'x: s("a")\n  // .attack(0.3)\n  .gain(1)\n';
  assert.equal(readSamplerControls(code, 'x').attack.set, false);
  assert.equal(set(code, 'x', { attack: 0.1 }), 'x: s("a")\n  // .attack(0.3)\n  .gain(1).attack(0.1)\n');
});

test('a literal is rewritten in place, keeping its spacing', () => {
  assert.equal(set('x: s("a").release(0.1).gain(1)', 'x', { release: 0.25 }), 'x: s("a").release(0.25).gain(1)');
  assert.equal(set('x: s("a").adsr(0.1, 0.2, 0.5, 0.3)', 'x', { decay: 0.05, sustain: 0.8 }), 'x: s("a").adsr(0.1, 0.05, 0.8, 0.3)');
  assert.equal(set('x: s("a").loop()', 'x', { loop: 0 }), 'x: s("a").loop(0)');
});

test('four unset stages append one adsr; fewer append their own calls', () => {
  assert.equal(
    set('x: s("a").gain(1)\n', 'x', { attack: 0.005, decay: 0.2, sustain: 0.5, release: 0.1 }),
    'x: s("a").gain(1).adsr(0.005, 0.2, 0.5, 0.1)\n',
  );
  assert.equal(set('x: s("a").attack(0.1)', 'x', { attack: 0.2, release: 0.3 }), 'x: s("a").attack(0.2).release(0.3)');
  assert.equal(set('x: s("a");', 'x', { begin: 0.25, end: 0.5, loop: 1 }), 'x: s("a").begin(0.25).end(0.5).loop(1);');
});

test('a patterned control is skipped, not overwritten', () => {
  const code = 'x: s("a").release(sine(1))';
  const res = samplerControlEdits(code, 'x', { release: 0.2, attack: 0.1 });
  assert.deepEqual(res.skipped, ['release']);
  assert.equal(apply(code, res), 'x: s("a").release(sine(1)).attack(0.1)');
});

test('a group edits its own chain, never its members', () => {
  const code = 'drums: group({\n  kick: s("bd").attack(0.3)\n}).gain(1)\n';
  assert.equal(readSamplerControls(code, 'drums').attack.set, false);
  assert.equal(readSamplerControls(code, 'kick').attack.value, 0.3);
  assert.equal(set(code, 'kick', { attack: 0.1 }), 'drums: group({\n  kick: s("bd").attack(0.1)\n}).gain(1)\n');
});

test('numbers are written short', () => {
  assert.equal(formatCtl(0.1 + 0.2), '0.3');
  assert.equal(formatCtl(0.000049), '0');
  assert.equal(formatCtl(2), '2');
});
