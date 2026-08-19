'use strict';

// What the server does about a slot the editor's preset panel is HOLDING - the two things that
// have to be true for the panel to be usable while a `.preset("<a b>")` plays.
//
// 1. The highlight grid's whole promise is that it lights what you are HEARING - it is computed from
// the same steps the scheduler plays, rather than guessed from the source text. A slot held by the
// preset panel is the one place that promise can be broken: the pattern still says `<a b>` and
// still has a step grid, but the plugin is sitting on whichever preset the panel is showing. Left
// alone, the editor would light a, then b, then a while the sound never changed once.
//
// 2. The hold is a LEASE the editor renews on its 500ms poll, so a closed tab releases the slot
// rather than freezing it forever. Renewing has to be inert: taking a hold LOADS the preset, and
// doing that on a heartbeat pushes whatever the store currently holds - which, in the window
// between auto-pin capturing a program and the evaluation that files it, is the OLD one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// patternSigs is internal to server.js (which spawns an engine on require), so it is read out of
// the source and evaluated on its own - the same trick param-mapping.test.js uses for the
// scheduler's tables. What is under test is the filter, which needs nothing else.
function loadPatternSigs() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const at = src.indexOf('function patternSigs(');
  assert.ok(at > 0, 'patternSigs not found in server.js - this test needs updating');
  let depth = 0;
  let end = src.indexOf('{', at);
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(at, end)}; return patternSigs;`)();
}

const patternSigs = loadPatternSigs();

// Only the fields patternSigs reads. The preset patterns are marked so they can be told apart.
const track = () => ({
  paramSignals: {},
  channel: {},
  presetPatterns: { 0: { name: 'slot0names' }, 1: { name: 'slot1names' } },
});

const names = (sigs) => sigs.map((s) => s.name).filter(Boolean);

test('preset names are lit like any other pattern when nothing is held', () => {
  assert.deepEqual(names(patternSigs(track(), null)), ['slot0names', 'slot1names']);
});

test('a held slot lights nothing - the pattern is not what is playing there', () => {
  assert.deepEqual(names(patternSigs(track(), new Set([0]))), ['slot1names']);
});

test('holding one slot leaves the rest of the chain alone', () => {
  assert.deepEqual(names(patternSigs(track(), new Set([1]))), ['slot0names']);
  assert.deepEqual(names(patternSigs(track(), new Set([0, 1]))), []);
});

test('the track pattern itself is always in, held or not', () => {
  const sig = track();
  assert.ok(patternSigs(sig, new Set([0, 1])).includes(sig), 'the notes go on playing while a slot is held');
});

test('a patterned lfo shape still lights alongside', () => {
  const shapePattern = { name: 'shapes' };
  const sig = { ...track(), paramSignals: { Cutoff: { name: 'cutoff', lfoIR: { shapePattern } } } };
  assert.deepEqual(names(patternSigs(sig, new Set([0]))), ['cutoff', 'shapes', 'slot1names']);
});

// ---------------------------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------------------------

// setPresetHold closes over module state (presetHolds, schedulers), so it is lifted out of the
// source and given its own - server.js spawns an engine on require and can't be imported here.
function loadHoldFns() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const take = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
    let depth = 0;
    let end = src.indexOf('{', at);
    for (let i = end; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    return src.slice(at, end);
  };
  const presetHolds = new Map();
  const schedulers = new Map();
  const ttl = /const PRESET_HOLD_TTL_MS = (\d+)/.exec(src);
  assert.ok(ttl, 'PRESET_HOLD_TTL_MS not found in server.js');
  // eslint-disable-next-line no-new-func
  const make = new Function('presetHolds', 'schedulers', 'PRESET_HOLD_TTL_MS',
    `${take('setPresetHold')}\n${take('expirePresetHolds')}\nreturn { setPresetHold, expirePresetHolds };`);
  return { presetHolds, schedulers, ...make(presetHolds, schedulers, Number(ttl[1])), ttl: Number(ttl[1]) };
}

// Records every hold/release the Scheduler is actually asked to perform. holdPreset() LOADS a
// preset into the plugin, so each call here is a program change you would hear.
function fakeScheduler() {
  const calls = [];
  return { calls, holdPreset: (slot, name) => { calls.push([slot, name]); return null; } };
}

test('taking a hold loads the preset', () => {
  const { setPresetHold, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  setPresetHold('lead', 0, 'a');
  assert.deepEqual(sch.calls, [[0, 'a']]);
});

test('renewing an unchanged lease loads nothing', () => {
  const { setPresetHold, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  setPresetHold('lead', 0, 'a');
  for (let poll = 0; poll < 20; poll++) setPresetHold('lead', 0, 'a'); // ten seconds of heartbeat
  assert.deepEqual(sch.calls, [[0, 'a']], 'the heartbeat is inert - it must not push the store at the plugin');
});

test('a renewal after a capture cannot push the pre-capture program back', () => {
  // The bug this exists for: auto-pin captures a new program out of the plugin, and for the ~150ms
  // until the evaluation files it, the preset STORE still holds the old one. A renewal that loaded
  // from the store in that window made the plugin jump back to the old sound and then return.
  const { setPresetHold, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  setPresetHold('lead', 0, 'a');
  sch.calls.length = 0;
  setPresetHold('lead', 0, 'a'); // the poll that used to land inside that window
  assert.deepEqual(sch.calls, [], 'nothing is loaded, so there is nothing to jump back to');
});

test('moving the hold to another preset does load it', () => {
  const { setPresetHold, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  setPresetHold('lead', 0, 'a');
  setPresetHold('lead', 0, 'b');
  assert.deepEqual(sch.calls, [[0, 'a'], [0, 'b']], 'picking one in the panel is what makes you hear it');
});

test('releasing hands the slot back, and re-taking it loads again', () => {
  const { setPresetHold, schedulers, presetHolds } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  setPresetHold('lead', 0, 'a');
  setPresetHold('lead', 0, null);
  assert.equal(presetHolds.size, 0, 'the lease is gone');
  setPresetHold('lead', 0, 'a');
  assert.deepEqual(sch.calls, [[0, 'a'], [0, null], [0, 'a']], 'a hold taken afresh is not a renewal');
});

test('a lease the editor stops renewing expires, releasing the slot', () => {
  const { setPresetHold, expirePresetHolds, schedulers, presetHolds, ttl } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  setPresetHold('lead', 0, 'a');
  expirePresetHolds();
  assert.equal(presetHolds.size, 1, 'a fresh lease survives');

  presetHolds.get('lead|0').at -= ttl + 1; // the tab closed with the panel open
  expirePresetHolds();
  assert.equal(presetHolds.size, 0);
  assert.deepEqual(sch.calls.at(-1), [0, null], 'and the pattern gets its slot back');
});

test('a track whose label contains a pipe still addresses one slot', () => {
  const { setPresetHold, expirePresetHolds, schedulers, presetHolds, ttl } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('a|b', sch);

  setPresetHold('a|b', 2, 'x');
  presetHolds.get('a|b|2').at -= ttl + 1;
  expirePresetHolds();
  assert.deepEqual(sch.calls.at(-1), [2, null], 'the key splits at the LAST pipe, not the first');
});
