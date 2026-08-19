// rand()/perlin() are independently seeded noise streams. They used to be one single stream -
// every rand() in a document was byte-identical, so `.when(rand().gte(0.7), …)` twice fired on
// exactly the same bars. The seed comes off the same shared build-time counter choose()/irand()/
// .degrade() use, so it is positional and a re-evaluation replays the same take.
// Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { rand, perlin, s, sine, saw, tri, square, ramp, resetRandomSeeds, setPatternWarn } from './src/signal.mjs';

const SPAN = Array.from({ length: 64 }, (_, k) => k * 0.25);
const readAt = (sig) => SPAN.map((t) => sig.sample(t, 1, t));

// How often two 0/1 gate streams agree. Two independent fair coins land near 0.5; the same coin
// twice lands at exactly 1.
const agreement = (a, b) => {
  const ga = readAt(a);
  const gb = readAt(b);
  return ga.filter((v, k) => v === gb[k]).length / ga.length;
};

test('two rand() calls are independent streams, not the same one twice', () => {
  resetRandomSeeds();
  const a = rand();
  const b = rand();
  assert.notDeepEqual(readAt(a), readAt(b), 'the raw noise differs');
  assert.ok(agreement(a.gte(0.7), b.gte(0.7)) < 0.95, 'the gates they drive disagree sometimes');
});

test('a rand() is still deterministic in time - the highlighter and the scheduler must agree', () => {
  resetRandomSeeds();
  const a = rand();
  assert.deepEqual(readAt(a), readAt(a));
  // Same document, evaluated again: the counter rewinds, so the same call gets the same stream.
  const first = readAt(a);
  resetRandomSeeds();
  assert.deepEqual(readAt(rand()), first);
});

test('an explicit seed pins a stream - the way to gate two things off ONE random', () => {
  resetRandomSeeds();
  assert.deepEqual(readAt(rand({ seed: 3 })), readAt(rand({ seed: 3 })));
  assert.notDeepEqual(readAt(rand({ seed: 3 })), readAt(rand({ seed: 4 })));
  // An explicit seed lives in its own low namespace, so it can never collide with an auto one.
  assert.notDeepEqual(readAt(rand({ seed: 0 })), readAt(rand()));
});

test('rand() has no rate - asking for one warns, and still plays', () => {
  resetRandomSeeds();
  // Unsmoothed noise has no speed of its own, so a rate could only re-index the stream. Every
  // spelling of "make it faster" says so on the console - and hands back a working rand(), because
  // a livecoding instrument does not go quiet over an argument it can't use.
  const warnings = [];
  setPatternWarn((line) => warnings.push(line));
  try {
    for (const build of [() => rand(0.5), () => rand({ rate: 2 }), () => rand({ phase: 0.25 }),
      () => rand().rate(3), () => rand().phase(0.25), () => rand().fast(2)]) {
      const sig = build();
      assert.equal(sig.lfoIR.shape, 'rand', 'still a rand');
      assert.equal(sig.lfoIR.rateHz, 1, 'and still unpaced - the argument changed nothing');
      assert.ok(typeof sig.sample(0.3, 1, 0.3) === 'number', 'and it still makes values');
    }
    assert.equal(warnings.length, 6, 'each one said so exactly once');
    assert.ok(warnings.every((w) => /no rate/.test(w)));
    warnings.length = 0;
    assert.equal(rand({ nope: 1 }).lfoIR.shape, 'rand');
    assert.match(warnings[0], /takes only \{ seed \}/);
  } finally {
    setPatternWarn(null);
  }
  // perlin keeps its rate - it is the one with a period to set.
  assert.equal(perlin(0.5).lfoIR.rateCycles, 0.5, 'the number shorthand is still the rate');
  assert.equal(perlin({ rate: 2, phase: 0.25 }).lfoIR.phaseCycles, 0.25);
});

test('the seed survives every transform that rebuilds the IR', () => {
  resetRandomSeeds();
  const seeded = rand({ seed: 7 });
  for (const derived of [seeded.range(2, 5), seeded.mul(2)]) {
    assert.equal(derived.lfoIR.seed, seeded.lfoIR.seed);
  }
  const p = perlin({ seed: 7 });
  for (const derived of [p.range(2, 5), p.fast(2), p.rate(3), p.mul(2)]) {
    assert.equal(derived.lfoIR.seed, p.lfoIR.seed);
  }
});

test('rand() is unsmoothed - neighbouring reads are independent draws', () => {
  resetRandomSeeds();
  // The distinguishing property, and the whole point of the control: reading rand() twice a
  // 64th apart gives two unrelated numbers, so per-event sampling is a fresh coin every event.
  // Smoothed noise would creep between neighbours instead (see perlin below).
  const jumpiness = (sig) => {
    const vals = Array.from({ length: 64 }, (_, k) => Number(sig.sample(k / 64, 1, k / 64)));
    const gaps = vals.slice(1).map((v, k) => Math.abs(v - vals[k]));
    return gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
  };
  // Independent uniforms average |a - b| = 1/3; interpolated noise crawls a fraction of that.
  assert.ok(jumpiness(rand()) > 0.2, 'rand jumps');
  assert.ok(jumpiness(perlin()) < 0.05, 'perlin drifts - it is the smooth one');
});

test('perlin() is independently seeded too', () => {
  resetRandomSeeds();
  assert.notDeepEqual(readAt(perlin()), readAt(perlin()));
  assert.deepEqual(readAt(perlin({ seed: 1 })), readAt(perlin({ seed: 1 })));
});

test('the deterministic shapes take no seed, so they cannot shift the random counter', () => {
  resetRandomSeeds();
  const bare = [rand().lfoIR.seed, rand().lfoIR.seed];
  resetRandomSeeds();
  const interleaved = [rand().lfoIR.seed, sine(2), saw(1), tri(1), square(1), ramp(1), rand().lfoIR.seed];
  assert.equal(interleaved[0], bare[0]);
  assert.equal(interleaved[6], bare[1], 'the LFOs in between consumed no seeds');
  for (const shape of [sine(1), saw(1), tri(1), square(1), ramp(1)]) {
    assert.equal(shape.lfoIR.seed, undefined, 'a deterministic shape carries no seed at all');
  }
});

test('the two .when(rand()) conditions in the reported pattern pick different bars', () => {
  resetRandomSeeds();
  // Both conditions are built the way the pattern builds them, and read the way .when() reads
  // one on a bar-long pattern: once per cycle, at the event's onset.
  const condA = rand().gte(0.7);
  const condB = rand().gte(0.7);
  const at = (cond) => Array.from({ length: 48 }, (_, c) => Number(cond.sample(c, 1)));
  const a = at(condA);
  const b = at(condB);
  assert.notDeepEqual(a, b, 'the two conditions no longer fire on identical bars');
  assert.ok(a.includes(1) && b.includes(1), 'both fire on some bars');
  // And the track really is built from them without either condition leaking into the other.
  const track = s('breaks:19').fit().when(condA, (x) => x.ply(2)).when(condB, (x) => x.ply(3));
  assert.ok(new Set(Array.from({ length: 16 }, (_, c) => track.stepsForCycle(c).length)).size > 1);
});
