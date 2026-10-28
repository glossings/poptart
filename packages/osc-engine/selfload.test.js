'use strict';

// Auto-pin does not hear the programs poptart loads itself (engine/loads.js: beginSelfLoad,
// endSelfLoad, selfLoading, watchPluginEdits). Loading a program makes a plugin fire the very
// callbacks auto-pin watches, so every push of a captured state came back as "the user just edited
// this slot" - and two slots sharing a preset made that a loop. Within a load (and a short tail
// after it) the slot's reports are ours; outside it they are the user's.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');

test('auto-pin does not hear the programs poptart loads itself', async () => {
  const { E, S, told } = fakeEngine();
  E.selfLoadTail = 0.2;
  const edits = () => told.filter((m) => m.address === '/poptart/pluginEdited').length;
  const params = () => told.filter((m) => m.address === '/poptart/paramAutomated').length;
  const ctl = { synth: { nodeID: 4000 }, synthIndex: 3, info: { parameters: [{ name: 'Cutoff' }] } };
  const track = { confMode: false, editWatch: new Map() };
  E.watchPluginEdits(track, 'pluck', 1, ctl);
  const knob = () => ctl.parameterAutomated(0, 0.5);
  const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

  track.confMode = true;
  assert.equal(E.selfLoading('pluck', 1), false);
  knob();
  assert.equal(edits(), 1, 'a real gesture must reach auto-pin');
  assert.equal(params(), 1, 'and conf mode');
  assert.deepEqual(told.find((m) => m.address === '/poptart/paramAutomated').args, ['pluck', 1, 'Cutoff', 0, 0.5]);

  E.beginSelfLoad(E.slotKey('pluck', 1));
  assert.equal(E.selfLoading('pluck', 1), true);
  knob();
  assert.equal(edits(), 1, 'a load of ours is not an edit');
  assert.equal(params(), 1, 'and not a parameter anyone moved');

  E.endSelfLoad(E.slotKey('pluck', 1));
  assert.equal(E.selfLoading('pluck', 1), true, 'the tail is still ours');
  knob();
  assert.equal(edits(), 1);
  assert.equal(E.selfLoading('pluck', 2), false, 'another slot hears its own');
  assert.equal(E.selfLoading('pluck2', 1), false, 'another track too');

  await wait(E.selfLoadTail + 0.2);
  assert.equal(E.selfLoading('pluck', 1), false);
  knob();
  assert.equal(edits(), 2, 'the next knob turn must be heard');
  assert.equal(params(), 2);

  // A load that never reports: bounded by coldWaitMax.
  E.beginSelfLoad(E.slotKey('pluck', 1));
  const stuck = E.selfLoads.get(E.slotKey('pluck', 1)).until - E.elapsed();
  assert.ok(stuck > 0 && stuck <= 20, `the failsafe window should be bounded, got ${stuck}`);

  // Two loads in flight: the first one landing must not open the slot early.
  E.beginSelfLoad(E.slotKey('pluck', 3));
  E.beginSelfLoad(E.slotKey('pluck', 3));
  E.endSelfLoad(E.slotKey('pluck', 3));
  assert.equal(E.selfLoading('pluck', 3), true);
  assert.ok(E.selfLoads.get(E.slotKey('pluck', 3)).until - E.elapsed() > E.selfLoadTail);

  // The update and program-index reports for this plugin's node reach auto-pin; another node's do not.
  const before = edits();
  E.selfLoads.clear();
  S._dispatch({ address: '/vst_update', args: [4000, 3] });
  S._dispatch({ address: '/vst_program_index', args: [4000, 3, 2] });
  S._dispatch({ address: '/vst_update', args: [4001, 3] });
  assert.equal(edits(), before + 2);
  // Watching again replaces the watchers rather than stacking them.
  E.watchPluginEdits(track, 'pluck', 1, ctl);
  S._dispatch({ address: '/vst_update', args: [4000, 3] });
  assert.equal(edits(), before + 3);
});
