// s() / se() / sr() are one sampler with three ways of naming what it plays. The scheduler is
// where the choice becomes visible: it stamps a namespace onto the value before handing it to the
// engine, and only a pack takes the ":n" index suffix - for an exact file or a recording, a ":"
// belongs to the name. Everything else about the three has to stay identical, which is most of
// what these tests check.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, se, sr, note, speed } from './src/signal.mjs';
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

const refs = (sig) => play(sig).map((c) => c.args[1]);
const cfgs = (sig) => play(sig).map((c) => c.args[2]);

test('s() sends a bare pack name, as it always has', () => {
  assert.deepEqual(refs(s('bd sn')), ['bd', 'sn']);
});

test('se() and sr() namespace the value', () => {
  assert.deepEqual(refs(se("'drums/kick.wav'")), ['file:drums/kick.wav']);
  assert.deepEqual(refs(sr('bass')), ['rec:bass']);
});

test('only a pack splits the ":n" index suffix off the value', () => {
  assert.deepEqual(refs(s('bd:4')), ['bd']);
  assert.equal(cfgs(s('bd:4'))[0].index, 4);
  // An exact file addresses one file - there is no index to pick, so a ":" is part of the name.
  assert.deepEqual(refs(se("'odd:name.wav'")), ['file:odd:name.wav']);
  assert.equal(cfgs(se("'odd:name.wav'"))[0].index, undefined);
  assert.deepEqual(refs(sr('take:2')), ['rec:take:2']);
});

test('an explicit .i() still wins over a pack suffix', () => {
  assert.equal(cfgs(s('bd:4').i(7))[0].index, 7);
});

test('the sampler config works identically on all three', () => {
  for (const sig of [s('bd'), se("'a.wav'"), sr('bass')]) {
    const cfg = cfgs(sig.speed(2).begin(0.25))[0];
    assert.equal(cfg.speed, 2);
    assert.equal(cfg.begin, 0.25);
  }
});

test('se()/sr() patterns sequence and stack like s()', () => {
  assert.deepEqual(refs(se("'a.wav' 'b.wav'")), ['file:a.wav', 'file:b.wav']);
  assert.equal(refs(sr('bass*2')).length, 2);
});

test('.slow() gives a bounce one event spanning the whole loop', () => {
  // What the recorder writes into the buffer: sr("x").slow(8) must be ONE event per 8 cycles,
  // not eight retriggers - otherwise the bounce restarts every cycle.
  const sig = sr('bass').slow(8);
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  for (let cycle = 0; cycle < 8; cycle++) sch._scheduleNoteEdges(cycle, cycle + 1);
  const played = callsTo('playSample');
  assert.equal(played.length, 1, 'one onset across the eight cycles');
  const [, , , onsetSec, offsetSec] = played[0].args;
  assert.equal(onsetSec, 0);
  assert.equal(offsetSec, 8, 'the event is as long as the recording');
});

test('a bounce plays at its native rate - no fit unless asked for', () => {
  // fit is what would time-stretch the file; an unset fit must stay absent so a bounce recorded
  // at this tempo plays back exactly as recorded.
  assert.equal(cfgs(sr('bass').slow(8))[0].fit, undefined);
});

test('the source kind survives the transforms that rebuild a pattern', () => {
  // Every one of these builds a NEW Sig rather than mutating - the kind has to be carried through
  // each, or a transformed bounce would be looked up as a pack name and silently not play.
  assert.deepEqual(refs(sr('bass').fast(2)), ['rec:bass', 'rec:bass']);
  assert.deepEqual(refs(se("'a.wav'").speed(speed(2))), ['file:a.wav']);
  assert.equal(sr('bass').slow(2).samplerKind, 'rec');
  assert.equal(sr('bass').seg(4).samplerKind, 'rec');
  assert.equal(se("'a.wav'").when('1', (x) => x.speed(2)).samplerKind, 'file');
});

test('the method forms name their own source kind', () => {
  assert.deepEqual(refs(note('c5').se('hits/stab.wav')), ['file:hits/stab.wav']);
  assert.deepEqual(refs(note('c5').sr('stab')), ['rec:stab']);
  assert.deepEqual(refs(note('c5').s('rave')), ['rave']);
});

test('the method form takes a literal path - only the builder parses mini', () => {
  // .se("a/b.wav") is one name, not a pattern, so it needs no quoting; se("'a/b.wav'") is a mini
  // string, where an unquoted "/" would read as the slow operator. Mixing them up is easy, so the
  // method rejects the quotes rather than looking for a file called "'a/b.wav'".
  assert.deepEqual(refs(note('c5').se('a/b.wav')), ['file:a/b.wav']);
  assert.throws(() => note('c5').se("'a/b.wav'"), /takes a sample file path/);
  assert.throws(() => note('c5').sr("'stab'"), /takes a recording name/);
});

test('the builders take the same inputs s() does', () => {
  assert.throws(() => se({}), /takes a number, a mini-notation string, or a signal/);
  assert.throws(() => sr([]), /takes a number, a mini-notation string, or a signal/);
});
