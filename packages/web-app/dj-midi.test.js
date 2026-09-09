'use strict';

// The DJ desk's MIDI layer: what one mapped CC message does.
//
// The mapping lives server-side precisely so a learned control drives the engine with no browser
// in the loop, which means this dispatch is the only thing between a hardware press and the
// deck. Three kinds of control go through it and each has an edge case worth pinning:
//
//   KNOBS   - the CC's 0..1 has to land in the control's own range, and the ranges differ
//             (two-sided at 0, gains at unity, one-sided at the bottom).
//   BUTTONS - a hold acts on BOTH edges (a platter push bends while the finger is down) and a
//             press acts on ONE (a play pad must not toggle again on release). Both need real
//             edge detection: a pad that restates 127 while held is not a second press.
//   PLATTER - a jog wheel is relative, centered at 64, and says nothing about where in the track
//             it is - so a message is a delta and 64 is standing still.
//
// Also pinned: the two targets the server deliberately cannot act on (the queue steps and ▶ on a
// deck holding code) reach the browser instead of doing nothing; and that every target the
// editor offers as a learn surface is one the server will actually accept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

// server.js spawns an engine on require, so the dispatch is read out of the source and given its
// own dependencies - the same trick mix-gate-all.test.js and highlight-grid.test.js use.
const NAMES = ['mixMidiValue', 'mixMidiScrubDelta', 'mixMidiApply', 'mixMidiButton', 'clockHeldByDesk'];
const CONSTS = ['MIX_MIDI_KNOBS', 'MIX_MIDI_HOLD', 'MIX_MIDI_PRESS', 'MIX_MIDI_DECK_CTLS', 'SONG_SCRUB_TICK_SEC'];
const DEPS = ['mixState', 'songDecks', 'songMasterDeck', 'mixMidiDown', 'applyMixTargets',
  'songScrub', 'songNudge', 'songCue', 'songTogglePlay', 'songSetMeta', 'songMultNext',
  'mixActionNotify'];

function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}
function grabConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm'));
  assert.ok(m, `const ${name} not found in server.js - this test needs updating`);
  return m[0];
}
// eslint-disable-next-line no-new-func
const makeMidi = new Function(...DEPS, `
  ${CONSTS.map(grabConst).join('\n')}
  ${NAMES.map(grabFn).join('\n')}
  return { ${NAMES.join(', ')} };
`);

/**
 * A desk with `songs` loaded (deck letters), and a log of everything the dispatch reached for.
 * `master` is the deck holding the grid, `override` the tempo migration's held bpm.
 */
function rig({ songs = ['a', 'b'], master = null, override = null, playing = true, phones = {} } = {}) {
  const log = [];
  const mixState = {
    tempoOverride: override,
    perDeck: {
      a: new Map(phones.a ? [['cue', phones.a]] : []),
      b: new Map(phones.b ? [['cue', phones.b]] : []),
    },
  };
  const songDecks = { a: null, b: null };
  for (const d of songs) songDecks[d] = { playing, sync: false, keylock: false, syncMult: 'auto' };
  const api = makeMidi(
    mixState,
    songDecks,
    master,
    new Map(),
    (targets) => log.push(['mix', ...targets.map((t) => [t.deck ?? t.name, t.name, t.value])]),
    (deck, by) => log.push(['scrub', deck, by]),
    (deck, arg) => log.push(['nudge', deck, arg]),
    (deck, hold) => log.push(['cue', deck, hold]),
    (deck) => log.push(['play', deck]),
    (deck, patch) => log.push(['meta', deck, patch]),
    (deck) => (deck === 'a' ? 0.5 : 2),
    (deck, action) => log.push(['toClient', deck, action]),
  );
  api.log = log;
  api.state = mixState;
  return api;
}

// --- knobs ---

test('a CC lands in each control\'s own range', () => {
  const m = rig();
  // Two-sided, centered at 0: the crossfader and the filter.
  assert.equal(m.mixMidiValue('xf', 0), -1);
  assert.equal(m.mixMidiValue('xf', 0.5), 0);
  assert.equal(m.mixMidiValue('a:djf', 1), 1);
  // Gains, unity at the knob's center.
  assert.equal(m.mixMidiValue('a:trim', 0.5), 1);
  assert.equal(m.mixMidiValue('b:eqlo', 0), 0);
  assert.equal(m.mixMidiValue('b:eqhi', 1), 2);
  // One-sided, neutral at the bottom.
  assert.equal(m.mixMidiValue('a:fader', 0.75), 0.75);
  assert.equal(m.mixMidiValue('a:djres', 0), 0);
});

test('a knob applies continuously - every message, no edge needed', () => {
  const m = rig();
  m.mixMidiApply('b:fader', 0.25);
  m.mixMidiApply('b:fader', 0.25); // the same value again still moves the desk
  m.mixMidiApply('b:fader', 0.5);
  assert.deepEqual(m.log, [
    ['mix', ['b', 'fader', 0.25]],
    ['mix', ['b', 'fader', 0.25]],
    ['mix', ['b', 'fader', 0.5]],
  ]);
});

test('the crossfader is one control, not a deck one', () => {
  const m = rig();
  m.mixMidiApply('xf', 1);
  assert.deepEqual(m.log, [['mix', ['xf', 'xf', 1]]]);
});

// --- buttons ---

test('a HOLD button acts on both edges - the platter bends while the finger is down', () => {
  const m = rig();
  m.mixMidiApply('a:nudgeup', 1);
  m.mixMidiApply('a:nudgeup', 0);
  assert.deepEqual(m.log, [['nudge', 'a', { hold: 1 }], ['nudge', 'a', { hold: 0 }]]);
});

test('cue is a hold too: press previews, release comes home', () => {
  const m = rig();
  m.mixMidiApply('b:cue', 1);
  m.mixMidiApply('b:cue', 0);
  assert.deepEqual(m.log, [['cue', 'b', true], ['cue', 'b', false]]);
});

test('a PRESS button fires once, on the way down', () => {
  const m = rig();
  m.mixMidiApply('a:jogup', 1);
  m.mixMidiApply('a:jogup', 0); // the release is not a second jog
  assert.deepEqual(m.log, [['nudge', 'a', { jog: 1 }]]);
});

test('a pad restating itself is not another press', () => {
  const m = rig();
  m.mixMidiApply('a:play', 1);
  m.mixMidiApply('a:play', 1); // held pads that keep sending 127
  m.mixMidiApply('a:play', 1);
  assert.deepEqual(m.log, [['play', 'a']]);
  m.mixMidiApply('a:play', 0);
  m.mixMidiApply('a:play', 1); // a real second press
  assert.deepEqual(m.log, [['play', 'a'], ['play', 'a']]);
});

test('the facts row toggles against what the deck currently is', () => {
  const m = rig();
  m.mixMidiButton('a', 'sync', true);
  m.mixMidiButton('a', 'keylock', true);
  assert.deepEqual(m.log, [['meta', 'a', { sync: true }], ['meta', 'a', { keylock: true }]]);
});

test('the tempo ratio does nothing on the deck that set the clock', () => {
  const held = rig({ master: 'a' });
  held.mixMidiButton('a', 'mult', true);
  assert.deepEqual(held.log, []); // its tempo IS the clock - the on-screen button is grayed too
  held.mixMidiButton('b', 'mult', true);
  assert.deepEqual(held.log, [['meta', 'b', { syncMult: 2 }]]);
});

test('the headphone button toggles the deck-wide cue send', () => {
  const off = rig();
  off.mixMidiButton('b', 'phones', true);
  assert.deepEqual(off.log, [['mix', ['b', 'cue', 1]]]);
  const on = rig({ phones: { b: 1 } });
  on.mixMidiButton('b', 'phones', true);
  assert.deepEqual(on.log, [['mix', ['b', 'cue', 0]]]);
});

// --- what the server hands to the browser ---

test('play is the server\'s for a deck holding a file, the browser\'s for one holding code', () => {
  const withSong = rig({ songs: ['a'] });
  withSong.mixMidiButton('a', 'play', true);
  assert.deepEqual(withSong.log, [['play', 'a']]);
  const code = rig({ songs: [] });
  code.mixMidiButton('a', 'play', true);
  assert.deepEqual(code.log, [['toClient', 'a', 'play']]);
});

test('the queue steps are always the browser\'s - the playlists live there', () => {
  const m = rig();
  m.mixMidiButton('a', 'next', true);
  m.mixMidiButton('b', 'prev', true);
  assert.deepEqual(m.log, [['toClient', 'a', 'next'], ['toClient', 'b', 'prev']]);
});

// --- the platter ---

test('the platter is relative: 64 is standing still, either side of it is a delta', () => {
  const m = rig();
  const tick = 0.003;
  assert.equal(m.mixMidiScrubDelta(64 / 127), 0);
  assert.ok(Math.abs(m.mixMidiScrubDelta(65 / 127) - tick) < 1e-9);
  assert.ok(Math.abs(m.mixMidiScrubDelta(63 / 127) + tick) < 1e-9);
  // A fast spin is a bigger excursion the same way round, never a wrap into the other direction.
  assert.ok(m.mixMidiScrubDelta(127 / 127) > m.mixMidiScrubDelta(100 / 127));
  assert.ok(m.mixMidiScrubDelta(1 / 127) < 0);
});

test('a platter message moves the playhead rather than setting it', () => {
  const m = rig();
  m.mixMidiApply('b:scrub', 66 / 127);
  assert.equal(m.log.length, 1);
  assert.equal(m.log[0][0], 'scrub');
  assert.equal(m.log[0][1], 'b');
  assert.ok(m.log[0][2] > 0);
});

// --- who holds the clock ---

test('the clock is the desk\'s while a migration holds it', () => {
  assert.equal(rig({ override: 132 }).clockHeldByDesk(), true);
  assert.equal(rig().clockHeldByDesk(), false);
});

test('the clock is the desk\'s while a song deck plays as grid master', () => {
  // A buffer's setbpm() must not snap the clock off the record the room is dancing to...
  assert.equal(rig({ master: 'b' }).clockHeldByDesk(), true);
  // ...but the moment that record stops holding it, the code's own tempo drives again.
  assert.equal(rig({ master: 'b', playing: false }).clockHeldByDesk(), false);
  assert.equal(rig({ master: 'b', songs: [] }).clockHeldByDesk(), false);
});

// --- the two sides agree on the target list ---

test('every learn surface the editor offers is a target the server accepts', () => {
  const decl = SRC.match(/const MIX_MIDI_DECK_CTLS = \[[^\]]*\]/s);
  assert.ok(decl, 'MIX_MIDI_DECK_CTLS not found in server.js');
  const known = new Set([...decl[0].matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
  for (const arr of ['MIX_MIDI_KNOBS', 'MIX_MIDI_HOLD', 'MIX_MIDI_PRESS']) {
    for (const m of grabConst(arr).matchAll(/'([a-z]+)'/g)) known.add(m[1]);
  }
  // The editor binds by writing `${deck}:name` (and the crossfader by name) into mixLearnAttach.
  const attached = [...CLIENT.matchAll(/mixLearnAttach\(.*?\$\{deck\}:([a-z]+)`/g)].map((x) => x[1]);
  const viaCtlList = /for \(const ctl of MIX_DECK_CONTROLS\) mixLearnAttach/.test(CLIENT);
  assert.ok(attached.length >= 11, `expected the decks to bind every per-deck control, saw ${attached.length}`);
  assert.ok(viaCtlList, 'the channel strip no longer binds through MIX_DECK_CONTROLS');
  for (const name of attached) {
    assert.ok(known.has(name), `client.js learns "${name}" but server.js has no such target`);
  }
  // ...and the dynamic one, spelled with a ternary rather than a literal.
  for (const name of ['next', 'prev']) {
    assert.ok(known.has(name), `server.js has no "${name}" target`);
  }
});

// The clock the browser draws by is mirrored from the desk frame, not only from an eval reply:
// the desk moves the tempo far more often than an eval does (the migration slider, a detent, a
// song deck taking the grid), and without this every client-side clock - playback highlighting,
// the livecoded decks' bar grid, the arrangement playhead - kept running at whatever cps the
// last eval's setbpm() had baked in. Cheap to lose in a refactor and invisible until you mix.
test('the desk frame carries the clock, and the browser adopts it', () => {
  const body = SRC.slice(SRC.indexOf('function mixDeskBody('));
  assert.match(body.slice(0, body.indexOf('\n}')), /transport: transport\?\.snapshot\(\)/);
  assert.match(CLIENT, /if \(state\.transport\) transport = state\.transport;/);
});

// The tempo-ratio cycle exists on both sides (the pane clicks it, the pad presses it) and they
// have to agree, or the same control walks two different ways depending on what you touch.
test('the tempo ratio cycles the same way by pad and by click', () => {
  const server = grabConst('SONG_MULT_ORDER').match(/\[(.*)\]/)[1].replace(/\s/g, '');
  const client = CLIENT.match(/const order = \[(.*?)\];/)[1].replace(/\s/g, '');
  assert.equal(client, server);
});

// --- learning: which message binds, and which one must not ---
//
// The rule follows the TARGET's nature rather than taking whatever arrives next, because taking
// whatever arrives next is wrong on a real control surface: a platter emits a stream of ccs
// around its center whenever it is brushed, and the buttons that a hand reaches for while a
// learn is armed mostly speak notes. Before the note feed existed, five of one deck's buttons
// bound to the same jog cc and none of them worked (2026-09-09).

const LEARN_NAMES = ['mixMidiLearnable', 'handleMixMidi'];
const LEARN_CONSTS = ['MIX_MIDI_HOLD', 'MIX_MIDI_PRESS', 'MIX_MIDI_BUTTONS',
  'midiKind', 'midiNum', 'midiSame', 'midiSay'];
const LEARN_DEPS = ['mixMidiMonitor', 'mixMidiSaid', 'mixMidiLearn', 'settings', 'saveSettings',
  'eventLogQueue', 'mixMidiDrive'];
// eslint-disable-next-line no-new-func
const makeLearn = new Function(...LEARN_DEPS, `
  ${LEARN_CONSTS.map(grabConst).join('\n')}
  ${LEARN_NAMES.map(grabFn).join('\n')}
  return { ${LEARN_NAMES.join(', ')}, learn: (t, finish) => { mixMidiLearn = { target: t, finish, timer: null }; },
           armed: () => !!mixMidiLearn };
`);

function learnRig(mixMidi = {}) {
  const settings = { mixMidi };
  const log = [];
  const driven = [];
  const api = makeLearn(false, new Map(), null, settings, () => {}, log, (t, v) => driven.push([t, v]));
  api.settings = settings;
  api.log = log;
  api.driven = driven;
  return api;
}
const DEV = 'DDJ-FLX4 DDJ-FLX4';

test('a button waits for its press - the platter brushing past does not bind it', () => {
  const r = learnRig();
  let bound = null;
  r.learn('a:play', (b) => { bound = b; });
  // The jog, drifting around its 64 center. Consumed (it must not reach a midicc() either), but
  // the arm stands - the hand is still on its way to the pad.
  assert.equal(r.handleMixMidi(DEV, 2, 0, 0.504, 'cc'), true);
  assert.equal(bound, null);
  assert.equal(r.armed(), true);
  // The pad itself.
  assert.equal(r.handleMixMidi(DEV, 2, 11, 1, 'note'), true);
  assert.deepEqual(bound, { device: DEV, channel: 2, kind: 'note', num: 11 });
  assert.deepEqual(r.settings.mixMidi['a:play'], { device: DEV, channel: 2, kind: 'note', num: 11 });
});

test('a button also takes a cc, but only a pressed one', () => {
  assert.equal(learnRig().mixMidiLearnable('a:cue', 'cc', 1), true);
  assert.equal(learnRig().mixMidiLearnable('a:cue', 'cc', 0.504), false); // a platter at rest
  assert.equal(learnRig().mixMidiLearnable('a:cue', 'cc', 0), false); // and never a release
});

test('a knob and the platter are ccs - a note pressed nearby cannot bind them', () => {
  const r = learnRig();
  assert.equal(r.mixMidiLearnable('a:scrub', 'note', 1), false);
  assert.equal(r.mixMidiLearnable('a:trim', 'note', 1), false);
  assert.equal(r.mixMidiLearnable('xf', 'cc', 0.2), true);
  assert.equal(r.mixMidiLearnable('a:scrub', 'cc', 0.504), true);
});

test('a control already driving something else is refused, and says so', () => {
  const r = learnRig({ 'a:jogdn': { device: DEV, channel: 2, kind: 'note', num: 11 } });
  let bound = null;
  r.learn('a:play', (b) => { bound = b; });
  r.handleMixMidi(DEV, 2, 11, 1, 'note');
  assert.equal(bound, null);
  assert.equal(r.armed(), true); // still listening: pick a different pad
  assert.match(r.log.join('\n'), /already drives a:jogdn/);
  assert.equal(r.settings.mixMidi['a:play'], undefined);
});

test('re-learning the SAME target onto its own control is not a collision', () => {
  const r = learnRig({ 'a:play': { device: DEV, channel: 2, kind: 'note', num: 11 } });
  let bound = null;
  r.learn('a:play', (b) => { bound = b; });
  r.handleMixMidi(DEV, 2, 11, 1, 'note');
  assert.deepEqual(bound, { device: DEV, channel: 2, kind: 'note', num: 11 });
});

// --- driving: a note and a cc of the same number are different controls ---

test('a note never fires a cc mapping, or the other way round', () => {
  const r = learnRig({ 'a:trim': { device: DEV, channel: 1, kind: 'cc', num: 4 } });
  assert.equal(r.handleMixMidi(DEV, 1, 4, 1, 'note'), false); // nothing here wants that note
  assert.deepEqual(r.driven, []);
  assert.equal(r.handleMixMidi(DEV, 1, 4, 1, 'cc'), true);
  assert.deepEqual(r.driven, [['a:trim', 1]]);
});

test('a mapping learned before the note feed existed still drives', () => {
  // The old shape: a bare cc number, no `kind`, no `num`.
  const r = learnRig({ 'a:eqlo': { device: DEV, channel: 1, cc: 15 } });
  assert.equal(r.handleMixMidi(DEV, 1, 15, 0.5, 'cc'), true);
  assert.deepEqual(r.driven, [['a:eqlo', 0.5]]);
});
