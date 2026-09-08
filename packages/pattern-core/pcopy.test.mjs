// pcopy(): another track's notes with the dressing left behind - the complement of .copy()'s
// chain-keeping method form. Pins the extraction (what survives, what is dropped), the sampler
// pitch conversion, the method form's swap, and the live-wire warning.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pcopy, setCopyResolver, note, s, mini, midi, synth, pianoroll, rand, setPatternWarn } from './src/signal.mjs';

const values = (sig, cycle = 0) => sig.stepsForCycle(cycle).map((st) => st.value);

function withResolver(map, fn) {
  setCopyResolver((name) => {
    if (!(name in map)) throw new Error(`no block called ${name}`);
    return map[name]();
  });
  try {
    return fn();
  } finally {
    setCopyResolver(null);
  }
}

test('pcopy() takes the notes exactly and none of the chain', () => {
  const a = () => pianoroll('60,0,4,0.8 64,4,4,0.5', { grid: 16, len: 16 }).synth('Serum 2').fx('ValhallaRoom').postgain(0.8);
  withResolver({ a }, () => {
    const b = pcopy('a');
    assert.deepEqual(values(b), [60, 64]);
    assert.deepEqual(b.stepsForCycle(0).map((st) => st.vel), [0.8, 0.5], 'drawn velocities ride the steps');
    assert.equal(b.instrument, null, 'no instrument comes along');
    assert.deepEqual(b.fxChain, [], 'no fx');
    assert.equal(b.sampler, null);
    assert.deepEqual(b.channel, {}, 'no channel strip');
    assert.equal(b.pitchKind, 'note');
  });
});

test("the asked-for use: a's roll, conditionally transposed, on a different synth", () => {
  const a = () => pianoroll('60,0,8 64,8,8', { grid: 16, len: 16 }).synth('Serum 2');
  withResolver({ a }, () => {
    const b = pcopy('a').when(rand().gte(2), (x) => x.add(note(12))).synth('Sub Boombass');
    assert.deepEqual(values(b), [60, 64], 'condition false: the roll exactly');
    const up = pcopy('a').when(rand().gte(-1), (x) => x.add(note(12))).synth('Sub Boombass');
    assert.deepEqual(values(up), [72, 76], 'condition true: transposed');
    assert.equal(b.instrument, 'Sub Boombass', 'and only the new chain dresses it');
    assert.deepEqual(b.fxChain, []);
  });
});

test('a sampler track copies as the notes it plays', () => {
  const a = () => pianoroll('36,0,4,0.9 43,4,4,0.4', { grid: 16, len: 16 }).s(mini('bd'));
  withResolver({ a }, () => {
    const b = pcopy('a');
    assert.deepEqual(values(b), [36, 43], 'the repitch notes, not the pack names');
    assert.deepEqual(b.stepsForCycle(0).map((st) => st.vel), [0.9, 0.4]);
    assert.equal(b.sampler, null);
    assert.equal(b.pitchKind, 'note');
    assert.equal(b.stepsForCycle(0).every((st) => st.cfg === undefined), true, 'sampler config is left behind');
  });
});

test('a sampler event with no pitch of its own copies as 60 - as recorded', () => {
  withResolver({ a: () => s(mini('bd hh')) }, () => {
    assert.deepEqual(values(pcopy('a')), [60, 60]);
  });
});

test('.pcopy(): the method form keeps THIS chain and plays the copied notes', () => {
  const a = () => note('c2 e2').synth('Serum 2');
  withResolver({ a }, () => {
    const b = synth('Sub Boombass').fx('Pro-C 2').pcopy('a');
    assert.deepEqual(values(b), [48, 52]); // c3 = 60 here, so c2/e2 = 48/52
    assert.equal(b.instrument, 'Sub Boombass');
    assert.deepEqual(b.fxChain.map((f) => f.name ?? f), b.fxChain.map((f) => f.name ?? f), 'chain intact');
    assert.equal(b.fxChain.length, 1);
  });
});

test('a copy is a pattern of its own - transforming it never touches the source', () => {
  const a = () => note('c3');
  withResolver({ a }, () => {
    const one = pcopy('a').add(note(12));
    const two = pcopy('a');
    assert.deepEqual(values(one), [72]);
    assert.deepEqual(values(two), [60]);
  });
});

test('a live-wire track has no written notes: warn, stay silent, keep playing', () => {
  const warnings = [];
  setPatternWarn((m) => warnings.push(m));
  try {
    withResolver({ keys: () => midi('KeyStep').synth('Serum 2') }, () => {
      const b = pcopy('keys');
      assert.equal(b.stepsForCycle, null);
      assert.equal(b.sample(0.5, 1, 0.5), null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /live wire/);
    });
  } finally {
    setPatternWarn(null);
  }
});

test('resolver errors read the same as copy()', () => {
  assert.throws(() => pcopy('a'), /inside an evaluation/);
  withResolver({ a: () => note('c3') }, () => {
    assert.throws(() => pcopy(''), /takes a track name/);
    assert.throws(() => pcopy('gone'), /no block called gone/);
  });
});
