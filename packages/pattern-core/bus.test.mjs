// Output-to-bus sends (Sig#bus / #dry / #bsend) and how the Scheduler forwards them to the engine.
// The audio summing itself lives in SuperCollider (sc/poptart.scd) and is covered by a manual
// checklist; here we pin the pure builder behavior and the engine calls the scheduler emits.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, synth, s, lfo, mini, sine } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { routePlan } from './src/route.mjs';

// A stand-in engine: every method is a spy that records its call; getTime is 0 so the Transport a
// Scheduler builds has a clock. `typeof engine.method === 'function'` holds for everything, which
// is what the scheduler feature-detects on.
function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, calls, callsTo };
}

test('.bus() appends a send; defaults amount to 1', () => {
  const sig = synth('Serum 2').bus('drums');
  assert.deepEqual(sig.busSends, [{ name: 'drums', amount: 1, at: 0 }]);
});

test('.bus() takes a send amount and stacks multiple buses', () => {
  const sig = synth('Serum 2').bus('reverb', 0.3).bus('delay', 0.5);
  assert.deepEqual(sig.busSends, [
    { name: 'reverb', amount: 0.3, at: 0 },
    { name: 'delay', amount: 0.5, at: 0 },
  ]);
});

test('.bus() trims the name and validates its arguments', () => {
  assert.deepEqual(synth('Serum 2').bus('  drums  ').busSends, [{ name: 'drums', amount: 1, at: 0 }]);
  assert.throws(() => synth('Serum 2').bus(''), /bus name/);
  assert.throws(() => synth('Serum 2').bus(42), /bus name/);
  assert.throws(() => synth('Serum 2').bus('drums', NaN), /amount must be a number/);
});

test('.bus() keeps a patterned name and a signal amount as signals', () => {
  // A Sig name is what the editor's transpile hands us for any literal here; a plain string stays
  // one literal name so a group's generated bus (`b:kick`) is never read as mini notation.
  const sig = synth('Serum 2').bus(mini('<reverb delay>'), sine());
  assert.equal(sig.busSends.length, 1);
  assert.equal(typeof sig.busSends[0].name, 'object', 'the name pattern is kept whole');
  assert.equal(typeof sig.busSends[0].amount, 'object', 'so is the level signal');
  // A string amount is a pattern like every other level (see .postgain()).
  assert.equal(typeof synth('Serum 2').bus('reverb', '0 .5').busSends[0].amount, 'object');
});

test('.dry() sets a dry-level channel control, independent of bus sends', () => {
  const sig = synth('Serum 2').bus('drums').dry(0.25);
  assert.ok('dry' in sig.channel, 'dry rides the channel strip');
  assert.deepEqual(sig.busSends, [{ name: 'drums', amount: 1, at: 0 }], 'dry leaves sends untouched');
});

test('.bsend() is .bus().dry(0)', () => {
  const sig = synth('Serum 2').bsend('reverb', 0.4);
  assert.deepEqual(sig.busSends, [{ name: 'reverb', amount: 0.4, at: 0 }]);
  const plain = synth('Serum 2').bus('reverb', 0.4).dry(0);
  // Same shape as spelling it out by hand.
  assert.deepEqual(sig.busSends, plain.busSends);
  assert.deepEqual(Object.keys(sig.channel), Object.keys(plain.channel));
});

test('bus sends survive later chaining (threaded through _clone)', () => {
  const sig = synth('Serum 2').bus('drums', 0.7).gain(0.5).pan(-1);
  assert.deepEqual(sig.busSends, [{ name: 'drums', amount: 0.7, at: 0 }]);
});

test('scheduler forwards .bus() sends to the engine', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2').bus('drums', 0.8).bus('room'));

  const sent = callsTo('setBusSends');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, ['kick', [{ name: 'drums', amount: 0.8, i: 0 }, { name: 'room', amount: 1, i: 1 }]]);
});

test('scheduler tears down sends when a re-eval drops .bus()', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2').bus('drums'));
  sch.setPattern(note('c2*4').synth('Serum 2')); // .bus() gone this eval

  assert.equal(callsTo('clearBusSends').length, 1);
  assert.deepEqual(callsTo('clearBusSends')[0].args, ['kick']);
});

test('scheduler does not clear sends when there were none to begin with', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2'));
  assert.equal(callsTo('clearBusSends').length, 0);
});

test('scheduler re-routes when a patterned bus name turns over, and only then', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick', cps: 1 });
  sch.transport.start(); // a frozen clock never leaves cycle 0, so the name could never turn over
  sch.setPattern(note('c2*4').synth('Serum 2').bus(mini('<reverb delay>')));

  // Cycle 0 of the name pattern - the send goes to "reverb".
  assert.deepEqual(callsTo('setBusSends').at(-1).args, ['kick', [{ name: 'reverb', amount: 1, i: 0 }]]);
  // Ticking inside the same cycle changes nothing: a re-route acquires and releases buses and
  // reorders the node tree, so it must not happen once per poll.
  sch._syncBusSends(0.1);
  assert.equal(callsTo('setBusSends').length, 1, 'no re-route while the name holds');
  // ...and the next cycle switches the destination.
  sch._syncBusSends(1.05);
  assert.deepEqual(callsTo('setBusSends').at(-1).args, ['kick', [{ name: 'delay', amount: 1, i: 0 }]]);
});

test('a resting name pattern drops the send entirely rather than sending at zero', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick', cps: 1 });
  sch.transport.start();
  sch.setPattern(note('c2*4').synth('Serum 2').bus(mini('<reverb ~>')));
  assert.deepEqual(callsTo('setBusSends').at(-1).args, ['kick', [{ name: 'reverb', amount: 1, i: 0 }]]);

  sch._syncBusSends(1.05); // the rest cycle
  assert.equal(callsTo('clearBusSends').length, 1, 'the bus is released while the name rests');
});

test('a signal send level is polled as a level, not as a re-route', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad', cps: 1 });
  sch.transport.start();
  sch.setPattern(note('c2').synth('Serum 2').bus('reverb', sine()));

  const routed = callsTo('setBusSends').length;
  sch._syncBusSends(0.3);
  sch._syncBusSends(0.6);
  assert.equal(callsTo('setBusSends').length, routed, 'the routing never changed');
  const moved = callsTo('setBusSendAmount');
  assert.ok(moved.length >= 2, 'the level was pushed on its own');
  assert.equal(moved[0].args[0], 'pad');
  assert.equal(moved[0].args[1], 0, 'addressed by the send\'s index in the routed set');
  assert.equal(typeof moved[0].args[2], 'number');
  assert.ok(moved[0].args[3] > 0, 'applied at the lookahead horizon it was sampled for');
});

test('a static send level is never re-pushed after its routing lands', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(note('c2').synth('Serum 2').bus('reverb', 0.3));
  sch._syncBusSends(0.3);
  sch._syncBusSends(0.6);
  assert.equal(callsTo('setBusSends').length, 1);
  assert.equal(callsTo('setBusSendAmount').length, 0, 'setBusSends already carried the level');
});

// A group member sounds only through its send, and clearing it swaps the send's output bus on
// one sample - the ringing hit vanishes, a click. Stop rings out, so the send stays; the next
// eval diffs it against the pattern and the play that brings the track back hushes it.
test('stop() leaves a track\'s bus sends up, so a grouped hit rings out like an ungrouped one', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2*4').synth('Serum 2').bus('drums'));
  sch.stop();
  assert.equal(callsTo('clearBusSends').length, 0);
  sch.setPattern(note('c2*4').synth('Serum 2')); // the eval after: .bus() gone, send cleared
  assert.equal(callsTo('clearBusSends').length, 1);
});

// A channel-control reset is setParam on the pseudo-slot (-1) with the control's default. It must
// be scheduled AHEAD of getTime() (0 here): a reset at "now" loses to the stale value the last
// poll already queued a lookahead into the future, which for dry=0 leaves the track silent.
const resetCalls = (callsTo, name, value) =>
  callsTo('setParam').filter((c) => c.args[1] === -1 && c.args[2] === name && c.args[3] === value);
const driedReset = (callsTo, name, value) => resetCalls(callsTo, name, value).length > 0;

test('dropping .bsend() on re-eval snaps dry back to 1, scheduled ahead of stale polls', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(note('c2').synth('Serum 2').bsend('reverb')); // dry -> 0
  sch.setPattern(note('c2').synth('Serum 2'));                 // .bsend() gone

  const resets = resetCalls(callsTo, 'dry', 1);
  assert.equal(resets.length, 1, 'dry is reset to its default of 1');
  assert.ok(resets[0].args[4] > 0, 'reset is scheduled at the lookahead horizon, not at getTime()=0');
});

test('a fresh Scheduler on a persisted track resets dry (mute/unmute, delete/retype)', () => {
  // The engine track outlives the Scheduler, so a re-added label lands on a synth that may still
  // hold dry=0 from a previous .bsend(). The first setPattern must reset it even though this
  // Scheduler never saw the .bsend().
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(note('c2').synth('Serum 2')); // plain track, no dry in its channel
  assert.ok(driedReset(callsTo, 'dry', 1), 'a fresh Scheduler resets unspecified channel controls');
});

test('stop() clears active Tier-2 modulators (muting must stop the modulation)', () => {
  // A modulated param runs as a persistent engine synth; muting stops the tick loop but that synth
  // keeps modulating until explicitly cleared - and the fresh Scheduler an unmute makes never saw
  // it. So stop() must tear it down.
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(note('c2').synth('Serum 2').param('cutoff', lfo()));
  assert.ok(callsTo('setParamLFO').length >= 1, 'the LFO was set up on the param');

  sch.stop();
  const cleared = callsTo('clearParamLFO');
  assert.equal(cleared.length, 1, 'stop() clears the LFO');
  assert.deepEqual(cleared[0].args.slice(0, 3), ['lead', 0, 'cutoff']);
});

// --- a send written inside the chain taps the signal where it is written ----------------------
//
// After the last device a send is the track's output, as it always was: the plan says nothing
// about it and the engine's post-strip send carries it. Before a device it is an item of the
// chain's tree, and the plan's `sends` says what it reads.

const IN = { k: 'in' };
const slot = (p) => ({ k: 'slot', p });

test('.bus() records the devices before it, and after the last device it is the plain send', () => {
  const sig = synth('Serum 2').fx('Delay').bus('feedback').fx('Reverb').bus('room');
  assert.deepEqual(sig.busSends.map((b) => b.at), [1, 2]);
  assert.equal(sig.fxRoute, null, 'a line stays a line until an engine needs its tree');
  assert.deepEqual(sig._routeItems(), [1, { send: 0 }, 2, { send: 1 }]);
  const { plan } = routePlan(sig);
  assert.deepEqual(plan.sends, { 0: { s: slot(1), g: 0 } }, 'the feedback send reads the delay alone');
  assert.deepEqual(plan.out, { s: slot(2), g: 0 }, 'the strip reads the reverb');
  assert.deepEqual(plan.reads, { 1: { s: IN, g: 0 }, 2: { s: slot(1), g: 0 } }, 'the chain is untouched by the tap');
});

test('a chain whose sends all come after its devices has no tree to send', () => {
  assert.equal(synth('Serum 2').fx('Delay').fx('Reverb').bus('a').bus('b').postgain(0.5)._routeItems(), null);
  assert.equal(routePlan(synth('Serum 2').bus('a').fx('Delay').bus('b').fx('Reverb').bus('c')).plan.sends[1].s.p, 1);
  assert.equal(routePlan(synth('Serum 2').bus('a').fx('Delay')).plan.sends[0].s.k, 'in', 'before the first device: the instrument');
  assert.equal(synth('Serum 2').bus('a')._routeItems(), null, 'no devices at all: the track output');
});

test('inside a branch a send taps that branch, at its level and pan when it ends the branch', () => {
  const sig = synth('Serum 2')
    .split(
      (x) => x.bus('dry'),
      (b) => b.fx('LPG').bus('mid').fx('Reverb').postgain(0.5).bus('wet'),
    )
    .fx('Comp')
    .bus('out');
  const { plan, controls } = routePlan(sig);
  assert.deepEqual(plan.sends[0], { s: IN, g: 0 }, 'the clean branch, as it arrives');
  assert.deepEqual(plan.sends[1], { s: slot(1), g: 0 }, 'mid-branch: the LPG, before the branch level');
  assert.equal(plan.sends[2].s.p, 2, 'the end of the branch: the reverb...');
  assert.ok(plan.sends[2].g > 0, '...at the branch level');
  assert.equal(controls[`rl${plan.sends[2].g}`].constVal, 0.5);
  assert.equal(plan.sends[3], undefined, 'after the last device: the plain send');
});

test('a sum only a send reads is kept for it', () => {
  const sig = synth('Serum 2').split((x) => x, (b) => b.fx('LPG')).bus('both').fx('Reverb');
  const { plan } = routePlan(sig);
  assert.equal(plan.sends[0].s.k, 'sum');
  assert.ok(plan.sums[plan.sends[0].s.id], 'the sum the send reads exists');
  assert.deepEqual(plan.reads[2], plan.sends[0], 'and the reverb reads the same sum');
});

test('scheduler sends the tree and names each send by its index, so a rest keeps the others in place', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'delay', cps: 1 });
  sch.transport.start();
  sch.setPattern(note('c2').synth('Serum 2').fx('Delay').bus(mini('<~ side>')).bus('feedback').fx('Reverb'));
  const routed = callsTo('setRouting').at(-1).args;
  assert.equal(routed[0], 'delay');
  assert.deepEqual(Object.keys(routed[1].sends), ['0', '1'], 'both sends are inside the chain');
  // Cycle 0: the patterned name rests, so only the feedback send is routed - still as send 1.
  assert.deepEqual(callsTo('setBusSends').at(-1).args, ['delay', [{ name: 'feedback', amount: 1, i: 1 }]]);
  sch._syncBusSends(1.05);
  assert.deepEqual(callsTo('setBusSends').at(-1).args, ['delay', [{ name: 'side', amount: 1, i: 0 }, { name: 'feedback', amount: 1, i: 1 }]]);
});

test('a plain chain with every send at its end sends no tree', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'kick' });
  sch.setPattern(note('c2').synth('Serum 2').fx('Delay').bus('feedback').postgain(0.5));
  assert.deepEqual(callsTo('setRouting').map((c) => c.args[1]), [null]);
});
