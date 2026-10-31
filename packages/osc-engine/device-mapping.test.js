'use strict';

// A preset loaded into one of poptart's own devices (server/device.js's readProgram) sets every
// control outright, and the UGen takes a control off its bus on an outright set. A control a knob
// or a modulator drives has to go back on its bus after the load, or it stops following - the
// Looper's Mix sat at the preset's value while its knob turned (2026-10-31).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DeviceController, DeviceDesc } = require('./server/device.js');

function controller() {
  const ctl = new DeviceController({ on: () => () => {} }, { nodeID: 1000 }, 0);
  ctl.info = new DeviceDesc('Looper', [{ id: 'record', name: 'Record' }, { id: 'mix', name: 'Mix' }]);
  ctl._positions = [0, 0.5];
  const sent = [];
  ctl.sendMsg = (cmd, ...args) => sent.push([cmd, ...args.map((a) => (a && typeof a === 'object' ? a.value : a))]);
  return { ctl, sent };
}

function program(params) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-devmap-')), 'program.json');
  fs.writeFileSync(file, JSON.stringify({ device: 'Looper', params }));
  return file;
}

test('a program loaded under a driven control puts it back on its bus', () => {
  const { ctl, sent } = controller();
  ctl.map(1, 42);
  let ok = null;
  ctl.readProgram(program({ Record: 0, Mix: 1 }), (_self, done) => { ok = done; });
  assert.strictEqual(ok, true);
  const set = sent.findIndex((m) => m[0] === '/set' && m[1] === 1);
  const remap = sent.findLastIndex((m) => m[0] === '/map' && m[1] === 1 && m[2] === 42);
  assert.ok(set >= 0 && remap > set, `Mix was not mapped back after the load: ${JSON.stringify(sent)}`);
  assert.ok(!sent.slice(set).some((m) => m[0] === '/map' && m[1] === 0), 'a control nothing drives is left where the program put it');
});

test('a control taken off its bus stays off through a later load', () => {
  const { ctl, sent } = controller();
  ctl.map(1, 42);
  ctl.unmap(1);
  ctl.readProgram(program({ Mix: 1 }));
  assert.ok(!sent.some((m, i) => i > 1 && m[0] === '/map'), `remapped after an unmap: ${JSON.stringify(sent)}`);

  const again = controller();
  again.ctl.map(1, 42);
  again.ctl.set(1, 0.3); // an outright set takes it off in the UGen, and so here too
  again.ctl.readProgram(program({ Mix: 1 }));
  assert.ok(!again.sent.slice(2).some((m) => m[0] === '/map'), `remapped after a set: ${JSON.stringify(again.sent)}`);
});
