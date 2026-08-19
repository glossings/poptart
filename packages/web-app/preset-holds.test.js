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

test('preset names are in the grid like any other pattern', () => {
  assert.deepEqual(names(patternSigs(track())), ['slot0names', 'slot1names']);
});

test('a held slot is NOT filtered out here - the grid says what the pattern says', () => {
  // It used to be, and that is what made holds flicker. A grid is computed in windows of cycles and
  // shipped ahead of the sound; a hold is taken and dropped between two of them. Baking one in left
  // names lit after a hold was taken and dark after one was dropped, until the next evaluation
  // rebuilt the window. The editor suppresses them live instead (client.js's syncHeldPresets), and
  // marks the preset that IS loaded while it does.
  assert.deepEqual(names(patternSigs(track())), ['slot0names', 'slot1names']);
  assert.equal(patternSigs.length, 1, 'patternSigs takes a sig and nothing else');
});

test('the track pattern itself is always in', () => {
  const sig = track();
  assert.ok(patternSigs(sig).includes(sig));
});

test('a patterned lfo shape still lights alongside', () => {
  const shapePattern = { name: 'shapes' };
  const sig = { ...track(), paramSignals: { Cutoff: { name: 'cutoff', lfoIR: { shapePattern } } } };
  assert.deepEqual(names(patternSigs(sig)), ['cutoff', 'shapes', 'slot0names', 'slot1names']);
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
    // Past the parameter list before counting braces: a destructured default (`{ force = false }`)
    // puts a pair of them in the signature, and the body's opening brace is the one that matters.
    let sig = src.indexOf('(', at);
    for (let parens = 0; sig < src.length; sig++) {
      if (src[sig] === '(') parens++;
      else if (src[sig] === ')' && --parens === 0) break;
    }
    let depth = 0;
    let end = src.indexOf('{', sig);
    for (let i = end; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    return src.slice(at, end);
  };
  const num = (name) => {
    const m = new RegExp(`const ${name} = (\\d+)`).exec(src);
    assert.ok(m, `${name} not found in server.js - this test needs updating`);
    return Number(m[1]);
  };
  const presetHolds = new Map();
  const schedulers = new Map();
  const handTaken = new Set();
  const uncaptured = new Map();
  const autoPinDirty = new Map(); // slots whose capture hasn't been taken yet (deferred mode holds them)
  const ttl = num('PRESET_HOLD_TTL_MS');
  const uncapTtl = num('UNCAPTURED_TTL_MS');
  const names = ['stateHeld', 'syncStateHold', 'stateHeldSlotsFor', 'noteHandEdit', 'takeSlotByHand',
    'releaseSlotsHeldByHand', 'commitCapture', 'currentHolds', 'expireStateHolds', 'setPresetHold',
    'expirePresetHolds'];
  // eslint-disable-next-line no-new-func
  const make = new Function('presetHolds', 'schedulers', 'handTaken', 'uncaptured', 'autoPinDirty',
    'PRESET_HOLD_TTL_MS', 'UNCAPTURED_TTL_MS',
    `let editSeq = 0;\n${names.map(take).join('\n')}\nreturn { ${names.join(', ')} };`);
  const fns = make(presetHolds, schedulers, handTaken, uncaptured, autoPinDirty, ttl, uncapTtl);
  return { presetHolds, schedulers, handTaken, uncaptured, autoPinDirty, ttl, uncapTtl, ...fns };
}

// Records every hold/release the Scheduler is actually asked to perform. holdPreset() LOADS a
// preset into the plugin, so each call here is a program change you would hear.
function fakeScheduler() {
  const calls = [];
  const frozen = [];
  return {
    calls,
    frozen, // every holdPluginState the slot is asked for, in order (see the hand-editing tests)
    holdPreset: (slot, name) => { calls.push([slot, name]); return null; },
    holdPluginState: (slot, on) => { frozen.push([slot, on]); },
    livePreset: (slot) => `sounding${slot}`, // what currentHolds reports as loaded there
  };
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

// ---------------------------------------------------------------------------------------------
// Hand editing: freezing the slot whose plugin you are turning knobs in.
//
// The bug: auto-pin captures a program out of the plugin, and until the evaluation that files it,
// the preset store still holds the OLD one - so the pattern's next swap round pushed the pre-tweak
// sound back for a cycle, and the eval put the tweak back the cycle after. Two things hold that
// off, and either alone is enough: the plugin's window being open (a lease the editor renews), and
// a capture that hasn't reached the code yet (released by sequence number).
// ---------------------------------------------------------------------------------------------

test('opening a plugin window takes its slot; a click in the code hands it back', () => {
  const { takeSlotByHand, releaseSlotsHeldByHand, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  takeSlotByHand('lead', 0);
  assert.deepEqual(sch.frozen, [[0, true]]);

  takeSlotByHand('lead', 0); // opening the window again (to bring it to the front) changes nothing
  assert.deepEqual(sch.frozen, [[0, true]]);

  assert.equal(releaseSlotsHeldByHand(), 1);
  assert.deepEqual(sch.frozen.at(-1), [0, false], 'and the pattern swaps it again');

  assert.equal(releaseSlotsHeldByHand(), 0, 'clicking around in the code costs nothing after that');
  assert.equal(sch.frozen.length, 2);
});

test('one click hands back every slot held by hand, not just the last one', () => {
  const { takeSlotByHand, releaseSlotsHeldByHand, schedulers } = loadHoldFns();
  const lead = fakeScheduler();
  const bass = fakeScheduler();
  schedulers.set('lead', lead);
  schedulers.set('bass', bass);

  takeSlotByHand('lead', 0);
  takeSlotByHand('lead', 2);
  takeSlotByHand('bass', 1);
  assert.equal(releaseSlotsHeldByHand(), 3, 'you are in the code now, not in any of them');

  assert.deepEqual(lead.frozen.slice(-2), [[0, false], [2, false]]);
  assert.deepEqual(bass.frozen.at(-1), [1, false]);
});

test('a hold outlives a browser reload - the plugin window is still up', () => {
  // The editor used to lease this on its poll, which meant a reload dropped the hold while the
  // plugin window was still open and still the thing deciding that slot's sound.
  const { takeSlotByHand, expireStateHolds, currentHolds, schedulers } = loadHoldFns();
  schedulers.set('lead', fakeScheduler());

  takeSlotByHand('lead', 0);
  for (let poll = 0; poll < 20; poll++) expireStateHolds(); // ten seconds with nobody renewing
  assert.deepEqual(currentHolds().map((h) => h.why), ['hand']);
});

test('a knob turn freezes the slot until the capture has reached the code', () => {
  const { noteHandEdit, commitCapture, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  const seq = noteHandEdit('lead|0');
  assert.deepEqual(sch.frozen, [[0, true]], 'frozen from the gesture, not from the capture');

  commitCapture({ trackId: 'lead', slot: 0, seq });
  assert.deepEqual(sch.frozen.at(-1), [0, false]);
});

test('committing one capture cannot release a knob turned after it', () => {
  const { noteHandEdit, commitCapture, schedulers, uncaptured } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  const first = noteHandEdit('lead|0');
  noteHandEdit('lead|0'); // touched again while the first capture was being written
  commitCapture({ trackId: 'lead', slot: 0, seq: first });

  assert.equal(uncaptured.has('lead|0'), true, 'the newer edit is still only in the plugin');
  assert.deepEqual(sch.frozen.at(-1), [0, true]);
});

test('either reason alone holds the slot', () => {
  const { noteHandEdit, takeSlotByHand, releaseSlotsHeldByHand, commitCapture, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  takeSlotByHand('lead', 0);
  const seq = noteHandEdit('lead|0');
  commitCapture({ trackId: 'lead', slot: 0, seq }); // written into the code, plugin still yours
  assert.deepEqual(sch.frozen.at(-1), [0, true], 'the plugin is still where the sound is decided');

  releaseSlotsHeldByHand();
  assert.deepEqual(sch.frozen.at(-1), [0, false]);
});

test('a capture that never reaches the code times out rather than freezing the slot for good', () => {
  const { noteHandEdit, expireStateHolds, schedulers, uncaptured, uncapTtl } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  noteHandEdit('lead|0'); // the browser went away before it could write the state
  uncaptured.get('lead|0').at -= uncapTtl + 1;
  expireStateHolds();

  assert.equal(uncaptured.size, 0);
  assert.deepEqual(sch.frozen.at(-1), [0, false]);
});

test('the eval that rebuilds a scheduler re-asserts every frozen slot of that track', () => {
  const { noteHandEdit, takeSlotByHand, stateHeldSlotsFor } = loadHoldFns();
  noteHandEdit('lead|0');
  takeSlotByHand('lead', 2);
  takeSlotByHand('bass', 1);

  assert.deepEqual([...stateHeldSlotsFor('lead')].sort(), [0, 2]);
  assert.deepEqual([...stateHeldSlotsFor('bass')], [1]);
  assert.deepEqual([...stateHeldSlotsFor('pad')], [], 'a track nobody is editing is untouched');
});

test('a track whose label contains a pipe freezes one slot', () => {
  const { noteHandEdit, schedulers, stateHeldSlotsFor } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('a|b', sch);

  noteHandEdit('a|b|2');
  assert.deepEqual(sch.frozen, [[2, true]], 'the key splits at the LAST pipe, not the first');
  assert.deepEqual([...stateHeldSlotsFor('a|b')], [2]);
});

test('the panel takes a frozen slot without loading over it, and loads once it thaws', () => {
  const { setPresetHold, noteHandEdit, commitCapture, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  const seq = noteHandEdit('lead|0'); // a knob moved, then the panel is opened on this slot
  setPresetHold('lead', 0, 'a');
  assert.deepEqual(sch.calls, [], 'loading the store here would throw away what your hands just did');

  setPresetHold('lead', 0, 'a'); // the heartbeat, still frozen
  assert.deepEqual(sch.calls, []);

  commitCapture({ trackId: 'lead', slot: 0, seq });
  setPresetHold('lead', 0, 'a'); // the first poll after the freeze lifts
  assert.deepEqual(sch.calls, [[0, 'a']], 'a hold that never loaded is not a heartbeat');
});

test('picking a preset in the panel loads it even while the slot is frozen', () => {
  const { setPresetHold, noteHandEdit, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  noteHandEdit('lead|0');
  // What the route does: capture what the knobs did first (flushPluginCaptures), then ask for it.
  setPresetHold('lead', 0, 'b', { force: true });
  assert.deepEqual(sch.calls, [[0, 'b']], 'a deliberate pick is a request to hear that preset');
});

test('a capture deferred until the next eval keeps its slot frozen however long that takes', () => {
  // POPTART_AUTOPIN=deferred holds captures for the whole of a performance on purpose. Thawing on
  // the timeout there would hand the pattern a plugin whose sound is still only in the plugin.
  const { noteHandEdit, expireStateHolds, schedulers, uncaptured, autoPinDirty, uncapTtl } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  noteHandEdit('lead|0');
  autoPinDirty.set('lead|0', {}); // still waiting for a quiet moment to capture
  uncaptured.get('lead|0').at -= uncapTtl + 1;
  expireStateHolds();

  assert.equal(uncaptured.size, 1);
  assert.deepEqual(sch.frozen, [[0, true]], 'nothing may push a stored program at it yet');
});

test('going back to the code does not thaw a slot whose capture is still in flight', () => {
  const { takeSlotByHand, releaseSlotsHeldByHand, noteHandEdit, schedulers } = loadHoldFns();
  const sch = fakeScheduler();
  schedulers.set('lead', sch);

  takeSlotByHand('lead', 0);
  noteHandEdit('lead|0'); // one last knob before clicking back into the buffer
  releaseSlotsHeldByHand();

  assert.deepEqual(sch.frozen.at(-1), [0, true], 'the code still has not got that sound');
});

test('currentHolds reports both kinds, with the preset each slot is really on', () => {
  const { setPresetHold, takeSlotByHand, noteHandEdit, currentHolds, schedulers } = loadHoldFns();
  schedulers.set('lead', fakeScheduler());
  schedulers.set('bass', fakeScheduler());

  setPresetHold('lead', 0, 'growl'); // the preset panel
  takeSlotByHand('bass', 1); // a plugin window
  noteHandEdit('pad|2'); // a capture on its way into the code

  assert.deepEqual(currentHolds(), [
    { trackId: 'lead', slot: 0, why: 'panel', preset: 'sounding0' },
    { trackId: 'bass', slot: 1, why: 'hand', preset: 'sounding1' },
    { trackId: 'pad', slot: 2, why: 'capture', preset: null }, // no scheduler for that track
  ]);
});

test('one slot held for two reasons is reported once, by the most deliberate', () => {
  const { takeSlotByHand, noteHandEdit, currentHolds, schedulers } = loadHoldFns();
  schedulers.set('lead', fakeScheduler());

  takeSlotByHand('lead', 0);
  noteHandEdit('lead|0');

  assert.deepEqual(currentHolds().map((h) => h.why), ['hand']);
});
