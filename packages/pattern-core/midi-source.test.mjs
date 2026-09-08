// Transforms on a live note source (midi()/midikeys()). The notes are a wire played engine-side,
// so value ops travel as the route's pitch-op chain: an all-constant chain folds to the engine's
// static transpose+scale, anything dynamic becomes a note-map closure the engine samples at each
// incoming note's own time - the note is the onset (see Sig#_routeBinop, Scheduler#_buildNoteMap).

import test from 'node:test';
import assert from 'node:assert/strict';

import { midi, note, mini, sine, irand, midikeys, resetRandomSeeds } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

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
  const [call] = callsTo('setInputSource');
  const [, , name, , pcs, , transpose, noteMap] = call.args;
  return { name, pcs, transpose, noteMap };
}

test('a constant chain folds to the static route - no closure, no defer', () => {
  for (const [build, transpose] of [
    [() => midi('kick').sub(note(24)), -24],
    [() => midi('kick').add(12).add(note(7)), 19],
    [() => midi('kick').add(mini('19')), 19],
  ]) {
    const r = routeFor(build().synth('SubLabXL'));
    assert.equal(r.transpose, transpose);
    assert.equal(r.noteMap, null);
  }
});

test('constant transpose then scale still folds, in that order', () => {
  const r = routeFor(midi('kick').sub(note(12)).scale('c minor'));
  assert.equal(r.transpose, -12);
  assert.ok(Array.isArray(r.pcs) && r.pcs.includes(3), 'minor third is in the folded scale');
  assert.equal(r.noteMap, null);
});

test('an op AFTER the scale cannot ride the static route - it becomes a map, in chain order', () => {
  const r = routeFor(midi('kick').scale('c minor').add(1));
  assert.equal(r.noteMap !== null, true);
  // 61 (c#) quantizes down to 60 (c), THEN +1 = 61 - the reverse order would give 60.
  assert.equal(r.noteMap(61, 0), 61);
});

test('the whole point: a per-note random transpose, drawn fresh per arrival, deterministically', () => {
  resetRandomSeeds();
  const r = routeFor(midi('myExternalSource').add(note(irand(8).seg(8))).synth('SubLabXL'));
  assert.equal(r.transpose, 0);
  assert.equal(typeof r.noteMap, 'function');
  const draws = [0, 0.125, 0.25, 0.375, 0.5].map((sec) => r.noteMap(60, sec) - 60);
  assert.ok(draws.every((d) => d >= 0 && d < 8), `all draws in range: ${draws}`);
  assert.ok(new Set(draws).size > 1, `the offset varies across the cycle: ${draws}`);
  for (const sec of [0, 0.125, 0.375]) {
    assert.equal(r.noteMap(60, sec), r.noteMap(60, sec), 'same position, same draw');
  }
});

test('an LFO operand reads where the note lands in time', () => {
  const r = routeFor(midi('kick').add(sine(0.25).mul(12)));
  const a = r.noteMap(60, 0); // sine(0.25) reads 0.5 here -> 66
  const b = r.noteMap(60, 1); // quarter period on: reads 1.0 -> 72
  assert.notEqual(a, b);
  for (const v of [a, b]) assert.ok(v >= 60 && v <= 72);
});

test('a rest in the operand silences the notes it covers, like a rest on the right of any operator', () => {
  const r = routeFor(midi('kick').add(mini('0 ~')));
  assert.equal(r.noteMap(60, 0.1), 60);
  assert.equal(r.noteMap(60, 0.6), null);
});

test('non-shift arithmetic works too - the wire behaves like a pattern', () => {
  const r = routeFor(midi('kick').mul(2));
  assert.equal(r.noteMap(30, 0), 60);
});

test('the map clamps to what MIDI can carry', () => {
  const r = routeFor(midi('kick').mul(3));
  assert.equal(r.noteMap(60, 0), 127);
});

test('midikeys chains ride the same machinery, through setMidiNotes', () => {
  const { engine, callsTo } = mockEngine();
  const kb = midikeys('KeyStep')(1);
  new Scheduler(engine, { trackId: 'lead', cps: 1 }).setPattern(kb.add(irand(8).seg(8)).synth('Serum 2'));
  // setMidiNotes args: (trackId, device, channel, pcs, transpose, noteMap)
  const [call] = callsTo('setMidiNotes');
  assert.equal(call.args[1], 'KeyStep');
  assert.equal(typeof call.args[5], 'function');
  const v = call.args[5](60, 0.3);
  assert.ok(v >= 60 && v < 68);
});

test('a static midikeys scale still goes the zero-latency way', () => {
  const { engine, callsTo } = mockEngine();
  const kb = midikeys('KeyStep')(1);
  new Scheduler(engine, { trackId: 'lead', cps: 1 }).setPattern(kb.scale('c minor').synth('Serum 2'));
  const [call] = callsTo('setMidiNotes');
  assert.ok(Array.isArray(call.args[3]));
  assert.equal(call.args[5], null);
});

test('a normal pattern is untouched by any of this', () => {
  const sig = note('c3 e3').add(note(12));
  assert.equal(sig.inputSource, null);
  assert.deepEqual(sig.stepsForCycle(0).map((s) => s.value), [72, 76]);
});
