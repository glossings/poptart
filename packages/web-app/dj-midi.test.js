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
const CONSTS = ['MIX_MIDI_KNOBS', 'MIX_MIDI_HOLD', 'MIX_MIDI_PRESS', 'MIX_MIDI_DECK_CTLS',
  'MIX_MIDI_GLOBAL_PRESS', 'MIX_MIDI_GLOBAL_HOLD', 'MIX_MIDI_FX_POS', 'MIX_MIDI_GLOBAL',
  'SONG_SCRUB_TICK_SEC', 'SONG_SEARCH_TICK_SEC', 'FX_ASSIGNS', 'DECK_TEMPO_RANGES'];
const DEPS = ['mixState', 'songDecks', 'songMasterDeck', 'mixMidiDown', 'applyMixTargets',
  'songScrub', 'songNudge', 'songCue', 'songTogglePlay', 'songSetMeta', 'songMultNext',
  'mixActionNotify', 'songBend', 'deckTempoApply', 'mixFxSet', 'mixFxStep',
  'setDeckLoops', 'deckLoopsOn', 'deckLoopApply', 'deckLoopLive'];

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
function rig({ songs = ['a', 'b'], master = null, override = null, playing = true, phones = {}, fx = {}, loops = {} } = {}) {
  const log = [];
  const mixState = {
    tempoOverride: override,
    perDeck: {
      a: new Map(phones.a ? [['cue', phones.a]] : []),
      b: new Map(phones.b ? [['cue', phones.b]] : []),
    },
    deckTempo: { a: { frac: 0, range: 6 }, b: { frac: 0, range: 6 } },
    fx: { plugin: null, on: false, held: false, depth: 0.5, assign: 'ab', ...fx },
  };
  const songDecks = { a: null, b: null };
  for (const d of songs) songDecks[d] = { playing, sync: false, keylock: false, syncMult: 'auto' };
  const deckLoopsOn = { a: true, b: true };
  const looping = { a: null, b: null, ...loops };
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
    (deck, ticks) => log.push(['bend', deck, ticks]),
    (deck, patch) => log.push(['tempo', deck, patch]),
    (patch) => log.push(['fx', patch]),
    // Stepping the chain list loads code off disk, so the real one is async and the dispatch
    // attaches its own .catch - the stub has to be a promise or that call throws.
    (dir) => { log.push(['fxstep', dir]); return Promise.resolve(); },
    (deck, on) => log.push(['loops', deck, on]),
    deckLoopsOn,
    (deck, patch) => log.push(['loop', deck, patch]),
    (deck) => looping[deck],
  );
  api.log = log;
  api.state = mixState;
  api.deckLoopsOn = deckLoopsOn;
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

// The jog's second mode. 1:1 is the wrong ratio for getting somewhere - crossing a five-minute
// track at 3ms a tick is a hundred revolutions - so the same wheel under shift sends a different
// cc, which is a second ordinary target rather than a modifier anything has to model.
test('search is the same platter in a much coarser gear', () => {
  const m = rig();
  m.mixMidiApply('a:scrub', 66 / 127);
  m.mixMidiApply('a:search', 66 / 127);
  const [scrub, search] = m.log.map((l) => l[2]);
  assert.equal(m.log.length, 2);
  assert.ok(search > scrub * 10, `search must cross a track, not place a beat (${scrub} -> ${search})`);
  // Same wheel: same center, same sign convention, same coalescing flush.
  assert.equal(m.mixMidiScrubDelta(64 / 127, m.SONG_SEARCH_TICK_SEC), 0);
  assert.ok(m.mixMidiScrubDelta(63 / 127, m.SONG_SEARCH_TICK_SEC) < 0);
  assert.equal(m.log[1][1], 'a');
});

// --- the pitch fader and the platter's bend mode ---

test('the tempo fader is mounted the player way: hardware top is minus', () => {
  const m = rig();
  m.mixMidiApply('a:tempo', 1); // fader pushed to its top
  m.mixMidiApply('a:tempo', 0.5);
  m.mixMidiApply('a:tempo', 0); // pulled to the bottom
  assert.deepEqual(m.log, [
    ['tempo', 'a', { frac: -1 }],
    ['tempo', 'a', { frac: 0 }],
    ['tempo', 'a', { frac: 1 }],
  ]);
});

test('bend speaks the platter convention: 64 still, either side signed ticks', () => {
  const m = rig();
  m.mixMidiApply('b:bend', 64 / 127);
  m.mixMidiApply('b:bend', 66 / 127);
  m.mixMidiApply('b:bend', 62 / 127);
  assert.deepEqual(m.log, [['bend', 'b', 0], ['bend', 'b', 2], ['bend', 'b', -2]]);
});

test('quant, regions and the range switch are press buttons on the deck', () => {
  const m = rig();
  m.mixMidiButton('a', 'quant', true);
  m.mixMidiButton('a', 'regions', true);
  m.mixMidiButton('a', 'temporange', true);
  assert.deepEqual(m.log, [
    ['meta', 'a', { quantize: false }], // the rig's song has no quantize key - reads as on, toggles off
    ['loops', 'a', false], // deckLoopsOn starts true
    ['tempo', 'a', { range: 10 }], // 6 -> 10 -> 16 -> 100 -> 6
  ]);
});

test('the loop pad arms a loop on a deck that has none and ends the one on a deck that has', () => {
  // The pad is a toggle against the deck's OWN truth, not against a flag of its own: a loop
  // armed from the screen is one the pad ends, and the other way round.
  const idle = rig();
  idle.mixMidiButton('a', 'loop', true);
  assert.deepEqual(idle.log, [['loop', 'a', { on: true }]]);
  const held = rig({ loops: { b: { from: 4, to: 8 } } });
  held.mixMidiButton('b', 'loop', true);
  assert.deepEqual(held.log, [['loop', 'b', { on: false }]]);
});

test('the length pads halve and double, and say which deck', () => {
  const m = rig();
  m.mixMidiButton('a', 'loophalve', true);
  m.mixMidiButton('b', 'loopdouble', true);
  assert.deepEqual(m.log, [['loop', 'a', { scale: 0.5 }], ['loop', 'b', { scale: 2 }]]);
});

test('the loop pads act on the press, not the release', () => {
  // Through the real dispatch, where the edge gate is: a pad sends 127 then 0, and a loop that
  // ended on the release would be a loop you could only hear while holding the button down.
  const m = rig();
  for (const name of ['loop', 'loophalve', 'loopdouble']) {
    m.mixMidiApply(`a:${name}`, 1);
    m.mixMidiApply(`a:${name}`, 0);
  }
  assert.deepEqual(m.log, [
    ['loop', 'a', { on: true }],
    ['loop', 'a', { scale: 0.5 }],
    ['loop', 'a', { scale: 2 }],
  ]);
});

// --- the FX unit's deck-less targets ---

test('the fx knob is continuous; the pads edge like the deck pads', () => {
  const m = rig();
  m.mixMidiApply('fxknob', 0.3);
  m.mixMidiApply('fxknob', 0.3); // a knob needs no edge
  m.mixMidiApply('fxon', 1);
  m.mixMidiApply('fxon', 1); // a pad restating itself is not a second press
  m.mixMidiApply('fxon', 0); // ...and the release is not one either
  assert.deepEqual(m.log, [
    ['fx', { knob: 0.3 }],
    ['fx', { knob: 0.3 }],
    ['fx', { on: true }],
  ]);
});

test('fxhold is the momentary pad: both edges reach the unit', () => {
  const m = rig();
  m.mixMidiApply('fxhold', 1);
  m.mixMidiApply('fxhold', 0);
  assert.deepEqual(m.log, [['fx', { held: true }], ['fx', { held: false }]]);
});

test('fxassign cycles a -> ab -> b, and the step pads walk the chain list', () => {
  const m = rig({ fx: { assign: 'ab' } });
  m.mixMidiApply('fxassign', 1);
  m.mixMidiApply('fxnext', 1);
  m.mixMidiApply('fxprev', 1);
  assert.deepEqual(m.log, [['fx', { assign: 'b' }], ['fxstep', 1], ['fxstep', -1]]);
});

// The three-way deck-select SWITCH, as opposed to the cycling pad above. A switch sends one
// message per position and its message is a STATE, so these three targets are absolute and
// deliberately not edge-detected - which is the whole bug: with one binding on a cycling pad, a
// switch moved the unit onto whatever came next in the cycle rather than onto the deck printed
// beside the position, and half its positions did nothing at all.
test('each fxassign position puts the unit where the switch says, not one step on', () => {
  const m = rig({ fx: { assign: 'ab' } });
  m.mixMidiApply('fxassignb', 1);
  m.mixMidiApply('fxassigna', 1);
  m.mixMidiApply('fxassignab', 1);
  assert.deepEqual(m.log, [['fx', { assign: 'b' }], ['fx', { assign: 'a' }], ['fx', { assign: 'ab' }]]);
});

test('a switch flipped back to a position it has been in before still lands', () => {
  // The edge detection the PADS need is wrong here. A surface that sends no note-off when the
  // switch leaves a position (and one that simply re-states where it is) would otherwise have
  // the second visit read as "no edge" and swallowed - the switch would work once per position
  // and then go dead, which is far worse than not working at all.
  const m = rig({ fx: { assign: 'ab' } });
  m.mixMidiApply('fxassigna', 1);
  m.mixMidiApply('fxassignb', 1);
  m.mixMidiApply('fxassigna', 1);
  assert.deepEqual(m.log.map((e) => e[1].assign), ['a', 'b', 'a']);
});

test('a switch position leaving (its note-off) moves nothing', () => {
  // Only the position being ENTERED says anything. Acting on the release too would move the unit
  // onto the deck the switch just left, every time.
  const m = rig({ fx: { assign: 'ab' } });
  m.mixMidiApply('fxassigna', 0);
  assert.deepEqual(m.log, []);
});

test('the switch positions the desk offers are the ones the server knows, and they are real assigns', () => {
  // Three names spelled in two files: the menu that learns them and the table that dispatches
  // them. A typo in either is a menu entry that arms a target the server refuses, which fails
  // at bind time with nothing on screen to explain it.
  // eslint-disable-next-line no-new-func
  const { MIX_MIDI_FX_POS, FX_ASSIGNS } = new Function(
    `${grabConst('MIX_MIDI_FX_POS')}\n${grabConst('FX_ASSIGNS')}\nreturn { MIX_MIDI_FX_POS, FX_ASSIGNS };`,
  )();
  const offered = [...CLIENT.matchAll(/mixLearnDo\('(fxassign[a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...offered].sort(), Object.keys(MIX_MIDI_FX_POS).sort(),
    'the desk offers a switch position the server has no target for, or the other way round');
  for (const [target, assign] of Object.entries(MIX_MIDI_FX_POS)) {
    assert.ok(FX_ASSIGNS.includes(assign), `${target} sets "${assign}", which is not an fx assign`);
  }
  // ...and every one of them is global, so the dispatch reads it as a deck-less target rather
  // than slicing a deck letter off the front of its name.
  assert.match(grabConst('MIX_MIDI_GLOBAL'), /Object\.keys\(MIX_MIDI_FX_POS\)/);
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
  const attached = [...CLIENT.matchAll(/mixLearnAttach\([^\n]*\)/g)]
    .flatMap((c) => [...c[0].matchAll(/\$\{deck\}:([a-z]+)`/g)].map((x) => x[1]));
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
const LEARN_CONSTS = ['MIX_MIDI_HOLD', 'MIX_MIDI_PRESS', 'MIX_MIDI_GLOBAL_PRESS',
  'MIX_MIDI_GLOBAL_HOLD', 'MIX_MIDI_FX_POS', 'MIX_MIDI_GLOBAL', 'MIX_MIDI_BUTTONS',
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
