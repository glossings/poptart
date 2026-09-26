// Reaching one device in a chain from anywhere in it: .param()/.wet() with a device named first,
// by label, by name or by "Name#k" - and the parameters a .when() sets following its condition.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, sine, setPatternWarn } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

const at = (sig, cycle) => sig.sample(cycle + 0.1, 1, cycle + 0.1);
const chain = () => n('0*4').synth('FM').fx('Filter').fx('Delay').fx('Filter');

test('a bare .param() still aims at the last device', () => {
  const s = chain().param('Cutoff', 0.3);
  assert.deepEqual(Object.keys(s.paramSignals), ['3:Cutoff']);
});

test('a device named first is reached wherever it sits', () => {
  const s = chain().param('Delay', 'Feedback', 0.6).param('FM', 'Algorithm', 2);
  assert.equal(at(s.paramSignals['2:Feedback'].sig, 0), 0.6);
  assert.equal(at(s.paramSignals['0:Algorithm'].sig, 0), 2);
});

test('"Name#k" counts devices of that name in chain order, case aside', () => {
  const s = chain().param('Filter#1', 'Cutoff', 0.1).param('filter#2', 'Cutoff', 0.9);
  assert.equal(at(s.paramSignals['1:Cutoff'].sig, 0), 0.1);
  assert.equal(at(s.paramSignals['3:Cutoff'].sig, 0), 0.9);
});

test('a label reaches its device however the chain is reordered', () => {
  const a = n('0').synth('FM').fx('Filter', { label: 'lo' }).fx('Delay').param('lo', 'Cutoff', 0.2);
  const b = n('0').synth('FM').fx('Delay').fx('Filter', { label: 'lo' }).param('lo', 'Cutoff', 0.2);
  assert.ok(a.paramSignals['1:Cutoff']);
  assert.ok(b.paramSignals['2:Cutoff']);
  const c = n('0').synth('FM', { label: 'voice' }).fx('Delay').param('voice', 'Algorithm', 3);
  assert.ok(c.paramSignals['0:Algorithm']);
});

test('a name two devices share reaches the last, and says how to reach the other', () => {
  const { value, lines } = capture(() => chain().param('Filter', 'Cutoff', 0.5));
  assert.ok(value.paramSignals['3:Cutoff']);
  assert.match(lines[0], /Filter#1/);
});

test('a reference to nothing warns, names the chain, and sets nothing', () => {
  const { value, lines } = capture(() => chain().param('Reverb', 'Size', 0.5).param('Filter#3', 'Cutoff', 1));
  assert.deepEqual(value.paramSignals, {});
  assert.match(lines[0], /"FM", "Filter", "Delay", "Filter"/);
  assert.match(lines[1], /no #3/);
});

test('a reference only reaches devices already added at that point', () => {
  const { value, lines } = capture(() => n('0').synth('FM').param('Delay', 'Feedback', 0.5).fx('Delay'));
  assert.deepEqual(value.paramSignals, {});
  assert.equal(lines.length, 1);
});

test('.wet() takes a device first too, and refuses the instrument', () => {
  const s = chain().wet('Delay', 0.25);
  assert.equal(at(s.channel.wet2, 0), 0.25);
  const { value, lines } = capture(() => chain().wet('FM', 0.5));
  assert.equal(value.channel.wet0, undefined);
  assert.match(lines[0], /instrument/);
});

test('a duplicated label warns, and the later device keeps it', () => {
  const { value, lines } = capture(() =>
    n('0').synth('FM').fx('Filter', { label: 'x' }).fx('Delay', { label: 'x' }).param('x', 'Time', 0.5));
  assert.ok(value.paramSignals['2:Time']);
  assert.match(lines[0], /two devices/);
});

test('a param a .when() sets follows its condition, and returns to the value set outside', () => {
  const s = n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.2).fx('Delay')
    .when('<0 1>', (x) => x.param('Filter', 'Cutoff', 0.8));
  const cutoff = s.paramSignals['1:Cutoff'].sig;
  assert.equal(at(cutoff, 0), 0.2);
  assert.equal(at(cutoff, 1), 0.8);
  assert.equal(at(cutoff, 2), 0.2);
});

test('a param set only inside a .when() answers nothing on the off side, quietly', () => {
  const { value, lines } = capture(() =>
    n('0*4').synth('FM').fx('Filter', { label: 'lo' }).when('<0 1>', (x) => x.param('lo', 'Cutoff', 0.8)));
  const cutoff = value.paramSignals['1:Cutoff'].sig;
  assert.equal(at(cutoff, 0), null);
  assert.equal(at(cutoff, 1), 0.8);
  assert.deepEqual(lines, []);
});

test('a .param() after the .when() wins outright, as a later call always does', () => {
  const s = n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.2)
    .when('<0 1>', (x) => x.param('Filter', 'Cutoff', 0.8))
    .param('Filter', 'Cutoff', 0.5);
  const cutoff = s.paramSignals['1:Cutoff'].sig;
  assert.equal(at(cutoff, 0), 0.5);
  assert.equal(at(cutoff, 1), 0.5);
});

// --- the scheduler's side: a parameter taken and handed back ---------------------------------

function mockEngine(now = 0) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => now },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, calls, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

test('the engine is told to hold a parameter before its first value, and to release it when the pattern goes quiet', () => {
  const { engine, calls } = mockEngine(0);
  const sched = new Scheduler(engine, { trackId: 'lead', cps: 1 });
  // On for cycle 0, off for cycle 1: one poll in each.
  sched.setPattern(n('0*4').synth('FM').fx('Filter').when('<1 0>', (x) => x.param('Filter', 'Cutoff', 0.8)));
  sched.start();
  sched._tick();
  const named = (m) => calls.filter((c) => c.method === m && c.args[1] === 1 && c.args[2] === 'Cutoff');
  assert.equal(named('holdParam').length, 1, 'held once');
  assert.ok(named('setParam').length >= 1, 'then set');
  assert.ok(calls.indexOf(named('holdParam')[0]) < calls.indexOf(named('setParam')[0]), 'the hold comes first');
  assert.equal(named('releaseParam').length, 0);
  // Into the off cycle: released, and not set again.
  engine.getTime = () => 1.0;
  sched._tick();
  assert.equal(named('releaseParam').length, 1, 'released when the condition dropped');
  assert.equal(named('setParam').filter((c) => c.args[4] >= 1.1).length, 0, 'and nothing sent for it while off');
  // Back on: held afresh.
  engine.getTime = () => 2.0;
  sched._tick();
  assert.equal(named('holdParam').length, 2);
  sched.stop();
});

test('a parameter whose call an eval removed is released, and one a modulator takes over too', () => {
  const { engine, calls } = mockEngine(0);
  const sched = new Scheduler(engine, { trackId: 'lead', cps: 1 });
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.3).param('Resonance', 0.2));
  sched.start();
  sched._tick();
  const released = () => calls.filter((c) => c.method === 'releaseParam').map((c) => c.args[2]);
  assert.deepEqual(released(), []);
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Resonance', sine(1)));
  assert.deepEqual(released().sort(), ['Cutoff', 'Resonance']);
  sched.stop();
});

test('stopping leaves every parameter where the pattern put it', () => {
  const { engine, calls } = mockEngine(0);
  const sched = new Scheduler(engine, { trackId: 'lead', cps: 1 });
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.3));
  sched.start();
  sched._tick();
  sched.stop();
  assert.equal(calls.filter((c) => c.method === 'releaseParam').length, 0, 'a stop is not a release');
});

test('a modulator set inside a .when() is read on its side of the condition', () => {
  const s = n('0*4').synth('FM').param('Level', 0).when('<0 1>', (x) => x.param('FM', 'Level', sine(1)));
  const level = s.paramSignals['0:Level'].sig;
  assert.equal(at(level, 0), 0);
  assert.equal(typeof at(level, 1), 'number');
});

test('params the callback leaves alone keep their own signal, untouched', () => {
  const base = n('0*4').synth('FM').param('Level', 0.4);
  const s = base.when('<0 1>', (x) => x.fx('Delay'));
  assert.equal(s.paramSignals['0:Level'], base.paramSignals['0:Level']);
});
