// The monitor marker: a leading or trailing capital M plays a track to the headphone cue pair and
// not the main output, as a track of its own beside an unmarked block of the same name - so a
// replacement part can be cued while the original plays, and takes over when the M is dropped.

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitLabeledBlocks } from './src/labels.mjs';
import { flagEdit, renameEdits } from './src/mixctl.mjs';
import { markerResolver, treeOfBlocks, parentsOf, trackNames, monitorPicker, MONITOR_SUFFIX } from './src/groups.mjs';
import { s, CHANNEL_DEFAULTS, monitorSig } from './src/signal.mjs';

const blocksOf = (code) => splitLabeledBlocks(code);

test('a leading or trailing capital M monitors the block, alongside the other markers', () => {
  const [a, b, c, d] = blocksOf('Mbass: s("bd")\nbassM: s("bd")\n_SMlead: s("hh")\nkeys: s("cp")');
  assert.deepEqual([a.label, a.monitored], ['bass', true]);
  assert.deepEqual([b.label, b.monitored], ['bass', true]);
  assert.deepEqual([c.label, c.muted, c.soloed, c.monitored], ['lead', true, true, true]);
  assert.equal(d.monitored, false);
  // ...and never down to an empty name: a track called M is a track called M.
  assert.deepEqual(blocksOf('M: s("bd")').map((x) => [x.label, x.monitored]), [['M', false]]);
});

test('the mixer\'s mute and solo buttons keep a monitor marker the label already has', () => {
  const code = 'bassM: s("bd")';
  const edit = flagEdit(code, 'bass', { muted: true });
  assert.equal(edit.text, '_Mbass');
  assert.deepEqual(blocksOf(code.slice(0, edit.from) + edit.text + code.slice(edit.to)).map((x) => [x.label, x.muted, x.monitored]), [['bass', true, true]]);
});

test('a rename keeps the monitor marker, and a name that would read as one is refused', () => {
  const code = 'Mbass: s("bd")';
  const r = renameEdits(code, 'bass', 'sub');
  assert.ok(!r.error, r.error);
  assert.match(JSON.stringify(r), /"Msub"/);
  assert.match(renameEdits(code, 'bass', 'subM').error, /monitor marker/);
});

test('a monitored block is a track of its own beside an unmarked one of the same name', () => {
  const blocks = blocksOf('bass: s("bd")\nbassM: s("sd")');
  const names = trackNames(blocks);
  assert.deepEqual(blocks.map(names.nameOf), ['bass', `bass${MONITOR_SUFFIX}`]);
  assert.equal(names.shadowed.size, 0, 'both play');
});

test('of two unmarked blocks of one name the last plays, unless the picker remembers the cued one', () => {
  const two = blocksOf('bass: s("bd")\nbass: s("sd")');
  assert.deepEqual([...trackNames(two).shadowed].map((b) => b.code.trim()), ['s("bd")']);

  // The replacement written ABOVE the original: cued, then its M dropped.
  const picker = monitorPicker();
  picker.names(blocksOf('bassM: s("new")\nbass: s("old")'));
  const after = blocksOf('bass: s("new")\nbass: s("old")');
  const names = picker.names(after);
  assert.deepEqual(names.handed, ['bass']);
  assert.deepEqual([...names.shadowed].map((b) => b.code.trim()), ['s("old")'], 'the part that was cued keeps playing');
  // ...on the next evaluation too, while the original is still written beside it,
  assert.deepEqual([...picker.names(after).shadowed].map((b) => b.code.trim()), ['s("old")']);
  // ...and once it is deleted there is nothing left to remember.
  picker.names(blocksOf('bass: s("new")'));
  assert.equal(picker.prefer.size, 0);
});

test('a name is handed over only when it had a cued track and now has none', () => {
  const picker = monitorPicker();
  assert.deepEqual(picker.names(blocksOf('bass: s("bd")')).handed, []);
  assert.deepEqual(picker.names(blocksOf('bass: s("bd")\nbassM: s("sd")')).handed, [], 'still cued');
  assert.deepEqual(picker.names(blocksOf('bass: s("bd")\nbass: s("sd")'), () => false).handed, [], 'the host says nothing was cued');
});

test('muted blocks are neither picked nor shadowed', () => {
  const blocks = blocksOf('_bass: s("bd")\nbass: s("sd")');
  assert.equal(trackNames(blocks).shadowed.size, 0);
});

test('a monitored group shows its members as monitored', () => {
  const blocks = blocksOf('drumsM: group({\n  kick: s("bd")\n})\nbass: s("sd")');
  const tree = treeOfBlocks(blocks);
  const { isMonitored } = markerResolver(blocks, tree, parentsOf(tree));
  assert.deepEqual(blocks.map((b) => [b.label, isMonitored(b)]), [['drums', true], ['kick', true], ['bass', false]]);
});

test('monitoring is the mon channel control, which a dropped marker resets like any other', () => {
  assert.equal(CHANNEL_DEFAULTS.mon, 0);
  const sig = monitorSig(s('bd').postgain(0.5));
  assert.equal(sig.channel.mon.constVal ?? sig.channel.mon.sample(0, 1, 0), 1);
  assert.ok(sig.channel.postgain, 'the rest of the strip is kept');
});

test('a track reports what a channel control reads right now, a controller mute included', async () => {
  const { Scheduler, Transport } = await import('./src/scheduler.mjs');
  const { midicc } = await import('./src/signal.mjs');
  const { feedMidiCC } = await import('./src/midi.mjs');
  const engine = {
    getTime: () => Date.now() / 1000,
    createTrack() {}, loadInstrument() {}, loadEffect() {}, unloadEffect() {},
    noteOn() {}, noteOff() {}, setParam() {},
  };
  const transport = new Transport(engine.getTime, { cps: 0.5, paused: true });
  const sch = new Scheduler(engine, { transport, trackId: 't' });
  const cc = midicc('Quiet Test Twister');
  sch.setPattern(s('bd').gain(cc(0, 2).hold().mul(-1).add(1)));
  feedMidiCC('Quiet Test Twister Port', 2, 0, 0);
  assert.equal(sch.channelNow('gain'), 1);
  feedMidiCC('Quiet Test Twister Port', 2, 0, 1);
  assert.equal(sch.channelNow('gain'), 0, 'the knob is all the way up: the track is muted');
  assert.equal(sch.channelNow('postgain'), 1, 'a control the pattern leaves alone reads its default');
  transport.dispose();
});
