'use strict';

// What the desk writes BACK to a control surface: the lamps in its pads and, where poptart knows
// the addresses, its level meters.
//
// The lamps are the part worth pinning. Nothing on a surface knows anything - every lit pad is a
// message somebody sent - so a lamp that disagrees with the desk is a lie told in the dark, at
// the one moment you are looking at the controller instead of the screen. And a lamp that is
// re-sent on every desk frame is a hundred messages a second at hardware that asked for none.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// server.js spawns an engine on require, so the functions are read out of the source and handed
// their own dependencies - the trick dj-midi.test.js and dj-loop.test.js use.
function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  const end = SRC.indexOf('\n}\n', at);
  assert.ok(end > at, `could not find the end of ${name} in server.js`);
  return SRC.slice(at, end + 3);
}
function grabConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm'));
  assert.ok(m, `const ${name} not found in server.js - this test needs updating`);
  return m[0];
}

const DEPS = ['settings', 'engine', 'deckLevels', 'songDecks', 'mixState', 'deckLoopsOn',
  'deckLoopLive', 'deckPlaying', 'mixLampSent'];
const NAMES = ['mixMeterProfile', 'mixMeterValue', 'mixFeedbackLevels', 'mixFeedbackLit',
  'mixFeedbackLamps', 'mixFeedbackBlank'];
// eslint-disable-next-line no-new-func
const makeFeedback = new Function(...DEPS, `
  ${grabConst('MIX_METER_PROFILES')}
  ${grabConst('MIX_FEEDBACK_DB_MIN')}
  ${NAMES.map(grabFn).join('\n')}
  return { ${NAMES.join(', ')}, MIX_METER_PROFILES };
`);

/**
 * A desk with a surface attached. `midi` is what has been learned (target -> binding), `state`
 * patches the desk's truth, and everything the engine is asked to send lands in `sent`.
 */
function rig({ port = 'DDJ-FLX4', midi = {}, levels = {}, songs = {}, fx = {}, loops = {}, regions = {}, playing = {} } = {}) {
  const sent = [];
  const settings = { mixFeedback: port, mixMidi: midi };
  const songDecks = { a: null, b: null, ...songs };
  const api = makeFeedback(
    settings,
    { midiOut: (messages) => sent.push(...messages) },
    { a: null, b: null, ...levels },
    songDecks,
    {
      fx: { on: false, held: false, ...fx },
      perDeck: { a: new Map(), b: new Map() },
    },
    { a: true, b: true, ...regions },
    (deck) => loops[deck] ?? null,
    (deck) => !!playing[deck],
    new Map(),
  );
  return { ...api, sent, settings, songDecks };
}

// --- the meters ---------------------------------------------------------------------------------

test('a surface poptart knows the meters of gets them; one it does not, does not', () => {
  assert.ok(rig({ port: 'DDJ-FLX4' }).mixMeterProfile(), 'the one profile that ships');
  assert.ok(rig({ port: 'Pioneer DDJ-FLX4 Port 1' }).mixMeterProfile(), 'matched inside the full port name');
  assert.ok(rig({ port: 'ddj-flx4' }).mixMeterProfile(), 'and whatever case the driver reports it in');
  assert.equal(rig({ port: 'Some Other Controller' }).mixMeterProfile(), null);
  assert.equal(rig({ port: null }).mixMeterProfile(), null, 'and nothing at all with the port off');
});

test('the level scale is the one the screen draws, so the two read alike', () => {
  const { mixMeterValue } = rig();
  assert.equal(mixMeterValue(1), 127, 'full scale is the top LED');
  assert.equal(mixMeterValue(0), 0, 'silence is dark');
  assert.equal(mixMeterValue(0.0001), 0, 'and so is anything under the floor');
  // -42dB is the floor of the on-screen meter: the bottom of the hardware's range too.
  assert.equal(mixMeterValue(10 ** (-42 / 20)), 0);
  // Halfway up in dB is halfway up the meter - a -21dB signal, not a 0.5 one.
  assert.equal(mixMeterValue(10 ** (-21 / 20)), 64);
  assert.ok(mixMeterValue(0.5) > mixMeterValue(0.25), 'and it rises with the level');
});

test('a reading past full scale pins the meter rather than wrapping it', () => {
  const { mixMeterValue } = rig();
  assert.equal(mixMeterValue(4), 127);
});

test('both decks are metered from the peak the engine just reported', () => {
  const m = rig({ levels: { a: { p: 1, r: 0.5 }, b: { p: 0, r: 0 } } });
  m.mixFeedbackLevels();
  assert.deepEqual(m.sent, [['cc', 0, 2, 127], ['cc', 1, 2, 0]]);
});

test('a deck that has not been measured is not metered at all', () => {
  // Not "metered at zero": a deck with no reading has no level to show, and writing one would
  // put the meter out on a deck that is playing while its first frame is in flight.
  const m = rig({ levels: { a: { p: 0.5, r: 0.2 } } });
  m.mixFeedbackLevels();
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0][1], 0, 'deck A, which has one');
});

test('a surface with no meter profile is sent no levels', () => {
  const m = rig({ port: 'Some Other Controller', levels: { a: { p: 1 }, b: { p: 1 } } });
  m.mixFeedbackLevels();
  assert.deepEqual(m.sent, []);
});

// --- the lamps -----------------------------------------------------------------------------------

test('a lamp reads the desk, never a flag of its own', () => {
  const m = rig({
    songs: { a: { sync: true, keylock: false, quantize: false, cueHeld: true } },
    playing: { a: true },
    loops: { b: { from: 0, to: 4 } },
    regions: { a: false },
    fx: { on: true },
  });
  assert.equal(m.mixFeedbackLit('a:play'), true);
  assert.equal(m.mixFeedbackLit('b:play'), false);
  assert.equal(m.mixFeedbackLit('a:sync'), true);
  assert.equal(m.mixFeedbackLit('a:keylock'), false);
  assert.equal(m.mixFeedbackLit('a:quant'), false, 'quantize off reads as dark');
  assert.equal(m.mixFeedbackLit('a:cue'), true);
  assert.equal(m.mixFeedbackLit('a:regions'), false);
  assert.equal(m.mixFeedbackLit('b:loop'), true, 'a loop running on the deck lights its pad');
  assert.equal(m.mixFeedbackLit('a:loop'), false);
  assert.equal(m.mixFeedbackLit('fxon'), true);
  assert.equal(m.mixFeedbackLit('fxhold'), false);
});

test('a control with nothing to show is left alone', () => {
  // A jog step, the loop length pads, the queue steps: they do something, they are not a state.
  const m = rig();
  for (const target of ['a:jogdn', 'a:jogup', 'a:loophalve', 'a:loopdouble', 'a:next', 'a:temporange']) {
    assert.equal(m.mixFeedbackLit(target), null, target);
  }
  assert.equal(m.mixFeedbackLit('a:quant'), null, 'and a deck with no song has no Q to report');
});

test('only pads are lit - a knob has no lamp and some surfaces answer their own echo', () => {
  const m = rig({
    midi: {
      'a:play': { device: 'X', channel: 0, kind: 'note', num: 11 },
      'a:fader': { device: 'X', channel: 0, kind: 'cc', num: 19 },
    },
    playing: { a: true },
  });
  m.mixFeedbackLamps();
  assert.deepEqual(m.sent, [['note', 0, 11, 127]]);
});

test('a frame sends only what changed, and a forced one sends the lot', () => {
  const m = rig({
    midi: {
      'a:play': { device: 'X', channel: 0, kind: 'note', num: 11 },
      'a:sync': { device: 'X', channel: 0, kind: 'note', num: 12 },
    },
    songs: { a: { sync: true } },
    playing: { a: false },
  });
  m.mixFeedbackLamps();
  assert.deepEqual(m.sent, [['note', 0, 11, 0], ['note', 0, 12, 127]], 'the first frame lights everything');
  m.sent.length = 0;
  m.mixFeedbackLamps();
  assert.deepEqual(m.sent, [], 'nothing changed, nothing sent');
  m.songDecks.a.sync = false;
  m.mixFeedbackLamps();
  assert.deepEqual(m.sent, [['note', 0, 12, 0]], 'only the one that moved');
  m.sent.length = 0;
  m.mixFeedbackLamps({ force: true });
  assert.deepEqual(m.sent, [['note', 0, 11, 0], ['note', 0, 12, 0]], 'a reconnected surface is told the lot');
});

test('nothing is written at all with the port off', () => {
  const m = rig({ port: null, midi: { 'a:play': { device: 'X', channel: 0, kind: 'note', num: 11 } }, playing: { a: true } });
  m.mixFeedbackLamps();
  m.mixFeedbackLevels();
  assert.deepEqual(m.sent, []);
});

test('leaving the desk puts every lamp out and both meters to zero', () => {
  const m = rig({
    midi: {
      'a:play': { device: 'X', channel: 0, kind: 'note', num: 11 },
      'a:jogup': { device: 'X', channel: 0, kind: 'note', num: 13 }, // no state: not a lamp
      'a:fader': { device: 'X', channel: 0, kind: 'cc', num: 19 },
    },
    playing: { a: true },
  });
  m.mixFeedbackLamps();
  m.sent.length = 0;
  m.mixFeedbackBlank();
  assert.deepEqual(m.sent, [['note', 0, 11, 0], ['cc', 0, 2, 0], ['cc', 1, 2, 0]]);
});

test('after blanking, the next frame lights what is on again', () => {
  // The sent-state cache has to be cleared by a blank, or a pad that was lit before leaving the
  // desk comes back to a desk that thinks it already told it.
  const m = rig({ midi: { 'a:play': { device: 'X', channel: 0, kind: 'note', num: 11 } }, playing: { a: true } });
  m.mixFeedbackLamps();
  m.mixFeedbackBlank();
  m.sent.length = 0;
  m.mixFeedbackLamps();
  assert.deepEqual(m.sent, [['note', 0, 11, 127]]);
});
