'use strict';

// OscEngine's half of param expressions: what goes over OSC, what a fresh Scheduler reads back,
// and that a leaf name ("~i~name") reaches sclang as a plain number even on a device's slot.

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index.js');

function engine() {
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  const sent = [];
  e._send = (addr, args) => sent.push({ addr, args });
  return { e, sent };
}

const TREE = { k: 'op', op: 'mul', a: [{ k: 'in', i: 0, rate: 'ar', source: 'kick' }, { k: 'const', v: 0.5 }] };

test('an expression is sent as JSON, remembered per control, and forgotten on a clear or a destroy', () => {
  const { e, sent } = engine();
  e.setParamExpr('t1', 0, 'Cutoff', TREE);
  assert.deepStrictEqual(sent.at(-1), { addr: '/poptart/setParamExpr', args: ['t1', 0, 'Cutoff', JSON.stringify(TREE)] });
  assert.deepStrictEqual([...e.paramExprs('t1')], [['0:Cutoff', JSON.stringify(TREE)]]);
  // What it hands back is a copy: a Scheduler editing it does not edit the engine's record.
  e.paramExprs('t1').clear();
  assert.strictEqual(e.paramExprs('t1').size, 1);
  e.clearParamExpr('t1', 0, 'Cutoff');
  assert.deepStrictEqual(sent.at(-1), { addr: '/poptart/clearParamExpr', args: ['t1', 0, 'Cutoff'] });
  assert.strictEqual(e.paramExprs('t1').size, 0);
  e.setParamExpr('t2', -1, 'pan', TREE);
  e.destroyTrack('t2');
  assert.strictEqual(e.paramExprs('t2').size, 0);
  assert.strictEqual(e.paramExprs('nobody').size, 0);
});

test('the retired audio routes are gone from the public API', () => {
  const { e } = engine();
  for (const name of ['connectParam', 'disconnectParam', 'paramRoutes']) assert.strictEqual(typeof e[name], 'undefined', name);
});

test('a leaf name takes a plain number, unconverted and unclipped, whatever is in the slot', () => {
  const { e, sent } = engine();
  // A device in the slot would read "~1~level" as a control it has not got; the leaf is not one.
  e._slotDevices.set('t1:0', { id: 'noise', params: [{ id: 'level', name: 'Level', min: 0, max: 1, default: 1 }] });
  e.setParam('t1', 0, '~1~Level', 3.5);
  assert.deepStrictEqual(sent.at(-1).addr, '/poptart/setParam');
  assert.deepStrictEqual(sent.at(-1).args.slice(0, 4), ['t1', 0, '~1~Level', 3.5]);
  const before = sent.length;
  e.setParam('t1', 0, '~1~Level', 'loud');
  assert.strictEqual(sent.length, before, 'a word is not a number an expression can add');
});
