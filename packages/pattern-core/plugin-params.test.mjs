// .param() addressing. A parameter belongs to a SLOT, not to a track: two plugins in one chain
// routinely share a parameter name (Mix, Drive, Gain and Freq are on half the plugins there are),
// so the pattern keys them by slot and name together. Keyed by name alone, the second .param("Mix")
// silently overwrote the first and that plugin's parameter was never sent at all - no warning
// anywhere, because the value was dropped in JS before the engine ever heard about it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, lfo, Sig } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine(now = 0) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => now },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

// What one eval plus one tick sends for a pattern.
function sent(sig) {
  const { engine, argsTo } = mockEngine(0.2);
  const sched = new Scheduler(engine, { trackId: 'kick' });
  sched.setPattern(sig);
  sched.start();
  sched._tick();
  sched.stop();
  return argsTo;
}

const twoMixes = () => s('808f')
  .fx('Decapitator').param('Mix', 0.8)
  .fx('FilterFreak2').param('Mix', lfo('0,0 0.5,1 1,0'));

test('the same parameter name on two plugins keeps both', () => {
  const t = twoMixes();
  assert.deepEqual(Object.keys(t.paramSignals), ['1:Mix', '2:Mix']);
  assert.equal(t.paramSignals['1:Mix'].slot, 1);
  assert.equal(t.paramSignals['2:Mix'].slot, 2);
  // The NAME the engine is addressed with is the plugin's own, never the composite key.
  assert.equal(t.paramSignals['1:Mix'].name, 'Mix');
  assert.equal(t.paramSignals['2:Mix'].name, 'Mix');
});

test('both reach the engine, each aimed at its own slot', () => {
  const argsTo = sent(twoMixes());
  const params = argsTo('setParam').filter(([, slot]) => slot >= 0);
  assert.deepEqual(params.map(([, slot, name, value]) => [slot, name, value]), [[1, 'Mix', 0.8]]);
  const lfos = argsTo('setParamLFO');
  assert.equal(lfos.length, 1);
  assert.deepEqual(lfos[0].slice(0, 3), ['kick', 2, 'Mix']);
});

test('setting one slot\'s parameter twice replaces it rather than piling up', () => {
  const t = s('bd').fx('Decapitator').param('Mix', 0.2).param('Mix', 0.9);
  assert.deepEqual(Object.keys(t.paramSignals), ['1:Mix']);
  assert.equal(t.paramSignals['1:Mix'].sig.constVal, 0.9);
});

test('a parameter name containing a colon is not mis-read as a slot', () => {
  // Nothing ever splits the key - slot and name are read off the entry - so a plugin free to name
  // a parameter "1:Mix" cannot collide with the Mix on slot 1.
  const t = s('bd').fx('A').param('1:Mix', 0.3).fx('B').param('Mix', 0.7);
  assert.equal(t.paramSignals['1:1:Mix'].name, '1:Mix');
  assert.equal(t.paramSignals['1:1:Mix'].slot, 1);
  assert.equal(t.paramSignals['2:Mix'].slot, 2);
});

test('the "Name#index" disambiguator still addresses by index', () => {
  const argsTo = sent(s('bd').fx('Decapitator').param('Mix#6', 0.5));
  const params = argsTo('setParam').filter(([, slot]) => slot >= 0);
  assert.deepEqual(params.map(([, slot, name]) => [slot, name]), [[1, 'Mix#6']]);
});

test('a cycle remap carries the parameter signal, entry and all', () => {
  // rib re-times which cycle sounds and every carried control signal has to loop with the notes
  // (see rib's remapSig) - the entry has to survive that rebuild with its slot and name intact.
  const t = s('bd*4').fx('Decapitator').param('Mix', s('0 1')).rib(4, 2);
  const entry = t.paramSignals['1:Mix'];
  assert.equal(entry.slot, 1);
  assert.equal(entry.name, 'Mix');
  assert.ok(entry.sig instanceof Sig);
});
