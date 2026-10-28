'use strict';

// Audio patched onto a parameter: wireParamRoute / unwireParamRoute / applyParamRoute and the
// route's place in trackLevels (engine/routing.js, engine/tracks.js). What has to hold:
//
//   - a route onto one of poptart's own devices maps the source's feed onto the control, with the
//     gain and offset it rode in on, and orders the source ahead of the track that reads it;
//   - unpatching takes the control off the bus, puts it back on the value last set, releases the
//     source's feed, and the order relaxes again;
//   - a plugin's slot cannot take one - it is warned about once, not connected, and held;
//   - a route dropped before its wiring got going (two evaluations in a row) never lands;
//   - a named bus works as a source the way a track does.
//
// Run on the engine with no server behind it (test-support/fake-engine.js) and mock controllers.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');

let paramsSection = true;
try { require.resolve('./engine/params'); } catch { paramsSection = false; }

// A device controller (mapAudio) or a plugin's (none), logging what it is asked.
function mockCtl(native) {
  const c = {
    log: [],
    info: { findParamIndex: (n) => ({ level: 4, cutoff: 3 })[n] ?? null, parameters: [] },
    map(i, bus) { c.log.push(['map', i, bus]); },
    unmap(i) { c.log.push(['unmap', i]); },
    get(i, action) { action(0.25); },
    set(i, v) { c.log.push(['set', i, v]); },
  };
  if (native) {
    c.mapAudio = (index, bus, gain, offset) => c.log.push(['mapAudio', index, typeof bus === 'object' ? bus.index : bus, gain, offset]);
    c.unmapAudio = (index) => c.log.push(['unmapAudio', index]);
  }
  return c;
}

const mkTrack = (ctl, loaded, born) => ({
  controllers: new Map(ctl ? [[0, ctl]] : []), loaded: new Map(loaded ? [[0, loaded]] : []),
  envs: new Map(), born, group: { nodeID: 1, moveToHead() {} },
});

test('a parameter route is wired, ordered, refused on a plugin and unwired as the engine expects', async () => {
  const { E } = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', ...(paramsSection ? ['params'] : [])] });
  if (!E.paramTarget) {
    // The control branch of paramTarget (engine/params.js), for a run without that section.
    E.paramTarget = (track, slot, name, index) => {
      const ctl = track.controllers.get(slot);
      const at = index ?? (ctl?.info ? E.resolveParamIndex(ctl.info, name) : null);
      if (!ctl || at == null) return null;
      const native = typeof ctl.mapAudio === 'function';
      return {
        kind: 'control', index: at, audio: native,
        mapAudio: native ? (bus, gain = 1, offset = 0) => ctl.mapAudio(at, bus, gain, offset) : null,
        unmapAudio: native ? () => { ctl.unmapAudio(at); ctl.get(at, (v) => ctl.set(at, v)); } : null,
      };
    };
  }
  const drops = [];
  E.dropRamp = (key, track, rampKey) => drops.push(rampKey);
  const feeds = new Map();
  const released = [];
  const buses = [];
  E.acquireSourceFeed = (key) => { feeds.set(key, (feeds.get(key) ?? 0) + 1); return 100; };
  E.releaseSourceFeed = (key) => released.push(key);
  E.acquireBus = (name) => { buses.push(String(name)); return 200; };
  E.releaseBus = (name) => buses.push(`-${name}`);
  E.namedBuses.set('mix', { bus: 200, refs: 1 });
  const native = mockCtl(true);
  const plugin = mockCtl(false);
  E.tracks.set('src', mkTrack(null, null, 1));
  E.tracks.set('t1', mkTrack(native, 'Noise', 2));
  E.tracks.set('t2', mkTrack(plugin, 'Serum 2', 3));

  // 1. A track source onto a native device's control.
  await E.wireParamRoute('t1', 0, 'level', 'src', 0.5, 0.25);
  assert.deepEqual(native.log, [['mapAudio', 4, 100, 0.5, 0.25]]);
  assert.equal(feeds.get('src'), 1);
  assert.deepEqual(drops, ['slot0_level'], 'a ramp left by a polled value should go');
  let levels = E.trackLevels();
  assert.deepEqual([levels.get('src'), levels.get('t1')], [0, 1], 'the source has to run before the track that reads it');
  // 2. Unpatched: off the bus, back on the value last set, the feed released.
  native.log.length = 0;
  E.unwireParamRoute('t1', 0, 'level');
  assert.deepEqual(native.log, [['unmapAudio', 4], ['set', 4, 0.25]]);
  assert.deepEqual(released, ['src']);
  assert.equal(E.paramRoutes.size, 0);
  levels = E.trackLevels();
  assert.equal(levels.get('t1'), 0);
  // 3. A plugin's slot: held, warned about, not connected.
  await E.wireParamRoute('t2', 0, 'cutoff', 'src', 1, 0);
  E.applyParamRoute(E.tracks.get('t2'), E.paramRoutes.get(E.paramRouteKey('t2', 0, 'cutoff')));
  assert.deepEqual(plugin.log, [], 'a plugin parameter must not be sent an audio map');
  assert.ok(E.paramRoutes.get(E.paramRouteKey('t2', 0, 'cutoff')));
  E.unwireParamRoute('t2', 0, 'cutoff');
  // 4. Dropped before its wiring ran: never lands.
  native.log.length = 0;
  feeds.clear();
  const p = E.wireParamRoute('t1', 0, 'level', 'src', 1, 0);
  E.unwireParamRoute('t1', 0, 'level');
  await p;
  assert.deepEqual([native.log, feeds.get('src'), E.paramRoutes.size], [[], undefined, 0]);
  // 5. A named bus as the source.
  await E.wireParamRoute('t1', 0, 'cutoff', 'bus:mix', 2, 0);
  assert.deepEqual(native.log, [['mapAudio', 3, 200, 2, 0]]);
  assert.deepEqual(buses, ['mix']);
  E.unwireParamRoute('t1', 0, 'cutoff');
  assert.deepEqual(buses, ['mix', '-mix']);
});

test('the refusal on a plugin is said once, not on every apply', async () => {
  const { E } = fakeEngine();
  E.paramTarget = () => ({ kind: 'control', index: 3, audio: false, mapAudio: null });
  E.acquireSourceFeed = () => 100;
  E.releaseSourceFeed = () => {};
  E.tracks.set('src', mkTrack(null, null, 1));
  E.tracks.set('t2', mkTrack(mockCtl(false), 'Serum 2', 2));
  const run = await fakeOutput(E, async () => {
    await E.wireParamRoute('t2', 0, 'cutoff', 'src', 1, 0);
    E.applyParamRoute(E.tracks.get('t2'), E.paramRoutes.get(E.paramRouteKey('t2', 0, 'cutoff')));
  });
  assert.equal((run.match(/reaches poptart's own devices only/g) ?? []).length, 1);
});

async function fakeOutput(E, fn) {
  let out = '';
  const orig = E._output;
  E._output = (t) => { out += t; orig(t); };
  try { await fn(); } finally { E._output = orig; }
  return out;
}
