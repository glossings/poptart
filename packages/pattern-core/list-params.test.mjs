// Controls that take a LIST rather than a number: a filter bank's levels, read a cycle at a time
// and handed over as that cycle's steps, and a device's scale, which is the track's key unless the
// pattern names one. Which controls take one is the engine's to say (listParams).

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, mini, Signal } from './src/signal.mjs';
import { Scheduler, cycleList, scaleList } from './src/scheduler.mjs';
import { setGlobalScale } from './src/notes.mjs';

/** An engine whose slot 1 holds a device with a Levels list and a Scale. */
function listEngine(clock) {
  const calls = [];
  const engine = new Proxy(
    {
      getTime: () => clock.now,
      listParams: (_track, slot) => (slot === 1
        ? [{ id: 'levels', name: 'Levels', takes: 'list', epoch: clock.epoch ?? 1 },
          { id: 'scale', name: 'Scale', takes: 'scale', epoch: clock.epoch ?? 1 }]
        : null),
    },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const lists = () => calls.filter((c) => c.method === 'setParam' && c.args[3] && typeof c.args[3] === 'object')
    .map((c) => ({ name: c.args[2], list: [...c.args[3].list], at: c.args[4] }));
  const scalars = () => calls.filter((c) => c.method === 'setParam' && typeof c.args[3] !== 'object').map((c) => c.args);
  return { engine, lists, scalars };
}

/** Plays `sig` from 0 through `seconds`, ticking every 30 ms. */
function playFor(sig, seconds, clock = { now: 0 }) {
  const { engine, lists, scalars } = listEngine(clock);
  const sched = new Scheduler(engine, { trackId: 't', cps: 1 });
  sched.setPattern(sig);
  sched.start();
  for (clock.now = 0; clock.now <= seconds; clock.now += 0.03) sched._tick();
  sched.stop();
  return { lists, scalars, sched, clock };
}

test('one cycle of a pattern is a list of its steps: start, end, value, a rest left out', () => {
  assert.deepEqual(cycleList(mini('1 0 .5 ~'), 0, 0, 1), [0, 0.25, 1, 0.25, 0.5, 0, 0.5, 0.75, 0.5]);
  assert.deepEqual(cycleList(mini('<[1 0] [0 .3]>'), 1, 1, 1), [0, 0.5, 0, 0.5, 1, 0.3]);
  assert.deepEqual(cycleList(mini('~'), 0, 0, 1), []);
  assert.deepEqual(cycleList(Signal(0.4), 0, 0, 1).slice(-1), [0.4]);
});

test('a scale is handed over as its root, its period and its intervals - a tuning exactly', () => {
  assert.deepEqual(scaleList('D dorian'), [62, 12, 0, 2, 3, 5, 7, 9, 10]);
  const edo = scaleList('31edo');
  assert.equal(edo.length, 2 + 31);
  assert.ok(Math.abs(edo[3] - 12 / 31) < 1e-12);
  assert.equal(scaleList('nonesuch scale', null), null);
});

test('a list control is sent a cycle at a time, on the cycle, and only when it changes', () => {
  const sig = n('0 2').fx('Filterbank').param('Levels', mini('<[1 0 .5 1] [0 1 0 .3]>'));
  const { lists, scalars } = playFor(sig, 3.5);
  const levels = lists().filter((l) => l.name === 'levels');
  assert.deepEqual(levels.map((l) => l.list), [
    [0, 0.25, 1, 0.25, 0.5, 0, 0.5, 0.75, 0.5, 0.75, 1, 1],
    [0, 0.25, 0, 0.25, 0.5, 1, 0.5, 0.75, 0, 0.75, 1, 0.3],
    [0, 0.25, 1, 0.25, 0.5, 0, 0.5, 0.75, 0.5, 0.75, 1, 1],
    [0, 0.25, 0, 0.25, 0.5, 1, 0.5, 0.75, 0, 0.75, 1, 0.3],
  ]);
  // Each due at the start of its cycle (one cycle a second here).
  for (let k = 1; k < levels.length; k++) assert.ok(Math.abs(levels[k].at - k) < 1e-9, `list ${k} is due at ${levels[k].at}`);
  // And never polled as a number.
  assert.ok(!scalars().some((a) => String(a[2]).toLowerCase() === 'levels'));
});

test('a list is sent again when a different device takes the slot', () => {
  const clock = { now: 0, epoch: 1 };
  const sig = n('0').fx('Filterbank').param('Levels', mini('1 0'));
  const { engine, lists } = listEngine(clock);
  const sched = new Scheduler(engine, { trackId: 't', cps: 1 });
  sched.setPattern(sig);
  sched.start();
  for (clock.now = 0; clock.now <= 0.5; clock.now += 0.03) sched._tick();
  clock.epoch = 2;
  for (; clock.now <= 0.9; clock.now += 0.03) sched._tick();
  sched.stop();
  assert.equal(lists().filter((l) => l.name === 'levels').length, 2);
});

test('a scale control is the track\'s key: the pattern\'s .scale(), else the buffer\'s setscale()', () => {
  setGlobalScale('F minor');
  try {
    const built = n('0 2').fx('Resonator');
    const own = n('0 2').scale('D dorian').fx('Resonator');
    setGlobalScale(null); // the evaluation is over: the key it built with is still the track's
    const fromBuffer = playFor(built, 0.2).lists().filter((l) => l.name === 'scale');
    assert.deepEqual(fromBuffer.map((l) => l.list), [scaleList('F minor')]);
    const fromPattern = playFor(own, 0.2).lists().filter((l) => l.name === 'scale');
    assert.deepEqual(fromPattern.map((l) => l.list), [scaleList('D dorian')]);
  } finally {
    setGlobalScale(null);
  }
});

test('a scale named on the control wins, written as one name with a space in it', () => {
  const sig = n('0').scale('D dorian').fx('Resonator').param('Scale', mini('31edo major'));
  const sent = playFor(sig, 0.2).lists().filter((l) => l.name === 'scale');
  assert.deepEqual(sent.map((l) => l.list), [scaleList('31edo major')]);
});

test('with no key anywhere, nothing is sent and the device keeps its own', () => {
  setGlobalScale(null);
  const sent = playFor(n('0').fx('Resonator'), 0.2).lists().filter((l) => l.name === 'scale');
  assert.deepEqual(sent, []);
});
