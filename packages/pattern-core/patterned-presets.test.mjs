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
  // `calls` in full, for the tests that care about the ORDER of two different methods.
  return { engine, clock, calls, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

// cps 0.5 (the Scheduler default): one cycle is two seconds, so cycle 1 is second 2.
const track = (names) => note('c').synth('Serum 2').preset(names);
// PRESET_SWAP_LEAD_SEC: a swap is applied this far BEFORE its onset, so the program is in by the
// time the notes at that onset play - a load is neither instant nor sample-accurate, and the note
// written at a swap used to be eaten by it (see the scheduler's constant, and poptart.scd).
const LEAD = 0.03;
const at = (sec) => sec - LEAD;

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
    { id: 'mine', plugin: 'Serum 2', layer: 'buffer' },
    { id: 'library', plugin: 'Serum 2', layer: 'prebake' },
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
  assert.match(why, /belongs to Serum 2.*holds Diva/);
});

// ---------------------------------------------------------------------------------------------
// One name per PLUGIN, not per buffer. A program only means anything to the plugin that wrote it,
// so `disco` on a delay and `disco` on a reverb are two unrelated presets - which is what lets a chain
// of effects carry one preset name throughout instead of disco1/disco2/disco3.
// ---------------------------------------------------------------------------------------------

test('the same name under two plugins is two different presets', () => {
  clearRolls('buffer');
  _preset('disco', 'ValhallaDelay', 'H4sIdelay');
  _preset('disco', 'ValhallaVintageVerb', 'H4sIverb');
  assert.equal(resolvePreset('disco', 'ValhallaDelay').state, 'H4sIdelay');
  assert.equal(resolvePreset('disco', 'ValhallaVintageVerb').state, 'H4sIverb');
});

test('defining the same name twice for ONE plugin still warns', () => {
  clearRolls('buffer');
  const seen = warnings(() => {
    _preset('disco', 'ValhallaDelay', 'H4sIfirst');
    _preset('disco', 'ValhallaVintageVerb', 'H4sIverb'); // a different preset - no warning
    _preset('disco', 'ValhallaDelay', 'H4sIsecond');
  });
  assert.equal(seen.length, 1, 'only the genuine collision is worth a line');
  assert.match(seen[0], /preset "disco" \(ValhallaDelay\) is defined twice/);
  assert.equal(resolvePreset('disco', 'ValhallaDelay').state, 'H4sIsecond');
  assert.equal(resolvePreset('disco', 'ValhallaVintageVerb').state, 'H4sIverb', 'the other one is untouched');
});

test('a name owned by other plugins says who has it, not "no such preset"', () => {
  clearRolls('buffer');
  _preset('disco', 'ValhallaDelay', 'H4sIdelay');
  _preset('disco', 'RC-20 Retro Color', 'H4sIrc');
  const { state, why } = resolvePreset('disco', 'Serum 2');
  assert.equal(state, null);
  assert.match(why, /belongs to ValhallaDelay \/ RC-20 Retro Color/);
  assert.match(why, /holds Serum 2/);
});

test('an uncaptured placeholder answers to whichever plugin asks', () => {
  clearRolls('buffer');
  _preset('disco', '', ''); // what the editor writes the moment a pattern says the name
  // No owner yet, so it holds the plugin as it is rather than reporting a mismatch - for any of them.
  assert.deepEqual(resolvePreset('disco', 'ValhallaDelay'), { state: null, why: null });
  assert.deepEqual(resolvePreset('disco', 'Serum 2'), { state: null, why: null });
});

test('a capture claims the placeholder for its own plugin', () => {
  clearRolls('buffer');
  _preset('disco', 'ValhallaDelay', 'H4sIdelay'); // auto-pin fills the plugin in with the state
  assert.equal(resolvePreset('disco', 'ValhallaDelay').state, 'H4sIdelay');
  assert.match(resolvePreset('disco', 'Serum 2').why, /belongs to ValhallaDelay/);
});

test('with no plugin to go on, any preset of that name will do', () => {
  clearRolls('buffer');
  _preset('disco', 'ValhallaDelay', 'H4sIdelay');
  // A slot past the end of the chain has no plugin name to check against; refusing there would
  // break patches that worked before presets were keyed this way.
  assert.equal(resolvePreset('disco', null).state, 'H4sIdelay');
});

test('a chain of effects each carry a preset called by the same name', () => {
  clearRolls('buffer');
  _preset('disco', 'ValhallaDelay', 'H4sIdelay');
  _preset('disco', 'ValhallaVintageVerb', 'H4sIverb');
  _preset('disco', 'RC-20 Retro Color', 'H4sIrc');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'disco' });
  sch.setPattern(
    note('c').synth('Serum 2')
      .fx('ValhallaDelay').preset('disco')
      .fx('ValhallaVintageVerb').preset('disco')
      .fx('RC-20 Retro Color').preset('disco')
  );
  sch._schedulePresetSwaps(0, 1);

  assert.deepEqual(argsTo('setPluginState'), [
    ['disco', 1, 'H4sIdelay', at(0)],
    ['disco', 2, 'H4sIverb', at(0)],
    ['disco', 3, 'H4sIrc', at(0)],
  ]);
});

test('presetIds keeps each name with the plugin that owns it', () => {
  clearRolls('buffer');
  _preset('disco', 'ValhallaDelay', 'H4sIdelay');
  _preset('disco', 'ValhallaVintageVerb', 'H4sIverb');
  assert.deepEqual(presetIds(), [
    { id: 'disco', plugin: 'ValhallaDelay', layer: 'buffer' },
    { id: 'disco', plugin: 'ValhallaVintageVerb', layer: 'buffer' },
  ]);
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
    ['lead', 0, 'H4sIa', at(0)], // cycle 0 -> second 0, less the swap lead
    ['lead', 0, 'H4sIb', at(2)], // cycle 1 -> second 2, at cps 0.5
  ]);
});

test('a window opening mid-pattern applies the preset already in force, now', () => {
  // DJ mode's deck B: its first eval comes against a clock deck A has been running for a while,
  // so the schedule window opens mid-cycle and the onset that named the current preset is
  // behind it. Before 2026-08-26 nothing was sent until the NEXT onset, and the freshly opened
  // plugin sounded its init program until then.
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch.start(3.7);
  sch._schedulePresetSwaps(3.7, 4.2);
  sch.stop();

  assert.deepEqual(argsTo('setPluginState'), [
    ['lead', 0, 'H4sIb', null], // cycle 3 named b - in force at 3.7, pushed untimed (immediately)
    ['lead', 0, 'H4sIa', at(sch.transport.secAt(4))], // then the window's own onset at cycle 4
  ]);
});

test('the catch-up never reaches back past the downbeat', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch.start(0);
  sch._schedulePresetSwaps(0, 1);
  sch.stop();
  // A cyclic pattern would answer 'b' for cycle -1; nothing was in force before cycle 0.
  assert.deepEqual(argsTo('setPluginState'), [['lead', 0, 'H4sIa', at(0)]]);
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

  assert.deepEqual(argsTo('setPluginState'), [['lead', 1, 'H4sIa', at(0)]]);
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
  assert.deepEqual(argsTo('setPluginState'), [['lead', 0, 'H4sIa', at(0)]], 'the pattern is what plays');
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
    ['lead', 1, 'H4sIq', 0], // the hold - loaded now, so no lead to take off
    ['lead', 0, 'H4sIa', at(0)], // the instrument's own pattern, untouched by it
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

  assert.match(sch.holdPreset(0, 'q'), /belongs to Pro-Q 3.*holds Serum 2/);
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

// ---------------------------------------------------------------------------------------------
// Hand editing: the slot whose plugin you are turning knobs in
// ---------------------------------------------------------------------------------------------

test('a frozen slot is not swapped by its pattern', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch.holdPluginState(0, true);
  sch._schedulePresetSwaps(0, 8);

  assert.deepEqual(argsTo('setPluginState'), [], 'your hands are the only thing changing this sound');
});

test('the flip-flop: a stale store cannot overwrite what the knobs just did', () => {
  // The bug this exists for. Auto-pin captures a program out of the plugin, and until the eval that
  // files it, the STORE still holds the old one - so the next swap round pushed the pre-tweak sound
  // back (one cycle of the old preset), and the eval put the tweak back a cycle later.
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIold');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));

  sch.holdPluginState(0, true); // a knob moved
  sch.markStateApplied(0, 'Serum 2', 'H4sInew'); // ...captured, and now live in the plugin
  sch._schedulePresetSwaps(0, 4); // four cycles of the pattern coming round with a stale store
  assert.deepEqual(argsTo('setPluginState'), [], 'nothing pushed - the old program stays out of it');

  clearRolls('buffer'); // the eval that files the capture
  _preset('a', 'Serum 2', 'H4sInew');
  sch.setPattern(track('a'));
  sch.holdPluginState(0, false);
  sch._schedulePresetSwaps(4, 8);
  assert.deepEqual(argsTo('setPluginState'), [], 'and nothing to put back either - it never left');
});

test('thawing hands the slot back to its pattern', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo, clock } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch.holdPluginState(0, true);
  sch._schedulePresetSwaps(0, 2);
  assert.deepEqual(argsTo('setPluginState'), []);

  sch.holdPluginState(0, false);
  clock.now = 4;
  sch._schedulePresetSwaps(2, 4);
  assert.deepEqual(argsTo('setPluginState').map((c) => c[2]), ['H4sIa', 'H4sIb']);
});

test('freezing one slot leaves the rest of the chain swapping', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('q', 'Pro-Q 3', 'H4sIq');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(note('c').synth('Serum 2').preset('a').fx('Pro-Q 3').preset('q'));
  sch.holdPluginState(0, true);
  sch._schedulePresetSwaps(0, 1);

  assert.deepEqual(argsTo('setPluginState'), [['lead', 1, 'H4sIq', at(0)]]);
});

test('a knob turned while frozen belongs to the preset that is really sounding', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, clock } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch._schedulePresetSwaps(0, 1); // cycle 0 is a, and it is what you can hear
  sch.holdPluginState(0, true);
  sch._schedulePresetSwaps(1, 4); // the cycles the pattern would have swapped in

  clock.now = 6;
  assert.equal(sch.livePreset(0), 'a', 'nothing was queued, so nothing has moved on');
});

test('an eval does not re-send a pinned { state } to a frozen slot', () => {
  clearRolls('buffer');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.holdPluginState(0, true);
  sch.setPattern(note('c').synth('Serum 2', { state: 'H4sIpinned' }));
  assert.deepEqual(argsTo('setPluginState'), [], 'the plugin holds something newer than the code');

  // ...and once the code has caught up, the same string is not owed a push either.
  sch.markStateApplied(0, 'Serum 2', 'H4sIpinned');
  sch.holdPluginState(0, false);
  sch.setPattern(note('c').synth('Serum 2', { state: 'H4sIpinned' }));
  assert.deepEqual(argsTo('setPluginState'), []);
});

test('the panel takes a frozen slot without loading over it, and a pick still loads', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch.holdPluginState(0, true);

  assert.equal(sch.holdPreset(0, 'b'), null);
  assert.deepEqual(argsTo('setPluginState'), [], 'the sound under your hands is the one being edited');
  assert.equal(sch.livePreset(0), 'b', 'the panel still owns the slot');

  // Picking one in the panel is deliberate: the server captures the knobs first, then asks for it.
  assert.equal(sch.holdPreset(0, 'b', { force: true }), null);
  assert.deepEqual(argsTo('setPluginState'), [['lead', 0, 'H4sIb', 0]]);
});

test('stopping the track thaws it - there is nothing left to protect', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch.holdPluginState(0, true);
  sch.stop();
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 1);

  assert.deepEqual(argsTo('setPluginState').map((c) => c[2]), ['H4sIa']);
});

test('freezing cancels the swap already on its way to the engine', () => {
  // Swaps are SENT a lookahead before their onset, so the one due next was queued before your hands
  // reached the plugin. Without the cancel, freezing means "the pattern stops swapping after one
  // more swap" - which is the same symptom, a moment later.
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch._schedulePresetSwaps(0, 2); // cycle 1's swap is sent now, to land later

  sch.holdPluginState(0, true);
  assert.deepEqual(argsTo('cancelPluginState'), [['lead', 0]]);
});

test('freezing an already-frozen slot cancels nothing new', () => {
  clearRolls('buffer');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch.holdPluginState(0, true);
  sch.holdPluginState(0, true); // every poll re-asserts the freeze
  sch.holdPluginState(0, true);

  assert.equal(argsTo('cancelPluginState').length, 1);
});

test('a cancelled swap is not remembered as loaded', () => {
  // _appliedStates is a belief about what the plugin holds. Cancelling a push makes that belief
  // false, and a false one is worse than none: the next time the pattern came round to that preset
  // it would be skipped as "already there" and the slot would sit on the wrong sound.
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  const { engine, argsTo, clock } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch._schedulePresetSwaps(0, 1); // a is pushed, and believed loaded

  sch.holdPluginState(0, true); // ...and cancelled: the plugin never got it
  sch.holdPluginState(0, false);
  clock.now = 2;
  sch._schedulePresetSwaps(1, 2);

  assert.deepEqual(argsTo('setPluginState').map((c) => c[2]), ['H4sIa', 'H4sIa'], 'it is sent again');
});

test('an engine with no cancel is driven exactly as before', () => {
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  // The mock answers every method; a real engine that predates cancelPluginState would not, and the
  // scheduler feature-detects it like every other optional engine call.
  const { engine: full, argsTo } = mockEngine();
  const engine = new Proxy(full, {
    get: (t, p) => (p === 'cancelPluginState' ? undefined : t[p]),
  });
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('a'));
  sch.holdPluginState(0, true);
  sch._schedulePresetSwaps(0, 2);

  assert.deepEqual(argsTo('setPluginState'), [], 'still frozen, just without the cancel');
});

test('a swap is applied a hair before its onset, so the note at that onset survives it', () => {
  // Loading a program suspends the plugin and resets its voices, in the language, while the notes
  // at the same onset are timestamped bundles the audio thread plays exactly on time. Applied AT
  // the onset, the load landed on the note written at it and ate it.
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch._schedulePresetSwaps(1, 2); // cycle 1 is second 2 at cps 0.5

  assert.deepEqual(argsTo('setPluginState').map((c) => c[3]), [2 - LEAD]);
  assert.ok(LEAD > 0 && LEAD < 0.05, 'small: it is also how much earlier the outgoing preset stops');
});

test('the lead does not move which preset a knob you turn belongs to', () => {
  // livePreset answers a question about the music ("what was sounding when I touched it"), not
  // about how long a plugin takes to swallow a program, so the QUEUE keeps the true onset.
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, clock } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch._schedulePresetSwaps(0, 2);

  clock.now = 2 - (LEAD / 2); // inside the lead: b's program is going in, but a is still sounding
  assert.equal(sch.livePreset(0), 'a');
  clock.now = 2;
  assert.equal(sch.livePreset(0), 'b');
});

test('the swap for an onset is sent before the notes at it', () => {
  // A note is a timestamped bundle from the moment the engine handles its message, so whether it
  // can wait for a program load is decided then - which means the load has to have been announced
  // by then (see poptart.scd's waitForLoad). Same tick, same window: the order they go out in is
  // the whole of it, and getting it backwards is what ate the first note of every cycle.
  clearRolls('buffer');
  _preset('a', 'Serum 2', 'H4sIa');
  _preset('b', 'Serum 2', 'H4sIb');
  const { engine, calls } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'lead' });
  sch.setPattern(track('<a b>'));
  sch._tick();

  const order = calls.map((c) => c.method).filter((m) => m === 'setPluginState' || m === 'noteOn');
  assert.ok(order.length >= 2, `expected a swap and a note, got ${order.join(', ') || 'nothing'}`);
  assert.equal(order[0], 'setPluginState', 'the swap is announced before the note it lands under');
});
