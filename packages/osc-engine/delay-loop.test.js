'use strict';

// A chain in the Delay's feedback loop, as the desktop's Node half tells the engine about it: the
// routing plan wires the loop (route-desktop.js), and /poptart/setRouting [id, 'loop', slot, sec]
// says how late its chain is,
// from the devices in it - the UGen adds its own block. Sent when that changes: a new plan, a
// device opening into a slot, the loop going.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { OscEngine } = require('./index.js');

function rig() {
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  const sent = [];
  engine._send = (addr, args) => sent.push({ addr, args });
  const loops = () => sent.filter((m) => m.addr === '/poptart/setRouting' && m.args[1] === 'loop').map((m) => [m.args[0], ...m.args.slice(2)]);
  return { engine, sent, loops };
}

const core = () => import(path.join(__dirname, '..', 'pattern-core', 'src', 'index.mjs'));

test('the engine is told how late a Delay\'s loop is, and again when a late device opens in it', async () => {
  const { note, routePlan } = await core();
  const { engine, loops } = rig();
  const sig = note('c2').synth('X').fx('Delay', (x) => x.fx('Voice'));
  engine.setRouting('t', routePlan(sig).plan, 2);
  assert.deepEqual(loops(), [['t', 2, 0]], 'nothing in the loop has opened yet');
  engine.loadEffect('t', 'Voice', 1);
  engine.loadEffect('t', 'Delay', 2);
  const late = engine._slotDevices.get('t:1').latencySec;
  assert.ok(late > 0);
  assert.deepEqual(loops(), [['t', 2, 0], ['t', 2, late]], 'once, when the Voice opened');
  engine.setRouting('t', routePlan(sig).plan, 2);
  assert.equal(loops().length, 2, 'the same plan again says nothing new');
});

test('a loop that goes is told it is gone, and a track destroyed forgets its loops', async () => {
  const { note, routePlan } = await core();
  const { engine, loops } = rig();
  engine.setRouting('t', routePlan(note('c2').synth('X').fx('Delay', (x) => x.fx('Filter'))).plan, 2);
  engine.setRouting('t', null, 1);
  assert.deepEqual(loops().at(-1), ['t', 2, -1]);
  engine.setRouting('t', routePlan(note('c2').synth('X').fx('Delay', (x) => x.fx('Filter'))).plan, 2);
  engine.destroyTrack('t');
  assert.equal(engine._loopPlans.size + engine._loopSent.size, 0);
});
