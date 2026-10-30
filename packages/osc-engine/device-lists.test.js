'use strict';

// A list for a device control that takes one (a filter bank's Levels, the Resonator's Scale) on
// the desktop: handed over as a drawn curve is - its floats outright, into an option slot - and the
// control pointed at that slot on the list's beat. The browser does the same with the same slots
// (web-engine's _loadListParam and spareListSlot). No engine boot: the OSC sends are captured.

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index.js');
const { nativeDevice, paramPosition } = require('./native-devices');

function engine() {
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  const clock = { now: 0 };
  e.getTime = () => clock.now;
  const sent = [];
  e._send = (addr, args) => sent.push({ addr, args });
  e._warnOnce = () => {};
  return { e, sent, clock };
}

const lists = (sent) => sent.filter((m) => m.addr === '/poptart/deviceShape').map((m) => m.args);
const selects = (sent, name) => sent.filter((m) => m.addr === '/poptart/setParam' && m.args[2] === name).map((m) => m.args);

test('a device names the controls of its that take a list, and what kind of list', () => {
  const { e } = engine();
  e.loadEffect('t', 'Resonator', 1);
  const wants = e.listParams('t', 1);
  assert.deepStrictEqual(wants.map((w) => [w.id, w.takes]), [['levels', 'list'], ['scale', 'scale']]);
  assert.strictEqual(e.listParams('t', 2), null);
  // A different device in the slot is a new epoch: what the last one was handed is not this one's.
  const before = wants[0].epoch;
  e.loadEffect('t', 'Filterbank', 1);
  assert.notStrictEqual(e.listParams('t', 1)[0].epoch, before);
});

test('a list goes over as its floats, into a slot past the control\'s own, and the control is pointed at it', () => {
  const { e, sent } = engine();
  e.loadEffect('t', 'Filterbank', 1);
  const device = nativeDevice('Filterbank');
  const levels = device.params.findIndex((p) => p.id === 'levels');
  e.setParam('t', 1, 'levels', { list: [0, 0.5, 1, 0.5, 1, 0.25] }, 2);
  const [one] = lists(sent);
  assert.deepStrictEqual(one.slice(0, 4), ['t', 1, levels, 1]);
  assert.deepStrictEqual(one.slice(4), [0, 0.5, 1, 0.5, 1, 0.25]);
  const [select] = selects(sent, 'levels');
  assert.strictEqual(select[3], paramPosition(device, 'levels', 1));
  // The same list again is a lookup: no table, only the control.
  e.setParam('t', 1, 'levels', { list: [0, 0.5, 1, 0.5, 1, 0.25] }, 3);
  assert.strictEqual(lists(sent).length, 1);
  assert.strictEqual(selects(sent, 'levels').length, 2);
  // A cycle of rests crosses as the one triple that covers nothing.
  e.setParam('t', 1, 'levels', { list: [] }, 4);
  assert.deepStrictEqual(lists(sent).at(-1).slice(4), [0, 0, 0]);
});

test('a new list never lands in the slot in force, or one due later', () => {
  const { e, sent, clock } = engine();
  e.loadEffect('t', 'Filterbank', 1);
  clock.now = 10;
  e.setParam('t', 1, 'levels', { list: [0, 1, 1] }, 10);     // slot 1, in force from 10
  e.setParam('t', 1, 'levels', { list: [0, 1, 0.5] }, 11);   // slot 2, due at 11
  e.setParam('t', 1, 'levels', { list: [0, 1, 0.25] }, 12);  // slot 3: 1 is in force, 2 is due
  assert.deepStrictEqual(lists(sent).map((a) => a[3]), [1, 2, 3]);
  clock.now = 12.5;                                          // 3 is in force now; 1 and 2 are done
  e.setParam('t', 1, 'levels', { list: [0, 1, 0.75] }, 13);
  assert.strictEqual(lists(sent).at(-1)[3], 1);
});

test('the Resonator\'s scale goes the same way, and a different device forgets the lists', () => {
  const { e, sent } = engine();
  e.loadEffect('t', 'Resonator', 1);
  e.setParam('t', 1, 'scale', { list: [62, 12, 0, 2, 3, 5, 7, 9, 10] }, 1);
  assert.deepStrictEqual(lists(sent)[0].slice(3), [1, 62, 12, 0, 2, 3, 5, 7, 9, 10]);
  e.loadEffect('t', 'Filterbank', 1);
  e.loadEffect('t', 'Resonator', 1);
  e.setParam('t', 1, 'scale', { list: [62, 12, 0, 2, 3, 5, 7, 9, 10] }, 2);
  assert.strictEqual(lists(sent).length, 2, 'handed over again to the device that is new');
});

test('a saved state leaves the lists out, and a restore has the scheduler hand them over again', async () => {
  const { e, sent } = engine();
  e.loadEffect('t', 'Resonator', 1);
  e.setParam('t', 1, 'scale', { list: [62, 12, 0, 2, 3, 5, 7, 9, 10], label: 'D dorian' }, 0);
  e.setParam('t', 1, 'levels', { list: [0, 1, 0.5] }, 0);
  assert.strictEqual(e.deviceSlot('t', 1).files.scale[1], 'D dorian', 'the window names the scale');
  const preset = await e.getPluginState('t', 1);
  const doc = JSON.parse(Buffer.from(String(preset), 'base64').toString().replace(/^[^{]*/, ''));
  assert.ok(!('levels' in (doc.params ?? {})) && !('scale' in (doc.params ?? {})), 'the lists are the pattern\'s, not the preset\'s');
  const before = e.listParams('t', 1)[0].epoch;
  e.setPluginState('t', 1, preset);
  await e._stateIdle();
  assert.ok(sent.some((m) => m.addr === '/poptart/setPluginState'));
  assert.notStrictEqual(e.listParams('t', 1)[0].epoch, before, 'a restored device is handed its lists again');
});

test('an open count is said to the device when it is sent, once per change, so room is made ahead', () => {
  const { e, sent } = engine();
  e.loadEffect('t', 'Filterbank', 1);
  const bands = nativeDevice('Filterbank').params.findIndex((p) => p.id === 'bands');
  e.setParam('t', 1, 'bands', 200, 5);
  e.setParam('t', 1, 'bands', 200, 6);
  const hints = lists(sent).filter((a) => a[2] === bands);
  assert.deepStrictEqual(hints, [['t', 1, bands, -1, 200]]);
});
