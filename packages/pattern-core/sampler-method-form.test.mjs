// The method forms .s()/.se()/.sr() as the editor actually calls them. The transpile wraps every
// pattern-position string in mini(), so .s("bd") reaches _asSampler as a one-atom Sig, not a
// string - accepting a Sig (sampled at each onset, the notes owning the structure) is what makes
// the documented note("c e g").s("rave") work in the editor at all, and it's also the Strudel
// spelling note("c").s("<bd sd>"). Each step's own pitch rides as its repitch note (step.cfg.note)
// so a drawn pianoroll() chord keeps per-note pitch through the conversion.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, note, mini, pianoroll } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, callsTo: (method) => calls.filter((c) => c.method === method) };
}

// One tick's worth of the lookahead walk over cycle 0.
function play(sig) {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, 1);
  return callsTo('playSample');
}

test('.s() accepts the mini-wrapped Sig the transpile hands it', () => {
  const calls = play(note(mini('c e g')).s(mini('rave')));
  assert.deepEqual(calls.map((c) => c.args[1]), ['rave', 'rave', 'rave']);
  assert.deepEqual(calls.map((c) => c.args[2].note), [60, 64, 67]);
});

test('pianoroll().s() drives the sampler with the drawn notes and velocities', () => {
  const kick = pianoroll('48,0,4,0.8 48,4,4,0.8 48,9,3,0.6', { grid: 16, len: 16 }).s(mini('bd'));
  const calls = play(kick);
  assert.deepEqual(calls.map((c) => c.args[1]), ['bd', 'bd', 'bd']);
  assert.deepEqual(calls.map((c) => c.args[2].note), [48, 48, 48]);
  assert.deepEqual(calls.map((c) => c.args[2].vel), [0.8, 0.8, 0.6]);
});

test('a drawn chord keeps per-note repitch through .s()', () => {
  // Two notes at ONE onset: sampling the note channel there could only return one of them, so
  // the repitch has to ride on each event (step.cfg.note).
  const calls = play(pianoroll('60,0,4 64,0,4', { grid: 16, len: 16 }).s(mini('bd')));
  assert.deepEqual(calls.map((c) => c.args[2].note).sort((a, b) => a - b), [60, 64]);
});

test('a patterned pack is sampled at the note onsets, adding no triggers', () => {
  const calls = play(note(mini('c c c c')).s(mini('bd sd')));
  assert.deepEqual(calls.map((c) => c.args[1]), ['bd', 'bd', 'sd', 'sd']);
});

test('arithmetic after .s() replaces the per-event repitch', () => {
  const calls = play(pianoroll('48,0,4', { grid: 16, len: 16 }).s(mini('bd')).add(12));
  assert.deepEqual(calls.map((c) => c.args[2].note), [60]);
});

test('re-.s() swaps the pack but keeps the note, and never stamps pack names as pitch', () => {
  const calls = play(s(mini('bd')).note(mini('50')).s(mini('house')));
  assert.deepEqual(calls.map((c) => c.args[1]), ['house']);
  assert.deepEqual(calls.map((c) => c.args[2].note), [50]);
});

test('a rest in the pack pattern silences that onset', () => {
  const calls = play(note(mini('c c')).s(mini('bd ~')));
  assert.equal(calls.length, 1);
});

test('.s() of junk still fails loudly', () => {
  assert.throws(() => note(mini('c')).s(3), /sample pack name/);
});
