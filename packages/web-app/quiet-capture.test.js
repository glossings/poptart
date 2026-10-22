'use strict';

// Deferred auto-pin over a long set. A plugin edit made while the clock runs is held in the plugin
// (a capture suspends it, which drops its notes), and only a stop or a save used to write it into
// the code - so an hour without either was an hour of sound design a crash would take, and a
// rename stranded it under a name the buffer no longer had. These pin the two fixes: a held slot is
// captured as soon as its track is quiet (stopped, or turned all the way down - a controller's
// midicc() mute included), and a renamed track takes its track, held edits and all, with the name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function grab(signature) {
  const at = SRC.indexOf(signature);
  assert.ok(at > 0, `${signature} not found in server.js - this test needs updating`);
  let depth = 0;
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${signature}`);
}

const constant = (name) => {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(SRC);
  assert.ok(m, `${name} not found in server.js`);
  return `const ${name} = ${m[1]};`;
};

function load(deps) {
  const body = [
    constant('QUIET_LEVEL'),
    constant('QUIET_TAIL_MS'),
    constant('QUIET_INSTRUMENT_MS'),
    grab('function trackQuiet('),
    grab('function quietCaptureTick('),
    grab('function followTrackRenames('),
  ].join('\n\n');
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn { trackQuiet, quietCaptureTick, followTrackRenames };`)(
    ...names.map((n) => deps[n]),
  );
}

// A track whose channel controls read whatever `levels` says right now, as a midicc() would.
function fakeScheduler(levels = {}, running = true) {
  return { running, channelNow: (name) => (name in levels ? levels[name] : 1) };
}

function harness({ dirty = [['bass|0', { trackId: 'bass', slot: 0 }]], tracks = { bass: fakeScheduler() } } = {}) {
  const clock = { now: 0 };
  const captured = [];
  const deps = {
    AUTOPIN_MODE: 'deferred',
    engine: {},
    transport: { paused: false },
    autoPinDirty: new Map(dirty),
    quietSince: new Map(),
    bufferKeys: { a: new Set(Object.keys(tracks)), b: new Set() },
    schedulers: new Map(Object.entries(tracks)),
    mixState: { dj: false, perTrack: new Map(), faders: { a: 1, b: 1 } },
    groupMembers: new Map(),
    mixGroupChain: (key) => {
      const out = [];
      for (let at = deps.groupMembers.get(key); at != null; at = deps.groupMembers.get(at)) out.push(at);
      return out;
    },
    deckXfGain: () => 1,
    deckOfKey: (key) => (key.startsWith('b:') ? 'b' : 'a'),
    // The pass captures what `which` says yes to and takes it off the dirty list, as the real one does.
    captureDirtyPlugins: async (which) => {
      for (const k of [...deps.autoPinDirty.keys()]) {
        if (which(k)) { deps.autoPinDirty.delete(k); captured.push(k); }
      }
    },
    autoPinRun: null,
    autoPinRunAll: false,
    Date: { now: () => clock.now },
    console: { log: () => {} },
    // followTrackRenames
    lastEvalBlocks: { a: null, b: null },
    trackIds: new Map(),
    rekeyTrack: (from, to) => { deps.rekeyed.push([from, to]); deps.trackIds.set(to, deps.trackIds.get(from)); deps.trackIds.delete(from); },
    rekeyed: [],
    eventLogQueue: [],
  };
  const api = load(deps);
  // A tick, then the capture pass it started - which the real one leaves in flight.
  const tickAt = async (ms) => {
    clock.now = ms;
    api.quietCaptureTick();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { ...api, deps, captured, tickAt };
}

test('an instrument behind a closed gain is captured once the gain has stayed shut briefly', async () => {
  const levels = { gain: 1 };
  const h = harness({ tracks: { bass: fakeScheduler(levels) } });
  await h.tickAt(0);
  assert.deepEqual(h.captured, [], 'heard: held');
  levels.gain = 0; // the Twister's mute
  await h.tickAt(100);
  await h.tickAt(400);
  assert.deepEqual(h.captured, [], 'not yet quiet for long enough');
  await h.tickAt(700);
  assert.deepEqual(h.captured, ['bass|0']);
});

test('turning the track back up before the wait is over keeps it held, and starts the wait over', async () => {
  const levels = { gain: 0 };
  const h = harness({ tracks: { bass: fakeScheduler(levels) } });
  await h.tickAt(0);
  levels.gain = 0.8;
  await h.tickAt(300);
  levels.gain = 0;
  await h.tickAt(600);
  assert.deepEqual(h.captured, []);
  await h.tickAt(1200);
  assert.deepEqual(h.captured, ['bass|0']);
});

test('an effect behind a closed gain, and anything on a stopped track, waits out the tails', async () => {
  const h = harness({
    dirty: [['bass|2', { trackId: 'bass', slot: 2 }], ['pad|0', { trackId: 'pad', slot: 0 }]],
    tracks: { bass: fakeScheduler({ postgain: 0 }), pad: fakeScheduler({}, false) },
  });
  await h.tickAt(0);
  await h.tickAt(1000);
  assert.deepEqual(h.captured, []);
  await h.tickAt(3100);
  assert.deepEqual(h.captured.sort(), ['bass|2', 'pad|0']);
});

test('a muted track has no scheduler at all, and counts as stopped', () => {
  const h = harness({ tracks: {} });
  assert.equal(h.trackQuiet('bass'), 'stopped');
});

test('a closed group, desk fader or crossfade silences what plays through it', () => {
  const h = harness({ tracks: { kick: fakeScheduler(), drums: fakeScheduler({ gain: 0 }), hat: fakeScheduler() } });
  h.deps.groupMembers.set('kick', 'drums');
  assert.equal(h.trackQuiet('kick'), 'silenced');
  assert.equal(h.trackQuiet('hat'), null);
  h.deps.mixState.perTrack.set('hat', new Map([['fader', 0]]));
  assert.equal(h.trackQuiet('hat'), 'silenced');
  h.deps.mixState.perTrack.clear();
  h.deps.mixState.dj = true;
  h.deps.deckXfGain = () => 0;
  const again = load(h.deps);
  assert.equal(again.trackQuiet('hat'), 'silenced', 'the crossfade is all the way to the other deck');
});

test('nothing is captured while the clock is stopped (it already captures at once), or for a track the code no longer has', async () => {
  const h = harness({ tracks: { bass: fakeScheduler({ gain: 0 }) } });
  h.deps.bufferKeys.a = new Set();
  await h.tickAt(0);
  await h.tickAt(5000);
  assert.deepEqual(h.captured, [], 'nowhere to write it');
  const p = harness({ tracks: { bass: fakeScheduler({ gain: 0 }) } });
  p.deps.transport.paused = true;
  await p.tickAt(0);
  await p.tickAt(5000);
  assert.deepEqual(p.captured, []);
});

test('a renamed track takes its track with it', () => {
  const h = harness();
  h.deps.trackIds.set('bass', '#1');
  h.followTrackRenames('a', [{ key: 'bass', body: 'note("c2").synth("Serum 2")' }], false);
  h.followTrackRenames('a', [{ key: 'sub', body: 'note("c2").synth("Serum 2")' }], false);
  assert.deepEqual(h.deps.rekeyed, [['bass', 'sub']]);
});

test('a rename that also changed the body, or two blocks that could be it, is left alone - and said, with edits held', () => {
  const h = harness();
  h.deps.trackIds.set('bass', '#1');
  h.followTrackRenames('a', [{ key: 'bass', body: 'x' }], false);
  h.followTrackRenames('a', [{ key: 'sub', body: 'y' }], false);
  assert.deepEqual(h.deps.rekeyed, []);
  assert.match(h.deps.eventLogQueue.join('\n'), /\[bass\] is gone from the code with plugin edits not yet written/);

  const two = harness({ dirty: [] });
  two.deps.trackIds.set('bass', '#1');
  two.followTrackRenames('a', [{ key: 'bass', body: 'x' }], false);
  two.followTrackRenames('a', [{ key: 'sub', body: 'x' }, { key: 'low', body: 'x' }], false);
  assert.deepEqual(two.deps.rekeyed, []);
  assert.deepEqual(two.deps.eventLogQueue, [], 'nothing held, nothing to say');
});

test('a newly opened buffer renames nothing', () => {
  const h = harness();
  h.deps.trackIds.set('bass', '#1');
  h.followTrackRenames('a', [{ key: 'bass', body: 'x' }], false);
  h.followTrackRenames('a', [{ key: 'sub', body: 'x' }], true);
  assert.deepEqual(h.deps.rekeyed, []);
});

test('the quiet pass runs beside a flush without answering for it', () => {
  // A flush asked for while a quiet-only pass is in flight has to run after it, not be handed its
  // promise - that pass skipped every slot whose track was playing.
  const flush = grab('function flushPluginCaptures(');
  assert.match(flush, /if \(!autoPinRun \|\| !autoPinRunAll\)/);
  assert.match(grab('function quietCaptureTick('), /autoPinRunAll = false;/);
});
