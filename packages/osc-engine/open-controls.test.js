'use strict';

// The desktop's reading of the controls that have no top any more (web-engine's
// open-controls.test.mjs is the browser's): a voice count written as a position before it was
// open plays the voices it played then, a count is the count past the knob's reach, and an
// enum that takes files takes any index. Read through the catalog the build writes
// (native/devices/devices.json) and native-devices.js's paramPosition, which is what a
// `.param()` on the desktop goes through.

const { test } = require('node:test');
const assert = require('node:assert');

const { nativeDevice, deviceParam, paramPosition } = require('./native-devices');

function valueOf(param, position) {
  const t = Math.max(0, position);
  return Math.round(param.min + (param.max - param.min) * t);
}

test('an old voice position plays the old count; a count is the count; a file enum has no top', (t) => {
  if (!nativeDevice('Wavetable')) { t.skip('no device catalog in this checkout'); return; }
  for (const [id, oldTop] of [['Wavetable', 16], ['Noise', 16], ['FM', 12], ['Granular', 8]]) {
    const device = nativeDevice(id);
    const voices = deviceParam(device, 'voices');
    assert.equal(voices.open, true, `${id}'s voices are open in the catalog`);
    assert.equal(voices.legacyMax, oldTop);
    for (let count = 1; count < oldTop; count++) {
      const written = Number(((count - 1) / (oldTop - 1)).toPrecision(4));
      assert.equal(valueOf(voices, paramPosition(device, 'voices', written)), count, `${id}: ${written}`);
    }
    for (const n of [1, 8, 40, 300]) assert.equal(valueOf(voices, paramPosition(device, 'voices', n)), n, `${id}: ${n} voices`);
  }
  for (const [id, name] of [['Wavetable', 'osc1.table'], ['Distort', 'mode'], ['Convolver', 'ir'], ['Granular', 'sample'], ['Granular', 'window']]) {
    const device = nativeDevice(id);
    const param = deviceParam(device, name);
    assert.equal(param.open, true, `${id} ${name} is open`);
    for (const i of [0, 3, 63, 200]) assert.equal(valueOf(param, paramPosition(device, name, i)), i, `${id} ${name}: ${i}`);
    assert.equal(valueOf(param, paramPosition(device, name, param.options[0])), 0);
  }
});
