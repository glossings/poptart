// Expressions on a control: audio patched onto a parameter, several sources summed, a source
// times a moving signal, modulators combined with each other. The pattern records what was
// computed as a tree (signal.mjs, Expressions); the scheduler sends the tree once and feeds each of
// its inputs as an ordinary control under the input's own name (Scheduler#_expanded). The math
// itself runs engine-side; what is pinned here is the tree and the calls.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Signal, audio, env, lfo, mini, n, setPatternWarn, sine, synth } from './src/signal.mjs';
import { Scheduler, leafName } from './src/scheduler.mjs';

const EXPR_METHODS = ['setParamExpr', 'clearParamExpr', 'paramExprs'];

function mockEngine({ canEval = true, held = null } = {}) {
  const calls = [];
  const base = { getTime: () => 0 };
  if (held) base.paramExprs = () => held;
  const engine = new Proxy(base, {
    get: (t, p) => {
      if (p in t) return t[p];
      if (!canEval && EXPR_METHODS.includes(p)) return undefined;
      return (...args) => { calls.push({ method: p, args }); };
    },
    has: (t, p) => (!canEval && EXPR_METHODS.includes(p) ? false : true),
  });
  return { engine, calls, callsTo: (m) => calls.filter((c) => c.method === m) };
}

const capture = () => {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  return { lines, restore: () => setPatternWarn(null) };
};

function run(pattern, opts) {
  const mock = mockEngine(opts);
  const sched = new Scheduler(mock.engine, { trackId: 't' });
  sched.setPattern(pattern);
  return { ...mock, sched };
}

const treeOf = (callsTo) => callsTo('setParamExpr').at(-1)?.args[3];
const src = (i, source) => ({ k: 'in', i, rate: 'ar', source });
const k = (v) => ({ k: 'const', v });
const op = (o, a, b) => ({ k: 'op', op: o, a: [a, b] });

test('audio in value position is an expression with one source, not a polled value', () => {
  const { callsTo } = run(synth('Wavetable').param('Osc 1 Phase', audio('mod')));
  assert.deepEqual(callsTo('setParamExpr')[0].args.slice(0, 3), ['t', 0, 'Osc 1 Phase']);
  assert.deepEqual(treeOf(callsTo), src(0, 'mod'));
  assert.equal(callsTo('setParam').filter((c) => c.args[2] === 'Osc 1 Phase').length, 0);
});

test('arithmetic on audio is the tree, in the order it was written', () => {
  const { callsTo } = run(synth('W').param('P', audio('mod').mul(0.5).add(0.5)));
  assert.deepEqual(treeOf(callsTo), op('add', op('mul', src(0, 'mod'), k(0.5)), k(0.5)));
});

test('two sources and an offset add up, each source an input of its own', () => {
  const { callsTo } = run(synth('W').param('P', audio('a').mul(0.2).add(audio('b').mul(0.1)).add(0.4)));
  assert.deepEqual(treeOf(callsTo), op('add', op('add', op('mul', src(0, 'a'), k(0.2)), op('mul', src(1, 'b'), k(0.1))), k(0.4)));
});

test('the same source twice is one input', () => {
  const { callsTo } = run(synth('W').param('P', audio('a').add(audio('a').mul(0.5))));
  assert.deepEqual(treeOf(callsTo), op('add', src(0, 'a'), op('mul', src(0, 'a'), k(0.5))));
});

test('a source times a moving signal is a VCA: the signal runs natively as an input', () => {
  const { callsTo } = run(synth('W').param('P', audio('a').mul(sine(2))));
  assert.deepEqual(treeOf(callsTo), op('mul', src(0, 'a'), { k: 'in', i: 1, rate: 'kr' }));
  const lfos = callsTo('setParamLFO');
  assert.equal(lfos.length, 1);
  assert.deepEqual(lfos[0].args.slice(1, 3), [0, leafName(1, 'P')]);
});

test('modulators combined run natively, an envelope as an audio-rate input', () => {
  const { callsTo } = run(synth('W').param('P', env().mul(sine())));
  assert.deepEqual(treeOf(callsTo), op('mul', { k: 'in', i: 0, rate: 'ar' }, { k: 'in', i: 1, rate: 'kr' }));
  assert.deepEqual(callsTo('setParamEnv')[0].args.slice(1, 3), [0, leafName(0, 'P')]);
  assert.deepEqual(callsTo('setParamLFO')[0].args.slice(1, 3), [0, leafName(1, 'P')]);
});

test('a pattern in an expression is polled onto its input', () => {
  const { callsTo, sched } = run(synth('W').param('P', audio('a').mul(mini('0.5 1'))));
  sched.start(0);
  sched._tick();
  sched.stop();
  const fed = callsTo('setParam').filter((c) => c.args[2] === leafName(1, 'P'));
  assert.ok(fed.length >= 1, 'the pattern is fed to input 1');
  assert.ok([0.5, 1].includes(fed[0].args[3]));
});

test('a modulator with a plain number stays one native modulator, not an expression', () => {
  const { callsTo } = run(synth('W').param('P', sine().mul(0.5).add(0.25)));
  assert.equal(callsTo('setParamExpr').length, 0);
  assert.deepEqual(callsTo('setParamLFO')[0].args.slice(1, 3), [0, 'P']);
});

test('the expression aims at the plugin last in the chain, like every other .param()', () => {
  const { callsTo } = run(synth('W').fx('Filter').param('Cutoff', audio('a')));
  assert.equal(callsTo('setParamExpr')[0].args[1], 1);
});

test('an unchanged expression is not sent again; a changed constant is', () => {
  const pattern = (g) => synth('W').param('P', audio('a').mul(g));
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(pattern(0.5));
  sched.setPattern(pattern(0.5));
  assert.equal(callsTo('setParamExpr').length, 1);
  sched.setPattern(pattern(0.7));
  assert.equal(callsTo('setParamExpr').length, 2);
  assert.deepEqual(treeOf(callsTo), op('mul', src(0, 'a'), k(0.7)));
});

test('an expression the new pattern dropped is cleared, by its real name', () => {
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(synth('W').param('Mode: A', audio('a')));
  sched.setPattern(synth('W'));
  assert.deepEqual(callsTo('clearParamExpr')[0].args, ['t', 0, 'Mode: A']);
});

test('a fresh scheduler leaves what the engine already holds alone, and clears what it dropped', () => {
  const tree = src(0, 'a');
  const held = new Map([['0:P', JSON.stringify(tree)], ['0:Q', JSON.stringify(tree)]]);
  const { callsTo } = run(synth('W').param('P', audio('a')), { held });
  assert.equal(callsTo('setParamExpr').length, 0, 'P is as it was');
  assert.deepEqual(callsTo('clearParamExpr').map((c) => c.args[2]), ['Q']);
});

test('an engine with no answer about its expressions is not a scheduler that throws', () => {
  const { engine } = mockEngine();
  engine.paramExprs = () => 42;
  const sched = new Scheduler(engine, { trackId: 't' });
  assert.doesNotThrow(() => sched.setPattern(synth('W').param('P', audio('a'))));
});

test('stopping clears the expressions, as it clears modulators', () => {
  const { callsTo, sched } = run(synth('W').param('P', audio('a')));
  sched.start(0);
  sched.stop();
  assert.deepEqual(callsTo('clearParamExpr').map((c) => c.args[2]), ['P']);
});

test('an engine that cannot evaluate expressions warns once about audio, and polls the rest', () => {
  const { lines, restore } = capture();
  try {
    const { callsTo, sched } = run(synth('W').param('P', audio('a')).param('Q', env().mul(sine())), { canEval: false });
    sched.start(0);
    sched._tick();
    sched.stop();
    assert.equal(lines.filter((l) => /cannot patch audio/.test(l)).length, 1);
    assert.ok(callsTo('setParam').some((c) => c.args[2] === 'Q'), 'the modulators are polled as their JavaScript');
  } finally {
    restore();
  }
});

test('range maps what a signal swings between: 0..1, or audio\'s -1..1 through its arithmetic', () => {
  const { callsTo } = run(synth('W').param('P', audio('a').range(0.2, 0.6)));
  assert.deepEqual(audio('a').range(0.2, 0.6)._span().map((v) => +v.toFixed(9)), [0.2, 0.6]);
  assert.deepEqual(audio('a').mul(0.5).range(0, 1)._span().map((v) => +v.toFixed(9)), [0, 1]);
  assert.ok(treeOf(callsTo));
  // Ordinary signals map 0..1 as they always have.
  assert.deepEqual(n('0 1').range(10, 20).stepsForCycle(0).map((st) => st.value), [10, 20]);
  assert.equal(sine().range(200, 400).lfoIR.max, 400);
});

test('anything that needs the values themselves warns on audio and leaves it as it was', () => {
  const { lines, restore } = capture();
  try {
    const a = audio('a').fmap((v) => v * 2);
    assert.ok(a._isBareAudioHandle(), 'still the plain connection');
    assert.ok(lines.some((l) => /audio does not have here/.test(l)));
  } finally {
    restore();
  }
});

test('rounding, clamping and comparing are part of the expression', () => {
  const { callsTo } = run(synth('W').param('P', audio('a').abs().clamp(0, Signal(0.5))));
  assert.deepEqual(treeOf(callsTo), op('min', op('max', { k: 'fn', op: 'abs', a: [src(0, 'a')] }, k(0)), k(0.5)));
});

test('setting a parameter twice keeps the last one, whichever kind each was', () => {
  const { callsTo } = run(synth('W').param('P', audio('a')).param('P', 0.3));
  assert.equal(callsTo('setParamExpr').length, 0);
});
