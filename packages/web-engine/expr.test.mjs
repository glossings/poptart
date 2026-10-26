// Parameter expressions (setParamExpr): the per-sample math in dsp/expr.mjs, and how the engine
// wires an expression's inputs and output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { EnvConnection, LfoConnection } from './src/engine/modulators.mjs';
import {
  compileExpr, exprConsts, exprInputCount, exprMapUnit, exprShape, renderExpr,
} from './src/dsp/expr.mjs';

function makeEngine() {
  const ctx = new FakeAudioContext();
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    routeWaitMs: 1,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  return { ctx, engine, warnings };
}

const c = (v) => ({ k: 'const', v });
const op = (name, x, y) => ({ k: 'op', op: name, a: [x, y] });
const fn = (name, x) => ({ k: 'fn', op: name, a: [x] });
const src = (i, source) => ({ k: 'in', i, rate: 'ar', source });
const leaf = (i, rate = 'kr') => ({ k: 'in', i, rate });
const at = (tree, x = []) => compileExpr(tree)(x);

// ---- the math --------------------------------------------------------------------------------

test('arithmetic matches the desktop engine, including where it has no answer', () => {
  assert.equal(at(op('add', c(1), c(2))), 3);
  assert.equal(at(op('sub', c(1), c(2))), -1);
  assert.equal(at(op('mul', c(3), c(2))), 6);
  assert.equal(at(op('div', c(3), c(2))), 1.5);
  assert.equal(at(op('div', c(3), c(0))), 0, 'a divide by zero is 0, never Infinity');
  assert.equal(at(op('mod', c(-1), c(4))), 3, 'mod is floored, as in the pattern language');
  assert.equal(at(op('mod', c(5), c(0))), 0);
  assert.equal(at(op('pow', c(-8), c(1 / 3))), 0, 'a power with no real answer is 0, never NaN');
  assert.equal(at(op('min', c(1), c(2))), 1);
  assert.equal(at(op('max', c(1), c(2))), 2);
  assert.deepEqual(['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].map((o) => at(op(o, c(1), c(1)))), [0, 1, 0, 1, 1, 0]);
  assert.deepEqual(['abs', 'neg', 'round', 'floor', 'ceil'].map((o) => at(fn(o, c(-2.5)))), [2.5, 2.5, -2, -3, -2]);
});

test('real units map onto a 0..1 position along a lin or log curve, clipped', () => {
  assert.equal(exprMapUnit(150, 100, 200, 'lin'), 0.5);
  assert.ok(Math.abs(exprMapUnit(1000, 100, 10000, 'log') - 0.5) < 1e-12);
  assert.equal(exprMapUnit(50000, 100, 10000, 'log'), 1);
  assert.equal(exprMapUnit(-3, 100, 10000, 'log'), 0);
  assert.equal(at({ k: 'map', min: 0, max: 10, curve: 'lin', a: [c(2.5)] }), 0.25);
});

test('inputs are read per sample, and an unconnected one reads 0', () => {
  const tree = op('add', op('mul', leaf(0, 'ar'), leaf(1)), leaf(3));
  assert.equal(exprInputCount(tree), 4, 'one past the highest index, whatever the gaps');
  const run = compileExpr(tree);
  const out = new Float32Array(3);
  // input 0 audio, input 1 a level, input 2 unread, input 3 unconnected (no channels)
  renderExpr(run, [[Float32Array.of(1, -1, 0.5)], [Float32Array.of(0.5, 0.5, 2)], [], []], out, new Float64Array(4));
  assert.deepEqual([...out], [0.5, -0.5, 1]);
});

test('a tree differing only in constants has the same shape, and new constants are taken live', () => {
  const a = op('add', op('mul', src(0, 'mod'), c(0.5)), c(0.1));
  const b = op('add', op('mul', src(0, 'mod'), c(0.2)), c(0.4));
  assert.equal(exprShape(a), exprShape(b));
  assert.notEqual(exprShape(a), exprShape(op('sub', op('mul', src(0, 'mod'), c(0.5)), c(0.1))));
  const consts = exprConsts(a);
  assert.deepEqual(consts, [0.5, 0.1]);
  const run = compileExpr(a, consts);
  assert.equal(run([1]), 0.6);
  consts.splice(0, 2, ...exprConsts(b));
  assert.ok(Math.abs(run([1]) - 0.6) < 1e-12, 'same array, new numbers');
  assert.ok(Math.abs(run([2]) - 0.8) < 1e-12);
});

test('an unknown node is refused by name', () => {
  assert.throws(() => compileExpr(op('nonesuch', c(1), c(2))), /nonesuch/);
  assert.throws(() => compileExpr({ k: 'what' }), /what/);
});

// ---- the engine ------------------------------------------------------------------------------

/** A Wavetable on `lead` and two tracks to patch from. */
function patchRig() {
  const made = makeEngine();
  made.engine.createTrack('a');
  made.engine.createTrack('b');
  made.engine.createTrack('lead');
  made.engine.loadInstrument('lead', 'Wavetable');
  const phase = made.engine.tracks.get('lead').slots.get(0).built.node.parameters.get('osc1.phase');
  const rec = () => made.engine.exprs.get('lead').get('0:Osc 1 Phase');
  return { ...made, phase, rec };
}

test('two sources patched onto one parameter are summed, each on an input of its own', () => {
  const { engine, phase, rec } = patchRig();
  // audio("a").mul(0.2).add(audio("b").mul(0.1)).add(0.4)
  const tree = op('add', op('add', op('mul', src(0, 'a'), c(0.2)), op('mul', src(1, 'b'), c(0.1))), c(0.4));
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', tree);
  const node = rec().node;
  assert.equal(node.options.numberOfInputs, 2);
  assert.equal(node.options.channelCount, 1, 'each input is one channel');
  assert.equal(node.options.channelInterpretation, 'speakers', 'so a stereo source folds to (L + R) / 2');
  assert.ok(engine.tracks.get('a').panner.links.some((l) => l.target === node && l.input === 0));
  assert.ok(engine.tracks.get('b').panner.links.some((l) => l.target === node && l.input === 1));
  assert.ok(node.outputs.includes(phase));
  assert.ok(Math.abs(at(tree, [1, 1]) - 0.7) < 1e-12, 'and the node sums them');
});

test('audio times an lfo is a VCA: the lfo drives the input it is aimed at', () => {
  const { engine, rec } = patchRig();
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('mul', src(0, 'a'), leaf(1)));
  engine.setParamLFO('lead', 0, '~1~Osc 1 Phase', { shape: 'sine', rateHz: 2, min: 0, max: 1 });
  const lfo = engine.modulators.get('lead').get('0:~1~Osc 1 Phase');
  assert.ok(lfo instanceof LfoConnection);
  const input = rec().inputs.get(1);
  assert.equal(lfo.target, input.offset, "the lfo's target is the constant feeding input 1");
  assert.ok(input.links.some((l) => l.target === rec().node && l.input === 1));
  assert.equal(engine.drivenParams('lead', 0).get('osc1.phase'), 'a combination of signals');
});

test('env times lfo: both modulators feed inputs, and the envelope is gated by the notes', () => {
  const { engine, rec } = patchRig();
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('mul', leaf(0, 'ar'), leaf(1)));
  engine.setParamEnv('lead', 0, '~0~Osc 1 Phase', { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2, min: 0, max: 1 });
  engine.setParamLFO('lead', 0, '~1~Osc 1 Phase', { shape: 'tri', rateHz: 1, min: 0, max: 1 });
  const env = engine.modulators.get('lead').get('0:~0~Osc 1 Phase');
  assert.ok(env instanceof EnvConnection);
  assert.equal(env.target, rec().inputs.get(0).offset);
  assert.ok(engine.envelopes.get('lead').has('0:~0~Osc 1 Phase'), 'filed with the envelopes the notes gate');
  const before = env.target.calls.length;
  engine.noteOn('lead', 60, 1, 0);
  assert.ok(env.target.calls.length > before, 'a note opens it');
});

test('a value for an input that arrives before its expression is kept and wired when it lands', () => {
  const { ctx, engine, rec } = patchRig();
  engine.setParam('lead', 0, '~1~Osc 1 Phase', 0.3, ctx.currentTime);
  const input = rec().inputs.get(1);
  assert.ok(input.offset.landedOn(0.3));
  assert.equal(rec().node, null, 'nothing is installed yet, so the parameter is still its own');
  engine.setParam('lead', 0, 'Osc 1 Phase', 0.6, ctx.currentTime);
  assert.ok(engine.tracks.get('lead').slots.get(0).built.node.parameters.get('osc1.phase').landedOn(0.6));

  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('add', src(0, 'a'), leaf(1)));
  assert.ok(input.links.some((l) => l.target === rec().node && l.input === 1));
});

test('new constants update the running node in place; a new shape rebuilds it and keeps its inputs', () => {
  const { engine, rec } = patchRig();
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('add', op('mul', src(0, 'a'), c(0.5)), leaf(1)));
  engine.setParamLFO('lead', 0, '~1~Osc 1 Phase', { shape: 'sine', rateHz: 2, min: 0, max: 1 });
  const node = rec().node;
  const lfo = engine.modulators.get('lead').get('0:~1~Osc 1 Phase');

  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('add', op('mul', src(0, 'a'), c(0.25)), leaf(1)));
  assert.equal(rec().node, node, 'same shape: not rebuilt');
  assert.deepEqual(node.messages.at(-1), { consts: [0.25] });

  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('sub', op('mul', src(0, 'a'), c(0.25)), leaf(1)));
  const rebuilt = rec().node;
  assert.notEqual(rebuilt, node, 'a new shape is a new node');
  assert.deepEqual(node.messages.at(-1), { kind: 'dispose' }, 'and the old one is told it is done');
  assert.equal(node.outputs.length, 0);
  assert.equal(engine.modulators.get('lead').get('0:~1~Osc 1 Phase'), lfo, 'the lfo on input 1 is not touched');
  assert.ok(rec().inputs.get(1).links.some((l) => l.target === rebuilt && l.input === 1), 'and feeds the new node');
  assert.equal(engine.tracks.get('a').panner.outputs.includes(node), false, 'the source left the old node');
  assert.ok(engine.tracks.get('a').panner.links.some((l) => l.target === rebuilt && l.input === 0));
});

test('an expression owns its parameter: plain sets are ignored until it is cleared', () => {
  const { ctx, engine, phase } = patchRig();
  engine.setParam('lead', 0, 'Osc 1 Phase', 0.4, ctx.currentTime);
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('add', src(0, 'a'), c(0.1)));
  const calls = phase.calls.length;
  engine.setParam('lead', 0, 'Osc 1 Phase', 0.9, ctx.currentTime);
  assert.equal(phase.calls.length, calls, 'a set while driven is not applied');
  engine.clearParamExpr('lead', 0, 'Osc 1 Phase');
  assert.ok(Math.abs(phase.value - 0.4) < 1e-9, `back at the last set value, not ${phase.value}`);
});

test('a channel control takes an expression, and gets its value back when it is cleared', () => {
  const { ctx, engine } = makeEngine();
  engine.createTrack('mod');
  engine.createTrack('t1');
  engine.setParam('t1', -1, 'postgain', 0.8, ctx.currentTime);
  const fader = engine.tracks.get('t1').postGain.gain;
  engine.setParamExpr('t1', -1, 'postgain', op('mul', leaf(0), c(0.5)));
  const node = engine.exprs.get('t1').get('-1:postgain').node;
  assert.ok(node.outputs.includes(fader));
  assert.equal(fader.value, 0);
  engine.setParamLFO('t1', -1, '~0~postgain', { shape: 'sine', rateHz: 1, min: 0, max: 1 });
  assert.equal(engine.modulators.get('t1').get('-1:~0~postgain').target, engine.exprs.get('t1').get('-1:postgain').inputs.get(0).offset);
  engine.clearParamLFO('t1', -1, '~0~postgain');
  engine.clearParamExpr('t1', -1, 'postgain');
  assert.equal(fader.value, 0.8);
});

test('the engine says which expressions it holds, so a fresh scheduler leaves them alone', () => {
  const { engine } = patchRig();
  const tree = op('add', src(0, 'a'), c(0.1));
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', tree);
  engine.setParam('lead', 0, '~3~Cutoff', 0.2, 0); // an input with no expression yet is not one
  assert.deepEqual([...engine.paramExprs('lead')], [['0:Osc 1 Phase', JSON.stringify(tree)]]);
  const node = engine.exprs.get('lead').get('0:Osc 1 Phase').node;
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', JSON.parse(JSON.stringify(tree)));
  assert.equal(engine.exprs.get('lead').get('0:Osc 1 Phase').node, node);
  assert.equal(node.messages.length, 0, 'an identical tree sends nothing at all');
});

test('a tree the engine cannot build warns and leaves the parameter as it was', () => {
  const { engine, warnings, phase } = patchRig();
  engine.setParamExpr('lead', 0, 'Osc 1 Phase', op('nonesuch', c(1), c(2)));
  assert.ok(warnings.some((w) => w.includes('Osc 1 Phase') && w.includes('nonesuch')));
  assert.equal(phase.connectedFrom.length, 0);
});
