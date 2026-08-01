// Step 4 of the all-signals rewrite: irand (a deterministic per-cycle random integer), .rib()
// (loop a band of cycles via an exact query remap), and naked .hold() (freeze a continuous signal
// into strudel-cycle updates). Pure pattern math - no scheduler/engine boot (see testing notes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, mini, sine, irand, s, choose } from './src/signal.mjs';

const valuesAt = (sig, cycle) => sig.stepsForCycle(cycle).filter((s) => s.value != null).map((s) => s.value);

// ---------------------------------------------------------------------------------------------
// irand: deterministic integer random, one value per cycle
// ---------------------------------------------------------------------------------------------

test('irand(n) draws integers in 0..n-1, one value per cycle', () => {
  const r = irand(8);
  for (let c = 0; c < 40; c++) {
    const steps = r.stepsForCycle(c);
    assert.equal(steps.length, 1, `cycle ${c} has one value`);
    const v = steps[0].value;
    assert.ok(Number.isInteger(v) && v >= 0 && v < 8, `cycle ${c} value ${v} in range`);
  }
});

test('irand is deterministic in time - same cycle draws the same value on every query', () => {
  const r = irand(100);
  for (const c of [0, 3, 17, 128, -4]) {
    const a = r.stepsForCycle(c)[0].value;
    const b = r.stepsForCycle(c)[0].value;
    assert.equal(a, b, `cycle ${c} stable across re-queries`);
    // sample() (what arithmetic/onset reads) agrees with the step grid at the cycle boundary.
    assert.equal(r.sample(c, 1, c), a, `cycle ${c} sample() agrees with the grid`);
  }
});

test('irand as a control draws per event, not once per cycle', () => {
  // irand varies WITHIN the cycle, so its whole-cycle step is only the phase-0 draw - as a
  // control it has to be read at each onset (the same contract choose() reads by).
  const sig = n('0!8').vel(irand(2));
  const vels = [0, 1, 2].flatMap((c) => sig.stepsForCycle(c).map((s) => s.vel));
  assert.ok(vels.every((v) => v === 0 || v === 1), 'every vel is a draw in range');
  assert.ok(new Set(vels).size > 1, 'events within the window draw independently');
  // and each merged value is the draw the scheduler will sample at that same onset
  const vel = sig.noteChannels.vel;
  for (const st of sig.stepsForCycle(0)) {
    assert.equal(st.vel, vel.sample(st.start, 1, st.start), `onset ${st.start} agrees with sample()`);
  }
});

test('independent irand() calls decorrelate', () => {
  const a = irand(1000);
  const b = irand(1000);
  const differ = [0, 1, 2, 3, 4, 5, 6, 7].some((c) => a.stepsForCycle(c)[0].value !== b.stepsForCycle(c)[0].value);
  assert.ok(differ, 'two independent irand() streams are not identical');
});

// ---------------------------------------------------------------------------------------------
// .rib(time, length): loop a band of cycles
// ---------------------------------------------------------------------------------------------

test('.rib(0, 2) loops the first two cycles forever', () => {
  const sig = n('<0 1 2 3>').rib(0, 2); // <> picks per cycle: cycle c -> value c
  assert.deepEqual(valuesAt(sig, 0), [0]);
  assert.deepEqual(valuesAt(sig, 1), [1]);
  assert.deepEqual(valuesAt(sig, 2), [0], 'cycle 2 wraps back to the band start');
  assert.deepEqual(valuesAt(sig, 3), [1]);
  assert.deepEqual(valuesAt(sig, 4), [0]);
});

test('.rib(14, 2) loops cycles 14 and 15', () => {
  const sig = n('<0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15>').rib(14, 2);
  assert.deepEqual(valuesAt(sig, 0), [14], 'plays from the band, not cycle 0');
  assert.deepEqual(valuesAt(sig, 1), [15]);
  assert.deepEqual(valuesAt(sig, 2), [14]);
  assert.deepEqual(valuesAt(sig, 100), [14], 'still looping the band far downstream');
  assert.deepEqual(valuesAt(sig, 101), [15]);
});

test('.rib() with a fractional length loops a sub-cycle window (twice per measure at 0.5)', () => {
  // The first half of the cycle (notes 0, 1) plays, then repeats: 0 1 0 1. The grid must be
  // phase-aware, not floored to a whole source cycle, so it matches sample()'s continuous remap.
  const sig = n('0 1 2 3').rib(0, 0.5);
  const g = sig.stepsForCycle(0).filter((s) => s.value != null).sort((a, b) => a.start - b.start);
  assert.deepEqual(g.map((s) => s.value), [0, 1, 0, 1], 'the half-cycle window loops twice');
  assert.deepEqual(g.map((s) => +s.start.toFixed(3)), [0, 0.25, 0.5, 0.75], 'four quarter-cycle slots');
  assert.ok(g.every((s) => !s.cont), 'each loop pass is a fresh strike, not a tie');
});

test('.rib() with a fractional length loops a later window (14, 0.5), not cycle 0', () => {
  // fast(2) puts two counter values per cycle, so source cycle 14 holds notes 28 (first half) and
  // 29. rib(14, 0.5) loops that first half, so we hear note 28 twice - proof the offset lands on
  // cycle 14's first half, not cycle 0.
  const sig = n('<0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29>')
    .fast(2)
    .rib(14, 0.5);
  const g = sig.stepsForCycle(0).filter((s) => s.value != null).sort((a, b) => a.start - b.start);
  assert.equal(g.length, 2, 'the half-cycle window (one note) plays twice');
  assert.deepEqual(g.map((s) => s.value), [28, 28], 'both passes are cycle 14, first half (note 28)');
  assert.deepEqual(g.map((s) => +s.start.toFixed(3)), [0, 0.5], 'once in each half of the output cycle');
});

test('.rib() loops a deterministic random into a repeating melody', () => {
  const sig = irand(8).rib(0, 4);
  const band = [0, 1, 2, 3].map((c) => sig.stepsForCycle(c)[0].value);
  for (let c = 4; c < 20; c++) {
    assert.equal(sig.stepsForCycle(c)[0].value, band[c % 4], `cycle ${c} repeats band[${c % 4}]`);
  }
});

test('.rib() rejects a non-positive constant length', () => {
  assert.throws(() => n('0 1').rib(0, 0), /positive length/);
});

test('.rib() accepts a patterned length, sampled at the outer position', () => {
  // length "<1 2>": cycle 0 loops just cycle 0 (len 1), cycle 1 loops a 2-cycle band from t0=0.
  const sig = n('<0 1 2 3>').rib(0, '<1 2>');
  assert.deepEqual(valuesAt(sig, 0), [0], 'len 1 at cycle 0 -> band is just cycle 0');
  assert.deepEqual(valuesAt(sig, 1), [1], 'len 2 at cycle 1 -> (1-0) mod 2 = 1');
  assert.deepEqual(valuesAt(sig, 2), [0], 'len 1 at cycle 2 -> (2-0) mod 1 = 0');
  assert.deepEqual(valuesAt(sig, 3), [1], 'len 2 at cycle 3 -> (3-0) mod 2 = 1');
});

test('.rib() accepts a patterned start, moving the band over time', () => {
  // start "<0 8>": even cycles anchor the band at 0, odd cycles at 8, length 2 throughout.
  const sig = n('<0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15>').rib('<0 8>', 2);
  assert.deepEqual(valuesAt(sig, 0), [0], 't0=0 at cycle 0 -> (0-0) mod 2 = 0');
  assert.deepEqual(valuesAt(sig, 1), [9], 't0=8 at cycle 1 -> 8 + ((1-8) mod 2) = 9');
  assert.deepEqual(valuesAt(sig, 2), [0], 't0=0 at cycle 2 -> 8 + ((2-0) mod 2)=0 -> value 0');
  assert.deepEqual(valuesAt(sig, 3), [9], 't0=8 at cycle 3 -> 8 + ((3-8) mod 2) = 9');
});

test('.rib() lights its patterned time/length atoms alongside the note (highlighting)', () => {
  // mini(str, offset) tags each atom's [start,end) span; rib folds time+length into the trigger so
  // the live band atoms light with the note the editor is playing (stepLocs reads step.locs).
  const base = note(mini('c', 0)); // the "c" atom spans [0,1)
  const sig = base.rib(mini('<0 8>', 4), mini('<2 3>', 20));
  // cycle 0: time atom "0" (at doc offset 5) and length atom "2" (at offset 21) are live.
  const c0 = sig.stepsForCycle(0).filter((s) => s.value != null)[0];
  assert.deepEqual(c0.locs, [[0, 1], [5, 6], [21, 22]], 'note + time "0" + length "2"');
  // cycle 1: the <> advances to time "8" (offset 7) and length "3" (offset 23).
  const c1 = sig.stepsForCycle(1).filter((s) => s.value != null)[0];
  assert.deepEqual(c1.locs, [[0, 1], [7, 8], [23, 24]], 'note + time "8" + length "3"');
});

test('.rib() with a patterned time subdivides a held note into fresh strikes (combines the trigger)', () => {
  // A whole-cycle note over a two-step time band: the mid-cycle band edge retriggers it, so the
  // note becomes two fresh strikes rather than one held event (rib affects the MIDI note).
  const sig = note('c4').rib('0 0', 2); // two half-cycle time atoms, same band value
  const g = sig.stepsForCycle(0).filter((s) => s.value != null).sort((a, b) => a.start - b.start);
  assert.equal(g.length, 2, 'the band edge at 0.5 splits the held note');
  assert.ok(!g[0].cont && !g[1].cont, 'both halves are fresh strikes, not a tie');
});

test('.rib() with a resting/zero patterned length plays straight (identity)', () => {
  // length "0" is ill-defined -> remap is the identity, so cycles pass through unlooped.
  const sig = n('<0 1 2 3>').rib(0, '0');
  assert.deepEqual(valuesAt(sig, 0), [0]);
  assert.deepEqual(valuesAt(sig, 2), [2], 'no looping - cycle 2 is its own value');
  assert.deepEqual(valuesAt(sig, 3), [3]);
});

// ---------------------------------------------------------------------------------------------
// naked .hold(): discretize a continuous signal into strudel-cycle updates
// ---------------------------------------------------------------------------------------------

test('naked .hold() on a continuous signal takes one value per cycle', () => {
  const held = sine(0.1).hold();
  for (const c of [0, 1, 5]) {
    const steps = held.stepsForCycle(c);
    assert.equal(steps.length, 1, `cycle ${c} holds a single value`);
    assert.equal(typeof steps[0].value, 'number');
    // the held value is the signal sampled at the cycle boundary, constant across the cycle
    assert.equal(held.sample(c + 0.5, 1, c + 0.5), steps[0].value, `cycle ${c} holds through the cycle`);
  }
});

test('naked .hold() borrows a pattern its own onsets', () => {
  const held = mini('1 2 3').hold();
  assert.deepEqual(valuesAt(held, 0), [1, 2, 3], 'one held value per onset, its own values');
});

// ---------------------------------------------------------------------------------------------
// .rib() loops the per-onset controls set before it, not just the note grid
// ---------------------------------------------------------------------------------------------

test('.rib(29, 1) freezes sampler-config randomness into a repeating bar', () => {
  const sig = s('breaks').vel('1!16').begin(irand(16).div(16)).speed(choose(1, -1)).rib(29, 1);
  for (let k = 0; k < 16; k++) {
    const p = k / 16;
    const begin29 = sig.sampler.begin.sample(29 + p, 1, 29 + p);
    // every output cycle remaps into the band, so cycles 0, 30 and 41 draw cycle 29's values
    for (const c of [0, 30, 41]) {
      assert.equal(sig.sampler.begin.sample(c + p, 1, c + p), begin29, `begin onset ${k} loops (cycle ${c})`);
      assert.equal(
        sig.sampler.speed.sample(c + p, 1, c + p),
        sig.sampler.speed.sample(29 + p, 1, 29 + p),
        `speed onset ${k} loops (cycle ${c})`,
      );
    }
  }
});

test('.rib() remaps channel-strip signals and their highlight grid', () => {
  const sig = n('0').gain('<0 1 2 3>').rib(2, 1);
  assert.equal(Number(sig.channel.gain.sample(5, 1, 5)), 2, 'polled gain reads the looped cycle');
  assert.equal(Number(sig.channel.gain.stepsForCycle(5)[0].value), 2, 'gain grid loops with it');
});

test('controls chained AFTER .rib() stay outside the loop', () => {
  const sig = n('0').rib(2, 1).gain('<0 1 2 3>');
  assert.equal(Number(sig.channel.gain.sample(5, 1, 5)), 1, 'post-rib gain keeps evolving (cycle 5 mod 4)');
});
