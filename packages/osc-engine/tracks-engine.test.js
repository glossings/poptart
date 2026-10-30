'use strict';

// A track on a real scsynth (engine/tracks.js, routing.js, loads.js, ids.js): what createTrack
// builds and in what order, audio from one track into another and through a named bus, the node
// order those routes give, one of poptart's own devices opening into a slot, and destroyTrack
// handing everything back. The engine runs as OscEngine drives it - '/poptart/*' messages in,
// '/poptart/ids/*' out.
//
// Needs scsynth and an audio device; skipped without them. Nothing sounds: every track is born
// with dry 0, so nothing reaches the outputs, and the audio is read off private buses.

const { test } = require('node:test');
const assert = require('node:assert');
const { bootEngine, skipReason, toldWhen } = require('./test-support/scsynth');
const { captureBus } = require('./test-support/capture');
const { Synth } = require('./server/objects');
const { nativeDevice, deviceParamArgs } = require('./native-devices');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids'];
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

// The node tree under `id`, as /g_queryTree answers: [{ id, children? }].
async function tree(S, id) {
  const a = await S.request(['/g_queryTree', id, 0], '/g_queryTree.reply', (r) => r[1] === id);
  let i = 1;
  const walk = () => {
    const nodeId = a[i];
    const n = a[i + 1];
    i += 2;
    if (n < 0) { i += 1; return { id: nodeId, def: a[i - 1] }; }
    const kids = [];
    for (let k = 0; k < n; k++) kids.push(walk());
    return { id: nodeId, children: kids };
  };
  return walk();
}

async function trackOf(E, key) {
  for (let i = 0; i < 100; i++) {
    const t = E.tracks.get(key);
    if (E.isTrack(t)) return t;
    await wait(0.02);
  }
  throw new Error(`track ${key} was never built`);
}

test('a track is built, routed, filled and taken down on a real server', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { S, E, told, quit } = await bootEngine({ port: 57476, sections: SECTIONS });
  try {
    E.dispatch('/poptart/createTrack', ['src', 'dry', 0, 'gain', 1]);
    E.dispatch('/poptart/createTrack', ['dst', 'dry', 0]);
    const src = await trackOf(E, 'src');
    const dst = await trackOf(E, 'dst');
    await S.sync();

    // The track as poptart.scd built it: [voices, chain [krGroup, head, strip], postGroup].
    const g = await tree(S, src.group.nodeID);
    assert.deepEqual(g.children.map((c) => c.id), [src.voices.nodeID, src.chain.nodeID, src.postGroup.nodeID]);
    const chain = g.children[1].children.map((c) => c.id);
    assert.deepEqual(chain, [src.krGroup.nodeID, src.head.nodeID, src.synth.nodeID]);
    const told1 = await toldWhen(told, '/poptart/ids/track', (a) => a[0] === 'src');
    assert.deepEqual(told1.args.slice(1), [src.group.nodeID, src.voices.nodeID, src.inBus.index, src.bendBus.index, src.head.nodeID]);
    assert.ok(told.some((m) => m.address === '/poptart/ids/slot' && m.args[0] === 'src' && m.args[1] === 0));

    // A steady 0.25 into src's input, where its sample voices write.
    Synth.new(S, 'poptart_lfo_square_ar', ['out', src.inBus.index, 'lo', 0.25, 'hi', 0.25], src.voices, 'addToHead');
    // dst reads src: its feed reader writes dst's input, and dst sits a level deeper.
    E.dispatch('/poptart/setAudioInput', ['dst', 'src']);
    for (let i = 0; i < 50 && !E.sidechainByTarget.get(E.scKey('dst', 0)); i++) await wait(0.02);
    assert.ok(E.sidechainByTarget.get(E.scKey('dst', 0)), 'the route is wired');
    await S.sync();
    const levels = await tree(S, E.levelGroups[1].nodeID);
    assert.deepEqual(levels.children.map((c) => c.id), [dst.group.nodeID], 'the reader runs a level after its source');
    let cap = await captureBus(S, dst.chainIn.index, 0.25, { target: E.recGroup });
    let mid = Math.floor(cap.frames / 2);
    assert.ok(Math.abs(cap.at(0, mid) - 0.25) < 1e-5, `dst hears src through the route (${cap.at(0, mid)})`);

    // A send to a named bus, and a third track reading it.
    E.dispatch('/poptart/setBusSends', ['src', 'mix', 0.5, 0]);
    E.dispatch('/poptart/createTrack', ['bus', 'dry', 0]);
    const reader = await trackOf(E, 'bus');
    E.dispatch('/poptart/setAudioInput', ['bus', 'bus:mix']);
    for (let i = 0; i < 50 && !E.sidechainByTarget.get(E.scKey('bus', 0)); i++) await wait(0.02);
    await S.sync();
    // The send is post-fader, at 0.5 - and the fader and deck are unity, so 0.125.
    cap = await captureBus(S, reader.chainIn.index, 0.25, { target: E.recGroup });
    mid = Math.floor(cap.frames / 2);
    assert.ok(Math.abs(cap.at(0, mid) - 0.125) < 1e-5, `the bus reader hears the send (${cap.at(0, mid)})`);
    assert.equal(E.namedBuses.get('mix').refs, 2, 'one ref for the writer, one for the reader');

    // One of poptart's own devices into slot 1 of dst, as OscEngine sends it.
    if (E.hasNativeDevices) {
      const filter = nativeDevice('Filter');
      E.dispatch('/poptart/loadDevice', ['dst', 1, filter.id, ...deviceParamArgs(filter)]);
      const slot = await toldWhen(told, '/poptart/ids/slot', (a) => a[0] === 'dst' && a[1] === 1 && a[3] === 1);
      assert.equal(slot.args[6], 1, 'the slot says it holds a native device');
      assert.equal(dst.loaded.get(1), filter.id);
      // Re-sending the same chain leaves the open device alone.
      const before = told.length;
      E.dispatch('/poptart/loadDevice', ['dst', 1, filter.id, ...deviceParamArgs(filter)]);
      await wait(0.1);
      assert.ok(!told.slice(before).some((m) => m.address === '/poptart/ids/slot'), 'an open device is not opened again');
      E.dispatch('/poptart/unloadEffect', ['dst', 1]);
      await toldWhen(told, '/poptart/ids/slot', (a) => a[0] === 'dst' && a[1] === 1 && a[2] === 0);
      assert.equal(dst.nodes.get(1), undefined, 'a slot the chain does not run through goes with its controller');
    }

    // Taking dst down hands back its nodes, its buses, and the route out of src.
    const nodesBefore = (await S.request(['/status'], '/status.reply'))[2];
    E.dispatch('/poptart/destroyTrack', ['dst']);
    await toldWhen(told, '/poptart/ids/trackGone', (a) => a[0] === 'dst');
    await S.sync();
    const nodesAfter = (await S.request(['/status'], '/status.reply'))[2];
    assert.ok(nodesAfter < nodesBefore, `synths freed (${nodesBefore} -> ${nodesAfter})`);
    assert.equal(E.tracks.get('dst'), undefined);
    assert.equal(E.sourceFeeds.get('src'), undefined, "src's feed goes with its last reader");
    assert.ok(!S.audioBuses.isUsed(dst.chainIn.index) && !S.audioBuses.isUsed(dst.inBus.index), 'its buses are given back');
  } finally {
    await quit();
  }
});

test('a track born with DJ-stage values comes up wearing them', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { S, E, quit } = await bootEngine({ port: 57477, sections: SECTIONS });
  try {
    E.dispatch('/poptart/createTrack', ['deck', 'dry', 0, 'trim', 0.5, 'deck', 0]);
    const tr = await trackOf(E, 'deck');
    await S.sync();
    assert.ok(tr.dj, 'the DJ stage is made at birth when born touched');
    const q = await S.request(['/s_get', tr.dj.nodeID, 'trim'], '/n_set', (a) => a[0] === tr.dj.nodeID);
    assert.ok(Math.abs(q[2] - 0.5) < 1e-6);
    const s = await S.request(['/s_get', tr.synth.nodeID, 'deck', 'direct'], '/n_set', (a) => a[0] === tr.synth.nodeID);
    assert.deepEqual([s[2], s[4]], [0, 0], 'the strip is born at deck 0 and hands its output to the DJ stage');
  } finally {
    await quit();
  }
});

// Small, free-standing plugins, in order of preference - never Native Instruments.
const EFFECTS = ['Safety Limiter', 'Diopser', 'OTT'];
const SYNTHS = ['TAL BassLine 101', 'Vital'];

function pickPlugin(list, names, synth) {
  const fs = require('node:fs');
  for (const n of names) {
    const d = list.find((x) => x.name === n && !!x.synth === synth && !x.bridged
      && !/native instruments/i.test(x.vendor ?? '') && x.path && fs.existsSync(x.path));
    if (d) return d;
  }
  return null;
}

test('a plugin opens into an instrument and an effect slot, once, and an unload closes it', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { VstHost } = require('./server/vst');
  const cache = [...new Set(new VstHost({ send() {} }, { warn() {} }).readPlugins().values())];
  const effect = pickPlugin(cache, EFFECTS, false);
  const synth = pickPlugin(cache, SYNTHS, true);
  if (!effect && !synth) { t.skip('no small plugin in the scan cache'); return; }
  const env = await bootEngine({ port: 57478, sections: SECTIONS });
  const { S, E, told, quit } = env;
  try {
    E.vst = new VstHost(S, { post: (x) => E.post(x), warn: (x) => E.warn(x) });
    E.vst.dict = E.vst.readPlugins();
    E.dispatch('/poptart/createTrack', ['vst', 'dry', 0]);
    const tr = await trackOf(E, 'vst');
    if (synth) {
      E.dispatch('/poptart/loadInstrument', ['vst', synth.name]);
      await toldWhen(told, '/poptart/ids/slot', (a) => a[0] === 'vst' && a[1] === 0 && a[3] === 1, 30000);
      assert.equal(tr.loaded.get(0), synth.name);
      assert.match(env.output, new RegExp(`poptart: loaded instrument ${synth.name}`));
    }
    if (effect) {
      E.dispatch('/poptart/loadEffect', ['vst', effect.name, 1]);
      const slot = await toldWhen(told, '/poptart/ids/slot', (a) => a[0] === 'vst' && a[1] === 1 && a[3] === 1, 30000);
      assert.equal(slot.args[6], 0, 'a plugin slot is not a native device');
      await S.sync();
      const q = await S.request(['/s_get', tr.nodes.get(1).nodeID, 'active', 'native'], '/n_set', (a) => a[0] === tr.nodes.get(1).nodeID);
      assert.deepEqual([q[2], q[4]], [1, 0], 'the slot is un-bypassed on its plugin half');
      // The same chain again: nothing reopens.
      const n = told.length;
      E.dispatch('/poptart/loadEffect', ['vst', effect.name, 1]);
      await wait(0.2);
      assert.ok(!told.slice(n).some((m) => m.address === '/poptart/ids/slot'));
      // The chain stops naming the slot: bypassed, closed, its node and controller gone.
      E.dispatch('/poptart/unloadEffect', ['vst', 1]);
      await toldWhen(told, '/poptart/ids/slot', (a) => a[0] === 'vst' && a[1] === 1 && a[2] === 0 && a[3] === 0);
      assert.match(env.output, new RegExp(`poptart: unloaded effect ${effect.name} from slot 1`));
      assert.equal(tr.nodes.get(1), undefined);
    }
    // A name nothing knows fails and says so, and clears the slot's claim so the next eval retries.
    E.dispatch('/poptart/loadEffect', ['vst', 'No Such Plugin Anywhere', 2]);
    for (let i = 0; i < 200 && !/FAILED to load effect 'No Such Plugin Anywhere'/.test(env.output); i++) await wait(0.05);
    assert.match(env.output, /FAILED to load effect 'No Such Plugin Anywhere'/);
    assert.equal(tr.wanted.get(2), undefined);
  } finally {
    await quit();
  }
});
