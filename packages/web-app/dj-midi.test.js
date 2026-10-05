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
  'setDeckLoops', 'deckLoopsOn', 'deckLoopApply', 'deckLoopLive', 'deckRunning'];

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
function rig({ songs = ['a', 'b'], master = null, override = null, playing = true, phones = {}, fx = {}, loops = {}, running = [] } = {}) {
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
    (deck) => running.includes(deck), // which decks have patterns playing to the clock
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

test('the tempo fader is mounted the player way: a rising cc is a rising tempo', () => {
  // PLUS is at the bottom of a pitch fader's throw, and that end is where it sends its HIGHEST
  // value - so the cc counts up as the tempo does. The on-screen fader's own 0..1 counts the
  // other way (upward from the bottom, see tempoFracOf), and reading the hardware with the
  // screen's sign is what put every learned fader in upside down.
  const m = rig();
  m.mixMidiApply('a:tempo', 0); // the minus end, at the top of the throw
  m.mixMidiApply('a:tempo', 0.5);
  m.mixMidiApply('a:tempo', 1); // the plus end, at the bottom
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
  const list = CLIENT.match(/const FX_SWITCH_TARGETS = \[([^\]]*)\]/);
  assert.ok(list, 'FX_SWITCH_TARGETS not found in client.js - this test needs updating');
  const offered = [...list[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...offered].sort(), Object.keys(MIX_MIDI_FX_POS).sort(),
    'the desk offers a switch position the server has no target for, or the other way round');
  // ...and in the switch's own printed order, which is what the sweep maps arrival order onto.
  assert.deepEqual(offered, ['fxassigna', 'fxassignb', 'fxassignab'],
    'the order IS the mapping: the first position swept becomes the first target here');
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

const LEARN_NAMES = ['mixMidiLearnable', 'midi14Partner', 'mixSwitchState', 'mixMidiSwitchSaw',
  'mixMidiSwitchFinish', 'handleMixMidi'];
const LEARN_CONSTS = ['MIX_MIDI_HOLD', 'MIX_MIDI_PRESS', 'MIX_MIDI_GLOBAL_PRESS',
  'MIX_MIDI_GLOBAL_HOLD', 'MIX_MIDI_FX_POS', 'MIX_MIDI_GLOBAL', 'MIX_MIDI_BUTTONS',
  'midiKind', 'midiNum', 'midiSame', 'midiSay',
  'MIDI_14_WINDOW_MS', 'MIDI_14_LSB', 'midi14', 'midi14Warned', 'midi14Key', 'midi14IsCoarse', 'midi14IsFine',
  'MIX_SWITCH_SETTLE_MS', 'MIX_SWITCH_TIMEOUT_MS'];
const LEARN_DEPS = ['mixMidiMonitor', 'mixMidiSaid', 'mixMidiLearn', 'settings', 'saveSettings',
  'eventLogQueue', 'mixMidiDrive', 'mixMidiDown'];
// eslint-disable-next-line no-new-func
const makeLearn = new Function(...LEARN_DEPS, `
  let mixMidiSwitch = null;
  ${LEARN_CONSTS.map(grabConst).join('\n')}
  ${LEARN_NAMES.map(grabFn).join('\n')}
  return { ${LEARN_NAMES.join(', ')}, learn: (t, finish) => { mixMidiLearn = { target: t, finish, timer: null }; },
           armed: () => !!mixMidiLearn, midi14, MIDI_14_WINDOW_MS,
           sweep: (targets, finish) => { mixMidiSwitch = { targets, seen: [], finish, settle: null, timer: null }; },
           sweeping: () => !!mixMidiSwitch };
`);

function learnRig(mixMidi = {}) {
  const settings = { mixMidi };
  const log = [];
  const driven = [];
  const api = makeLearn(false, new Map(), null, settings, () => {}, log,
    (t, v) => driven.push([t, v]), new Map());
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

// --- high-resolution (14-bit) faders ---------------------------------------------------------
//
// A pitch fader sends its position as a PAIR of ccs, coarse first and the fine half 32 numbers
// up. Both failures this guards were real, on one controller, at once: deck A's tempo fader was
// learned onto the coarse half and read the right way; deck B's was learned onto cc 32 - the fine
// half of cc 0 - and swept its whole range over and over across an inch of travel.

test('a fine half refines its coarse half rather than being a control of its own', () => {
  const r = learnRig({ 'a:tempo': { device: DEV, channel: 1, kind: 'cc', num: 0 } });
  // The coarse half alone drives, so a 7-bit-only surface still works.
  assert.equal(r.handleMixMidi(DEV, 1, 0, 64 / 127, 'cc'), true);
  // ...and the fine half arriving behind it lands on the same target, finer.
  assert.equal(r.handleMixMidi(DEV, 1, 32, 64 / 127, 'cc'), true);
  assert.deepEqual(r.driven.map((d) => d[0]), ['a:tempo', 'a:tempo'],
    'the fine half reached a different target - it IS the fader, 32 numbers up');
  const [coarse, fine] = r.driven.map((d) => d[1]);
  assert.ok(Math.abs(coarse - 64 / 127) < 1e-9);
  assert.ok(Math.abs(fine - (64 * 128 + 64) / 16383) < 1e-9, 'the two halves make one 14-bit value');
});

test('both ends of the throw still reach both ends of the range', () => {
  const r = learnRig({ 'a:tempo': { device: DEV, channel: 1, kind: 'cc', num: 0 } });
  r.handleMixMidi(DEV, 1, 0, 0, 'cc');
  r.handleMixMidi(DEV, 1, 32, 0, 'cc');
  r.handleMixMidi(DEV, 1, 0, 1, 'cc');
  r.handleMixMidi(DEV, 1, 32, 1, 'cc');
  const vals = r.driven.map((d) => d[1]);
  assert.equal(vals[1], 0, 'the bottom of the throw has to be exactly 0');
  assert.equal(vals[3], 1, 'the top of the throw has to be exactly 1');
});

test('a learn cannot bind the fine half while its coarse half is live', () => {
  // This is the actual bug. Sweeping the fader sends both halves; the learn has to take the one
  // that means something, not whichever arrived when the hand was moving.
  const r = learnRig();
  let got = null;
  r.learn('b:tempo', (l) => { got = l; });
  r.handleMixMidi(DEV, 2, 0, 0.4, 'cc'); // coarse - this is the one worth binding
  assert.deepEqual(got, { device: DEV, channel: 2, kind: 'cc', num: 0 });

  const r2 = learnRig();
  let got2 = null;
  r2.learn('b:tempo', (l) => { got2 = l; });
  r2.handleMixMidi(DEV, 2, 0, 0.4, 'cc'); // ...and when the coarse half lands first anyway,
  r2.handleMixMidi(DEV, 2, 32, 0.9, 'cc'); // the fine half that follows must not rebind it
  assert.equal(got2.num, 0, 'the learn took the fine half - the fader will jump everywhere');
});

test('cc 32..63 is left alone when the desk has no reason to want it', () => {
  // Plenty of surfaces use those numbers as ordinary knobs, and a midicc() in a song has to go
  // on seeing them. With nothing bound to the coarse half and no learn armed, there is no pair.
  const r = learnRig({ 'a:trim': { device: DEV, channel: 1, kind: 'cc', num: 40 } });
  r.handleMixMidi(DEV, 1, 8, 0.5, 'cc'); // would be the coarse half of 40, but nothing wants it
  assert.equal(r.handleMixMidi(DEV, 1, 40, 0.25, 'cc'), true);
  assert.deepEqual(r.driven, [['a:trim', 0.25]], 'cc 40 was folded into cc 8 and lost its own meaning');
});

test('a stale coarse half is not a pair', () => {
  const r = learnRig({ 'a:tempo': { device: DEV, channel: 1, kind: 'cc', num: 0 } });
  r.handleMixMidi(DEV, 1, 0, 0.5, 'cc');
  // Far later: two separate gestures, not two halves of one. cc 32 is its own control again.
  r.midi14.get(`${DEV}|1|0`).at -= r.MIDI_14_WINDOW_MS + 1;
  assert.equal(r.handleMixMidi(DEV, 1, 32, 0.9, 'cc'), false);
});

test('a control left bound to a fine half says so, once, and names the fix', () => {
  // Her deck B tempo fader, exactly: bound to cc 32 when the fader's real address is cc 0. The
  // binding cannot be repaired from here (the halves are not interchangeable), so the console
  // has to turn "it jumps around" into something actionable.
  const r = learnRig({ 'b:tempo': { device: DEV, channel: 2, kind: 'cc', num: 32 } });
  r.handleMixMidi(DEV, 2, 0, 0.4, 'cc'); // the coarse half this surface also sends
  r.handleMixMidi(DEV, 2, 32, 0.9, 'cc');
  const said = r.log.filter((l) => /FINE half/.test(l));
  assert.equal(said.length, 1);
  assert.match(said[0], /b:tempo/);
  assert.match(said[0], /cc 0/, 'the message has to name the address it should be on');
  assert.match(said[0], /alt\+click/, 'and how to get there');
  // Said once. A fader being swept sends this pair twenty times a second.
  r.handleMixMidi(DEV, 2, 0, 0.5, 'cc');
  r.handleMixMidi(DEV, 2, 32, 0.1, 'cc');
  assert.equal(r.log.filter((l) => /FINE half/.test(l)).length, 1);
});

// --- the cue pad on a deck playing code --------------------------------------------------------
//
// A pattern has no cue POINT - it is not a recording with a place in it - but the gesture still
// means the same thing as on a record: hold to hear this deck without committing it to the room.
// Starting a code deck means evaluating a buffer only the editor has, so the press leaves here
// the way `play` does rather than being refused.

test('a code deck\'s cue press goes to the browser; a file deck\'s is served here', () => {
  const m = rig({ songs: ['a'] }); // deck a holds a file, deck b holds code
  m.mixMidiButton('a', 'cue', true);
  m.mixMidiButton('b', 'cue', true);
  m.mixMidiButton('b', 'cue', false);
  assert.deepEqual(m.log, [
    ['cue', 'a', true],
    ['toClient', 'b', 'cue'],
    ['toClient', 'b', 'cueoff'],
  ]);
});

test('both edges of a code deck\'s cue are forwarded, because the hold IS the gesture', () => {
  // A press-only forward would start the deck and never stop it - the pad would latch.
  const m = rig({ songs: [] });
  m.mixMidiApply('a:cue', 1);
  m.mixMidiApply('a:cue', 0);
  assert.deepEqual(m.log, [['toClient', 'a', 'cue'], ['toClient', 'a', 'cueoff']]);
});

test('the browser side runs both halves of it', () => {
  // Source-shape, since this half is a DOM gesture: what matters is that the release is wired at
  // all and that it restores what the press found rather than assuming the deck was idle.
  assert.match(CLIENT, /action === 'cue'\) deckCuePress\(deck, true\)/);
  assert.match(CLIENT, /action === 'cueoff'\) deckCuePress\(deck, false\)/);
  assert.match(CLIENT, /const was = \{ playing: !!deckPlayingNow\[deck\], cued: mixCueOn\(deck\), started: null \}/,
    'the press has to remember what it found, or the release leaves the deck wrong');
  // The release must not re-check the live mirror: it arrives on an SSE frame, so on a quick
  // press it still reads "not playing" when the finger comes up and the stop gets skipped.
  assert.doesNotMatch(CLIENT, /!was\.playing && deckPlayingNow\[deck\]/,
    'the cue release consults the live mirror again - a quick press will not stop');
  // ...and it waits for the start it fired, or the stop lands first and the deck starts after it.
  assert.match(CLIENT, /\(was\.started \?\? Promise\.resolve\(\)\)\.then\(\(\) => djCueStop\(deck\)\)/);
  assert.match(CLIENT, /'\/api\/stop', \{ deck, hush: true \}/,
    'an audition that rings on after the finger is up is not an audition');
});

// --- learning a multi-position switch in one sweep --------------------------------------------
//
// Learning the three positions one at a time does not work, and the reason is physical: the
// positions are in a row, so you cannot reach the far one without passing THROUGH the middle one.
// Arming "deck A" and flipping there binds whatever the switch brushed on the way, every time.
//
// Sweeping it end to end instead makes that pass-through the point: the positions arrive in their
// own order, and that order is the mapping.

const SWITCH = ['fxassigna', 'fxassignb', 'fxassignab'];

/** A rig with a sweep armed, and the answer it eventually gives. */
function sweepRig(mixMidi = {}) {
  const r = learnRig(mixMidi);
  let answer = null;
  r.sweep(SWITCH, (a) => { answer = a; });
  return { ...r, answer: () => answer };
}

test('a sweep maps the positions to the targets in the order they arrive', () => {
  const r = sweepRig();
  // One continuous movement across a switch that sends a note per position, with the note-offs
  // for the position being left interleaved the way hardware sends them.
  r.handleMixMidi(DEV, 5, 16, 1, 'note');
  r.handleMixMidi(DEV, 5, 16, 0, 'note');
  r.handleMixMidi(DEV, 5, 17, 1, 'note');
  r.handleMixMidi(DEV, 5, 17, 0, 'note');
  r.handleMixMidi(DEV, 5, 18, 1, 'note');
  r.mixMidiSwitchFinish();
  assert.deepEqual(r.answer().learned.map((b) => [b.target, b.num]), [
    ['fxassigna', 16], ['fxassignb', 17], ['fxassignab', 18],
  ]);
  // ...and they are really written, so the dispatch finds them.
  assert.equal(r.settings.mixMidi.fxassignab.num, 18);
  assert.equal(r.settings.mixMidi.fxassigna.kind, 'note');
});

test('a note-off is the position being LEFT, and is not a position of its own', () => {
  // Counting them would fill the sweep with duplicates of where the switch has just been, and
  // the third "position" would be the first one again.
  const r = sweepRig();
  assert.equal(r.mixSwitchState(5, 16, 0, 'note'), null);
  assert.ok(r.mixSwitchState(5, 16, 1, 'note'));
});

test('passing through the middle position is the middle entry, not a misbinding', () => {
  // The whole point. Sweeping from the 1&2 end backwards gives the reverse order, which is what
  // the console line asks you not to do - but nothing is bound to the position it merely crossed.
  const r = sweepRig();
  for (const num of [18, 17, 16]) r.handleMixMidi(DEV, 5, num, 1, 'note');
  r.mixMidiSwitchFinish();
  assert.deepEqual(r.answer().learned.map((b) => b.num), [18, 17, 16],
    'the order swept is the order mapped - there is nothing else it could mean');
});

test('a sweep that did not reach every position binds nothing and says so', () => {
  const r = sweepRig();
  r.handleMixMidi(DEV, 5, 16, 1, 'note');
  r.handleMixMidi(DEV, 5, 17, 1, 'note');
  r.mixMidiSwitchFinish();
  assert.equal(r.answer().learned, null);
  assert.match(r.answer().why, /only 2 of 3/);
  assert.deepEqual(r.settings.mixMidi, {}, 'a half-learned switch must leave the old mapping alone');
});

test('a switch that is one cc at three values is refused rather than bound wrong', () => {
  // A binding records an address, not a value - so all three targets would match every message
  // and the unit would land on whichever one the map happened to list first.
  const r = sweepRig();
  for (const raw of [0, 64, 127]) r.handleMixMidi(DEV, 5, 11, raw / 127, 'cc');
  r.mixMidiSwitchFinish();
  assert.equal(r.answer().learned, null);
  assert.match(r.answer().why, /one control.*per position/s);
  assert.match(r.answer().why, /cycling pad/, 'and it names what to do instead');
});

test('a sweep takes over the positions from whatever was on them', () => {
  // The cycling `fxassign` was almost certainly learned onto one of these very positions, and a
  // stale binding would win the dispatch (first match takes the message). So it goes, out loud.
  const r = sweepRig({ fxassign: { device: DEV, channel: 5, kind: 'note', num: 16 } });
  for (const num of [16, 17, 18]) r.handleMixMidi(DEV, 5, num, 1, 'note');
  r.mixMidiSwitchFinish();
  assert.ok(!('fxassign' in r.settings.mixMidi), 'the old cycling binding is still on position 1');
  assert.match(r.log.join('\n'), /fxassign was on one of those positions - unbound/);
  assert.equal(r.settings.mixMidi.fxassigna.num, 16);
});

test('a switch mid-sweep drives nothing', () => {
  const r = sweepRig();
  r.handleMixMidi(DEV, 5, 16, 1, 'note');
  assert.deepEqual(r.driven, [], 'a position learned while sweeping must not also act');
});

// --- who owns the tempo ------------------------------------------------------------------------
//
// A grid-master SONG deck has always held the clock against an eval's setbpm, for an obvious
// reason: the room is dancing to that record's bars. A livecoded deck was not protected, and its
// patterns are generated FROM the clock - so starting a second track on deck A snapped the one
// already playing to the newcomer's tempo (reported 2026-10-05, confirmed on a live server with
// deck B playing at 137, songMasterDeck null and tempoOverride null - nothing holding it).

test('a livecode deck playing holds the clock against the OTHER deck\'s setbpm', () => {
  const m = rig({ songs: [], running: ['b'] });
  assert.equal(m.clockHeldByDesk('a'), true, 'deck a could re-tempo the music deck b is playing');
});

test('...but a deck already playing may still change the tempo, which is livecoding', () => {
  // Re-evaluating the deck you are playing, with a different setbpm, is how a tempo change is
  // made. Blocking that would be a worse bug than the one above.
  const m = rig({ songs: [], running: ['a'] });
  assert.equal(m.clockHeldByDesk('a'), false);
});

test('one deck playing alone outside a mix is unaffected', () => {
  assert.equal(rig({ songs: [], running: [] }).clockHeldByDesk('a'), false, 'nothing is playing');
  // ...and the single-deck case, which is every evaluation outside DJ mode.
  assert.equal(rig({ songs: [], running: ['a'] }).clockHeldByDesk('a'), false);
});

test('a caller with no deck in hand gets the answer it always got', () => {
  // Link's adopt asks whether the DESK holds the clock, and knows nothing about decks. Teaching
  // it about livecoded decks would change when a session's tempo is adopted, which is not this
  // bug and not this change.
  assert.equal(rig({ songs: [], running: ['a', 'b'] }).clockHeldByDesk(), false);
  assert.equal(rig({ songs: [], running: ['a'], override: 132 }).clockHeldByDesk(), true);
});

test('the migration and the grid master still outrank everything', () => {
  assert.equal(rig({ songs: [], running: ['a'], override: 132 }).clockHeldByDesk('a'), true,
    'a tempo migration holds the clock even against the deck that is playing');
  assert.equal(rig({ master: 'b', running: ['a'] }).clockHeldByDesk('a'), true);
});

test('only deck A can drive the clock at all, and only when nothing holds it', () => {
  // The second half of the guard, in the evaluator rather than here: deck B's setbpm has never
  // driven the shared clock, so the newcomer rule is what protects the other direction.
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(src, /deck === 'a' && !clockHeldByDesk\(deck\) \? declareTempo\(value, v\) : TEMPO_BLOCK/);
  assert.match(src, /if \(deck === 'a' && !clockHeldByDesk\(deck\)\) declareTempo\(DEFAULT_CPS/,
    'a buffer with no setbpm returns the clock to 120 - that has to be held off too');
});
