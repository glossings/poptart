// The bare `vel`: the velocity of the note a track is playing, as a signal, held from each note's
// start to the next one's. Assigned to a control it is a native modulator the engines latch at
// each note-on (an envelope-filed IR, `latch: 'vel'`); composed with other modulators it is an
// expression's input; anywhere else it is read off the track's note grid, as env() is. `vel(x)` and
// `.vel(x)` set velocity exactly as they always did.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from './src/index.mjs';
import { compileExpr } from '../web-engine/src/dsp/expr.mjs';

const { Sig, Scheduler, vel, n, s, set, sine, steps, injectLocations, beginWidgets, takeWidgets, setClipsOwner, widgetOption, withNoteGate } = core;

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

// A scheduler on a recording engine. `exprs: false` is an engine that cannot evaluate expressions,
// so a composed signal is polled as its JavaScript.
function rig(pattern, { exprs = true, label = 't', deck = 'a' } = {}) {
  const calls = [];
  let now = 0;
  const no = exprs ? new Set() : new Set(['setParamExpr', 'clearParamExpr', 'paramExprs']);
  const engine = new Proxy({ getTime: () => now }, { get: (t, p) => (p in t ? t[p] : no.has(p) ? undefined : (...a) => calls.push({ m: p, a })) });
  const sched = new Scheduler(engine, { trackId: 't', label, deck });
  sched.setPattern(pattern);
  return { sched, calls, of: (m) => calls.filter((c) => c.m === m), setNow: (t) => { now = t; } };
}

// `sig` read under the track's gate at cycle `pos`.
const readAt = (sched, sig, pos) => sched._withNoteGate(() => sig.sample(sched.transport.secAt(pos), sched.transport.cps, pos), pos);

test('bare vel is a signal and vel(x) is still the operand it was', () => {
  assert.ok(vel instanceof Sig);
  assert.deepEqual(vel.envIR, { latch: 'vel', min: 0, max: 1 });
  const op = vel(0.5);
  assert.equal(op.ctl, 'vel');
  assert.equal(op.constVal ?? op.sample(0, 1, 0), 0.5);
  // .vel(x) and set(vel(x)) put the same velocity on each note as before.
  const velsOf = (pattern) => {
    const { sched, of } = rig(pattern);
    sched._scheduleNoteEdges(0, 1, 0);
    return of('noteOn').map((c) => c.a[2]);
  };
  assert.deepEqual(velsOf(n('0 1').vel('1 0.5').synth('X')), [1, 0.5]);
  assert.deepEqual(velsOf(n('0 1').set(vel(0.25)).synth('X')), [0.25, 0.25]);
  assert.deepEqual(velsOf(n('0 1').vel(vel(0.6)).synth('X')), [0.6, 0.6]);
});

test('vel reads each note\'s velocity, held from its start until the next note', () => {
  const { sched } = rig(n('0 1 ~ 2').vel('1 0.5 ~ 0.25').synth('X'));
  near(readAt(sched, vel, 0), 1, 'the first note');
  near(readAt(sched, vel, 0.2), 1, 'held through it');
  near(readAt(sched, vel, 0.25), 0.5, 'the second note, from its start');
  near(readAt(sched, vel, 0.6), 0.5, 'held through the rest after it');
  near(readAt(sched, vel, 0.75), 0.25, 'the third');
  near(readAt(sched, vel, 1.1), 1, 'the next cycle\'s first');
  // No gate in scope (nothing is playing): it rests at its floor, as the engines' latch does.
  assert.equal(vel.sample(0, 1, 0), 0);
});

test('vel goes through range and arithmetic', () => {
  const { sched } = rig(n('0 1').vel('0.5 1').synth('X'));
  near(readAt(sched, vel.range(0.3, 0.9), 0), 0.6, 'range');
  near(readAt(sched, vel.mul(2).add(0.1), 0), 1.1, 'mul and add');
  near(readAt(sched, vel.range(0.2, 0.4).mul('<1 2>'), 1.5), 0.8, 'with a pattern');
  // Linear math keeps it the native latch, with its bounds rewritten.
  assert.deepEqual(vel.range(0.3, 0.9).envIR, { latch: 'vel', min: 0.3, max: 0.9 });
});

test('a velocity over 1 is capped as the note is sent; a sample\'s gain is read as it is sent', () => {
  near(readAt(rig(n('0').vel(1.5).synth('X')).sched, vel, 0.1), 1, 'a note');
  near(readAt(rig(s('bd').vel(1.5)).sched, vel, 0.1), 1.5, 'a sample');
  near(readAt(rig(s('bd bd').vel('0.4 0.8')).sched, vel, 0.6), 0.8, 'each sample\'s own');
});

test('on an fx after a synth, vel is a native latch the engine is handed once', () => {
  const { of } = rig(n('0 1').vel('0.8 0.4').synth('X').fx('Filter').param('Cutoff', vel.range(0.3, 0.9)));
  const env = of('setParamEnv');
  assert.equal(env.length, 1);
  const [, slot, name, ir] = env[0].a;
  assert.equal(slot, 1);
  assert.equal(name, 'Cutoff');
  assert.equal(ir.latch, 'vel');
  assert.deepEqual([ir.min, ir.max], [0.3, 0.9]);
  // ...and on the channel strip, the same.
  const gain = rig(n('0').synth('X').gain(vel)).of('setParamEnv');
  assert.equal(gain[0].a[2], 'gain');
  assert.equal(gain[0].a[3].latch, 'vel');
});

test('vel times an lfo is an expression with vel a control-rate input', () => {
  const { of } = rig(n('0').synth('X').fx('Q').param('Drive', vel.mul(sine())));
  const tree = of('setParamExpr').at(-1).a[3];
  assert.ok(tree, 'sent as an expression');
  const inputs = [];
  const walk = (node) => { if (node.k === 'in') inputs.push(node); for (const a of node.a ?? []) walk(a); };
  walk(tree);
  assert.deepEqual(inputs.map((i) => i.rate).sort(), ['kr', 'kr']);
  assert.equal(compileExpr(tree)([0.5, 0.5]), 0.25);
  const latch = of('setParamEnv').find((c) => String(c.a[2]).endsWith('Drive'));
  assert.equal(latch.a[3].latch, 'vel', 'its input is the native latch');
});

test('polled, vel follows the notes the poll reads', () => {
  const { sched, of, setNow } = rig(n('0 1').vel('0.2 0.6').synth('X').fx('Q').param('Drive', vel.mul('1')), { exprs: false });
  const at = (pos) => {
    setNow(sched.transport.secAt(pos) - 0.15); // the poll samples a lookahead ahead of now
    sched._tick();
    return of('setParam').filter((c) => c.a[1] === 1).pop().a[3];
  };
  sched.start(0);
  try {
    near(at(0.25), 0.2, 'first note');
    near(at(0.75), 0.6, 'second note');
  } finally {
    sched.stop();
  }
});

test('a steps() mutate amount of vel reads the velocity of its own track\'s notes', () => {
  setClipsOwner('a', 'lead');
  let widgets;
  try {
    const code = 'steps("x . x .", { mutate: vel })';
    const names = Object.keys(core);
    beginWidgets('a');
    new Function(...names, `return ${injectLocations(code, 0)}`)(...names.map((k) => core[k]));
    widgets = takeWidgets();
  } finally {
    setClipsOwner('a', null);
  }
  const [row] = widgets.inputs;
  assert.equal(row.opts.mutateLive, true);
  // Before its track plays there is no gate to read: the floor.
  assert.equal(widgetOption('a', row.at, 'mutate', 0), 0);
  rig(n('0 1').vel('0.3 0.7').synth('X'), { label: 'lead' });
  near(widgetOption('a', row.at, 'mutate', 0), 0.3, 'the pass starting on the first note');
  near(widgetOption('a', row.at, 'mutate', 0.5), 0.7, 'on the second');
});

test('a gate span carries velocity through a song-time shift', () => {
  const gate = { intervalsUpTo: (pos) => [[0, 0.5, 0.4]].filter(([a]) => a <= pos) };
  withNoteGate(gate, () => near(vel.sample(0.1, 1, 0.1), 0.4, 'read off a gate'));
});
