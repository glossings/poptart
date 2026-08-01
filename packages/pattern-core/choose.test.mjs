// choose(): deterministic weighted pick with the irand() sampling contract - one pick per cycle
// as a pattern (a chosen pattern option plays in full), a fresh draw per position when sampled
// by an outside pattern's structure. Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { choose, irand, mini, n, s, resetRandomSeeds } from './src/signal.mjs';

const valuesAt = (sig, cycle) => sig.stepsForCycle(cycle).filter((s) => s.value != null).map((s) => s.value);

test('choose() picks one option per cycle as a pattern, stable across re-queries', () => {
  const c = choose(1, 2, 3);
  for (let cyc = 0; cyc < 20; cyc++) {
    const steps = c.stepsForCycle(cyc);
    assert.equal(steps.length, 1, `cycle ${cyc} has one whole-cycle step`);
    assert.ok([1, 2, 3].includes(steps[0].value), `cycle ${cyc} value from the options`);
    assert.equal(c.stepsForCycle(cyc)[0].value, steps[0].value, `cycle ${cyc} stable across re-queries`);
    // sample() at the cycle boundary agrees with the step grid (phase 0 hashes identically).
    assert.equal(c.sample(cyc, 1, cyc), steps[0].value, `cycle ${cyc} sample() agrees with the grid`);
  }
});

test('choose() eventually picks every option', () => {
  const c = choose(1, 2, 3);
  const seen = new Set();
  for (let cyc = 0; cyc < 200; cyc++) seen.add(c.stepsForCycle(cyc)[0].value);
  assert.deepEqual([...seen].sort(), [1, 2, 3]);
});

test('choose() sampled mid-cycle draws per position, not per cycle', () => {
  const c = choose(1, -1);
  // 16 onsets within one cycle (what .speed(choose(1, -1)) under a 16-step grid samples at).
  const draws = Array.from({ length: 16 }, (_, k) => c.sample(k / 16, 1, k / 16));
  assert.ok(draws.every((v) => v === 1 || v === -1), 'every draw is one of the options');
  assert.ok(new Set(draws).size > 1, 'onsets within one cycle draw independently');
  // Deterministic in time: the same positions re-draw identically.
  const again = Array.from({ length: 16 }, (_, k) => c.sample(k / 16, 1, k / 16));
  assert.deepEqual(again, draws);
});

test('a chosen pattern option plays in full for its cycle', () => {
  const c = choose('0 1 2 3', '7'); // options: a 4-step pattern and a constant
  let sawPattern = false;
  let sawConstant = false;
  for (let cyc = 0; cyc < 40; cyc++) {
    const vals = valuesAt(c, cyc);
    if (vals.length === 4) {
      assert.deepEqual(vals, [0, 1, 2, 3], `cycle ${cyc} plays the whole pattern`);
      sawPattern = true;
    } else {
      assert.deepEqual(vals, [7], `cycle ${cyc} plays the constant`);
      sawConstant = true;
    }
  }
  assert.ok(sawPattern && sawConstant, 'both options came up');
});

test('choose() honours weights', () => {
  const c = choose([1, 99], [2, 1]);
  let ones = 0;
  for (let cyc = 0; cyc < 200; cyc++) if (c.stepsForCycle(cyc)[0].value === 1) ones++;
  assert.ok(ones > 150, `heavily-weighted option dominates (got ${ones}/200)`);
});

test('a sampler config choose() lights the option actually drawn at each hit', () => {
  // Location-tagged options, as the transpile produces: "1" spans [10,11], "-1" spans [20,22].
  const sig = s(mini('breaks', 100)).vel(mini('1!16', 200)).speed(choose(mini('1', 10), mini('-1', 20)));
  const hasLoc = (st, [a, b]) => (st.locs ?? []).some((l) => l[0] === a && l[1] === b);
  let sawEach = new Set();
  for (let cyc = 0; cyc < 4; cyc++) {
    for (const st of sig.stepsForCycle(cyc)) {
      const draw = Number(sig.sampler.speed.sample(cyc + st.start, 1, cyc + st.start));
      const [drawn, other] = draw === 1 ? [[10, 11], [20, 22]] : [[20, 22], [10, 11]];
      assert.ok(hasLoc(st, drawn), `cycle ${cyc} step @${st.start}: drawn option (${draw}) lights`);
      assert.ok(!hasLoc(st, other), `cycle ${cyc} step @${st.start}: the other option stays dark`);
      sawEach.add(draw);
    }
  }
  assert.deepEqual([...sawEach].sort(), [-1, 1], 'both options came up across the window');
});

test('vel(choose(...)) draws per event, not per cycle', () => {
  const sig = n('0!16').vel(choose(1, 0.5));
  const vels = [0, 1].flatMap((cyc) => sig.stepsForCycle(cyc).map((st) => st.vel));
  assert.ok(vels.every((v) => v === 1 || v === 0.5), 'every vel is one of the options');
  assert.ok(new Set(vels).size > 1, 'events within the window draw independently');
});

// ---------------------------------------------------------------------------------------------
// Build-time seeds: stable across re-evaluation, independent of each other
// ---------------------------------------------------------------------------------------------

// The user's pattern, fingerprinted by what each of the 8 onsets in cycle 0 actually plays.
const takeOf = (sig) =>
  sig
    .stepsForCycle(0)
    .map((st) => `${sig.sampler.begin.sample(st.start, 1, st.start)}/${sig.sampler.speed.sample(st.start, 1, st.start)}`)
    .join(' ');
const buildTake = () => s('breaks').vel('1!8').begin(irand(16).div(16)).speed(choose(1, -1));

test('re-evaluating the same source rebuilds the same take (after resetRandomSeeds)', () => {
  // Playing, stopping and playing again re-evaluates the buffer. /api/stop rewinds the clock to
  // cycle 0, so the second play must be the same performance - which needs the seed counter,
  // which only ever climbs, rewound too.
  resetRandomSeeds();
  const first = takeOf(buildTake());
  resetRandomSeeds();
  assert.equal(takeOf(buildTake()), first, 'same source + same seed counter -> same take');
});

test('without the rewind, a rebuild draws a different take (what resetRandomSeeds fixes)', () => {
  resetRandomSeeds();
  const first = takeOf(buildTake());
  const second = takeOf(buildTake()); // no rewind: the next seeds off the counter
  assert.notEqual(second, first, 'the counter alone would re-roll every replay');
});

test('irand() and choose() in one pattern draw independently', () => {
  // Both read the same uniform hash at the same position, so a per-builder seed counter would
  // hand the first irand() and the first choose() seed 1 and correlate them absolutely: every
  // begin in the sample's second half would play reversed.
  resetRandomSeeds();
  const r = irand(16);
  const c = choose(1, -1);
  const draws = Array.from({ length: 64 }, (_, k) => {
    const pos = k / 16;
    return { hi: r.sample(pos, 1, pos) >= 8, fwd: c.sample(pos, 1, pos) === 1 };
  });
  assert.ok(draws.some((d) => d.hi && d.fwd), 'a high irand can still play forwards');
  assert.ok(draws.some((d) => !d.hi && !d.fwd), 'a low irand can still play reversed');
});

test('two bare .degrade()s drop different events; a shared explicit seed pins them together', () => {
  const dropped = (sig) => sig.stepsForCycle(0).map((st) => st.value == null);
  resetRandomSeeds();
  const a = dropped(n('0!16').degrade(0.5));
  const b = dropped(n('0!16').degrade(0.5));
  assert.notDeepEqual(b, a, 'independent .degrade()s flip independently');
  // The explicit seed is the escape hatch: same seed, same events dropped, so two patterns can be
  // gated in lockstep. It must NOT be reachable by the auto counter.
  assert.deepEqual(dropped(n('0!16').degrade(0.5, 7)), dropped(n('0!16').degrade(0.5, 7)));
});

test('.degrade() rebuilds identically after a reset, and is independent of an irand() beside it', () => {
  // Both are built in one "eval", so they take adjacent seeds off the shared counter - the case
  // that used to collide, since .degrade()'s default seed 0 hashed as 1 and so did the first irand().
  const build = () => {
    resetRandomSeeds();
    const r = irand(2);
    const steps = n('0!16').degrade(0.5).stepsForCycle(0);
    return steps.map((st) => ({
      dropped: st.value == null,
      low: r.sample(st.start, 1, st.start) === 0, // the same uniform, thresholded at 0.5
    }));
  };
  const first = build();
  assert.deepEqual(build(), first, 'the same source degrades the same way on re-eval');
  assert.ok(new Set(first.map((e) => e.dropped)).size > 1, 'a 50% degrade both drops and keeps');
  assert.ok(first.some((e) => e.low && !e.dropped), 'a low draw can survive');
  assert.ok(first.some((e) => !e.low && e.dropped), 'a high draw can be dropped');
});

test('independent choose() calls decorrelate', () => {
  const a = choose(...Array.from({ length: 50 }, (_, i) => i));
  const b = choose(...Array.from({ length: 50 }, (_, i) => i));
  const differ = [0, 1, 2, 3, 4, 5, 6, 7].some((cyc) => a.stepsForCycle(cyc)[0].value !== b.stepsForCycle(cyc)[0].value);
  assert.ok(differ, 'two independent choose() streams are not identical');
});
