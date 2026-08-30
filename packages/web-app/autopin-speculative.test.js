'use strict';

// Auto-pin's SPECULATIVE capture: asking a plugin for its program without having been told it
// changed.
//
// Some plugins never tell. Omnisphere rewrites its whole program from its own editor and emits
// none of the events VSTPlugin forwards, so the normal trigger never fires and a sound designed in
// it exists nowhere but the plugin. The fix is to ask - on the browser regaining focus, and on the
// click in the code that hands a held slot back - which is only affordable because the answer is
// comparable: a program identical to the last one seen from that slot stops right there.
//
// What is under test is that comparison and who gets asked. Both are the difference between "we
// pinned a sound the plugin never mentioned" and "every alt-tab rewrites your buffer with the
// preset your pattern is playing".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// server.js spawns an engine on require, so the functions under test are read out of its source
// and evaluated on their own with mocks for everything they close over - the same trick
// preset-holds.test.js uses for patternSigs.
function loadAutopin(deps) {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const grab = (signature) => {
    const at = src.indexOf(signature);
    assert.ok(at > 0, `${signature} not found in server.js - this test needs updating`);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`could not find the end of ${signature}`);
  };
  const body = [
    grab('function stateHandle('),
    grab('function markSlotDirty('),
    grab('function captureOpenEditors('),
    grab('async function captureDirtyPlugins('),
  ].join('\n\n');
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn { markSlotDirty, captureOpenEditors, captureDirtyPlugins, stateHandle };`)(
    ...names.map((n) => deps[n]),
  );
}

const handleOf = (state) => `@${crypto.createHash('sha256').update(String(state), 'utf8').digest('hex').slice(0, 12)}`;

// One track, one plugin in slot 0, and enough of the server's bookkeeping to run a capture pass.
function harness({ program = 'PROGRAM-A', applied, mode = 'immediate' } = {}) {
  const state = { program };
  const scheduler = {
    applied: new Map(applied ? [['0:Omnisphere', applied]] : []),
    marked: [],
    livePreset: () => null,
    appliedState: (slot, plugin) => scheduler.applied.get(`${slot}:${plugin}`),
    markStateApplied: (slot, plugin, s) => scheduler.marked.push([slot, plugin, s]),
  };
  const deps = {
    engine: { getPluginState: async () => state.program },
    mappedEngine: { chains: new Map([['t1', ['Omnisphere']]]) },
    blobs: { putBlob: async (text) => handleOf(text), blobId: (text) => handleOf(text).slice(1) },
    schedulers: new Map([['pad', scheduler]]),
    autoPinDirty: new Map(),
    autoPinReady: new Map(),
    uncaptured: new Map(),
    lastCapturedState: new Map(),
    handTaken: new Set(),
    autoPinTimer: null,
    noteHandEdit: (key) => { deps.uncaptured.set(key, { seq: 1, at: Date.now() }); froze.push(key); },
    syncStateHold: () => {},
    pluginInSlot: (trackId, slot) => deps.mappedEngine.chains.get('t1')?.[slot] ?? null,
    engineTrack: () => 't1',
    deckOfKey: (key) => (key.startsWith('b:') ? 'b' : 'a'),
    AUTOPIN_MODE: mode,
    AUTOPIN_SLOW_MS: 50,
    AUTOPIN_DEBOUNCE_MS: 400,
    transport: { paused: true },
    flushPluginCaptures: () => {},
    // Timers are the debounce, not the behaviour under test: the pass is driven by hand here.
    setTimeout: () => null,
    clearTimeout: () => {},
    console: { log: (line) => logs.push(line) },
  };
  const froze = [];
  const logs = [];
  return { ...loadAutopin(deps), deps, scheduler, state, froze, logs };
}

test('a plugin that reports nothing still gets pinned: an unreported edit reads as an edit', async () => {
  const h = harness({ program: 'PROGRAM-A' });
  h.deps.handTaken.add('pad|0');

  // First look: nothing has ever been captured from this slot and the pattern never pushed
  // anything into it, so whatever it holds is news.
  h.captureOpenEditors();
  await h.captureDirtyPlugins();
  assert.equal(h.deps.autoPinReady.get('pad|0')?.state, handleOf('PROGRAM-A'));
  assert.deepEqual(h.froze, ['pad|0'], 'an unreported edit must freeze the slot like a reported one');

  // Somebody turns a knob in a plugin that will never say so, and comes back to the browser.
  h.deps.autoPinReady.clear();
  h.state.program = 'PROGRAM-B';
  h.captureOpenEditors();
  await h.captureDirtyPlugins();
  assert.equal(h.deps.autoPinReady.get('pad|0')?.state, handleOf('PROGRAM-B'));
});

test('an untouched plugin is invisible: no write, no freeze, no log line', async () => {
  const h = harness({ program: 'PROGRAM-A' });
  h.deps.handTaken.add('pad|0');
  h.captureOpenEditors();
  await h.captureDirtyPlugins();
  h.deps.autoPinReady.clear();
  h.froze.length = 0;

  // Alt-tab, alt-tab, alt-tab. Each one asks the plugin and each one gets the same bytes back.
  for (let i = 0; i < 3; i++) {
    h.captureOpenEditors();
    await h.captureDirtyPlugins();
  }
  assert.equal(h.deps.autoPinReady.size, 0, 'an unchanged program must not be written into the code');
  assert.deepEqual(h.froze, [], 'and must not freeze the slot away from its pattern');
  assert.deepEqual(h.logs, []);
});

test('the program a pattern pushed in is not mistaken for something you dialled in', async () => {
  // The dangerous case: a slot whose `.preset(...)` loaded a program poptart has never captured.
  // Compared only against past captures, the first speculative one would file the pattern's own
  // sound back into the code as a hand-made edit.
  const h = harness({ program: 'PRESET-LEAD', applied: 'PRESET-LEAD' });
  h.deps.handTaken.add('pad|0');
  h.captureOpenEditors();
  await h.captureDirtyPlugins();
  assert.equal(h.deps.autoPinReady.size, 0);
  assert.deepEqual(h.froze, []);
});

test('...including a preset the scheduler holds in full, not as a handle', async () => {
  // States reach the scheduler as handles from the buffer and in full from a saved or shared file.
  // Both have to compare equal to a capture of the same program, which is what content-addressing
  // buys - stateHandle is where that is cashed in.
  const h = harness({ program: 'PRESET-LEAD', applied: handleOf('PRESET-LEAD') });
  h.deps.handTaken.add('pad|0');
  h.captureOpenEditors();
  await h.captureDirtyPlugins();
  assert.equal(h.deps.autoPinReady.size, 0);
});

test('a reported edit is never downgraded to a speculative one', async () => {
  // The report carries the preset that was live AT the gesture and has already frozen the slot;
  // a focus event landing on top of it must not be able to drop either, nor to let the capture
  // fall out on an "unchanged" comparison the report has no business losing.
  const h = harness({ program: 'PROGRAM-A' });
  h.deps.lastCapturedState.set('pad|0', handleOf('PROGRAM-A'));
  h.deps.handTaken.add('pad|0');
  h.markSlotDirty('pad', 0, false);
  h.captureOpenEditors();
  assert.equal(h.deps.autoPinDirty.get('pad|0').speculative, false);
  await h.captureDirtyPlugins();
  assert.equal(h.deps.autoPinReady.get('pad|0')?.state, handleOf('PROGRAM-A'));
});

test('the queued deck is left alone here too', async () => {
  const h = harness();
  h.deps.handTaken.add('b:pad|0');
  assert.equal(h.captureOpenEditors(), 0);
  assert.equal(h.deps.autoPinDirty.size, 0);
});

test('a slot that changed hands since the ask is dropped quietly', async () => {
  const h = harness({ program: 'PROGRAM-A' });
  h.deps.handTaken.add('pad|0');
  h.captureOpenEditors();
  h.deps.mappedEngine.chains.set('t1', ['Serum']); // the chain was rewritten before the pass ran
  await h.captureDirtyPlugins();
  assert.equal(h.deps.autoPinReady.size, 0);
  assert.deepEqual(h.logs, [], 'nobody asked for this capture, so its dead end is not news');
});
