// Patterned plugin STATE: `.preset("<init growl>")` swaps the whole program of the plugin last in
// the chain, on the names' own step grid. Which plugin is loaded never varies - that's a name (see
// assertPluginName) - so what's tested here is the other half: when a state is pushed, when it is
// deliberately NOT pushed, and which preset a knob you turn belongs to.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, _preset, resolvePreset, setPatternWarn, mini } from './src/signal.mjs';
import { clearRolls, setRollLayer, presetIds } from './src/rolls.mjs';
import { injectLocations } from './src/locations.mjs';
import { Scheduler } from './src/scheduler.mjs';

// Same stand-in engine as pluginstate.test.mjs, with a movable clock: livePreset() reads against it.
function mockEngine(now = 0) {
  const clock = { now };
  const calls = [];
  const engine = new Proxy(
    { getTime: () => clock.now },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, clock, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

// cps 0.5 (the Scheduler default): one cycle is two seconds, so cycle 1 is second 2.
const track = (names) => note('c').synth('Serum 2').preset(names);

function warnings(fn) {
  const seen = [];
  setPatternWarn((m) => seen.push(m));
  try { fn(); } finally { setPatternWarn(null); }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------------------------

test('a preset files a plugin and its state under a name', () => {
  clearRolls('buffer');
  _preset('growl', 'Serum 2', 'H4sIgrowl');
  assert.deepEqual(resolvePreset('growl', 'Serum 2'), { state: 'H4sIgrowl', why: null });
});

test('a definition is marked so a definitions block is never played as a track', () => {
  clearRolls('buffer');
  assert.equal(_preset('growl', 'Serum 2', 'H4sIgrowl').isDef, 'growl');
  assert.equal(track('growl').isDef, undefined, 'a pattern naming presets is a track like any other');
});

test('a preset id has to be writable inside a pattern', () => {
  assert.throws(() => _preset('two words', 'X', 'H4sI'), /one plain word/);
  assert.throws(() => _preset('<a>', 'X', 'H4sI'), /one plain word/);
});

test('defining one twice warns rather than throwing - the later one wins', () => {
  clearRolls('buffer');
  const seen = warnings(() => {
    _preset('dup', 'Serum 2', 'H4sIfirst');
    _preset('dup', 'Serum 2', 'H4sIsecond');
  });
  assert.match(seen[0], /defined twice/);
  assert.equal(resolvePreset('dup', 'Serum 2').state, 'H4sIsecond');
});

test('presetIds lists what is playable, buffer first', () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('prebake');
  _preset('library', 'Serum 2', 'H4sIlib');
  setRollLayer('buffer');
  _preset('mine', 'Serum 2', 'H4sImine');
  assert.deepEqual(presetIds(), [
    { id: 'mine', layer: 'buffer' },
    { id: 'library', layer: 'prebake' },
  ]);
  clearRolls('prebake');
});

// ---------------------------------------------------------------------------------------------
// resolvePreset: the three ways a name doesn't produce a state
// ---------------------------------------------------------------------------------------------

test('a name nothing defines reports itself rather than throwing', () => {
  clearRolls('buffer');
  const { state, why } = resolvePreset('gone', 'Serum 2');
  assert.equal(state, null);
  assert.match(why, /no preset called "gone"/);
});

test('a named-but-uncaptured preset holds the plugin as it is, silently', () => {
  clearRolls('buffer');
  _preset('growl', '', ''); // what the editor writes the moment a pattern says the name
  assert.deepEqual(resolvePreset('growl', 'Serum 2'), { state: null, why: null });
});

test("a preset is refused to a plugin it wasn't captured from", () => {
  clearRolls('buffer');
  _preset('growl', 'Serum 2', 'H4sIgrowl');
  const { state, why } = resolvePreset('growl', 'Diva');
  assert.equal(state, null, 'a program is only meaningful to the plugin that wrote it');
  assert.match(why, /captured from Serum 2.*holds Diva/);
});

// ---------------------------------------------------------------------------------------------
// Scheduling the swaps
// ---------------------------------------------------------------------------------------------

test('each name pushes its state at its own onset', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch._schedulePresetSwaps(0, 2);

  assert.deepEqual(argsTo('setPluginState'), [
    ['lead', 0, 'H4sIa', 0], // cycle 0 -> second 0
    ['lead', 0, 'H4sIb', 2], // cycle 1 -> second 2, at cps 0.5
  ]);
});

test('a state the plugin already holds is not pushed again', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 4); // four cycles of the same name

  assert.equal(argsTo('setPluginState').length, 1);
});

test('a state captured out of the plugin is not pushed straight back into it', () => {
  clearRolls('buffer');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  // Auto-pin's round trip: it captured this program from the plugin and wrote it into the preset's
  // definition, so the next evaluation must not make the plugin reload what it just handed over.
  sch.markStateApplied(0, 'Serum 2', 'H4sIcaptured');
  _preset('a', 'Serum 2', 'H4sIcaptured');
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 2);

  assert.deepEqual(argsTo('setPluginState'), []);
});

test('editing a preset by hand does reach the plugin, even under a constant name', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIold');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 1);

  clearRolls('buffer'); // the next evaluation redefines the buffer's presets
  _preset('a', 'Serum 2', 'H4sInew');
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(1, 2);

  assert.deepEqual(argsTo('setPluginState').map((c) => c[2]), ['H4sIold', 'H4sInew']);
});

test('a rest holds whatever is loaded rather than resetting the plugin', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a ~>'));
  sch._schedulePresetSwaps(0, 2);

  assert.deepEqual(argsTo('setPluginState').map((c) => c[2]), ['H4sIa']);
});

test('a bad name says so once, not once a cycle, and costs nothing else', () => {
  clearRolls('buffer');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('gone'));
  const seen = warnings(() => sch._schedulePresetSwaps(0, 8));

  assert.equal(seen.length, 1);
  assert.match(seen[0], /track "lead" slot 0: no preset called "gone"/);
  assert.deepEqual(argsTo('setPluginState'), []);
});

test('.preset() after an .fx() aims at that effect, not at the instrument', () => {
  clearRolls('buffer');
  _preset('a', 'Pro-Q 3', 'H4sIa');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(note('c').synth('Serum 2').fx('Pro-Q 3').preset('a'));
  sch._schedulePresetSwaps(0, 1);

  assert.deepEqual(argsTo('setPluginState'), [['lead', 1, 'H4sIa', 0]]);
});

// ---------------------------------------------------------------------------------------------
// livePreset: which one a knob you turn belongs to
// ---------------------------------------------------------------------------------------------

test('livePreset reports the one sounding, not the one already scheduled', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, clock } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch._schedulePresetSwaps(0, 2); // queues second 0 -> a and second 2 -> b, both up front

  assert.equal(sch.livePreset(0), 'a');
  clock.now = 1.9;
  assert.equal(sch.livePreset(0), 'a', "b's onset hasn't come yet - a is what you can hear");
  clock.now = 2.0;
  assert.equal(sch.livePreset(0), 'b');
});

test('livePreset reports a preset with nothing captured in it yet', () => {
  clearRolls('buffer');
  _preset('a', '', ''); // the empty definition the editor writes; a capture is what fills it
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 1);

  assert.equal(sch.livePreset(0), 'a');
});

test('a slot with no .preset() is not a preset slot, so auto-pin writes { state } there', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 1);
  assert.equal(sch.livePreset(0), 'a');

  sch.setPattern(note('c').synth('Serum 2')); // .preset(...) deleted from the code
  assert.equal(sch.livePreset(0), null);
});

test('stopping the track leaves no slot on a preset', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 1);
  sch.stop();

  assert.equal(sch.livePreset(0), null);
});

// ---------------------------------------------------------------------------------------------
// The editor's transpile
// ---------------------------------------------------------------------------------------------

test('the editor hands .preset() a tagged pattern, and the names keep their source spans', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const src = 'note("c").synth("Serum 2").preset("<a b>")';
  const sig = new Function('note', 'mini', `return (${injectLocations(src, 0)})`)(note, mini);
  const pattern = sig.presetPatterns[0];
  // Which is what lets the editor light the name that is running, exactly as it does a roll's.
  assert.deepEqual(pattern.stepsForCycle(0)[0].loc, [36, 37]);
  assert.deepEqual(pattern.stepsForCycle(1)[0].loc, [38, 39]);
});

test('.preset() with nothing to name warns and changes nothing', () => {
  const sig = note('c').synth('Serum 2');
  let out;
  const seen = warnings(() => { out = sig.preset(''); });
  assert.match(seen[0], /names no preset/);
  assert.deepEqual(out.presetPatterns, {});
});

test('the swap queue does not grow with the length of the set', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, clock } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  // An hour of playing with nobody ever touching a plugin, so nothing reads the queue off.
  for (let cycle = 0; cycle < 1800; cycle++) {
    clock.now = cycle * 2;
    sch._schedulePresetSwaps(cycle, cycle + 1);
  }
  assert.ok(sch._presetQueue(0).length <= 2, `queue held ${sch._presetQueue(0).length} swaps`);
  assert.equal(sch.livePreset(0), 'b', 'and it still reports the one sounding'); // cycle 1799 = b
});

test('a pinned { state } on a slot a preset drives is ignored, and says so', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  // Auto-pin wrote a `{ state }` before .preset(...) was added. Sending both would load the blob at
  // eval time and the preset over it at the next onset - two program changes, one of them audible
  // and neither of them what the code says.
  const seen = warnings(() => sch.setPattern(note('c').synth('Serum 2', { state: 'H4sIpinned' }).preset('a')));
  assert.deepEqual(argsTo('setPluginState'), []);
  assert.match(seen[0], /slot 0: \.preset\(\.\.\.\) drives this plugin/);

  sch._schedulePresetSwaps(0, 1);
  assert.deepEqual(argsTo('setPluginState'), [['lead', 0, 'H4sIa', 0]], 'the pattern is what plays');
});

test('a pinned { state } on a slot with no preset still works', () => {
  clearRolls('buffer');
  _preset('a', 'Pro-Q 3', 'H4sIa');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  // The preset drives the fx; the instrument keeps its pin.
  sch.setPattern(note('c').synth('Serum 2', { state: 'H4sIpinned' }).fx('Pro-Q 3').preset('a'));
  assert.deepEqual(argsTo('setPluginState'), [['lead', 0, 'H4sIpinned']]);
});

// ---------------------------------------------------------------------------------------------
// holdPreset - what makes a patterned preset editable at all
// ---------------------------------------------------------------------------------------------

test('holding a slot loads that preset now and stops the pattern swapping it', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));

  assert.equal(sch.holdPreset(0, 'b'), null);
  assert.deepEqual(argsTo('setPluginState'), [['lead', 0, 'H4sIb', 0]], 'you hear what you are editing');

  sch._schedulePresetSwaps(0, 8); // four cycles of <a b> that would otherwise swap eight times
  assert.equal(argsTo('setPluginState').length, 1, 'the pattern does not touch a held slot');
  assert.equal(sch.livePreset(0), 'b', 'so a knob turned now belongs to b, whatever the pattern says');
});

test('releasing hands the slot back to the pattern', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo, clock } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch.holdPreset(0, 'b');
  sch.holdPreset(0, null);

  clock.now = 4;
  sch._schedulePresetSwaps(2, 3); // cycle 2, which <a b> plays as a
  assert.deepEqual(argsTo('setPluginState').map((c) => c[2]), ['H4sIb', 'H4sIa'], 'the pattern is back in charge');
  assert.equal(sch.livePreset(0), 'a');
});

test('a hold only takes the slot it names', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('q', 'Pro-Q 3', 'H4sIq');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(note('c').synth('Serum 2').preset('a').fx('Pro-Q 3').preset('q'));
  sch.holdPreset(1, 'q');
  sch._schedulePresetSwaps(0, 1);

  assert.deepEqual(argsTo('setPluginState'), [
    ['lead', 1, 'H4sIq', 0], // the hold
    ['lead', 0, 'H4sIa', 0], // the instrument's own pattern, untouched by it
  ]);
});

test('holding an empty preset leaves the plugin exactly as it is', () => {
  clearRolls('buffer');
  _preset('b', '', ''); // named, nothing saved into it yet
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));

  assert.equal(sch.holdPreset(0, 'b'), null, 'nothing to report - an empty preset holds the sound');
  assert.deepEqual(argsTo('setPluginState'), []);
  // ...and it is still where a knob you turn now belongs, which is how an empty one gets filled.
  assert.equal(sch.livePreset(0), 'b');
});

test('holding a preset captured from another plugin says why rather than loading it', () => {
  clearRolls('buffer');
  _preset('q', 'Pro-Q 3', 'H4sIq');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));

  assert.match(sch.holdPreset(0, 'q'), /captured from Pro-Q 3.*holds Serum 2/);
  assert.deepEqual(argsTo('setPluginState'), []);
});

test('a hold survives the evaluation a save triggers', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch.holdPreset(0, 'b');

  // Saving writes the definition and re-evaluates; the server re-asserts the hold afterwards.
  sch.setPattern(track('<a b>'));
  sch.holdPreset(0, 'b');
  sch._schedulePresetSwaps(0, 4);

  assert.equal(argsTo('setPluginState').length, 1, 'still held, and not reloaded either');
});

test('stopping the track drops any hold', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch.holdPreset(0, 'a');
  sch.stop();

  assert.equal(sch.livePreset(0), null);
});
