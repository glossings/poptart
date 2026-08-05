'use strict';

// Unit tests for the audio device policy (audio-selection.js). The case that motivated all of it,
// and the one pinned hardest below: an aggregate built around a pair of EarPods, the EarPods
// unplugged, and the aggregate left holding nothing but a BlackHole loopback - which the engine
// used to open and play into, meters moving, in complete silence.

const { test } = require('node:test');
const assert = require('node:assert');

const { plainOutputDevice, deviceToOpen, aggregateProblem, aggregateMembers } = require('./audio-selection.js');

const AGG = 'com.poptart.aggregate';

const speakers = { uid: 'BuiltInSpeakerDevice', name: 'MacBook Pro Speakers', channels: 2, inChannels: 0, isDefault: true };
const blackhole = { uid: 'BlackHole2ch_UID', name: 'BlackHole 2ch', channels: 2, inChannels: 2, isDefault: false };
const earpods = { uid: 'EarPods:1', name: 'EarPods', channels: 2, inChannels: 0, isDefault: false };
const aggregate = { uid: AGG, name: 'poptart', channels: 4, inChannels: 2, isDefault: false };

const devices = [speakers, blackhole, earpods, aggregate];

test('plainOutputDevice: the saved name wins, the default is the fallback, never the aggregate', () => {
  assert.strictEqual(plainOutputDevice(devices, 'BlackHole 2ch', AGG).device, blackhole);
  assert.strictEqual(plainOutputDevice(devices, null, AGG).device, speakers);
  // The aggregate is a device like any other in the list, and must never be picked as the *plain*
  // output - that's what would make it its own clock master.
  assert.strictEqual(plainOutputDevice(devices, 'poptart', AGG).device, speakers);
});

test('plainOutputDevice: a saved device that is gone falls back to the default, and says so', () => {
  const { device, warning } = plainOutputDevice(devices, 'Scarlett 18i20', AGG);
  assert.strictEqual(device, speakers);
  assert.match(warning, /not connected/);
});

test('deviceToOpen: no extra inputs means the plain output device', () => {
  const { device } = deviceToOpen({ devices, wanted: 'MacBook Pro Speakers', inputUids: [], aggregateUid: AGG });
  assert.strictEqual(device, speakers);
});

test('deviceToOpen: with extra inputs and a healthy aggregate, the aggregate', () => {
  const layout = { subDevices: [speakers, blackhole], missing: [] };
  const { device, warning } = deviceToOpen({
    devices, wanted: 'MacBook Pro Speakers', inputUids: [blackhole.uid], aggregateUid: AGG, layout,
  });
  assert.strictEqual(device, aggregate);
  assert.strictEqual(warning, null);
});

test('deviceToOpen: an aggregate that no longer holds the output device is NOT a playback path', () => {
  // The real-world state: built around EarPods, EarPods unplugged, only the loopback left.
  const layout = { subDevices: [blackhole], missing: ['EarPods:1', 'EarPods:2'] };
  const { device, warning } = deviceToOpen({
    devices, wanted: 'MacBook Pro Speakers', inputUids: [blackhole.uid], aggregateUid: AGG, layout,
  });
  assert.strictEqual(device, speakers, 'must fall back to the speakers, not play into the loopback');
  assert.match(warning, /no longer contains "MacBook Pro Speakers"/);
});

test('deviceToOpen: missing members alone do not move playback off the aggregate', () => {
  // The output device is still in there, so the aggregate still reaches the speakers; only the
  // input channel numbering is affected, which is a warning, not a reason to tear playback out.
  const layout = { subDevices: [speakers, blackhole], missing: ['EarPods:2'] };
  const { device } = deviceToOpen({
    devices, wanted: 'MacBook Pro Speakers', inputUids: [blackhole.uid, 'EarPods:2'], aggregateUid: AGG, layout,
  });
  assert.strictEqual(device, aggregate);
});

test('deviceToOpen: a configured aggregate that does not exist falls back and says so', () => {
  const { device, warning } = deviceToOpen({
    devices: [speakers, blackhole], wanted: null, inputUids: [blackhole.uid], aggregateUid: AGG,
  });
  assert.strictEqual(device, speakers);
  assert.match(warning, /configured but missing/);
});

test('deviceToOpen: an unreadable layout leaves the aggregate trusted', () => {
  // No helper, no layout, nothing to check against - the old behaviour, rather than second-guessing
  // an aggregate we cannot see inside.
  const { device } = deviceToOpen({
    devices, wanted: 'MacBook Pro Speakers', inputUids: [blackhole.uid], aggregateUid: AGG, layout: null,
  });
  assert.strictEqual(device, aggregate);
});

test('aggregateProblem: names the two failures, and is silent when healthy', () => {
  assert.strictEqual(aggregateProblem({ layout: { subDevices: [speakers, blackhole], missing: [] }, outDevice: speakers }), null);
  assert.strictEqual(aggregateProblem({ layout: null, outDevice: speakers }), null);

  const gone = aggregateProblem({ layout: { subDevices: [blackhole], missing: ['EarPods:1'] }, outDevice: speakers });
  assert.strictEqual(gone.kind, 'no-output-member');

  const short = aggregateProblem({ layout: { subDevices: [speakers, blackhole], missing: ['EarPods:2'] }, outDevice: speakers });
  assert.strictEqual(short.kind, 'missing-members');
  assert.match(short.message, /EarPods:2/);
});

test('aggregateMembers: output device first, and never twice', () => {
  assert.deepStrictEqual(aggregateMembers('OUT', ['MIC', 'BH']), ['OUT', 'MIC', 'BH']);
  // Picking the output device as an extra input too is the ordinary case for an interface that
  // does both - it stays the clock master and does not get a second membership.
  assert.deepStrictEqual(aggregateMembers('OUT', ['OUT', 'BH']), ['OUT', 'BH']);
});
