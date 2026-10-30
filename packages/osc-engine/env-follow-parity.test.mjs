// The two lags in param expressions - the envelope follower env("x") and .smooth(t) - on both
// engines over the same audio.
//
// The desktop runs them inside a param expression's SynthDef (synthdef/expr.js, and the same def
// built by sc/poptart.scd: LagUD and Lag), the browser inside the poptart-expr worklet (web-engine's
// dsp/expr.mjs). Both use one formula, so a source rendered through the desktop's def offline
// (scsynth NRT, no server to boot) and the same samples run through the browser's code in Node
// must give the same output sample for sample.
//
// Skipped, not failed, where scsynth cannot run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { compileExpr } from '../web-engine/src/dsp/expr.mjs';

const require = createRequire(import.meta.url);
const { renderNRT, ugen, G } = require('./test-support/nrt');
const synthdef = require('./synthdef');
const U = require('./synthdef/ugens');
const { locateServer } = require('./server/locate');
const { extensionFlags } = require('./server/defs');
const bootDef = (name) => synthdef.defsFor(extensionFlags(locateServer().extensionsDir)).find((d) => d.name === name).def;

const SR = 48000;
const { SynthDef, mul, add } = G;
const { Out, In, K2A } = U;
const SinOsc = ugen('SinOsc', [440, 0]);
const LFPulse = ugen('LFPulse', [440, 0, 0.5]);

const c = (v) => ({ k: 'const', v });
const envFollow = (x, atk, rel) => ({ k: 'fn', op: 'env', a: [x, atk, rel] });
const smooth = (x, t) => ({ k: 'fn', op: 'smooth', a: [x, t] });
const source = { k: 'in', i: 0, rate: 'ar', source: 'drums' };
const f = (v) => ({ type: 'f', value: v });

// A 110 Hz tone in bursts, some of them past full scale (1.5), on channel 0 and a stereo bus; and
// a stepped level (the bursts' envelope alone, jumping between 0, 0.8 and 1.5) on channel 1 and
// another bus - what a stepped pattern fed to .smooth() looks like.
const src = new SynthDef('t_lag_src', {}, () => {
  const amp = add(mul(LFPulse.ar(3, 0, 0.3), 0.8), mul(LFPulse.ar(0.75, 0, 0.5), 0.7));
  const sig = mul(SinOsc.ar(110), amp);
  Out.ar(20, [sig, sig]);
  Out.ar(24, [sig, mul(sig, -1)]); // the same tone as an out-of-phase pair
  Out.ar(22, [amp, amp]);
  Out.ar(0, sig);
  Out.ar(1, amp);
});

// `stereo` says how the source pair is made from the mono tone: in phase, or R = -L. The browser
// is handed what its processor makes of the pair: (L + R) / 2, and each side.
function compare(r, inputCh, outCh, tree, what, stereo = 'same') {
  const run = compileExpr(tree, undefined, { sampleRate: SR });
  let worst = 0;
  let at = 0;
  let peak = 0;
  for (let i = 0; i < r.frames; i++) {
    const v = r.at(inputCh, i);
    const mid = stereo === 'same' ? v : 0;
    const web = Math.fround(run([mid], [v], [stereo === 'same' ? v : -v]));
    const desk = r.at(outCh, i);
    peak = Math.max(peak, desk);
    const d = Math.abs(web - desk);
    if (d > worst) { worst = d; at = i; }
  }
  assert.ok(worst < 1e-5, `${what}: the engines differ by ${worst} at sample ${at}`);
  return peak;
}

test('the desktop and the browser follow and smooth the same audio to the same values, sample for sample', (t) => {
  const follows = [[0.01, 0.25], [0.002, 0.05], [0, 0.4]];
  const smooths = [0.2, 0.01, 0];
  const fDef = synthdef.exprDef(envFollow(source, c(0), c(0)), { outKind: 'device' });
  const sDef = synthdef.exprDef(smooth(source, c(0)), { outKind: 'device' });
  const flipped = 2 + 2 * (follows.length + smooths.length);
  const flippedMath = flipped + 2;
  const outs = flippedMath + 2;
  // A follower of the pair through arithmetic, which reads each side through it.
  const mathTree = envFollow({ k: 'op', op: 'mul', a: [source, c(0.5)] }, c(0.01), c(0.25));
  const mDef = synthdef.exprDef(mathTree, { outKind: 'device' });
  const r = renderNRT([
    [0, ['/d_recv', src]],
    [0, ['/d_recv', fDef.def]],
    [0, ['/d_recv', sDef.def]],
    [0, ['/d_recv', mDef.def]],
    [0, ['/s_new', 't_lag_src', 1000, 1, 0]],
    // Each on its own output pair: the followers read the tone, the smooths the stepped level.
    ...follows.map(([a, rel], k) => [0, ['/s_new', fDef.name, 2000 + k, 1, 0, 'out', 2 + 2 * k, 'a0', 20, 'k0', -1, 'c0', f(a), 'c1', f(rel)]]),
    ...smooths.map((tt, k) => [0, ['/s_new', sDef.name, 3000 + k, 1, 0, 'out', 2 + 2 * (follows.length + k), 'a0', 22, 'k0', -1, 'c0', f(tt)]]),
    // The default follower again, on the out-of-phase pair.
    [0, ['/s_new', fDef.name, 4000, 1, 0, 'out', flipped, 'a0', 24, 'k0', -1, 'c0', f(0.01), 'c1', f(0.25)]],
    [0, ['/s_new', mDef.name, 4001, 1, 0, 'out', flippedMath, 'a0', 24, 'k0', -1, 'c0', f(0.5), 'c1', f(0.01), 'c2', f(0.25)]],
  ], { duration: 2, sampleRate: SR, outChannels: outs });
  if (!r.data) { t.skip(r.why); return; }

  follows.forEach(([a, rel], k) => {
    const peak = compare(r, 0, 2 + 2 * k, envFollow({ k: 'in', i: 0, rate: 'ar' }, c(a), c(rel)), `env follower ${a}/${rel}`);
    assert.ok(peak > 0.99 && peak <= 1, `env follower ${a}/${rel}: the level reaches full scale and stops there (${peak})`);
  });
  // R = -L: its mid is silence, its linked peak the tone's level - the same as in phase.
  const flippedPeak = compare(r, 0, flipped, envFollow({ k: 'in', i: 0, rate: 'ar' }, c(0.01), c(0.25)), 'env follower of an out-of-phase pair', 'flipped');
  assert.ok(flippedPeak > 0.99, `an out-of-phase pair reads its full level, not 0 (${flippedPeak})`);
  for (let i = 0; i < r.frames; i += 97) assert.equal(r.at(flipped, i), r.at(2, i), 'the same level as the pair in phase');
  const mathPeak = compare(r, 0, flippedMath, envFollow({ k: 'op', op: 'mul', a: [{ k: 'in', i: 0, rate: 'ar' }, c(0.5)] }, c(0.01), c(0.25)),
    'env follower of an out-of-phase pair through arithmetic', 'flipped');
  assert.ok(mathPeak > 0.6 && mathPeak <= 0.75, `through .mul(0.5) the pair reads its halved level, not 0 (${mathPeak})`);
  smooths.forEach((tt, k) => {
    const ch = 2 + 2 * (follows.length + k);
    compare(r, 1, ch, smooth({ k: 'in', i: 0, rate: 'ar' }, c(tt)), `smooth ${tt}`);
    // A step glides: ten samples after the first big step up, a smooth is still short of it; a
    // smooth of 0 is the input itself.
    if (tt > 0) {
      const edge = Array.from({ length: r.frames }, (_, i) => i).find((i) => i > 0 && r.at(1, i) > r.at(1, i - 1) + 0.5);
      assert.ok(r.at(ch, edge + 10) < r.at(1, edge + 10), `smooth ${tt}: glides into a step instead of jumping`);
    } else {
      for (let i = 0; i < 2000; i++) assert.equal(r.at(ch, i), r.at(1, i), 'smooth(0) passes the input through');
    }
  });
});

test('a polled value reaches an expression input the same way on both: at once, over 30 ms or as a step', (t) => {
  // The desktop's polled input: a poptart_ramp synth on a control bus, at its usual 30 ms and at
  // 0 (an input the tree marks `step`), each read by smooth(0) - the input as it arrives.
  const sDef = synthdef.exprDef(smooth({ k: 'in', i: 0, rate: 'kr', step: 1 }, c(0)), { outKind: 'device' });
  const STEP = 0.5;
  const r = renderNRT([
    [0, ['/d_recv', bootDef('poptart_ramp')]],
    [0, ['/d_recv', sDef.def]],
    [0, ['/s_new', 'poptart_ramp', 1000, 0, 0, 'out', 5, 'target', 0, 'time', f(0.03)]],
    [0, ['/s_new', 'poptart_ramp', 1001, 0, 0, 'out', 6, 'target', 0, 'time', 0]],
    [0, ['/s_new', sDef.name, 2000, 1, 0, 'out', 0, 'k0', 5, 'a0', -1, 'c0', 0]],
    [0, ['/s_new', sDef.name, 2001, 1, 0, 'out', 2, 'k0', 6, 'a0', -1, 'c0', 0]],
    [STEP, ['/n_set', 1000, 'target', 1]],
    [STEP, ['/n_set', 1001, 'target', 1]],
  ], { duration: 1, sampleRate: SR, outChannels: 4 });
  if (!r.data) { t.skip(r.why); return; }
  const at = Math.round(STEP * SR);
  const BLOCK = 64;
  const RAMP = Math.round(0.03 * SR);
  // The browser: linearRampToValueAtTime from the step to 30 ms after it (EXPR_LEAF_GLIDE_SEC),
  // or setValueAtTime at the step, then the same smooth(0).
  const run = compileExpr(smooth({ k: 'in', i: 0, rate: 'kr' }, c(0)), undefined, { sampleRate: SR });
  const webRamp = (i) => run([Math.min(1, Math.max(0, (i - at) / RAMP))]);
  const webStep = (i) => (i >= at ? 1 : 0);
  // The server works in 64-sample blocks: the value lands on the block it falls in and the ramp
  // moves a block at a time, so it is within a block's worth of the browser's line throughout -
  // and, above all, it starts at once rather than up to 30 ms late.
  let worst = 0;
  for (let i = at - 4 * BLOCK; i < at + RAMP + 4 * BLOCK; i++) worst = Math.max(worst, Math.abs(r.at(0, i) - webRamp(i)));
  assert.ok(worst < 2.5 * BLOCK / RAMP, `30 ms ramp: the engines differ by ${worst}`);
  assert.ok(r.at(0, at + 3 * BLOCK) > 0.05, `30 ms ramp: under way three blocks after the value (${r.at(0, at + 3 * BLOCK)})`);
  assert.ok(Math.abs(r.at(0, at + RAMP + 3 * BLOCK) - 1) < 1e-6, 'and there 30 ms later');
  // Stepped: at the new value within a few blocks - the server's resolution for a control input.
  assert.equal(r.at(2, at - BLOCK), 0);
  assert.ok(Math.abs(r.at(2, at + 4 * BLOCK) - 1) < 1e-6, `stepped: ${r.at(2, at + 4 * BLOCK)} four blocks after the step`);
  assert.equal(webStep(at - 1), 0);
  assert.equal(webStep(at), 1);
});
