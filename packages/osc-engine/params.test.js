'use strict';

// The bookkeeping of engine/params.js and engine/expr.js, on the engine with no server behind it
// (test-support/fake-engine.js) and mock controllers:
//
//   - rampTo / dropRamp / dropSlotRamps: a polled control rides one ramp bus, the first value makes
//     it and maps it, later values move its target, a moved index re-maps the same bus, a channel
//     control maps onto the track synth, and a slot's ramps drop alone and are freed later;
//   - holdParam / releaseParam: a hold reads the parameter once and files it, a release drops the
//     ramp, unmaps and sets back exactly that reading; with no reading it only unmaps;
//   - anchorParamLFO / setParamShape: a basic shape's rate is `freq`, a drawn one's `rate`, and a
//     drawn shape's swap starts at the rate it names (or the one in force);
//   - freeModulatorLater: nothing goes at once; then the node goes only if its track still owns that
//     group, and the bus always comes back;
//   - expressions: a device's control gets an audio bus, a plugin's a control bus read first and put
//     back on the clear; sources are wired on "~i~name"; numbers alone keep the synth and the def;
//     a new shape builds a def and retires the old synth; a leaf call is held for an expression
//     made later; a clear unmaps and forgets; one control's jobs run in order, a failure stalls none.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');

const ALL = ['tracks', 'routing', 'loads', 'ids', 'params', 'expr'];
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// The fake server answers a def load at once, as scsynth's /done would.
function engine() {
  const fe = fakeEngine({ sections: ALL });
  const raw = fe.S.sendRaw;
  fe.S.sendRaw = (bytes) => {
    const before = fe.sent.length;
    raw(bytes);
    for (const m of fe.sent.slice(before)) {
      if (m[0] === '/d_recv' || m[0] === '/d_load') setImmediate(() => fe.S._dispatch({ address: '/done', args: [m[0]] }));
    }
  };
  fe.E.modFreeDelay = 0.05;
  return fe;
}

function mockCtl(native, info = { level: 4, cutoff: 3, Mix: 7, Drive: 1, Tone: 2 }) {
  const c = {
    log: [],
    info: { findParamIndex: (n) => info[n] ?? null, parameters: Object.keys(info).map((name) => ({ name })) },
    map(i, bus) { c.log.push(['map', i, typeof bus === 'object' ? bus.index : bus]); },
    unmap(i) { c.log.push(['unmap', i]); },
    get(i, action) { c.log.push(['get', i]); if (c.answer !== undefined) action(c.answer); },
    set(i, v) { c.log.push(['set', i, v]); },
    answer: 0.25,
  };
  if (native) {
    c.mapAudio = (index, bus, gain, offset) => c.log.push(['mapAudio', index, typeof bus === 'object' ? bus.index : bus, gain, offset]);
    c.unmapAudio = (index) => c.log.push(['unmapAudio', index]);
  }
  return c;
}

function addTrack(E, key, ctls) {
  const S = E.S;
  const { Group, Synth } = require('./server/objects');
  const group = Group.basicNew(S, S.nextNodeID());
  const track = {
    key, group, chain: Group.basicNew(S, S.nextNodeID()), synth: Synth.basicNew('poptart_track_shared', S, S.nextNodeID()),
    head: Synth.basicNew('poptart_head', S, S.nextNodeID()), controllers: new Map(ctls.map((c, i) => [i, c])),
    loaded: new Map(ctls.map((c, i) => [i, c ? 'X' : null]).filter((e) => e[1])), wanted: new Map(),
    nodes: new Map(), wet: new Map(), lfos: new Map(), envs: new Map(), ramps: new Map(), resting: new Map(),
    taps: new Map(), held: 0, gains: new Map(), xos: new Map(),
  };
  E.tracks.set(key, track);
  return track;
}

test('a polled control rides one ramp bus, and the bus follows the parameter', async () => {
  const { E, sent } = engine();
  const ctl = mockCtl(false);
  const track = addTrack(E, 't', [null, ctl, mockCtl(false)]);
  E.rampTo(track, 'slot1_Mix', 1, E.paramTarget(track, 1, 'Mix', 7), 0.5);
  const mix = track.ramps.get('slot1_Mix');
  assert.ok(mix, 'the first value creates the ramp');
  assert.deepStrictEqual(ctl.log.at(-1), ['map', 7, mix.bus.index]);
  assert.ok(sent.some((m) => m[0] === '/s_new' && m[1] === 'poptart_ramp' && m.includes(mix.bus.index)));
  E.rampTo(track, 'slot1_Mix', 1, E.paramTarget(track, 1, 'Mix', 7), 0.8);
  assert.strictEqual(track.ramps.get('slot1_Mix').bus, mix.bus);
  assert.strictEqual(ctl.log.length, 1, 'a later value only moves the target');
  assert.ok(sent.some((m) => m[0] === '/n_set' && m[1] === mix.synth.nodeID && m[2] === 'target'));
  E.rampTo(track, 'slot1_Mix', 1, E.paramTarget(track, 1, 'Mix', 3), 0.8);
  assert.deepStrictEqual(ctl.log.at(-1), ['map', 3, mix.bus.index], 'a moved index re-maps the same bus');
  E.rampTo(track, 'slot-1_gain', -1, E.paramTarget(track, -1, 'gain'), 1);
  const gain = track.ramps.get('slot-1_gain');
  assert.ok(sent.some((m) => m[0] === '/n_mapn' && m[1] === track.head.nodeID && m[2] === 'gain' && m[3] === gain.bus.index),
    'a channel control maps onto its node by name');
  E.rampTo(track, 'slot2_Drive', 2, E.paramTarget(track, 2, 'Drive', 1), 0.2);
  E.rampTo(track, 'slot2_Tone', 2, E.paramTarget(track, 2, 'Tone', 2), 0.2);
  E.dropSlotRamps('t', track, 2);
  assert.deepStrictEqual([...track.ramps.keys()].sort(), ['slot-1_gain', 'slot1_Mix']);
  E.dropRamp('t', track, 'slot-1_gain');
  assert.deepStrictEqual([...track.ramps.keys()], ['slot1_Mix']);
  assert.ok(gain.bus.index != null, 'a dropped ramp is not freed synchronously');
  await settle(120);
  assert.strictEqual(gain.bus.index, null, 'a dropped ramp is freed after the deferral');
  assert.ok(mix.bus.index != null, 'a ramp still in use keeps its bus');
});

test('a held parameter is read once and set back on release', async () => {
  const { E } = engine();
  const ctl = mockCtl(false);
  const track = addTrack(E, 't', [null, ctl]);
  ctl.answer = undefined; // the answer comes later
  let answer = null;
  ctl.get = (i, action) => { ctl.log.push(['get', i]); answer = action; };
  E.dispatch('/poptart/holdParam', ['t', 1, 'Mix']);
  assert.deepStrictEqual(ctl.log.at(-1), ['get', 7]);
  assert.strictEqual(track.resting.get('slot1_Mix'), 'pending');
  E.rampTo(track, 'slot1_Mix', 1, E.paramTarget(track, 1, 'Mix'), 0.9);
  answer(0.42);
  assert.strictEqual(track.resting.get('slot1_Mix'), 0.42);
  ctl.log.length = 0;
  E.dispatch('/poptart/holdParam', ['t', 1, 'Mix']);
  assert.strictEqual(ctl.log.length, 0, 'a second hold neither asks nor overwrites');
  assert.strictEqual(track.resting.get('slot1_Mix'), 0.42);
  E.dispatch('/poptart/releaseParam', ['t', 1, 'Mix', 0]);
  assert.deepStrictEqual(ctl.log, [['unmap', 7], ['set', 7, 0.42]]);
  assert.ok(!track.ramps.has('slot1_Mix') && !track.resting.has('slot1_Mix'));
  // No reading: unmap only.
  ctl.log.length = 0;
  E.dispatch('/poptart/holdParam', ['t', 1, 'Drive']);
  E.rampTo(track, 'slot1_Drive', 1, E.paramTarget(track, 1, 'Drive'), 0.5);
  ctl.log.length = 0;
  E.dispatch('/poptart/releaseParam', ['t', 1, 'Drive', 0]);
  assert.deepStrictEqual(ctl.log, [['unmap', 1]]);
  ctl.log.length = 0;
  E.dispatch('/poptart/holdParam', ['t', 1, 'Nope']);
  assert.strictEqual(ctl.log.length, 0, 'an unknown parameter is left alone');
});

test("an anchor with a rate sets it by the name each shape kind uses, and a swap starts at the rate it names", () => {
  const { E, S, sent } = engine();
  const { Synth } = require('./server/objects');
  const track = addTrack(E, 't', [null]);
  const basic = { synth: Synth.basicNew('poptart_lfo_saw', S, 5000), shape: 'saw' };
  const drawn = {
    synth: Synth.basicNew('poptart_shape_lfo', S, 5001), shape: 'custom', mode: 'free', rate: 0.5, lo: 0, hi: 1,
    def: 'poptart_shape_lfo', bufs: [{ bufnum: 70 }, { bufnum: 71 }], current: 0, glide: 0, bus: { index: 9 }, group: track.group,
  };
  track.lfos.set('slot0_A', basic);
  track.lfos.set('slot0_B', drawn);
  const sets = () => sent.filter((m) => m[0] === '/n_set').map((m) => m.slice(1));
  E.dispatch('/poptart/anchorParamLFO', ['t', 0, 'A', 0.25, 0]);
  E.dispatch('/poptart/anchorParamLFO', ['t', 0, 'A', 0.5, 0, 2]);
  E.dispatch('/poptart/anchorParamLFO', ['t', 0, 'B', 0.75, 0, 3]);
  assert.deepStrictEqual(sets(), [
    [5000, 't_trig', 1, 'phase', 0.25],
    [5000, 't_trig', 1, 'phase', 0.5, 'freq', 2],
    [5001, 't_trig', 1, 'phase', 0.75, 'rate', 3],
  ]);
  assert.strictEqual(drawn.rate, 3, 'the drawn entry remembers the rate for its next swap');
  sent.length = 0;
  E.dispatch('/poptart/setParamShape', ['t', 0, 'B', 1, 0, 1.5]);
  let made = sent.find((m) => m[0] === '/s_new');
  assert.deepStrictEqual(made.slice(5, 11), ['out', 9, 'buf', 71, 'rate', 1.5]);
  assert.strictEqual(drawn.rate, 1.5);
  sent.length = 0;
  E.dispatch('/poptart/setParamShape', ['t', 0, 'B', 0, 0]);
  made = sent.find((m) => m[0] === '/s_new');
  assert.deepStrictEqual(made.slice(5, 11), ['out', 9, 'buf', 70, 'rate', 1.5], 'a swap naming no rate keeps the one in force');
  assert.ok(E.modFreeDelay < 1 && require('./engine/core').Engine, 'sanity');
});

test('a dropped modulator outlives the notes already in flight', async () => {
  const { E, S } = engine();
  const { Engine } = require('./engine/core');
  const { Group, Bus, Synth } = require('./server/objects');
  // The scheduler's note lookahead (DEFAULT_LOOKAHEAD_SEC) is 0.15s.
  assert.ok(new Engine({ server: S, config: {}, tell() {}, output() {}, defs: E.defs }).modFreeDelay > 0.15);
  const groupA = Group.basicNew(S, 100);
  const groupB = Group.basicNew(S, 200);
  const entry = () => ({ synth: Synth.basicNew('x', S, S.nextNodeID()), bus: Bus.control(S, 1) });
  const freed = new Set();
  const living = entry(); const orphaned = entry(); const rebuilt = entry();
  for (const e of [living, orphaned, rebuilt]) e.synth.free = () => freed.add(e.synth.nodeID);
  E.tracks.set('living', { group: groupA });
  E.tracks.set('orphaned', { group: groupA });
  E.tracks.set('rebuilt', { group: groupA });
  E.freeModulatorLater('living', groupA, living.synth, living.bus);
  E.freeModulatorLater('orphaned', groupA, orphaned.synth, orphaned.bus);
  E.freeModulatorLater('rebuilt', groupA, rebuilt.synth, rebuilt.bus);
  assert.ok(freed.size === 0 && living.bus.index != null, 'nothing is freed synchronously');
  assert.ok(E.nodeGoneSaid.has(living.synth.nodeID), 'the late writes to it are accounted for');
  E.tracks.delete('orphaned');
  E.tracks.set('rebuilt', { group: groupB });
  await settle(150);
  assert.ok(freed.has(living.synth.nodeID) && living.bus.index == null, 'the deferred teardown ran');
  assert.ok(!freed.has(orphaned.synth.nodeID) && orphaned.bus.index == null, 'a destroyed track: no double free, no bus leak');
  assert.ok(!freed.has(rebuilt.synth.nodeID) && rebuilt.bus.index == null, 'a rebuilt track keeps its new group');
});

const TREE = JSON.stringify({ k: 'op', op: 'add', a: [
  { k: 'op', op: 'mul', a: [{ k: 'in', i: 0, rate: 'ar', source: 'src' }, { k: 'const', v: 0.5 }] },
  { k: 'op', op: 'mul', a: [{ k: 'in', i: 1, rate: 'kr' }, { k: 'const', v: 0.25 }] },
] });
const TREE_NUMBERS = TREE.replace('0.5', '0.8');
const TREE_SHAPE = JSON.stringify({ k: 'op', op: 'mul', a: [{ k: 'in', i: 1, rate: 'kr' }, { k: 'const', v: 2 }] });

test('an expression is installed, updated, rebuilt and cleared as the engine expects', async () => {
  const { E, sent } = engine();
  const native = mockCtl(true);
  const plugin = mockCtl(false);
  const t1 = addTrack(E, 't1', [native]);
  const t2 = addTrack(E, 't2', [plugin]);
  const wired = [];
  const unwired = [];
  const freed = [];
  E.wireParamRoute = (key, slot, name, src) => wired.push([key, slot, name, src]);
  E.unwireParamRoute = (key, slot, name) => unwired.push([key, slot, name]);
  const freeLater = E.freeModulatorLater;
  E.freeModulatorLater = (key, group, synth, bus) => { freed.push(synth); freeLater(key, group, synth, bus); };

  // 1. A leaf call before the expression exists is held for it.
  E.paramTarget(t1, 0, '~1~level').map(77);
  assert.deepStrictEqual(E.exprFeedArgs(t1, 0, 'level', [{ i: 1 }]), ['k1', 77, 'a1', -1]);
  // 2. On a device's control: an audio bus, its source wired on the leaf.
  await E.installExpr('t1', t1, 0, 'level', TREE);
  const e = E.exprsOf(t1).get('slot0_level');
  const first = e.synth;
  assert.strictEqual(e.outKind, 'device');
  assert.deepStrictEqual(native.log.map((l) => l[0]), ['mapAudio']);
  assert.strictEqual(native.log.at(-1)[1], 4);
  assert.strictEqual(native.log.at(-1)[2], e.out.index);
  assert.strictEqual(e.out.rate, 'audio');
  assert.deepStrictEqual(wired, [['t1', 0, '~0~level', 'src']]);
  assert.strictEqual(E.exprDefs.size, 1);
  const made = sent.find((m) => m[0] === '/s_new' && m[1] === e.def);
  assert.ok(made && made.includes('k1') && made[made.indexOf('k1') + 1] === 77, 'the held feed rides the birth');
  // 3. Only the numbers changed: same synth, same def, nothing re-wired.
  wired.length = 0;
  await E.installExpr('t1', t1, 0, 'level', TREE_NUMBERS);
  assert.strictEqual(E.exprsOf(t1).get('slot0_level').synth, first);
  assert.strictEqual(E.exprDefs.size, 1);
  assert.strictEqual(wired.length, 0);
  assert.strictEqual(freed.length, 0);
  // 4. Another shape: a new def, a new synth, the old one retired, the source unwired.
  await E.installExpr('t1', t1, 0, 'level', TREE_SHAPE);
  assert.notStrictEqual(E.exprsOf(t1).get('slot0_level').synth, first);
  assert.strictEqual(E.exprDefs.size, 1, 'the first def was retired as its last user went');
  assert.ok(freed.includes(first));
  assert.deepStrictEqual(unwired, [['t1', 0, '~0~level']]);
  // 5. A leaf call now reaches the running expression's input record.
  E.paramTarget(t1, 0, '~1~level').mapAudio(88);
  assert.deepStrictEqual(E.exprFeedArgs(t1, 0, 'level', [{ i: 1 }]), ['k1', 77, 'a1', 88]);
  // 6. Cleared: off the control, back on the value last set, the inputs forgotten.
  native.log.length = 0;
  unwired.length = 0;
  E.clearExpr('t1', t1, 0, 'level');
  assert.deepStrictEqual(native.log.map((l) => l[0]), ['unmapAudio', 'get', 'set']);
  assert.ok(!E.exprsOf(t1).has('slot0_level'));
  assert.strictEqual(E.exprFeedsOf(t1).size, 0);
  // 7. On a plugin parameter: a control bus, the value read first, put back on the clear.
  await E.installExpr('t2', t2, 0, 'cutoff', TREE_SHAPE);
  assert.strictEqual(E.exprsOf(t2).get('slot0_cutoff').outKind, 'plugin');
  assert.deepStrictEqual(plugin.log.map((l) => l[0]), ['get', 'map']);
  plugin.log.length = 0;
  E.clearExpr('t2', t2, 0, 'cutoff');
  assert.deepStrictEqual(plugin.log, [['unmap', 3], ['set', 3, 0.25]]);
  // 8. One control's jobs run in order, and a failing one does not stall the next.
  const order = [];
  E.exprRun('t1', 0, 'level', async () => { await E.wait(0.1); order.push(1); });
  E.exprRun('t1', 0, 'level', async () => { order.push(2); throw new Error('boom'); });
  E.exprRun('t1', 0, 'level', async () => { order.push(3); });
  await settle(400);
  assert.deepStrictEqual(order, [1, 2, 3]);
  assert.strictEqual(E.exprQueue.size, 0);
});

test('a def freed late is kept when its shape comes back inside the wait', async () => {
  const { E, sent } = engine();
  const t1 = addTrack(E, 't1', [mockCtl(true)]);
  await E.installExpr('t1', t1, 0, 'level', TREE_SHAPE);
  const def = E.exprsOf(t1).get('slot0_level').def;
  E.clearExpr('t1', t1, 0, 'level');
  await E.installExpr('t1', t1, 0, 'level', TREE_SHAPE);
  assert.strictEqual(E.exprsOf(t1).get('slot0_level').def, def);
  await settle(2200);
  assert.ok(!sent.some((m) => m[0] === '/d_free' && m[1] === def), 'a def in use again is not freed');
  assert.ok(E.defs.has(def));
});
