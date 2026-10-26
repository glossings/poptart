// .param() addressing. A parameter belongs to a SLOT, not to a track: two plugins in one chain
// routinely share a parameter name (Mix, Drive, Gain and Freq are on half the plugins there are),
// so the pattern keys them by slot and name together. Keyed by name alone, the second .param("Mix")
// silently overwrote the first and that plugin's parameter was never sent at all - no warning
// anywhere, because the value was dropped in JS before the engine ever heard about it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, lfo, env, _shape, Sig } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine(now = 0) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => now },
    {
      get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }),
      set: (t, p, v) => { t[p] = v; return true; },
    },
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

// ---------------------------------------------------------------------------------------------
// Combining two modulators on one parameter. The engine runs ONE native modulator per parameter
// (a synth on a control bus mapped onto it), so an expression made of two is polled instead -
// and a modulator is a signal like any other, so that just works. The note-gated ones (env(),
// lfo() in retrigger/envelope mode) read their timing off the track's note grid when sampled in
// JS (see sampleEnvIR / withNoteGate). Before 2026-08-26 the composed expression silently sampled
// as a constant, the parameter pinned, and the scheduler's clear of the native it replaced freed
// a synth the notes in flight were still gating - "/n_set Node not found" on every note.
// ---------------------------------------------------------------------------------------------

_shape('sweepA', '0,1 1,0');
_shape('sweepB', '0,0 0.5,1 1,0');

test('two modulators multiply like any two signals, as an expression the engine evaluates', () => {
  const t = s('bd').fx('Pro-Q')
    .param('Frequency', lfo('sweepA', { rate: 1, mode: 'envelope' }).mul(lfo('sweepB')).mul(0.7));
  const sig = t.paramSignals['1:Frequency'].sig;
  assert.equal(sig.lfoIR, null, 'a product of two modulators is not itself one modulator');
  const argsTo = sent(t);
  assert.equal(argsTo('setParamExpr').length, 1);
  assert.deepEqual(argsTo('setParamLFO').map((a) => a[2]), ['~0~Frequency', '~1~Frequency'], 'each runs natively as an input');
  assert.equal(argsTo('setParam').filter(([, slot, name]) => slot >= 0 && name === 'Frequency').length, 0, 'nothing is polled');
});

test('the product still samples in JavaScript, and moves with the notes', () => {
  // For the editor, and for an engine that can't evaluate expressions. s("bd") fires at cycle 0;
  // the envelope-mode shape falls from 1 over its one-cycle pass, the free one rises to its
  // midpoint - so the product is neither frozen nor a constant.
  const product = lfo('sweepA', { rate: 1, mode: 'envelope' }).mul(lfo('sweepB'));
  const values = [0.05, 0.15, 0.25, 0.35, 0.45].map((t) => product.sample(t, 1, t));
  assert.ok(values.every((v) => typeof v === 'number'));
  assert.ok(new Set(values.map((v) => v.toFixed(3))).size > 3, `the product should vary, got ${values}`);
});

test('a plain number still folds into a note-gated lfo() symbolically', () => {
  // The native fast path: .mul(0.7) rewrites the IR's bounds, so a lone modulator stays native.
  const scaled = lfo('sweepA', { rate: 1, mode: 'envelope' }).mul(0.7);
  assert.ok(scaled.lfoIR, 'scaling by a number must keep the modulator native');
  assert.equal(scaled.lfoIR.mode, 'envelope');
  assert.equal(scaled.lfoIR.max, 0.7);
});

test('env() composes too', () => {
  const t = s('bd').fx('Q').param('F', env().mul(lfo('sweepB')));
  assert.equal(t.paramSignals['1:F'].sig.envIR, null);
  const argsTo = sent(t);
  assert.deepEqual(argsTo('setParamEnv').map((a) => a[2]), ['~0~F']);
  assert.equal(argsTo('setParam').filter(([, slot, name]) => slot === 1 && name === 'F').length, 0);
});

test('a lone modulator with a signal-valued bound is still native and dynamic', () => {
  const t = s('bd').fx('Pro-Q')
    .param('Frequency', lfo('sweepA', { rate: 1, mode: 'envelope' }).range(0, lfo('sweepB').mul(0.7)));
  const sig = t.paramSignals['1:Frequency'].sig;
  assert.equal(sig.lfoIR.mode, 'envelope');
  assert.ok(sig.lfoIR.max instanceof Sig, 'the upper bound stays a signal the scheduler polls');
  const argsTo = sent(t);
  assert.equal(argsTo('setParamLFO').length, 1);
  assert.equal(argsTo('setParam').filter(([, slot]) => slot >= 0).length, 0);
});

test('a modulator clear the engine rejects fails neither the eval diff nor stop()', () => {
  const quiet = console.error;
  const logged = [];
  console.error = (line) => logged.push(String(line));
  try {
    const { engine } = mockEngine(0.2);
    engine.clearParamLFO = () => { throw new TypeError('cannot encode OSC argument: [object Object]'); };
    const sched = new Scheduler(engine, { trackId: 'kick' });
    sched.setPattern(s('808f').fx('Decapitator').param('Mix', lfo('0,0 0.5,1 1,0')));
    // The next eval drops the modulator; the failing clear must not abort the diff...
    sched.setPattern(s('808f').fx('Decapitator').param('Mix', 0.5));
    assert.equal(sched._activeModulators.size, 0, 'the modulator is dropped from the table regardless');
    // ...and the teardown path survives it too.
    sched.setPattern(s('808f').fx('Decapitator').param('Mix', lfo('0,0 0.5,1 1,0')));
    sched.stop();
    assert.equal(sched._activeModulators.size, 0);
    assert.match(logged.join('\n'), /could not clear/);
  } finally {
    console.error = quiet;
  }
});
