'use strict';

// Unit tests for the audio device policy (audio-selection.js). The case that motivated all of it,
// and the one pinned hardest below: an aggregate built around a pair of EarPods, the EarPods
// unplugged, and the aggregate left holding nothing but a BlackHole loopback - which the engine
// used to open and play into, meters moving, in complete silence.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  plainOutputDevice, deviceToOpen, playbackChannels, aggregateProblem, aggregateMembers,
  splitConnected, aggregateStaleReason,
} = require('./audio-selection.js');

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
  // deviceToOpen's warning is the console's, so it carries the long form.
  assert.match(warning, /does not include "MacBook Pro Speakers"/);
  assert.match(warning, /clock master/);
  assert.match(warning, /no longer connected/); // names the cause: unplugged hardware
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

test('playbackChannels: a plain device offers all of its own channels', () => {
  assert.strictEqual(playbackChannels({ devices, wanted: null, active: speakers, aggregateUid: AGG }), 2);
  assert.strictEqual(playbackChannels({
    devices, wanted: null, active: { ...speakers, channels: 8 }, aggregateUid: AGG,
  }), 8);
});

test('playbackChannels: the aggregate offers only the playback device\'s channels', () => {
  // Stereo speakers plus a stereo loopback is a FOUR-channel aggregate, and .o(2) wrapping at four
  // wrote pair 2 into the loopback - audible nowhere, meters moving. It has to wrap at two.
  assert.strictEqual(playbackChannels({
    devices, wanted: 'MacBook Pro Speakers', active: aggregate, aggregateUid: AGG,
  }), 2);
});

test('playbackChannels: an aggregate around a wider device keeps that device\'s pairs', () => {
  const scarlett = { uid: 'Scarlett:1', name: 'Scarlett 18i20', channels: 8, inChannels: 8, isDefault: false };
  const wide = { uid: AGG, name: 'poptart', channels: 10, inChannels: 10, isDefault: false };
  assert.strictEqual(playbackChannels({
    devices: [speakers, blackhole, scarlett, wide], wanted: 'Scarlett 18i20', active: wide, aggregateUid: AGG,
  }), 8);
});

test('playbackChannels: no device at all still leaves a stereo pair to wrap at', () => {
  assert.strictEqual(playbackChannels({ devices: [], wanted: null, active: null, aggregateUid: AGG }), 2);
  // An aggregate whose playback device has vanished from the list must not report zero pairs.
  assert.strictEqual(playbackChannels({
    devices: [aggregate], wanted: 'EarPods', active: aggregate, aggregateUid: AGG,
  }), 4);
});

test('aggregateProblem: names the two failures, and is silent when healthy', () => {
  assert.strictEqual(aggregateProblem({ layout: { subDevices: [speakers, blackhole], missing: [] }, outDevice: speakers }), null);
  assert.strictEqual(aggregateProblem({ layout: null, outDevice: speakers }), null);

  const gone = aggregateProblem({ layout: { subDevices: [blackhole], missing: ['EarPods:1'] }, outDevice: speakers });
  assert.strictEqual(gone.kind, 'no-output-member');
  assert.match(gone.detail, /no longer connected/);

  // Same failure, different cause: nothing is unplugged, so the aggregate was simply built around
  // some other output device - and the detail says that instead of blaming absent hardware.
  const rekeyed = aggregateProblem({ layout: { subDevices: [blackhole], missing: [] }, outDevice: speakers });
  assert.strictEqual(rekeyed.kind, 'no-output-member');
  assert.match(rekeyed.detail, /a different output device/);

  const short = aggregateProblem({ layout: { subDevices: [speakers, blackhole], missing: ['EarPods:2'] }, outDevice: speakers });
  assert.strictEqual(short.kind, 'missing-members');
  assert.match(short.detail, /EarPods:2/);
  assert.match(short.detail, /1 device that is configured but not plugged in/);
});

// The UI line is a sidebar line, not an essay: what is wrong, and what to press. Everything that
// explains WHY lives in the detail, which goes to the console and the tooltip.
test('aggregateProblem: the UI message stays short and says what to press', () => {
  const cases = [
    aggregateProblem({ layout: { subDevices: [blackhole], missing: ['EarPods:1'] }, outDevice: speakers }),
    aggregateProblem({ layout: { subDevices: [speakers, blackhole], missing: ['EarPods:2'] }, outDevice: speakers }),
  ];
  for (const problem of cases) {
    assert.ok(problem.message.length <= 90, `too long for a sidebar: ${problem.message}`);
    assert.match(problem.message, /press apply/);
    assert.ok(!/clock master|drift-correct/.test(problem.message), 'the explanation belongs in detail');
    assert.ok(problem.detail.length > problem.message.length, 'detail carries the full story');
  }
});

// The dead end this prevents, exactly as it happened: EarPods unplugged, still in the saved
// selection, no checkbox for them (the tab only draws connected devices), and the server rejecting
// every apply because of them - so the aggregate could never be rebuilt from the UI at all.
test('splitConnected: an unplugged device is set aside, not a reason to reject the request', () => {
  const known = ['BuiltInSpeakerDevice', 'BlackHole2ch_UID'];
  const { present, absent } = splitConnected(['BlackHole2ch_UID', 'EarPods:2'], known);
  assert.deepStrictEqual(present, ['BlackHole2ch_UID'], 'the aggregate still gets built');
  assert.deepStrictEqual(absent, ['EarPods:2'], 'and the missing one is reported, not fatal');
});

test('splitConnected: order is preserved, and everything-present is the ordinary case', () => {
  const known = ['A', 'B', 'C'];
  assert.deepStrictEqual(splitConnected(['C', 'A'], known), { present: ['C', 'A'], absent: [] });
  assert.deepStrictEqual(splitConnected([], known), { present: [], absent: [] });
  // Every selected device gone (interface pulled between sessions): nothing to build, all reported.
  assert.deepStrictEqual(splitConnected(['X', 'Y'], known), { present: [], absent: ['X', 'Y'] });
});

// The heal check that runs on every engine start - the thing that means an unplugged interface
// costs you a restart rather than a trip to the settings tab.
test('aggregateStaleReason: silent when the aggregate is already exactly right', () => {
  const layout = { subDevices: [speakers, blackhole], missing: [] };
  assert.strictEqual(
    aggregateStaleReason({ layout, outUid: speakers.uid, wantUids: [blackhole.uid] }),
    null,
  );
});

test('aggregateStaleReason: rebuilds a stale, absent, or reordered aggregate', () => {
  const want = [blackhole.uid, 'MIC'];
  // The state this whole thread started in: built around hardware that is gone.
  assert.match(
    aggregateStaleReason({ layout: { subDevices: [blackhole] }, outUid: speakers.uid, wantUids: [blackhole.uid] }),
    /does not include the output device/,
  );
  assert.match(
    aggregateStaleReason({ layout: null, outUid: speakers.uid, wantUids: [blackhole.uid] }),
    /does not exist/,
  );
  // A member came back, or went away: the set no longer matches.
  assert.match(
    aggregateStaleReason({ layout: { subDevices: [speakers, blackhole] }, outUid: speakers.uid, wantUids: want }),
    /no longer match/,
  );
  // Same devices, different order - which IS a different channel numbering for input().
  assert.match(
    aggregateStaleReason({
      layout: { subDevices: [speakers, { uid: 'MIC' }, blackhole] },
      outUid: speakers.uid,
      wantUids: want,
    }),
    /no longer match/,
  );
});

test('aggregateStaleReason: nothing connected means no aggregate at all', () => {
  // An aggregate of the output device alone buys nothing over opening that device directly.
  assert.match(
    aggregateStaleReason({ layout: { subDevices: [speakers] }, outUid: speakers.uid, wantUids: [] }),
    /nothing selected is plugged in/,
  );
  // ...and once it's gone there is nothing left to do about it.
  assert.strictEqual(aggregateStaleReason({ layout: null, outUid: speakers.uid, wantUids: [] }), null);
  // No output device to build around at all: deviceToOpen handles that, this stays out of it.
  assert.strictEqual(aggregateStaleReason({ layout: null, outUid: null, wantUids: [blackhole.uid] }), null);
});

test('aggregateProblem: reports selected-but-unplugged devices by name', () => {
  // `absent` comes from the settings-vs-connected comparison and is passed pre-named, which is
  // what keeps a raw CoreAudio UID out of the sidebar.
  const problem = aggregateProblem({
    layout: { subDevices: [speakers, blackhole], missing: [] },
    outDevice: speakers,
    absent: ['EarPods'],
  });
  assert.strictEqual(problem.kind, 'missing-members');
  assert.match(problem.detail, /EarPods/);
  assert.ok(!/AppleUSBAudioEngine/.test(problem.detail));
});

test('aggregateMembers: output device first, and never twice', () => {
  assert.deepStrictEqual(aggregateMembers('OUT', ['MIC', 'BH']), ['OUT', 'MIC', 'BH']);
  // Picking the output device as an extra input too is the ordinary case for an interface that
  // does both - it stays the clock master and does not get a second membership.
  assert.deepStrictEqual(aggregateMembers('OUT', ['OUT', 'BH']), ['OUT', 'BH']);
});
