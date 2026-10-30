// env("x"), the envelope follower - the level of a track, bus or input as a signal - and
// .smooth(t), a lag on any signal. Both are expression nodes (signal.mjs, Expressions) the engines
// run every sample; what is pinned here is the tree, how they compose with everything a modulator
// composes with, and the calls the scheduler makes for them. env() with an object (or nothing) is
// still the note-driven ADSR.

import test from 'node:test';
import assert from 'node:assert/strict';

import { audio, env, lfo, macro, midicc, mini, s, setPatternWarn, sine, synth, ENV_FOLLOW_DEFAULTS } from './src/signal.mjs';
import { Scheduler, leafName } from './src/scheduler.mjs';
import { injectLocations } from './src/locations.mjs';

function mockEngine({ canEval = true } = {}) {
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, {
    get: (t, p) => {
      if (p in t) return t[p];
      if (!canEval && ['setParamExpr', 'clearParamExpr', 'paramExprs'].includes(p)) return undefined;
      return (...args) => { calls.push({ method: p, args }); };
    },
  });
  return { engine, calls, callsTo: (m) => calls.filter((c) => c.method === m) };
}

function run(pattern, opts) {
  const mock = mockEngine(opts);
  const sched = new Scheduler(mock.engine, { trackId: 't' });
  sched.setPattern(pattern);
  return { ...mock, sched };
}

const capture = () => {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  return { lines, restore: () => setPatternWarn(null) };
};

const k = (v) => ({ k: 'const', v });
const src = (i, source) => ({ k: 'in', i, rate: 'ar', source });
const fol = (x, a, r) => ({ k: 'fn', op: 'env', a: [x, a, r] });
const sm = (x, t) => ({ k: 'fn', op: 'smooth', a: [x, t] });
const leaf = (i, rate = 'kr') => ({ k: 'in', i, rate });
const st = (i, rate = 'kr') => ({ k: 'in', i, rate, step: 1 });
const op = (o, a, b) => ({ k: 'op', op: o, a: [a, b] });
const treeOf = (callsTo) => callsTo('setParamExpr').at(-1)?.args[3];
const round = (tree) => JSON.parse(JSON.stringify(tree, (key, v) => (typeof v === 'number' ? +v.toFixed(9) : v)));

test('env("x") is the source\'s level with the default times, sent as an expression', () => {
  const { callsTo } = run(synth('W').param('Cutoff', env('drums')));
  assert.deepEqual(treeOf(callsTo), fol(src(0, 'drums'), k(ENV_FOLLOW_DEFAULTS.attack), k(ENV_FOLLOW_DEFAULTS.release)));
  assert.equal(callsTo('setParam').filter((c) => c.args[2] === 'Cutoff').length, 0, 'nothing polled');
});

test('range maps from 0..1, and arithmetic stacks on top', () => {
  const { callsTo } = run(synth('W').param('Cutoff', env('drums').range(0.2, 0.8)));
  assert.deepEqual(round(treeOf(callsTo)), op('add', op('mul', fol(src(0, 'drums'), k(0.01), k(0.25)), k(0.6)), k(0.2)));
  assert.deepEqual(env('a')._span(), [0, 1]);
});

test('a ducking gain is an expression on the channel control', () => {
  const { callsTo } = run(s('bd').gain(env('vox', { release: 0.3 }).mul(-1).add(1)));
  const call = callsTo('setParamExpr').find((c) => c.args[2] === 'gain');
  assert.ok(call, 'gain takes the expression');
  assert.deepEqual(call.args[3], op('add', op('mul', fol(src(0, 'vox'), k(0.01), k(0.3)), k(-1)), k(1)));
});

test('chained gains keep the follower: the product is an expression too', () => {
  const { callsTo } = run(s('bd').gain(0.5).gain(env('vox')));
  const call = callsTo('setParamExpr').find((c) => c.args[2] === 'gain');
  assert.ok(call, 'still an expression after a second .gain()');
});

test('attack and release take patterns and modulators, each fed as an input', () => {
  const { callsTo, sched } = run(synth('W').param('P', env('a', { attack: lfo(1), release: mini('<0.1 0.5>') })));
  assert.deepEqual(treeOf(callsTo), fol(src(0, 'a'), { k: 'in', i: 1, rate: 'kr' }, { k: 'in', i: 2, rate: 'kr' }));
  assert.deepEqual(callsTo('setParamLFO')[0].args.slice(1, 3), [0, leafName(1, 'P')]);
  sched.start(0);
  sched._tick();
  sched.stop();
  const fed = callsTo('setParam').filter((c) => c.args[2] === leafName(2, 'P'));
  assert.ok(fed.length >= 1 && [0.1, 0.5].includes(fed[0].args[3]), 'the release pattern is polled onto its input');
});

test('a quoted time is the number it says', () => {
  const { callsTo } = run(synth('W').param('P', env('a', { attack: mini('0.05') })));
  assert.deepEqual(treeOf(callsTo).a[1], k(0.05));
});

test('it follows any signal with audio in it, and composes with other modulators', () => {
  const { callsTo } = run(synth('W').param('P', env(audio('a').mul(2)).mul(lfo(2))));
  assert.deepEqual(treeOf(callsTo), op('mul', fol(op('mul', src(0, 'a'), k(2)), k(0.01), k(0.25)), { k: 'in', i: 1, rate: 'kr' }));
});

test('an unchanged follower is not sent again, new times are, and a removed one is cleared', () => {
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(synth('W').param('P', env('a')));
  sched.setPattern(synth('W').param('P', env('a')));
  assert.equal(callsTo('setParamExpr').length, 1);
  sched.setPattern(synth('W').param('P', env('a', { release: 1 })));
  assert.equal(callsTo('setParamExpr').length, 2);
  sched.setPattern(synth('W'));
  assert.deepEqual(callsTo('clearParamExpr').map((c) => c.args.slice(1)), [[0, 'P']]);
});

test('in JavaScript it rests, and anything needing its values warns and leaves it as it was', () => {
  const { lines, restore } = capture();
  try {
    assert.equal(env('a').sample(0.3, 1, 0.3), null);
    assert.equal(env('a').mul(-1).add(1).sample(0.3, 1, 0.3), null);
    const f = env('a');
    assert.equal(f.fmap((v) => v * 2), f);
    assert.ok(lines.some((l) => /audio does not have here/.test(l)));
  } finally {
    restore();
  }
});

test('an engine that cannot evaluate expressions warns once and leaves the control alone', () => {
  const { lines, restore } = capture();
  try {
    const { callsTo, sched } = run(synth('W').param('P', env(lfo(1))), { canEval: false });
    sched.start(0);
    sched._tick();
    sched.stop();
    assert.equal(lines.filter((l) => /cannot patch audio/.test(l)).length, 1);
    assert.equal(callsTo('setParam').filter((c) => c.args[2] === 'P').length, 0);
  } finally {
    restore();
  }
});

test('a missing source name warns and reads 0', () => {
  const { lines, restore } = capture();
  try {
    assert.equal(env('').sample(0, 1, 0), 0);
    assert.equal(lines.length, 1);
  } finally {
    restore();
  }
});

test('the editor leaves the source name alone', () => {
  assert.equal(injectLocations('env("drums")'), 'env("drums")');
});

test('env with an object or nothing is still the note-driven ADSR', () => {
  assert.equal(env({ attack: 0.2 }).envIR.attack, 0.2);
  assert.ok(env().envIR);
  assert.equal(env({ attack: 0.2 }).expr, undefined);
  const { callsTo } = run(synth('W').param('P', env({ decay: 0.3 })));
  assert.equal(callsTo('setParamExpr').length, 0);
  assert.equal(callsTo('setParamEnv').length, 1);
});

test('smooth lags a stepped pattern, an lfo, a cc, a macro, audio, arithmetic and a follower', () => {
  const tree = (sig) => run(synth('W').param('P', sig)).callsTo('setParamExpr').at(-1)?.args[3];
  assert.deepEqual(tree(mini('<0 1 0.5>').smooth(0.2)), sm(st(0), k(0.2)));
  assert.deepEqual(tree(sine(1).smooth(0.1)), sm(st(0), k(0.1)));
  assert.deepEqual(tree(env({ decay: 0.2 }).smooth(0.1)), sm(st(0, 'ar'), k(0.1)));
  assert.deepEqual(tree(midicc('Twister')(12).smooth(0.1)), sm(st(0), k(0.1)));
  assert.deepEqual(tree(macro(1).smooth(0.1)), sm(st(0), k(0.1)), 'a knob is an input, never baked in');
  assert.deepEqual(tree(audio('x').smooth(0.01)), sm(src(0, 'x'), k(0.01)));
  assert.deepEqual(tree(sine(1).mul(sine(3)).smooth(0.1)), sm(op('mul', st(0), st(1)), k(0.1)));
  assert.deepEqual(tree(env('kick').smooth(0.05)), sm(fol(src(0, 'kick'), k(0.01), k(0.25)), k(0.05)));
});

test('smooth takes its time as a pattern, and composes with range and arithmetic', () => {
  const { callsTo } = run(synth('W').param('P', mini('<0 1>').smooth(mini('<0.1 0.4>')).range(200, 800)));
  assert.deepEqual(callsTo('setParamExpr').at(-1).args[3], op('add', op('mul', sm(st(0), leaf(1)), k(600)), k(200)));
});

test('a smoothed lfo plays on the engine; the lone lfo stays a native modulator', () => {
  assert.equal(run(synth('W').param('P', sine(1))).callsTo('setParamExpr').length, 0);
  const { callsTo } = run(synth('W').param('P', sine(1).smooth(0.1)));
  assert.equal(callsTo('setParamExpr').length, 1);
  assert.deepEqual(callsTo('setParamLFO')[0].args.slice(1, 3), [0, leafName(0, 'P')]);
});

test('in JavaScript a smoothed pattern reads unsmoothed, and smoothed audio rests', () => {
  assert.equal(mini('<0 1>').smooth(0.2).sample(1.5, 1, 1.5), 1);
  assert.equal(audio('x').smooth(0.01).sample(0, 1, 0), null);
});

test('an unchanged smooth keeps running, a new time is sent, a removed one is cleared', () => {
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(synth('W').param('P', sine(1).smooth(0.1)));
  sched.setPattern(synth('W').param('P', sine(1).smooth(0.1)));
  assert.equal(callsTo('setParamExpr').length, 1);
  sched.setPattern(synth('W').param('P', sine(1).smooth(0.3)));
  assert.equal(callsTo('setParamExpr').length, 2);
  sched.setPattern(synth('W'));
  assert.deepEqual(callsTo('clearParamExpr').map((c) => c.args.slice(1)), [[0, 'P']]);
});

test('the envelope editor opens on an ADSR env(), not on a follower', async () => {
  const { findEnvCallAt } = await import('./src/envctl.mjs');
  assert.equal(findEnvCallAt('env("kick")', 1), null);
  assert.equal(findEnvCallAt('env(audio("x"))', 1), null);
  assert.ok(findEnvCallAt('env({ attack: 0.1 })', 1));
  assert.ok(findEnvCallAt('env()', 1));
});

test('an input read only under a smooth is marked to arrive stepped; one also read outside is not', async () => {
  const { markStepped } = await import('./src/scheduler.mjs');
  const tree = op('add', sm(op('mul', leaf(0), leaf(1)), leaf(2)), leaf(1));
  assert.deepEqual(markStepped(tree), op('add', sm(op('mul', st(0), leaf(1)), leaf(2)), leaf(1)));
  assert.deepEqual(markStepped(sm(src(0, 'a'), k(0))), sm(src(0, 'a'), k(0)), 'audio is never polled');
});
