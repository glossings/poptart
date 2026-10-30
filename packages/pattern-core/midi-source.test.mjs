// Transforms on a live note source (midi()/midikeys()). The notes are a wire played engine-side,
// so value ops travel as the route's pitch-op chain: an all-constant chain folds to the engine's
// static transpose+scale, anything dynamic becomes a note-map closure the engine samples at each
// incoming note's own time - the note is the onset (see Sig#_routeBinop, Scheduler#_buildNoteMap).

import test from 'node:test';
import assert from 'node:assert/strict';

import { audio, midi, note, mini, sine, irand, midikeys, resetRandomSeeds } from './src/signal.mjs';
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

// A tuning on a keyboard (2026-10-25): its pitches sit between the keys, so the route can't fold
// to the engine's whole-key quantize, and snapping keys to its nearest pitches would reach only 12
// of 31-EDO's steps. Keys map to STEPS instead - the root's key plays the root, each key up the next.
test('a midikeys tuning maps each key to the next step, through the per-note map', () => {
  const { engine, callsTo } = mockEngine();
  const kb = midikeys('KeyStep')(1);
  new Scheduler(engine, { trackId: 'lead', cps: 1 }).setPattern(kb.scale('c3 31edo').synth('Wavetable'));
  const [call] = callsTo('setMidiNotes');
  const map = call.args[5];
  assert.equal(typeof map, 'function', 'a tuning goes to the per-note map');
  assert.equal(map(60, 0), 60, 'the root key plays the root');
  assert.equal(map(61, 0), 60.387, 'one key up is one 31-EDO step, kept to a thousandth');
  assert.equal(map(91, 0), 72, '31 keys up is the octave');
  assert.equal(map(59, 0), 59.613, 'below the root counts down');
  // A mode of a tuning: each key is the next step OF THE MODE.
  new Scheduler(engine, { trackId: 'b', cps: 1 }).setPattern(kb.scale('c3 31edo major').synth('Wavetable'));
  const modeMap = callsTo('setMidiNotes')[1].args[5];
  assert.deepEqual([60, 61, 62, 67].map((k) => modeMap(k, 0)), [60, 61.935, 63.871, 72]);
});

test('"nearest" snaps each live key to the tuning\'s nearest pitch instead', () => {
  const { engine, callsTo } = mockEngine();
  const kb = midikeys('KeyStep')(1);
  new Scheduler(engine, { trackId: 'lead', cps: 1 }).setPattern(kb.scale('c3 9/8 5/4 4/3 3/2 5/3 15/8 2/1', 'nearest').synth('Wavetable'));
  const map = callsTo('setMidiNotes')[0].args[5];
  assert.equal(map(64, 0), 63.863, 'e3 plays the pure third');
  assert.equal(map(67, 0), 67.02, 'g3 the pure fifth');
  assert.equal(map(61, 0), 60, 'c#3 is a semitone from c3 and 1.039 from the just d3 (9/8): c3 is nearer');
  // The editor hands the word over wrapped, as it does every literal in pattern position.
  new Scheduler(engine, { trackId: 'b', cps: 1 }).setPattern(kb.scale('c3 31edo', mini('nearest')).synth('Wavetable'));
  assert.equal(callsTo('setMidiNotes')[1].args[5](64, 0), 63.871, 'e3 snaps to 31-EDO step 10');
});

test('a normal pattern is untouched by any of this', () => {
  const sig = note('c3 e3').add(note(12));
  assert.equal(sig.inputSource, null);
  assert.deepEqual(sig.stepsForCycle(0).map((s) => s.value), [72, 76]);
});

test('stopping a track fed by another track\'s notes unplugs that route, and the next pattern plugs it back', () => {
  // A muted or deleted b: midi("a").synth(...) went on playing a's notes: the route lives
  // engine-side, and nothing but a new pattern ever cleared it.
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'b', cps: 1 });
  sch.setPattern(midi('a').synth('Serum 2'));
  assert.equal(callsTo('setInputSource').length, 1);
  sch.stop();
  assert.deepEqual(callsTo('clearInputSource').map((c) => c.args[0]), ['b']);
  sch.stop();
  assert.equal(callsTo('clearInputSource').length, 1, 'cleared once, not on every stop');
  sch.setPattern(midi('a').synth('Serum 2'));
  assert.equal(callsTo('setInputSource').length, 2, 'the evaluation that brings the track back sends it again');
});

test('stopping a track that reads another track\'s AUDIO leaves that route up to ring out', () => {
  // A group row reads its members' bus as its head input; cutting it on stop cuts their tails.
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'grp', cps: 1 });
  sch.setPattern(audio('drums').fx('Distort'));
  assert.equal(callsTo('setInputSource').length, 1);
  sch.stop();
  assert.equal(callsTo('clearInputSource').length, 0);
});

test('a patterned scale is read where each live note lands', () => {
  const r = routeFor(midi('kick').scale('<C3:major C3:minor>').synth('SubLabXL'));
  assert.equal(typeof r.noteMap, 'function', 'a scale that changes cannot fold to the static route');
  assert.equal(r.noteMap(63, 0.5), 62, 'cycle 0, C major: eb snaps to d');
  assert.equal(r.noteMap(63, 1.5), 63, 'cycle 1, C minor: eb stays');
});
