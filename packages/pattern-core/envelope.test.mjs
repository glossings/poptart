// The sampler envelope's time base: attack/decay/release are seconds, .envscale() multiplies
// them, and dur() is the length of the note being emitted - so `.envscale(dur())` is how a pattern
// asks for times that follow the note. Scheduler walk against a recording engine, no boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, mini, note, pianoroll, dur, envscale, Signal, withNoteGate, noteGateFromGrid } from './src/signal.mjs';
import { Scheduler, setEventLogger } from './src/scheduler.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);

function play(sig, { cps = 1 } = {}) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const sch = new Scheduler(engine, { trackId: 't', cps });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, 1);
  return calls.filter((c) => c.method === 'playSample').map((c) => c.args[2]);
}

test('attack, decay and release reach the engine as written, unscaled', () => {
  const [cfg] = play(s(mini('bd')).attack(0.005).decay(0.2).sustain(0.3).release(0.1));
  assert.equal(cfg.attack, 0.005);
  assert.equal(cfg.decay, 0.2);
  assert.equal(cfg.sustain, 0.3);
  assert.equal(cfg.release, 0.1);
  assert.equal(cfg.envScale, undefined, 'no scale unless one is set');
});

test('envscale is a channel: method form, patterned, and as an operand', () => {
  assert.deepEqual(play(s(mini('bd bd')).release(0.1).envscale(mini('2 3'))).map((c) => c.envScale), [2, 3]);
  const [cfg] = play(s(mini('bd')).envscale(2).mul(envscale(0.5)));
  assert.equal(cfg.envScale, 1, 'an operand combines with the scale in force');
});

test('dur() is the length of each note as it is emitted, in seconds', () => {
  // Quarter and eighth notes at 0.5 cps: 0.5s and 0.25s.
  const cfgs = play(note(mini('c _ c c')).s(mini('bd')).envscale(dur()), { cps: 0.5 });
  assert.equal(cfgs.length, 3);
  near(cfgs[0].envScale, 1, 'the tied half note');
  near(cfgs[1].envScale, 0.5);
  near(cfgs[2].envScale, 0.5);
});

test('dur() tells apart the notes of a chord that ring for different lengths', () => {
  const cfgs = play(pianoroll('60,0,4 64,0,8', { grid: 16, len: 16 }).s(mini('bd')).envscale(dur()));
  const byNote = Object.fromEntries(cfgs.map((c) => [c.note, c.envScale]));
  near(byNote[60], 0.25);
  near(byNote[64], 0.5);
});

test('dur() includes clip, since that is how long the note sounds', () => {
  const [cfg] = play(s(mini('bd')).clip(0.5).envscale(dur()));
  near(cfg.envScale, 0.5);
});

test('the old length-relative envelope is one envscale(dur()) away', () => {
  const [cfg] = play(s(mini('bd bd')).attack(0.1).envscale(dur()), { cps: 0.5 });
  near(cfg.attack * cfg.envScale, 0.1, 'an attack of 0.1 of a one-second note is 0.1s');
  const [inv] = play(s(mini('bd')).envscale(Signal(1).div(dur())), { cps: 0.5 });
  near(inv.envScale, 0.5, 'an inverse is plain arithmetic');
});

test('outside an emission dur() reads the latest note off the gate, and rests with none', () => {
  assert.equal(dur().sample(0, 1, 0), null, 'nothing in scope');
  const grid = (cycle) => [{ start: 0, end: 0.25, value: 1 }, { start: 0.5, end: 1, value: 1 }].map((st) => ({ ...st }));
  const gate = noteGateFromGrid(grid, (st, cycle) => [cycle + st.start, cycle + st.end]);
  withNoteGate(gate, () => {
    near(dur().sample(0.1, 2, 0.2), 0.125, 'first note: a quarter cycle at 2 cps');
    near(dur().sample(0.3, 2, 0.6), 0.25, 'second note: half a cycle at 2 cps');
  });
});

test('.log() prints the envelope in the seconds the voice gets', () => {
  const lines = [];
  setEventLogger((line) => lines.push(typeof line === 'string' ? line : line.text ?? JSON.stringify(line)));
  try {
    play(s(mini('bd')).attack(0.1).release(0.2).envscale(0.5).log());
  } finally {
    setEventLogger(null);
  }
  const line = lines.join('\n');
  assert.match(line, /attack=0\.05s/);
  assert.match(line, /release=0\.1s/);
});
