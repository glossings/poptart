// The note gate: how a note-gated modulator - env(), lfo() in retrigger/envelope mode - is
// sampled in JS. The engine gates its native modulators from the note events as they play; those
// events are the scheduler's own output, so the same gate is a pure function of the track's step
// grid, and a modulator composed into anything the engine can't run natively (a product of two,
// a .when(), a signal-valued bound) reads it off the grid instead. What these pin: the ADSR traces
// what poptart_env plays, the gated shapes count from the last onset as the engine's Sweep does,
// overlapping notes hold one gate while touching ones retrigger, and outside any gate a modulator
// rests at its start level rather than throwing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, n, lfo, env, _shape, withNoteGate, noteGateFromGrid, sampleEnvIR, NOTE_GATE_LOOKBACK_CYCLES } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

_shape('fall', '0,1 1,0');
_shape('rise', '0,0 1,1');

// A gate from literal spans: [[onset, end], ...] in absolute cycles.
const gateOf = (...spans) => ({ intervalsUpTo: (pos) => spans.filter(([a]) => a <= pos) });
const linear = (opts = {}) => ({ attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.2, curve: 0, ...opts });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test('an ADSR traces attack, decay, sustain and release against one note', () => {
  const ir = linear();
  withNoteGate(gateOf([0, 0.5]), () => {
    near(sampleEnvIR(ir, 0, 1), 0, 'onset');
    near(sampleEnvIR(ir, 0.05, 1), 0.5, 'halfway up the attack');
    near(sampleEnvIR(ir, 0.1, 1), 1, 'peak');
    near(sampleEnvIR(ir, 0.15, 1), 0.75, 'halfway down the decay');
    near(sampleEnvIR(ir, 0.3, 1), 0.5, 'sustain');
    near(sampleEnvIR(ir, 0.6, 1), 0.25, 'halfway through the release');
    near(sampleEnvIR(ir, 0.8, 1), 0, 'released');
  });
});

test('envelope times are seconds, so the tempo scales the cycle positions', () => {
  const ir = linear();
  withNoteGate(gateOf([0, 1]), () => {
    near(sampleEnvIR(ir, 0.1, 2), 0.5, 'at 2 cps, 0.1 cycles is 0.05s - halfway up the attack');
  });
});

test('the curve is the engine\'s: negative scoops fast, positive bulges', () => {
  withNoteGate(gateOf([0, 1]), () => {
    const scoop = sampleEnvIR(linear({ curve: -4 }), 0.05, 1);
    const bulge = sampleEnvIR(linear({ curve: 4 }), 0.05, 1);
    assert.ok(scoop > 0.8, `a -4 curve is most of the way up at half the attack, got ${scoop}`);
    assert.ok(bulge < 0.2, `a +4 curve has barely left the floor, got ${bulge}`);
  });
});

test('overlapping notes hold one gate; a note starting where the last ends retriggers', () => {
  const ir = linear();
  // Overlap: the second onset falls inside the first note, so the gate stays open - sustain.
  withNoteGate(gateOf([0, 0.5], [0.3, 0.8]), () => near(sampleEnvIR(ir, 0.35, 1), 0.5, 'held through the overlap'));
  // Touching: the gate closes and reopens, and the attack restarts - from the level the release
  // had reached, which at the instant of the new onset is the sustain level itself.
  withNoteGate(gateOf([0, 0.5], [0.5, 1]), () => {
    near(sampleEnvIR(ir, 0.5, 1), 0.5, 'restarts from where the release was');
    near(sampleEnvIR(ir, 0.55, 1), 0.75, 'halfway up an attack from 0.5 to 1');
  });
});

test('a note inside the previous release starts from the release level, not zero', () => {
  const ir = linear();
  withNoteGate(gateOf([0, 0.5], [0.6, 1]), () => {
    near(sampleEnvIR(ir, 0.6, 1), 0.25, 'the previous release was halfway down');
  });
});

test('with no gate in scope a gated modulator rests at its start level', () => {
  assert.equal(sampleEnvIR(linear(), 0.3, 1), 0);
  assert.equal(env().sample(0.3, 1, 0.3), 0);
  assert.equal(lfo('fall', { mode: 'envelope' }).sample(0.3, 1, 0.3), 1);
  assert.equal(lfo('rise', { mode: 'retrigger' }).sample(0.3, 1, 0.3), 0);
});

test('an envelope-mode shape plays once from the last onset over 1/rate, then holds', () => {
  const shape = lfo('fall', { rate: 2, mode: 'envelope' }); // one pass per half cycle
  withNoteGate(gateOf([1, 2]), () => {
    near(shape.sample(1, 1, 1), 1, 'at the onset');
    near(shape.sample(1.25, 1, 1.25), 0.5, 'halfway through the pass');
    near(shape.sample(1.5, 1, 1.5), 0, 'the pass is done');
    near(shape.sample(1.9, 1, 1.9), 0, 'and holds its final level');
  });
});

test('a retrigger-mode shape loops from the last onset', () => {
  const shape = lfo('rise', { rate: 2, mode: 'retrigger' });
  withNoteGate(gateOf([0, 0.1], [0.3, 0.4]), () => {
    near(shape.sample(0.25, 1, 0.25), 0.5, 'a full pass in, the second pass is half way');
    near(shape.sample(0.3, 1, 0.3), 0, 'the new onset resets the phase');
    near(shape.sample(0.35, 1, 0.35), 0.1, 'and it climbs again');
  });
});

test('a gate built from a grid reads onsets in cycle order across the lookback window', () => {
  const gate = noteGateFromGrid(
    (cycle) => [{ start: 0, end: 0.25, value: 60 }, { start: 0.5, end: 0.75, value: 62 }],
    (step, cycle) => [cycle + step.start, cycle + step.end],
  );
  const spans = gate.intervalsUpTo(2.6);
  assert.deepEqual(spans[spans.length - 1], [2.5, 2.75]);
  assert.deepEqual(spans[spans.length - 2], [2, 2.25]);
  assert.ok(spans.every(([a]) => a <= 2.6), 'nothing from the future');
  assert.ok(spans[0][0] >= 2 - NOTE_GATE_LOOKBACK_CYCLES, 'and nothing older than the lookback');
});

// A scheduler on a recording mock engine, started at cycle 0, torn down whatever the test does -
// a scheduler left running keeps the process alive.
function withScheduler(pattern, fn) {
  const calls = [];
  let now = 0;
  const engine = new Proxy({ getTime: () => now }, { get: (t, p) => (p in t ? t[p] : (...a) => calls.push({ m: p, a })) });
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(pattern);
  sched.start(0);
  try {
    fn(sched, calls, (t) => { now = t; });
  } finally {
    sched.stop();
  }
}

test('the scheduler gates on what it plays: rests, ties and silent notes open nothing', () => {
  // Every other step is a rest and the sounding note is tied over two steps, so the gate is one
  // span per cycle, [0, 0.5). A modulator polled off it sees the release from 0.5 on. (.mul("1")
  // rather than .mul(1): a plain number folds into the envelope's bounds and keeps it native.)
  withScheduler(n('60@2 ~ ~').synth('X').fx('Q').param('F', env(linear()).mul('1')), (sched, calls, setNow) => {
    // Reads the value the poll applies at cycle `pos` (it samples a lookahead ahead of now). The
    // transport runs at its default tempo, so envelope seconds are converted through it.
    const at = (pos) => {
      setNow(sched.transport.secAt(pos) - 0.15);
      sched._tick();
      return calls.filter((c) => c.m === 'setParam' && c.a[1] === 1).pop().a[3];
    };
    const releaseCycles = 0.2 * sched.transport.cps;
    near(at(0.3), 0.5, 'sustaining inside the tie');
    near(at(0.5 + releaseCycles / 2), 0.25, 'releasing through the rest');
  });
});

test('a zero-velocity note is no gate, and nothing before the start played', () => {
  withScheduler(n('60 60').vel('1 0').synth('X'), (sched) => {
    assert.deepEqual(sched._noteGate.intervalsUpTo(0.9), [[0, 0.5]]);
  });
});

test('a sampler pattern gates on its hits', () => {
  withScheduler(s('bd ~ bd ~'), (sched) => {
    assert.deepEqual(sched._noteGate.intervalsUpTo(1.9), [[0, 0.25], [0.5, 0.75], [1, 1.25], [1.5, 1.75]]);
  });
});
