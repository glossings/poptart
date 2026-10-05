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

// --- the memo -----------------------------------------------------------------------------------
//
// Listing devices spawns the helper and waits for it - about 95ms. That is fine for a settings tab
// and not fine as a side effect: the note scheduler shares this process behind a 150ms lookahead,
// so a stray listing is a gap in the music on every playing deck. Two of them in one request made
// opening the library browser mid-set audible, which is what this memo exists to stop.
//
// It is NOT a cache of what is plugged in. The window is short, so that the several questions one
// request asks cost one spawn between them, and anything that changes the configuration clears it.

test('a repeated listing inside the window costs nothing and says the same thing', (t) => {
  if (!devices.helperAvailable()) return t.skip('needs the helper to have something to memoize');
  devices.forgetDevices();
  const cold = process.hrtime.bigint();
  const first = devices.listDevices();
  const coldMs = Number(process.hrtime.bigint() - cold) / 1e6;
  const warm = process.hrtime.bigint();
  const second = devices.listDevices();
  const warmMs = Number(process.hrtime.bigint() - warm) / 1e6;
  assert.deepEqual(second, first, 'the memo must answer exactly what the helper did');
  // Generous, because this is about orders of magnitude: the point is that the second answer did
  // not spawn anything. A real spawn cannot come back in a millisecond.
  assert.ok(warmMs < 5, `the second listing took ${warmMs.toFixed(1)}ms - it spawned the helper again`);
  assert.ok(coldMs >= warmMs, 'the cold listing should be the expensive one');
});

test('{ fresh: true } reads past the memo', (t) => {
  if (!devices.helperAvailable()) return t.skip('needs the helper');
  devices.listDevices(); // warm it
  const at = process.hrtime.bigint();
  devices.listDevices({ fresh: true });
  const ms = Number(process.hrtime.bigint() - at) / 1e6;
  assert.ok(ms > 5, `a forced read came back in ${ms.toFixed(1)}ms - it was answered from the memo`);
});

test('the filtered listings are filters of the memoized one, not extra spawns', (t) => {
  if (!devices.helperAvailable()) return t.skip('needs the helper');
  const all = devices.listDevices();
  const at = process.hrtime.bigint();
  const outs = devices.listOutputDevices();
  const ins = devices.listInputDevices();
  const ms = Number(process.hrtime.bigint() - at) / 1e6;
  assert.ok(ms < 5, `the filters took ${ms.toFixed(1)}ms - each one listed again`);
  assert.deepEqual(outs, all.filter((d) => d.outChannels > 0));
  assert.deepEqual(ins, all.filter((d) => d.inChannels > 0));
});

test('forgetDevices() is what anything changing the configuration owes the memo', () => {
  // Asserted on the source: the two functions that mutate the machine's audio setup have to clear
  // it, or a listing straight after a rebuild describes the device that was just replaced.
  const src = fs.readFileSync(path.join(__dirname, 'audio-devices.js'), 'utf8');
  for (const fn of ['rebuildAggregate', 'destroyAggregate']) {
    const at = src.indexOf(`function ${fn}(`);
    assert.ok(at > 0, `${fn} not found - this test needs updating`);
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.match(body, /forgetDevices\(\)/, `${fn} changes the devices without clearing the memo`);
  }
});
