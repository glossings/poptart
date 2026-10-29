'use strict';

// What a device window is told is DRIVING a control (deviceSlot().driven): a pattern that keeps
// putting its value back is named, so the window can refuse to fight it; a value the code merely
// sets - `.param("Mode", "asym")`, which is what the window's own pickers write - is not, so the
// window stays free to change it. No scsynth: the engine is built offline and its sends stubbed.

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index');
const { nativeDevice } = require('./native-devices');

function engineWithDistort() {
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  engine.getTime = () => 0;
  engine._send = () => {};
  const device = nativeDevice('Distort');
  assert.ok(device, 'the Distort device is in the catalog');
  engine._rememberDevice('bass:2', device);
  return engine;
}

test('a steady value is a setting, not a driver; a pattern is named', () => {
  const engine = engineWithDistort();
  engine.holdParam('bass', 2, 'Mode', { steady: true });
  engine.holdParam('bass', 2, 'Drive', { steady: false });
  assert.deepStrictEqual(engine.deviceSlot('bass', 2).driven, { drive: 'pattern' });
});

test('a hold with nothing said about it is a pattern, as before', () => {
  const engine = engineWithDistort();
  engine.holdParam('bass', 2, 'Mode');
  assert.deepStrictEqual(engine.deviceSlot('bass', 2).driven, { mode: 'pattern' });
});

test('a release takes the driver off, and a steady hold after a pattern does too', () => {
  const engine = engineWithDistort();
  engine.holdParam('bass', 2, 'Drive', { steady: false });
  engine.releaseParam('bass', 2, 'Drive', 0);
  assert.deepStrictEqual(engine.deviceSlot('bass', 2).driven, {});
  engine.holdParam('bass', 2, 'Drive', { steady: false });
  engine.holdParam('bass', 2, 'Drive', { steady: true });
  assert.deepStrictEqual(engine.deviceSlot('bass', 2).driven, {});
});
