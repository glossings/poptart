// .split() and .bands(): parallel effect branches on one track. The pattern keeps the chain as a
// tree (Sig#fxRoute) with slots numbered straight through it; route.mjs turns the tree into the
// plan both engines build; the scheduler sends the plan and drives each branch level, pan and
// crossover frequency as a channel control, so every one of them takes anything a control takes. A
// crossover is the engine's, never the user's: it takes no slot number.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { note, synth, s, env, lfo, sine, setPatternWarn, MAX_FX_SLOTS } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import {
  routePlan, routeLatencies, isRouteControl, routeControlDefault, CROSSOVER_MIN_HZ, CROSSOVER_MAX_HZ,
} from './src/route.mjs';

function mockEngine({ routing = true } = {}) {
  const calls = [];
  const base = { getTime: () => 0 };
  const engine = new Proxy(base, {
    get: (t, p) => {
      if (p in t) return t[p];
      if (!routing && p === 'setRouting') return undefined;
      return (...args) => { calls.push({ method: p, args }); };
    },
  });
  return { engine, calls, callsTo: (m) => calls.filter((c) => c.method === m) };
}

const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

const IN = { k: 'in' };
const slot = (p) => ({ k: 'slot', p });
const sum = (id) => ({ k: 'sum', id });
const rest = (p) => ({ k: 'rest', p });
const ap = (p) => ({ k: 'ap', p });

// A crossover's Frequency control, as the Hz it stands for at a time.
const hzOf = (v) => CROSSOVER_MIN_HZ + v * (CROSSOVER_MAX_HZ - CROSSOVER_MIN_HZ);
const hzAt = (controls, k, t = 0) => hzOf(controls[`xo${k}`].sample(t, 1, t));

// The approved example, verbatim.
const lead = () => note('c2 eb2 g2').synth('Wavetable')
  .split(
    (x) => x,
    (b) => b.fx('LPG').param('Decay', 0.08),
    (b) => b.fx('LPG').param('Decay', 0.6)
      .param('Cutoff', env().range(0.2, 0.7)).pan(-0.5).postgain(0.7),
  )
  .fx('Reverb');

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

test('slots number straight through the branches, and .param() addresses the device before it', () => {
  const sig = lead();
  assert.deepEqual(sig.fxChain, ['LPG', 'LPG', 'Reverb']);
  assert.deepEqual(Object.keys(sig.paramSignals).sort(), ['1:Decay', '2:Cutoff', '2:Decay']);
  assert.equal(sig.paramSignals['1:Decay'].sig.sample(0, 1, 0), 0.08);
  assert.equal(sig.paramSignals['2:Decay'].sig.sample(0, 1, 0), 0.6);
  assert.equal(sig.fxRoute.length, 2);
  const [split, after] = sig.fxRoute;
  assert.equal(after, 3);
  assert.deepEqual(split.split.map((b) => b.items), [[], [1], [2]]);
});

test('a branch\'s .postgain() and .pan() are its own, and the track strip is left as it was', () => {
  const sig = note('c2').synth('X').postgain(0.5).pan(0.25)
    .split((x) => x, (b) => b.fx('A').postgain(0.7).pan(-0.5));
  const [, b] = sig.fxRoute[0].split;
  assert.equal(b.level.sample(0, 1, 0), 0.7);
  assert.equal(b.pan.sample(0, 1, 0), -0.5);
  assert.equal(sig.channel.postgain.sample(0, 1, 0), 0.5, 'the track postgain is untouched');
  assert.equal(sig.channel.pan.sample(0, 1, 0), 0.25);
  // ...and a branch does not inherit the track's: its level starts at unity.
  const [first] = sig.fxRoute[0].split;
  assert.equal(first.level, null);
});

test('a chain with no split keeps no tree, so nothing about it changes', () => {
  const sig = note('c2').synth('X').fx('A').fx('B');
  assert.equal(sig.fxRoute, null);
  assert.equal(routePlan(sig), null);
});

test('.midi(), .preset() and .wet() inside a branch reach that branch\'s device', () => {
  const sig = note('c2').synth('X').fx('A')
    .split((x) => x, (b) => b.fx('LPG').midi('lead').preset('<soft hard>').wet(0.5));
  assert.deepEqual(sig.midiInjects, [{ slot: 2, name: 'lead', note: null }]);
  assert.ok(sig.presetPatterns[2]);
  assert.equal(sig.channel.wet2.sample(0, 1, 0), 0.5);
});

test('a branch that returns nothing, or changes the notes, warns and passes the signal through', () => {
  const r = capture(() => note('c2').synth('X').split((x) => x, (b) => { b.fx('A'); }));
  assert.match(r.lines.join('\n'), /returned nothing/);
  assert.deepEqual(r.value.fxRoute[0].split[1].items, []);
  const r2 = capture(() => note('c2 e2').synth('X').split((b) => b.fast(2).fx('A')));
  assert.match(r2.lines.join('\n'), /changes the notes/);
  assert.equal(r2.value.fxChain[0], 'A', 'the device is kept');
});

test('a strip control other than postgain/pan inside a branch says it is the whole track\'s', () => {
  const r = capture(() => note('c2').synth('X').split((b) => b.fx('A').width(0)));
  assert.match(r.lines.join('\n'), /\.width\(\) inside a \.split\(\) branch sets it for the whole track/);
});

test('a chain has no slot limit: branches past twenty slots are wired like any', () => {
  let sig = note('c2').synth('X');
  for (let i = 0; i < MAX_FX_SLOTS + 3; i++) sig = sig.fx('A');
  const r = capture(() => sig.split((b) => b.fx('B'), (b) => b.fx('C')));
  assert.deepEqual(r.lines, []);
  const { plan } = routePlan(r.value);
  assert.deepEqual(plan.sums['0'].map((t) => t.s), [slot(MAX_FX_SLOTS + 4), slot(MAX_FX_SLOTS + 5)]);
});

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

test('the approved example: the clean signal, two gates and the reverb on the sum', () => {
  const { plan, controls } = routePlan(lead());
  assert.deepEqual(plan.reads, { 1: { s: IN, g: 0 }, 2: { s: IN, g: 0 }, 3: { s: sum('0'), g: 0 } });
  assert.deepEqual(plan.sums['0'], [{ s: IN, g: 0 }, { s: slot(1), g: 0 }, { s: slot(2), g: 1 }]);
  assert.deepEqual(plan.out, { s: slot(3), g: 0 });
  assert.equal(controls.rl1.sample(0, 1, 0), 0.7);
  assert.equal(controls.rp1.sample(0, 1, 0), -0.5);
});

test('a split at the end of a branch pours into the outer sum - no sum of its own', () => {
  const sig = note('c2').synth('X').fx('A')
    .split((x) => x.split((y) => y.fx('B'), (y) => y), (x) => x.fx('C').split((z) => z, (z) => z.fx('D')))
    .fx('E');
  const { plan } = routePlan(sig);
  assert.deepEqual(Object.keys(plan.sums), ['0']);
  assert.deepEqual(plan.sums['0'].map((t) => t.s), [slot(2), slot(1), slot(3), slot(4)]);
  assert.deepEqual(plan.reads[2].s, slot(1));
  assert.deepEqual(plan.reads[4].s, slot(3));
  assert.deepEqual(plan.reads[5].s, sum('0'));
});

test('a split in the middle of a branch is a sum the next device reads', () => {
  const sig = note('c2').synth('X')
    .split((x) => x, (b) => b.split((y) => y, (y) => y.fx('A')).fx('B'));
  const { plan } = routePlan(sig);
  assert.deepEqual(plan.reads[2].s, sum('1'));
  assert.deepEqual(plan.sums['1'].map((t) => t.s), [IN, slot(1)]);
  assert.deepEqual(plan.sums['0'].map((t) => t.s), [IN, slot(2)]);
});

test('levels compose through a folded split, and same-source terms merge into one', () => {
  const sig = note('c2').synth('X')
    .split((x) => x.postgain(0.5).split((y) => y.fx('A').postgain(0.4), (y) => y), (x) => x.postgain(0.25));
  const { plan, controls } = routePlan(sig);
  const terms = plan.sums['0'];
  assert.deepEqual(terms.map((t) => t.s), [slot(1), IN]);
  const level = (t) => controls[`rl${t.g}`].sample(0, 1, 0);
  assert.equal(level(terms[0]), 0.2, 'A at 0.4 inside a branch at 0.5');
  assert.equal(level(terms[1]), 0.75, 'the clean signal at 0.5 and again at 0.25');
});

test('two clean branches panned apart merge to one term at the combined level and pan', () => {
  const sig = note('c2').synth('X').split((x) => x.pan(-1), (x) => x.pan(1), (b) => b.fx('A'));
  const { plan, controls } = routePlan(sig);
  const clean = plan.sums['0'].find((t) => t.s.k === 'in');
  // Hard left and hard right at unity each: sqrt(2) on each side, which is center at sqrt(2).
  assert.ok(Math.abs(controls[`rl${clean.g}`].sample(0, 1, 0) - Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(controls[`rp${clean.g}`].sample(0, 1, 0)) < 1e-9);
});

test('a sum of one term dissolves into its reader', () => {
  const sig = note('c2').synth('X').fx('A').split((x) => x.postgain(0.5)).fx('B');
  const { plan, controls } = routePlan(sig);
  assert.deepEqual(plan.sums, {});
  assert.deepEqual(plan.reads[2].s, slot(1));
  assert.equal(controls[`rl${plan.reads[2].g}`].sample(0, 1, 0), 0.5);
});

test('a branch level that is an lfo() stays one - the native path is kept', () => {
  const sig = note('c2').synth('X').split((x) => x, (b) => b.fx('A').postgain(lfo().range(0.2, 0.8)));
  const { controls } = routePlan(sig);
  assert.ok(controls.rl1.lfoIR, 'the branch level is the lfo itself');
  // ...and scaled by an outer number, still native.
  const nested = note('c2').synth('X').split((x) => x, (b) => b.postgain(0.5).split((c) => c.fx('A').postgain(sine(1))));
  assert.ok(routePlan(nested).controls.rl1.lfoIR);
});

// ---------------------------------------------------------------------------------------------
// .bands()
// ---------------------------------------------------------------------------------------------

test('a crossover takes no slot: the user\'s numbering is the same with and without .bands()', () => {
  const banded = s('break').bands([250, 2500], (low) => low.fx('A'), (mid) => mid.fx('Distort').param('Drive', 0.6), (high) => high.fx('B')).fx('C').param('Mix', 0.3);
  const split = s('break').split((low) => low.fx('A'), (mid) => mid.fx('Distort').param('Drive', 0.6), (high) => high.fx('B')).fx('C').param('Mix', 0.3);
  assert.deepEqual(banded.fxChain, ['A', 'Distort', 'B', 'C']);
  assert.deepEqual(banded.fxChain, split.fxChain);
  assert.deepEqual(Object.keys(banded.paramSignals), Object.keys(split.paramSignals));
  assert.deepEqual(Object.keys(banded.paramSignals), ['2:Drive', '4:Mix']);
});

test('.bands() puts each crossover just before the band it hands down, in the order audio runs', () => {
  const sig = s('break').bands([250, 2500], (low) => low.fx('A'), (mid) => mid.fx('Distort'), (high) => high.fx('B'));
  const { plan, controls } = routePlan(sig);
  assert.deepEqual(plan.order, ['x1', 1, 'x2', 2, 3]);
  assert.ok(Math.abs(hzAt(controls, 1) - 250) < 1e-9);
  assert.ok(Math.abs(hzAt(controls, 2) - 2500) < 1e-9);
  assert.deepEqual(plan.reads.x1.s, IN, 'the first crossover splits the input');
  assert.deepEqual(plan.reads[1].s, slot('x1'), 'the low band is the crossover\'s own output');
  assert.deepEqual(plan.reads.x2.s, rest('x1'), 'the next crossover splits what is above the first');
  assert.deepEqual(plan.reads[2].s, slot('x2'));
  assert.deepEqual(plan.reads[3].s, rest('x2'), 'the top band is what is above the last');
  // The second crossover's key is the low band as processed, and comes back out of it in phase
  // with the bands above.
  assert.deepEqual(plan.keys.x2.s.k, 'sum');
  assert.deepEqual(plan.sums[plan.keys.x2.s.id].map((t) => t.s), [slot(1)]);
  assert.deepEqual(plan.sums[plan.out.s.id].map((t) => t.s), [ap('x2'), slot(2), slot(3)]);
});

test('three crossovers chain their keys: each all-pass carries everything below it', () => {
  const sig = s('break').bands([100, 1000, 5000], (a) => a, (b) => b, (c) => c, (d) => d);
  assert.deepEqual(sig.fxChain, []);
  const { plan } = routePlan(sig);
  assert.deepEqual(plan.order, ['x1', 'x2', 'x3']);
  assert.deepEqual(plan.sums[plan.keys.x2.s.id].map((t) => t.s), [slot('x1')]);
  assert.deepEqual(plan.sums[plan.keys.x3.s.id].map((t) => t.s), [ap('x2'), slot('x2')]);
  assert.deepEqual(plan.sums[plan.out.s.id].map((t) => t.s), [ap('x3'), slot('x3'), rest('x3')]);
});

test('each crossover takes anything a control takes: a pattern, a modulator', () => {
  const sig = s('break').bands(['<250 400>', sine(0.25).range(1500, 3000)], (l) => l, (m) => m, (h) => h);
  const { controls } = routePlan(sig);
  assert.ok(Math.abs(hzAt(controls, 1, 0) - 250) < 1e-9);
  assert.ok(Math.abs(hzAt(controls, 1, 1) - 400) < 1e-9);
  const swept = controls.xo2;
  assert.ok(swept.lfoIR, 'still a whole modulator, so it runs natively');
  const pos = (hz) => (hz - CROSSOVER_MIN_HZ) / (CROSSOVER_MAX_HZ - CROSSOVER_MIN_HZ);
  assert.ok(Math.abs(swept.lfoIR.min - pos(1500)) < 1e-12 && Math.abs(swept.lfoIR.max - pos(3000)) < 1e-12);
});

test('.bands() with the wrong number of functions warns and fills in the missing bands', () => {
  const r = capture(() => s('break').bands([250, 2500], (low) => low.fx('A')));
  assert.match(r.lines.join('\n'), /takes 3 functions - it was given 1/);
  assert.deepEqual(r.value.fxChain, ['A']);
  const { plan } = routePlan(r.value);
  assert.deepEqual(plan.sums[plan.out.s.id].map((t) => t.s), [ap('x2'), slot('x2'), rest('x2')]);
});

test('bands nest inside a split, and a bands at the end of an unleveled branch pours into its sum', () => {
  const sig = note('c2').synth('X').split((x) => x, (b) => b.bands([300], (l) => l.fx('A'), (h) => h));
  const { plan } = routePlan(sig);
  assert.deepEqual(plan.reads.x1.s, IN);
  assert.deepEqual(plan.sums[plan.out.s.id].map((t) => t.s), [IN, slot(1), rest('x1')]);
});

test('a .bands() at the end of a branch with its own level or pan pours through that level', () => {
  const r = capture(() => routePlan(note('c2').synth('X').split((x) => x, (b) => b.bands([300], (l) => l.fx('A'), (h) => h).postgain(0.5).pan(-0.3))));
  assert.deepEqual(r.lines, []);
  const { plan, controls } = r.value;
  assert.deepEqual(plan.order, ['x1', 1]);
  // The outer sum takes every term of the bands at the branch's level - the all-pass among them.
  const terms = plan.sums[plan.out.s.id];
  assert.deepEqual(terms.map((t) => t.s), [IN, slot(1), rest('x1')]);
  for (const t of terms.slice(1)) {
    assert.ok(t.g > 0);
    assert.equal(controls[`rl${t.g}`].sample(0, 1, 0), 0.5);
  }
});

test('many crossovers beside many effects: no limit, nothing unsplit', () => {
  let sig = note('c2').synth('X');
  for (let i = 0; i < MAX_FX_SLOTS; i++) sig = sig.fx('A');
  const r = capture(() => routePlan(sig.bands([300], (l) => l, (h) => h).bands([200, 900], (a) => a, (b) => b, (c) => c)));
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.value.plan.order.filter((p) => typeof p === 'string'), ['x1', 'x2', 'x3']);
});

// ---------------------------------------------------------------------------------------------
// The bound on gains, and latency
// ---------------------------------------------------------------------------------------------

test('latency is the longest way through: a sum waits for its latest branch', () => {
  const sig = note('c2').synth('X').split((x) => x, (b) => b.fx('A'), (b) => b.fx('B')).fx('C');
  const { plan } = routePlan(sig);
  const per = [0, 0.010, 0.003, 0.001];
  const lat = routeLatencies(plan, per);
  assert.ok(Math.abs(lat[0] - 0.011) < 1e-12, 'through A, the slower branch, and C');
  assert.ok(Math.abs(lat[2] - 0.004) < 1e-12);
  assert.ok(Math.abs(lat[3] - 0.001) < 1e-12);
});

test('a crossover adds no delay of its own: a band is as late as its devices', () => {
  const sig = s('x').bands([300], (l) => l.fx('A'), (h) => h);
  const { plan } = routePlan(sig);
  assert.deepEqual(routeLatencies(plan, [0, 0]).slice(0, 2), [0, 0]);
  const lat = routeLatencies(plan, [0, 0.002]);
  assert.ok(Math.abs(lat[0] - 0.002) < 1e-12, 'the low band\'s device, and nothing for the split');
  assert.ok(Math.abs(lat[1] - 0.002) < 1e-12);
});

test('route control names and their neutral values', () => {
  assert.ok(isRouteControl('rl3') && isRouteControl('rp12') && isRouteControl('xo4'));
  assert.ok(!isRouteControl('postgain') && !isRouteControl('wet1'));
  assert.equal(routeControlDefault('rl1'), 1);
  assert.equal(routeControlDefault('rp1'), 0);
  assert.ok(Math.abs(hzOf(routeControlDefault('xo1')) - 1000) < 1e-9, 'a crossover rests at 1 kHz');
});

// ---------------------------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------------------------

test('the scheduler sends the plan, and null once the split is gone', () => {
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(lead());
  const sent = callsTo('setRouting');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args[1], routePlan(lead()).plan);
  assert.equal(sent[0].args[2], 3, 'with the chain\'s length, for the plain line an engine lays out without one');
  sched.setPattern(lead());
  assert.equal(callsTo('setRouting').length, 1, 'an unchanged plan is not sent again');
  sched.setPattern(note('c2').synth('X').fx('A'));
  assert.equal(callsTo('setRouting').at(-1).args[1], null);
  assert.equal(callsTo('setRouting').at(-1).args[2], 1);
});

test('a fresh Scheduler always sends its plan - the engine track outlives the old one', () => {
  const { engine, callsTo } = mockEngine();
  new Scheduler(engine, { trackId: 't' }).setPattern(note('c2').synth('X'));
  assert.equal(callsTo('setRouting').length, 1);
  assert.equal(callsTo('setRouting')[0].args[1], null);
});

test('a crossover loads nothing the scheduler can see: the user\'s effects load in their own slots', () => {
  const { engine, callsTo } = mockEngine();
  new Scheduler(engine, { trackId: 't' }).setPattern(s('x').bands([300], (l) => l.fx('A'), (h) => h));
  assert.deepEqual(callsTo('loadEffect').map((c) => c.args.slice(1)), [['A', 1]]);
});

test('the wiring is sent before the effects load, so an engine can lay the chain out by it', () => {
  const { engine, calls } = mockEngine();
  new Scheduler(engine, { trackId: 't' }).setPattern(s('x').bands([300], (l) => l.fx('A'), (h) => h));
  const names = calls.map((c) => c.method);
  assert.ok(names.indexOf('setRouting') < names.indexOf('loadEffect'));
});

test('branch levels and pans, and crossover frequencies, ride every control path', () => {
  const sig = note('c2').synth('X')
    .split((x) => x, (b) => b.fx('A').postgain(lfo().range(0.2, 0.8)).pan(-0.5))
    .bands(['<250 400>', sine(0.5).range(1000, 3000)], (l) => l, (m) => m, (h) => h);
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(sig);
  const lfos = callsTo('setParamLFO').filter((c) => c.args[1] === -1).map((c) => c.args[2]);
  assert.ok(lfos.includes('rl1'), 'the branch level runs natively');
  assert.ok(lfos.includes('xo2'), 'so does the swept crossover');
  sched._pollGenericParams(0);
  const polled = (name) => callsTo('setParam').filter((c) => c.args[1] === -1 && c.args[2] === name).map((c) => c.args[3]);
  assert.deepEqual(polled('rp1'), [-0.5]);
  assert.ok(Math.abs(hzOf(polled('xo1')[0]) - 250) < 1e-9, 'the patterned crossover is polled');
});

test('a crossover takes an expression - modulators combined - evaluated by the engine', () => {
  const sig = s('x').bands([env().mul(lfo()).range(200, 800)], (l) => l, (h) => h);
  const { engine, callsTo } = mockEngine();
  new Scheduler(engine, { trackId: 't' }).setPattern(sig);
  const expr = callsTo('setParamExpr').find((c) => c.args[1] === -1 && c.args[2] === 'xo1');
  assert.ok(expr, 'sent as an expression on the crossover control');
});

test('an engine with no routing plays the chain in series and says so once', () => {
  const { engine } = mockEngine({ routing: false });
  const r = capture(() => {
    const sched = new Scheduler(engine, { trackId: 't', label: 'lead' });
    sched.setPattern(lead());
    sched.setPattern(lead());
  });
  assert.equal(r.lines.filter((l) => /cannot run \.split\(\)/.test(l)).length, 1);
});

// ---- a chain in a Delay's feedback loop ----------------------------------------------------------

const loop = (p) => ({ k: 'loop', p });
const dub = () => note('c2').synth('X').fx('Delay', (x) => x.fx('Filter').param('Mode', 'highpass'));

test('a function on .fx("Delay") is a chain in its loop: numbered before the Delay, read off its loop output', () => {
  const sig = dub().param('Feedback', 0.8).fx('Reverb');
  assert.deepEqual(sig.fxChain, ['Filter', 'Delay', 'Reverb']);
  assert.deepEqual(Object.keys(sig.paramSignals), ['1:Mode', '2:Feedback'], 'a .param() after the call reaches the Delay');
  const { plan } = routePlan(sig);
  assert.deepEqual(plan.order, [2, 1, 3]);
  assert.deepEqual(plan.reads[2].s, IN);
  assert.deepEqual(plan.reads[1].s, loop(2), 'the chain reads the Delay\'s repeats');
  assert.deepEqual(plan.returns, { 2: { s: slot(1), g: 0 } }, 'and comes back into its return');
  assert.deepEqual(plan.reads[3].s, slot(2), 'the rest of the chain goes on from the Delay\'s own output');
  assert.deepEqual(plan.out.s, slot(3));
});

test('{ loop } is the same as a function, and keeps its label', () => {
  const a = routePlan(note('c2').synth('X').fx('Delay', { loop: (x) => x.fx('Filter'), label: 'dub' }));
  const b = routePlan(note('c2').synth('X').fx('Delay', (x) => x.fx('Filter')));
  assert.deepEqual(a.plan, b.plan);
  assert.equal(note('c2').synth('X').fx('Delay', { loop: (x) => x.fx('Filter'), label: 'dub' }).slotLabels[2], 'dub');
});

test('a loop branches like a split branch: a split inside it, and its own .postgain() on the way back', () => {
  const sig = note('c2').synth('X').fx('Delay', (x) => x.split((a) => a.fx('A'), (b) => b.fx('B')).postgain(0.5));
  const { plan, controls } = routePlan(sig);
  assert.deepEqual(plan.reads[1].s, loop(3));
  assert.deepEqual(plan.reads[2].s, loop(3));
  const back = plan.returns[3];
  assert.equal(back.s.k, 'sum');
  assert.ok(back.g > 0, 'the loop\'s level is a route control on the return');
  assert.equal(controls[`rl${back.g}`].sample(0, 1, 0), 0.5);
});

test('a loop inside a .split() branch and a .bus() inside a loop are placed where they are written', () => {
  const sig = note('c2').synth('X').split((x) => x, (b) => b.fx('Delay', (l) => l.fx('A').bus('fb')));
  const { plan } = routePlan(sig);
  assert.deepEqual(plan.returns[2].s, slot(1));
  assert.deepEqual(plan.sends[0].s, slot(1), 'the send taps the loop\'s end');
});

test('the loop adds nothing to the chain\'s latency compensation: the Delay takes it off its time', () => {
  const { plan } = routePlan(dub().fx('Reverb'));
  assert.deepEqual(routeLatencies(plan, [0, 0.1, 0, 0]), [0, 0.1, 0, 0, 0]);
});

test('a function that returns no chain, an empty loop, and a device with no loop all play the plain Delay', () => {
  const plain = routePlan(note('c2').synth('X').fx('Delay'));
  for (const fn of [() => 42, (x) => x]) {
    const { value, lines } = capture(() => note('c2').synth('X').fx('Delay', fn));
    assert.deepEqual(value.fxChain, ['Delay']);
    assert.equal(routePlan(value), plain);
    if (fn.length === 0) assert.match(lines.join('\n'), /loop returned number/);
  }
  const { value, lines } = capture(() => note('c2').synth('X').fx('Reverb', (x) => x.fx('Filter')));
  assert.deepEqual(value.fxChain, ['Reverb']);
  assert.match(lines.join('\n'), /no feedback loop/);
  const odd = capture(() => note('c2').synth('X').fx('Delay', { loop: 3 }));
  assert.deepEqual(odd.value.fxChain, ['Delay']);
  assert.match(odd.lines.join('\n'), /loop is a function/);
});

test('re-evaluation keeps an unchanged loop; changing or removing the function rewires it', () => {
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(dub());
  assert.ok(callsTo('setRouting')[0].args[1].returns, 'the loop is sent');
  sched.setPattern(dub());
  assert.equal(callsTo('setRouting').length, 1, 'an unchanged loop is not sent again');
  sched.setPattern(note('c2').synth('X').fx('Delay', (x) => x.fx('Distort')));
  assert.equal(callsTo('setRouting').length, 1, 'another device in the same place is the same wiring');
  assert.deepEqual(callsTo('loadEffect').at(-2).args.slice(1), ['Distort', 1], 'with the new device in its slot');
  sched.setPattern(note('c2').synth('X').fx('Delay', (x) => x.fx('Distort').fx('Filter')));
  assert.equal(callsTo('setRouting').length, 2, 'a loop of another shape is wired again');
  sched.setPattern(note('c2').synth('X').fx('Delay'));
  assert.equal(callsTo('setRouting').at(-1).args[1], null, 'without the function the Delay is back on the plain line');
  assert.deepEqual(callsTo('loadEffect').at(-1).args.slice(1), ['Delay', 1], 'and the Delay in the first slot');
});

test('a fresh Scheduler on a track that had a loop sends its own plain wiring', () => {
  const { engine, callsTo } = mockEngine();
  new Scheduler(engine, { trackId: 't' }).setPattern(dub());
  new Scheduler(engine, { trackId: 't' }).setPattern(note('c2').synth('X').fx('Delay'));
  assert.equal(callsTo('setRouting').at(-1).args[1], null);
});
