// Audio device enumeration + aggregate management. The CoreAudio work itself lives in the
// poptart-audio Swift helper and is exercised by a manual checklist (creating an aggregate mutates
// the machine's audio configuration, so no test does it); what's pinned here is the contract the
// rest of poptart depends on - the device shape, and that everything degrades rather than throws
// when the helper isn't there.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const devices = require('./audio-devices');

const HELPER = path.join(__dirname, 'native', 'bin', 'poptart-audio');
const onMac = process.platform === 'darwin';

test('the prebuilt helper is committed, so installing poptart needs no Swift toolchain', (t) => {
  if (!onMac) return t.skip('macOS-only helper');
  assert.ok(fs.existsSync(HELPER), `expected a committed binary at ${HELPER} - rebuild it with native/build.sh`);
  assert.ok(fs.statSync(HELPER).mode & 0o111, 'the helper must be executable');
});

test('helperAvailable() is false off macOS whatever is on disk', () => {
  assert.equal(devices.helperAvailable(), onMac && fs.existsSync(HELPER));
});

test('listDevices() returns the documented shape', () => {
  const list = devices.listDevices();
  assert.ok(Array.isArray(list));
  for (const d of list) {
    assert.equal(typeof d.name, 'string');
    assert.equal(typeof d.inChannels, 'number');
    assert.equal(typeof d.outChannels, 'number');
    assert.ok(d.inChannels >= 0 && d.outChannels >= 0, 'channel counts are non-negative');
    assert.equal(typeof d.isAggregate, 'boolean');
  }
});

test('listInputDevices()/listOutputDevices() are the channel-count filters of listDevices()', () => {
  const all = devices.listDevices();
  assert.deepEqual(devices.listInputDevices().map((d) => d.name), all.filter((d) => d.inChannels > 0).map((d) => d.name));
  assert.deepEqual(devices.listOutputDevices().map((d) => d.name), all.filter((d) => d.outChannels > 0).map((d) => d.name));
});

test('deviceLayout() of an unknown UID reports null rather than throwing', () => {
  assert.equal(devices.deviceLayout('definitely-not-a-device-uid'), null);
  assert.equal(devices.deviceLayout(null), null, 'no UID (the system default) has no layout to read');
});

test('every real input device resolves to a layout whose channels sum to its own', (t) => {
  if (!devices.helperAvailable()) return t.skip('no helper on this system');
  for (const d of devices.listInputDevices()) {
    if (!d.uid) continue;
    const layout = devices.deviceLayout(d.uid);
    assert.ok(layout, `expected a layout for ${d.name}`);
    const summed = layout.subDevices.reduce((n, s) => n + s.inChannels, 0);
    // This is the invariant input()'s channel offsets rest on: the aggregate's own channel count
    // is the concatenation of its ACTIVE subdevices'. If it ever fails, offsets are lies.
    assert.equal(summed, layout.inChannels,
      `${d.name}: subdevice channels (${summed}) should sum to the device's ${layout.inChannels}`);
  }
});

test('rebuildAggregate() refuses an empty device list instead of making a broken device', () => {
  assert.throws(() => devices.rebuildAggregate([]), /at least one device|not available/);
});

test('the managed aggregate has a fixed UID, so rebuilding replaces rather than accumulates', () => {
  assert.equal(typeof devices.AGGREGATE_UID, 'string');
  assert.ok(devices.AGGREGATE_UID.length > 0);
});
