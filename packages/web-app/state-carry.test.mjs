// A solo toggle stops every track it soloes away and builds each one a fresh Scheduler when it comes
// back. The engine track stays warm - its plugins open, holding their programs - so a preset that
// has not changed must not be loaded again: a load resets the plugin's voices. What the server
// does (state-carry.js, wired in server.js's eval sweep) is replayed here with the real Scheduler
// and an engine that answers each load the way OscEngine does: a promise of whether it landed.
//
// The other half matters as much: wherever the plugin may not hold the program any more, it has
// to be sent again - a missed restore is a wrong sound nobody is told about.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { note, synth } from '../pattern-core/src/signal.mjs';
import { Scheduler } from '../pattern-core/src/scheduler.mjs';

const require = createRequire(import.meta.url);
const { StateCarry } = require('./state-carry');

// Every call recorded; setPluginState answers with `landed` (true unless a test says otherwise).
function fakeEngine({ landed = () => true } = {}) {
  const loads = [];
  const target = {
    getTime: () => 0,
    setPluginState: (trackId, slot, state) => {
      loads.push({ trackId, slot, state });
      return Promise.resolve(landed(trackId, slot, state));
    },
  };
  const engine = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => {}) });
  return { engine, loads };
}

const settle = () => new Promise((r) => setImmediate(r));

const song = (lead = 'H4sIlead', delay = 'H4sIdelay') => note('c3').synth('Serum 2', { state: lead }).fx('Echo', { state: delay });

// One track as the server runs it: a Scheduler while it plays, parked in the carry while a solo
// has it stopped, a new Scheduler when it comes back.
function track(engine, carry, trackId = '#1') {
  let sch = null;
  return {
    play(sig) {
      if (!sch) {
        sch = new Scheduler(engine, { trackId, label: 'lead' });
        carry.adopt(sch, engine);
      }
      sch.setPattern(sig);
      return sch;
    },
    stop() {
      carry.retire(sch, engine); // before the stop, as the server does: it lets go of the holds
      sch.stop();
      sch = null;
    },
    get sch() { return sch; },
  };
}

test('a solo and unsolo send no preset that has not changed', async () => {
  const { engine, loads } = fakeEngine();
  const carry = new StateCarry();
  const t = track(engine, carry);
  t.play(song());
  await settle();
  assert.equal(loads.length, 2, 'the first play loads both');
  for (let i = 0; i < 3; i++) {
    t.stop();
    t.play(song());
    await settle();
  }
  assert.equal(loads.length, 2, 'nothing loaded again across three solo cycles');
});

test('a state changed while soloed away is sent, and only that one', async () => {
  const { engine, loads } = fakeEngine();
  const carry = new StateCarry();
  const t = track(engine, carry);
  t.play(song());
  await settle();
  t.stop();
  t.play(song('H4sIlead', 'H4sIdelay2'));
  assert.deepEqual(loads.slice(2), [{ trackId: '#1', slot: 1, state: 'H4sIdelay2' }]);
});

test('an engine restart sends every state again', async () => {
  const first = fakeEngine();
  const carry = new StateCarry();
  const t = track(first.engine, carry);
  t.play(song());
  await settle();
  t.stop();
  // The server clears the carry on a restart; even a record that slipped through is from another
  // engine and is not taken.
  const second = fakeEngine();
  const back = new Scheduler(second.engine, { trackId: '#1', label: 'lead' });
  carry.adopt(back, second.engine);
  back.setPattern(song());
  assert.equal(second.loads.length, 2);

  t.play(song()); // the record went to `back`: this one starts empty
  await settle();
  const before = first.loads.length;
  t.stop();
  carry.clear();
  t.play(song());
  assert.equal(first.loads.length - before, 2, 'cleared: both sent again');
});

test('a destroyed engine track sends every state again', async () => {
  const { engine, loads } = fakeEngine();
  const carry = new StateCarry();
  const t = track(engine, carry);
  t.play(song());
  await settle();
  t.stop();
  carry.forgetTrack('#1'); // dropTrack
  t.play(song());
  assert.equal(loads.length, 4);
});

test('a plugin replaced in its slot, and brought back, is given its state again', async () => {
  const { engine, loads } = fakeEngine();
  const carry = new StateCarry();
  const t = track(engine, carry);
  t.play(song());
  await settle();
  // Echo swapped out for another effect and back: the Echo that returns is a new instance, on its
  // defaults - in one Scheduler's life, and across a rebuild.
  t.play(note('c3').synth('Serum 2', { state: 'H4sIlead' }).fx('Chorus'));
  t.play(song());
  await settle();
  assert.deepEqual(loads.slice(2).map((l) => l.state), ['H4sIdelay']);
  t.play(note('c3').synth('Serum 2', { state: 'H4sIlead' }).fx('Chorus'));
  t.stop();
  t.play(song());
  assert.deepEqual(loads.slice(3).map((l) => l.state), ['H4sIdelay']);
});

test('a load that did not land, or was never answered, is sent again', async () => {
  // The cold-open case: a restore that timed out leaves the plugin on its init program.
  const failed = fakeEngine({ landed: (id, slot) => slot !== 1 });
  const carry = new StateCarry();
  const t = track(failed.engine, carry);
  t.play(song());
  await settle();
  t.stop();
  t.play(song());
  assert.deepEqual(failed.loads.slice(2).map((l) => l.slot), [1]);

  // Stopped before the engine answered: in doubt, so sent.
  const slow = fakeEngine();
  const carry2 = new StateCarry();
  const t2 = track(slow.engine, carry2);
  t2.play(song());
  t2.stop(); // no settle: both loads still unanswered
  t2.play(song());
  assert.equal(slow.loads.length, 4);
});

test('a slot held by a hand edit is not carried', async () => {
  const { engine, loads } = fakeEngine();
  const carry = new StateCarry();
  const t = track(engine, carry);
  t.play(song());
  await settle();
  t.sch.holdPluginState(1, true);
  t.stop();
  t.play(song());
  assert.deepEqual(loads.slice(2).map((l) => l.slot), [1]);
});

test('what auto-pin learns about a parked track reaches its return', async () => {
  const { engine, loads } = fakeEngine();
  const carry = new StateCarry();
  const t = track(engine, carry);
  t.play(song());
  await settle();
  t.stop();
  // A capture of the parked Echo, filed into the code: no send-back when it returns.
  carry.markApplied('#1', 1, 'Echo', 'H4sIcaptured', engine);
  // A hand edit nobody filed: the slot is owed its program.
  carry.forgetSlot('#1', 0);
  t.play(song('H4sIlead', 'H4sIcaptured'));
  assert.deepEqual(loads.slice(2), [{ trackId: '#1', slot: 0, state: 'H4sIlead' }]);
});
