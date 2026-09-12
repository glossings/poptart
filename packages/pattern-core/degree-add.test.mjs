// Pitch arithmetic (add/sub/mul/div/mod) with an n(x) operand on a NOTE pattern: the degree operand
// names its unit, so the operation happens in scale tones rather than semitones. Pure pattern math, no scheduler/engine boot beyond the mock
// route below (see testing notes).
//
// NOTE: the global scale is module state, so these run in declaration order and the "nothing set
// yet" case has to come first - nothing clears it once set.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, mini, s, midi, setPatternWarn } from './src/signal.mjs';
import { setGlobalScale, noteToMidi } from './src/notes.mjs';
import { Scheduler } from './src/scheduler.mjs';

const values = (sig, cycle = 0) => sig.stepsForCycle(cycle).filter((st) => st.value != null).map((st) => st.value);
const midis = (names) => names.split(' ').map(noteToMidi);

function warnings(fn) {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  try {
    fn();
  } finally {
    setPatternWarn(null);
  }
  return lines;
}

function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, callsTo: (m) => calls.filter((c) => c.method === m) };
}

// setInputSource args: (trackId, io, name, channel, pcs, hwChans, transpose, noteMap)
function routeFor(sig) {
  const { engine, callsTo } = mockEngine();
  new Scheduler(engine, { trackId: 'sub', cps: 1 }).setPattern(sig);
  const [, , , , pcs, , transpose, noteMap] = callsTo('setInputSource')[0].args;
  return { pcs, transpose, noteMap };
}

test('a note pattern with no key anywhere warns and steps in the default scale', () => {
  let out;
  const said = warnings(() => { out = note('c3 e3').add(n(1)); });
  assert.equal(said.length, 1);
  assert.match(said[0], /setscale/);
  assert.deepEqual(values(out), midis('d3 f3'));
});

test('.add(n(x)) after .scale() steps in that key; .add(x) is still semitones', () => {
  const base = note('c3 e3 g3').scale('c major');
  assert.deepEqual(values(base.add(n(2))), midis('e3 g3 b3'));
  assert.deepEqual(values(base.sub(n(1))), midis('b2 d3 f3'));
  assert.deepEqual(values(base.add(2)), midis('d3 f#3 a3'));
  assert.deepEqual(values(base.add('2')), midis('d3 f#3 a3'));
});

test('the key is the one the notes went through, not the global one', () => {
  setGlobalScale('c major');
  const out = note('c3 eb3 g3').scale('c minor').add(n(1));
  assert.deepEqual(values(out), midis('d3 f3 ab3'));
});

test('a bare note pattern (a pianoroll) steps in the global setscale() key', () => {
  setGlobalScale('f minor');
  assert.deepEqual(values(note('f3 ab3 c4').add(n(2))), midis('ab3 c4 eb4'));
  assert.deepEqual(values(note('f3 ab3 c4').sub(n(7))), midis('f2 ab2 c3'));
});

test('a degree pattern is unchanged: the numbers are steps already', () => {
  setGlobalScale('c major');
  assert.deepEqual(values(n('0 2 4').add(n(2))), [2, 4, 6]);
  assert.deepEqual(values(n('0 2 4').add(n(2)).sc()), values(n('0 2 4').sc().add(n(2))));
});

test('a note outside the key keeps its distance from the nearest degree; n(0) is the identity', () => {
  setGlobalScale('c major');
  assert.deepEqual(values(note('f#3').add(n(1))), midis('g#3'));
  assert.deepEqual(values(note('f#3 c3 b3').add(n(0))), midis('f#3 c3 b3'));
});

test('the step is patternable and a `,`-stack fans the note out into a chord', () => {
  setGlobalScale('c major');
  const cycled = note('c3').sc().add(n('<0 2 -1>'));
  assert.deepEqual([0, 1, 2].map((c) => values(cycled, c)), [midis('c3'), midis('e3'), midis('b2')]);
  assert.deepEqual(values(note('d3').sc().add(n('0,2,4'))), midis('d3 f3 a3'));
});

test('the lift is uniform over the pitch arithmetic: mul, div and mod work in degrees too', () => {
  setGlobalScale('c major');
  const line = note('c3 e3 g3 c4').sc();
  assert.deepEqual(values(line.mul(n(2))), midis('c3 g3 d4 c5')); // degrees 0 2 4 7 -> 0 4 8 14
  assert.deepEqual(values(line.div(n(2))), midis('c3 d3 e3 g3')); // 0 1 2 3.5 -> rounds to a whole degree
  assert.deepEqual(values(line.mod(n(7))), midis('c3 e3 g3 c3')); // folded into one in-key octave
  assert.deepEqual(values(note('c3 e3').sc().mod(7)), [4, 1]); // a plain number is still raw MIDI math
  // ...and on a degree pattern the numbers are degrees already
  assert.deepEqual(values(n('0 2 4 7').mod(n(7))), [0, 2, 4, 0]);
});

test('the comparisons are not lifted - they answer 1/0, not a pitch', () => {
  setGlobalScale('c major');
  assert.deepEqual(values(note('c3 e3').sc().gte(n(62))), [0, 1]);
});

test('a sampler steps its repitch note the same way, on the channel and on the events', () => {
  setGlobalScale('c major');
  const sig = s('pluck').n('0 2').scale('c major').add(n(1));
  assert.deepEqual(values(sig.sampler.note), midis('d3 f3'));
  assert.deepEqual(sig.stepsForCycle(0).map((st) => st.cfg.note), midis('d3 f3'));
  // still degrees before the scale, so the same words mean plain addition there
  assert.deepEqual(values(s('pluck').n('0 2').add(n(1)).scale('c major').sampler.note), midis('d3 f3'));
});

test('a live source steps per incoming note through the map - it cannot fold to a transpose', () => {
  const r = routeFor(midi('keys').scale('c minor').add(n(2)));
  assert.equal(typeof r.noteMap, 'function');
  assert.equal(r.noteMap(noteToMidi('c3'), 0), noteToMidi('eb3'));
  assert.equal(r.noteMap(noteToMidi('eb3'), 0), noteToMidi('g3'));
  const chromatic = routeFor(midi('keys').scale('c minor').add(2));
  assert.equal(chromatic.noteMap(noteToMidi('c3'), 0), noteToMidi('d3'));
});
