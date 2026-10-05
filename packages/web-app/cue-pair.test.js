'use strict';

// The headphone cue's channel arithmetic (server.js).
//
// A cue used to mean a SECOND device: poptart's aggregate gained one more member and the cue pair
// was that member's own first pair. That is not how a DJ controller is built. A controller is one
// USB audio device with four outputs - channels 1/2 are the master and 3/4 are the headphone jack
// on the front of it - so "the output device" and "the cue device" are the same device, and what
// separates the mix from the cue is the PAIR, not the device.
//
// Everything here is about one number: where the cue pair starts in whatever device scsynth
// opened. It is worth its own test file because getting it wrong is silent. Offset 0 is the master
// out, so a cue that resolves wrong does not go quiet - it plays the headphone mix, which is the
// next record and whatever you are lining it up against, over the top of what the room is
// hearing. (That is exactly what the old code did if you named the output device as the cue: it
// went into the aggregate list, CoreAudio cannot hold one device twice, and the offset came out
// as 0.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// server.js spawns an engine on require, so the subjects are read out of the source and given
// their own dependencies - the same trick dj-midi.test.js and mix-gate-all.test.js use.
// Brace-matched from the start of the BODY, not from the first `{` after the name: two of these
// destructure their argument, so the first brace is in the parameter list and counting from there
// returns the signature and nothing else.
function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  let i = SRC.indexOf('(', at);
  for (let depth = 0; i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')' && --depth === 0) break;
  }
  let end = SRC.indexOf('{', i);
  for (let depth = 0, j = end; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  return SRC.slice(at, end);
}
function grabArrow(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
  assert.ok(m, `const ${name} not found in server.js - this test needs updating`);
  return m[0];
}

const NAMES = ['cueOffsetIn', 'cueName', 'cueOnOutputDevice', 'cuePairChoices', 'aggregateExtraUids'];
const DEPS = ['settings', 'audioOutputDevices', 'plainOutputDevice'];
// eslint-disable-next-line no-new-func
const makeCue = new Function(...DEPS, `
  ${grabArrow('cueDevice')}
  ${grabArrow('cuePair')}
  ${NAMES.map(grabFn).join('\n')}
  return { ${NAMES.join(', ')}, cuePair, cueDevice };
`);

const FLX4 = { uid: 'uid:flx4', name: 'DDJ-FLX4', channels: 4, isDefault: false, isAggregate: false };
const SPEAKERS = { uid: 'uid:speakers', name: 'MacBook Pro Speakers', channels: 2, isDefault: true, isAggregate: false };
const BH2 = { uid: 'uid:bh2', name: 'BlackHole 2ch', channels: 2, isDefault: false, isAggregate: false };
const AGG_UID = 'com.poptart.aggregate';

/**
 * A desk with `out` as the chosen output device and `cue` as the saved cue setting, over a fixed
 * list of connected devices.
 */
function rig({ cue = null, out = FLX4, inputs = [] } = {}) {
  const devices = [FLX4, SPEAKERS, BH2];
  const settings = { audioCueDevice: cue, audioOutputDevice: out?.name ?? null, audioInputDevices: inputs };
  return makeCue(settings, () => devices, () => out);
}

// --- the offset, which is the whole thing ------------------------------------------------------

test('a cue on the output device is the pair, and nothing but the pair', () => {
  // The controller is the only device open: channels 3/4 of it, which is its headphone jack.
  const at = rig().cueOffsetIn({
    activeUid: FLX4.uid, aggregateUid: AGG_UID, layout: null, cueUid: FLX4.uid, pair: 1,
  });
  assert.equal(at, 2);
});

test('...and it is still the pair when the controller is inside the combined device', () => {
  // Extra inputs combined in means scsynth opens poptart's aggregate instead, with the output
  // device FIRST - so the member offset is 0 and the answer has to come out the same. This is
  // the real configuration: a controller for the sound, a loopback and an interface for inputs.
  const layout = { subDevices: [{ uid: FLX4.uid, outChannels: 4 }, { uid: BH2.uid, outChannels: 2 }] };
  const at = rig({ inputs: [BH2.uid] }).cueOffsetIn({
    activeUid: AGG_UID, aggregateUid: AGG_UID, layout, cueUid: FLX4.uid, pair: 1,
  });
  assert.equal(at, 2, 'the cue landed somewhere other than the controller\'s own second pair');
});

test('a separate cue device is the channels of everything ahead of it', () => {
  const layout = { subDevices: [{ uid: FLX4.uid, outChannels: 4 }, { uid: BH2.uid, outChannels: 2 }] };
  const at = rig().cueOffsetIn({
    activeUid: AGG_UID, aggregateUid: AGG_UID, layout, cueUid: BH2.uid, pair: 0,
  });
  assert.equal(at, 4, 'a second device starts after the output device\'s four channels');
});

test('a cue device that is not in the combined device is no cue at all', () => {
  const layout = { subDevices: [{ uid: FLX4.uid, outChannels: 4 }] };
  const at = rig().cueOffsetIn({
    activeUid: AGG_UID, aggregateUid: AGG_UID, layout, cueUid: BH2.uid, pair: 0,
  });
  assert.equal(at, null, 'an unplugged cue has to read as absent, not as offset 0');
});

test('pair 0 of the device being played through is refused, because that is the master out', () => {
  const at = rig().cueOffsetIn({
    activeUid: FLX4.uid, aggregateUid: AGG_UID, layout: null, cueUid: FLX4.uid, pair: 0,
  });
  assert.equal(at, null, 'this is the failure that plays the cue mix out of the speakers');
});

test('no cue, or no device open, is null rather than zero', () => {
  const c = rig();
  assert.equal(c.cueOffsetIn({ activeUid: FLX4.uid, aggregateUid: AGG_UID, cueUid: null }), null);
  assert.equal(c.cueOffsetIn({ activeUid: null, aggregateUid: AGG_UID, cueUid: FLX4.uid, pair: 1 }), null);
});

// --- the saved setting -------------------------------------------------------------------------

test('the pair survives whatever is in a hand-edited settings file', () => {
  const pairOf = (pair) => rig({ cue: { uid: FLX4.uid, name: FLX4.name, pair } }).cuePair();
  assert.equal(pairOf(1), 1);
  assert.equal(pairOf(undefined), 0, 'a cue saved before pairs existed is pair 0 of its own device');
  assert.equal(pairOf('2'), 2);
  assert.equal(pairOf(-3), 0);
  assert.equal(pairOf(1.7), 1);
  assert.equal(pairOf('nonsense'), 0);
});

test('a cue on a pair names its channels, because the device name alone names the master out', () => {
  assert.equal(
    rig({ cue: { uid: FLX4.uid, name: FLX4.name, pair: 1 } }).cueName(),
    'DDJ-FLX4 channels 3/4',
  );
  // A device of its own has only one pair in play, so its name says it all.
  assert.equal(rig({ cue: { uid: BH2.uid, name: BH2.name, pair: 0 } }).cueName(), 'BlackHole 2ch');
  assert.equal(rig().cueName(), null);
});

test('the output device is never a member of its own aggregate', () => {
  // CoreAudio cannot hold one device twice, and an aggregate built around the FLX4 that also
  // lists the FLX4 is either rejected or silently collapses - taking the cue offset with it.
  const withPairCue = rig({ cue: { uid: FLX4.uid, name: FLX4.name, pair: 1 }, inputs: [BH2.uid] });
  assert.deepEqual(withPairCue.aggregateExtraUids(), [BH2.uid]);
  // A cue device of its own still joins, which is what the aggregate is for.
  const withOwnCue = rig({ cue: { uid: BH2.uid, name: BH2.name, pair: 0 }, inputs: [] });
  assert.deepEqual(withOwnCue.aggregateExtraUids(), [BH2.uid]);
});

test('cueOnOutputDevice tells the two kinds of cue apart', () => {
  assert.equal(rig({ cue: { uid: FLX4.uid, name: FLX4.name, pair: 1 } }).cueOnOutputDevice(), true);
  assert.equal(rig({ cue: { uid: BH2.uid, name: BH2.name, pair: 0 } }).cueOnOutputDevice(), false);
  assert.equal(rig().cueOnOutputDevice(), false);
});

// --- what the picker may offer -----------------------------------------------------------------

test('only a device with a spare pair offers one', () => {
  assert.deepEqual(rig({ out: FLX4 }).cuePairChoices(), { device: 'DDJ-FLX4', pairs: [1] });
  // The usual two-channel device has nowhere else to send a cue, so the option is not offered -
  // which is what keeps this out of the way of everybody who has no controller plugged in.
  assert.deepEqual(rig({ out: SPEAKERS }).cuePairChoices(), { device: 'MacBook Pro Speakers', pairs: [] });
});

test('a six-output interface offers both of its spare pairs', () => {
  const six = { uid: 'uid:six', name: 'Scarlett 6i6', channels: 6, isDefault: false, isAggregate: false };
  assert.deepEqual(rig({ out: six }).cuePairChoices().pairs, [1, 2]);
});

// --- and the one thing the arithmetic cannot protect -------------------------------------------

test('playback is capped so an orbit cannot be sent into the cue pair', () => {
  // .o(n) wraps at the "output channels" setting, and on a four-output controller a setting of 4
  // would put orbit 1 on channels 3/4 - the headphones. Asserted on the source because the cap
  // is computed where the engine is constructed, which a unit test cannot reach.
  const at = SRC.indexOf('playChannels: Math.max(2, Math.min(');
  assert.ok(at > 0, 'the playback channel count is no longer capped - an orbit can reach the cue pair');
  assert.match(SRC.slice(at, at + 420), /activeCue && cueOnOut \? activeCue\.offset : Infinity/);
});
