// A modulator whose rate is a pattern: sine("<1 2 4>"), lfo(...).fast("<1 2>"), a rate that follows
// a signal. Its phase is the integral of the rate over the cycle grid (see src/lfo-rate.mjs), and
// three readers have to agree on it: the JS sample, the anchors the scheduler sends the native
// modulator, and the rate those anchors carry. The last test integrates what the engine is told
// and holds it to the JS sample, which is the contract both engines implement.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Sig, note, saw, sine, lfo, mini, Signal, setPatternWarn, lfoRateHz, lfoPhaseCount } from './src/signal.mjs';
import { rateLedger, RATE_STEPS_PER_CYCLE } from './src/lfo-rate.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine(now = 0) {
  const calls = [];
  const state = { now };
  const engine = new Proxy(
    { getTime: () => state.now },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, state, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

const withLfo = (l) => note('c').synth('X').param('Cutoff', l);
const frac = (x) => ((x % 1) + 1) % 1;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// saw reads as its own phase (unipolar = phase), so a sample of it IS the phase.
const phaseOf = (sig, cycle, cps = 1) => sig.sample(cycle / cps, cps, cycle);

test('a rate pattern that never changes counts exactly as the number does', () => {
  for (const pos of [0, 0.3, 1, 2.75, 7.5, 13.125]) {
    assert.ok(near(phaseOf(saw(mini('0.25')), pos), phaseOf(saw(0.25), pos)), `at ${pos}`);
    assert.ok(near(phaseOf(saw('<0.25 0.25>'), pos), phaseOf(saw(0.25), pos)), `at ${pos}`);
  }
  // ...so the grid anchors survive: rate 0.25 still starts its pass on 0, 4, 8.
  for (const c of [0, 4, 8]) assert.ok(near(phaseOf(saw('<0.25 0.25>'), c), 0));
});

test('the phase is the integral of the rate, re-anchored at each change', () => {
  const ir = saw('<1 2 4>').lfoIR;
  assert.ok(ir.rateSig, 'a patterned rate rides in the IR as a signal');
  // Turns at each cycle edge: 0, +1, +2, +4.
  assert.deepEqual([0, 1, 2, 3].map((c) => lfoPhaseCount(ir, c, 1, c)), [0, 1, 3, 7]);
  // Inside cycle 1 the rate is 2: a quarter of the way in is half a turn on from cycle 1's start.
  assert.ok(near(lfoPhaseCount(ir, 1.25, 1, 1.25), 1.5));
  // Whole-turn rates pass every cycle edge on a whole turn, so each cycle starts the shape at the top.
  for (const c of [1, 2, 3, 4, 5]) assert.ok(near(phaseOf(saw('<1 2 4>'), c), 0), `cycle ${c}`);
});

test('a change lands on the phase the old rate reached, then counts on from there', () => {
  // rate 0.25 for cycle 0 reaches a quarter turn at cycle 1; rate 1 carries on from that quarter.
  const l = saw('<0.25 1>');
  assert.ok(near(phaseOf(l, 1), 0.25));
  assert.ok(near(phaseOf(l, 1.5), 0.75));
  assert.ok(near(phaseOf(l, 2), 0.25));
  // No jump across the change: just either side of it reads the same phase.
  assert.ok(Math.abs(phaseOf(l, 1 - 1e-7) - phaseOf(l, 1 + 1e-7)) < 1e-6);
});

test('a rest holds the rate before it, and a pattern opening on one starts at rate 1', () => {
  const held = saw('1 [2 ~]').lfoIR; // 1 for the first half, 2 for a quarter, then held at 2
  assert.ok(near(lfoPhaseCount(held, 1, 1, 1), 0.5 + 0.25 * 2 + 0.25 * 2));
  const opening = saw('<~ 2>').lfoIR;
  assert.ok(near(lfoPhaseCount(opening, 1, 1, 1), 1), 'the opening rest runs at the default rate');
  assert.ok(near(lfoPhaseCount(opening, 2, 1, 2), 3));
});

test('every spelling reaches the same patterned rate', () => {
  const expect = (sig) => assert.ok(near(phaseOf(sig, 1.25), 0.5), `got ${phaseOf(sig, 1.25)}`);
  expect(saw('<1 2>'));
  expect(saw(mini('<1 2>', 0))); // what the editor's location transpile hands over
  expect(saw({ rate: '<1 2>' }));
  expect(lfo('saw', { rate: '<1 2>' }));
  expect(lfo('saw', '<1 2>'));
  expect(saw(1).rate('<1 2>'));
  expect(saw(1).fast('<1 2>'));
  expect(saw(1).slow('<1 0.5>'));
  expect(saw(0.5).fast('<2 4>'));
  expect(saw('<0.5 1>').fast(2));
});

test('the editor still reads a lone literal rate as the value it spells', () => {
  // The location transpile wraps sine("0.5hz") as sine(mini("0.5hz", …)).
  assert.equal(sine(mini('0.5hz', 5)).lfoIR.rateHz, 0.5);
  assert.equal(sine(mini('2', 5)).lfoIR.rateCycles, 2);
  assert.equal(sine(mini('2', 5)).lfoIR.rateSig, undefined);
  assert.equal(sine(Signal(3)).lfoIR.rateCycles, 3, 'a constant signal is a constant rate');
});

test('a free rate does not take a pattern, and says so', () => {
  const seen = [];
  setPatternWarn((m) => seen.push(m));
  let out;
  try { out = saw('2hz').fast('<1 2>'); } finally { setPatternWarn(null); }
  assert.match(seen.join('\n'), /free-running "2hz" rate can't follow a pattern/);
  assert.equal(out.lfoIR.rateHz, 2, 'and plays on as it was');
});

test('an "hz" step inside a rate pattern warns and holds the rate before it', () => {
  const seen = [];
  setPatternWarn((m) => seen.push(m));
  let turns;
  try { turns = lfoPhaseCount(saw('<2 3hz>').lfoIR, 2, 1, 2); } finally { setPatternWarn(null); }
  assert.match(seen.join('\n'), /patterned rate counts in cycles/);
  assert.ok(near(turns, 4));
});

test('a continuous rate signal is read on slices of the cycle and integrated', () => {
  // A rate of 1 + position: the integral from 0 to x is x + x^2/2.
  const ramp = new Sig((t, cps, pos) => 1 + (pos ?? t * cps));
  const ir = saw(ramp).lfoIR;
  assert.ok(ir.rateSig);
  for (const x of [1, 2, 3.5]) {
    // Midpoint slices integrate a straight line exactly at slice edges.
    assert.ok(near(lfoPhaseCount(ir, x, 1, x), x + (x * x) / 2, 1e-9), `at ${x}`);
  }
  // The rate in force is the slice's midpoint value, held across the slice.
  const slice = 1 / RATE_STEPS_PER_CYCLE;
  assert.ok(near(lfoRateHz(ir, 1, 2 + slice * 0.1), 1 + 2 + slice / 2));
});

test('the ledger lists each change once, inside the window asked for', () => {
  const ledger = rateLedger(mini('<1 2 2 4>'));
  assert.deepEqual(ledger.changesIn(0, 4), [{ at: 1, rate: 2 }, { at: 3, rate: 4 }]);
  assert.deepEqual(ledger.changesIn(1.5, 3), []);
  assert.deepEqual(ledger.changesIn(3, 3.1), [{ at: 3, rate: 4 }]);
  // A late first read is cheap and the same answer an early one would have given.
  const late = rateLedger(mini('<1 2>'));
  assert.equal(late.turnsAt(2001), 3001);
});

test('the native modulator is seeded with the rate in force, and told not to take rate re-sends', () => {
  const { engine, state, argsTo } = mockEngine(0);
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  state.now = 1.5;
  sch.setPattern(withLfo(saw('<1 2 4>')));
  const [[, , , ir]] = argsTo('setParamLFO');
  assert.equal(ir.rateHz, 2, 'cycle 1.5 is at rate 2');
  assert.equal(ir.rateFromAnchors, true);
  assert.equal(ir.rateSig, undefined, 'the engine is handed numbers, not the pattern');
});

test('each rate change goes out as an anchor on its step, with the phase and the new rate', () => {
  const { engine, argsTo } = mockEngine();
  const cps = 0.5;
  const sch = new Scheduler(engine, { trackId: 't', cps });
  sch.setPattern(withLfo(saw('<0.25 1 4>')));
  sch._scheduleRateChanges(0, 3);
  const anchors = argsTo('anchorParamLFO');
  assert.equal(anchors.length, 2);
  const [a1, a2] = anchors;
  assert.ok(near(a1[4], 1 / cps), 'cycle 1, in seconds');
  assert.ok(near(a1[3], 0.25), 'where rate 0.25 had brought it');
  assert.ok(near(a1[5], 1 * cps), 'rate 1 in Hz at this tempo');
  assert.ok(near(a2[4], 2 / cps));
  assert.ok(near(a2[3], 0.25), '0.25 + one whole turn');
  assert.ok(near(a2[5], 4 * cps));
});

test('a tempo move re-anchors a patterned rate at once, in the new Hz', () => {
  const { engine, state, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(withLfo(saw('<1 2>')));
  sch._anchorLFOs(0);
  assert.equal(argsTo('anchorParamLFO').length, 1);
  state.now = 0.5;
  sch._anchorLFOs(0.5);
  assert.equal(argsTo('anchorParamLFO').length, 1, 'nothing moved, so it waits for the periodic anchor');
  sch.transport.setCps(2, 0.5);
  sch._anchorLFOs(0.5);
  const last = argsTo('anchorParamLFO').at(-1);
  assert.equal(argsTo('anchorParamLFO').length, 2);
  // 0.65s is cycle 0.5 + 0.15 x 2 = 0.8, still at rate 1: one pass per cycle is 2 Hz at 2 cps.
  assert.ok(near(sch.transport.cycleAt(last[4]), 0.8));
  assert.ok(near(last[5], 2));
});

test('a shape swap carries the rate in force, and a change on the same step is the swap\'s', () => {
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(withLfo(lfo('<pluck swell>', { rate: '<1 2>' })));
  sch._scheduleShapeSwaps(0, 2);
  sch._scheduleRateChanges(0, 2);
  assert.deepEqual(argsTo('setParamShape'), [
    ['t', 0, 'Cutoff', 0, 0, 1],
    ['t', 0, 'Cutoff', 1, 1, 2],
  ]);
  assert.deepEqual(argsTo('anchorParamLFO'), [], 'the swap at cycle 1 already starts the shape at rate 2');
});

test('a note-gated shape takes its patterned rate from re-sends, since it is never anchored', () => {
  const { engine, state, argsTo } = mockEngine(0);
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  state.now = 0.5;
  sch.setPattern(withLfo(lfo('pluck', { rate: '<1 2>', mode: 'retrigger' })));
  assert.equal(argsTo('setParamLFO')[0][3].rateFromAnchors, undefined);
  sch._scheduleRateChanges(0, 2);
  assert.deepEqual(argsTo('anchorParamLFO'), []);
  state.now = 1.5;
  for (const m of sch._activeModulators.values()) sch._sendModulator(m, 1.5);
  assert.equal(argsTo('setParamLFO').at(-1)[3].rateHz, 2);
});

test('what the engine is told integrates to the JS sample', () => {
  // Plays the scheduler through a few cycles the way its timer would, records every anchor, and
  // runs the modulator the way both engines do: from each anchor's time, its phase plus elapsed x
  // its rate. That has to land on the JS count everywhere - step patterns exactly, a continuous
  // rate to within its slicing.
  for (const [label, sig, eps] of [
    ['steps', saw('<0.25 1 [2 4] 3>'), 1e-9],
    ['fast', saw(0.5).fast('<1 3>'), 1e-9],
    ['continuous', saw(sine(0.5).range(0.5, 3)), 1e-9],
  ]) {
    const cps = 0.5;
    const { engine, state, argsTo } = mockEngine(0);
    const sch = new Scheduler(engine, { trackId: 't', cps });
    sch.setPattern(withLfo(sig));
    sch.start(0);
    clearInterval(sch._timer);
    for (let t = 0; t <= 9; t += 0.03) {
      state.now = t;
      sch._tick();
    }
    const anchors = argsTo('anchorParamLFO').map((a) => ({ at: a[4], phase: a[3], rate: a[5] }));
    assert.ok(anchors.length > 2, `${label}: anchors were sent`);
    anchors.sort((a, b) => a.at - b.at);
    const engineAt = (t) => {
      let a = null;
      for (const x of anchors) if (x.at <= t) a = x;
      return frac(a.phase + (t - a.at) * a.rate);
    };
    const first = anchors[0].at;
    for (let t = first + 0.011; t < 8.5; t += 0.097) {
      const want = frac(lfoPhaseCount(sig.lfoIR, t, cps, t * cps));
      const got = engineAt(t);
      const d = Math.min(Math.abs(got - want), 1 - Math.abs(got - want));
      assert.ok(d < eps + 1e-9, `${label}: at ${t.toFixed(3)}s the engine is at ${got}, the JS count at ${want}`);
    }
  }
});
