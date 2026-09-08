// copy(): another track's pattern, re-evaluated fresh - the programmatic form of duplicating a
// block of code. The buffer lookup itself lives host-side (see /api/evaluate's resolver in
// web-app/server.js, which also owns the loop guard); what these pin is the pattern-core half:
// the resolver hook, the chainability of the result, and the method form's note swap.

import test from 'node:test';
import assert from 'node:assert/strict';

import { copy, setCopyResolver, note, s, vel, mini, setPatternWarn } from './src/signal.mjs';

const values = (sig, cycle) => sig.stepsForCycle(cycle).map((st) => st.value);

function withResolver(map, fn) {
  setCopyResolver((name) => {
    if (!(name in map)) throw new Error(`no block called ${name}`);
    return map[name](); // fresh per call, as the host's evaluator is
  });
  try {
    return fn();
  } finally {
    setCopyResolver(null);
  }
}

test('copy() hands back the resolved pattern, and chains like anything else', () => {
  withResolver({ kick: () => mini('10 20') }, () => {
    assert.deepEqual(values(copy('kick'), 0), [10, 20]);
    assert.deepEqual(values(copy('kick').fast(2), 0), [10, 20, 10, 20], 'a copy is a pattern of its own');
  });
});

test('copy() is fresh per call - two copies never share a Sig', () => {
  withResolver({ kick: () => s('bd*4') }, () => {
    assert.notEqual(copy('kick'), copy('kick'));
  });
});

test('copy() without a resolver, or without a name, says why', () => {
  assert.throws(() => copy('kick'), /inside an evaluation/);
  withResolver({ kick: () => mini('1') }, () => {
    assert.throws(() => copy(''), /takes a track name/);
    assert.throws(() => copy(7), /takes a track name/);
    assert.throws(() => copy('gone'), /no block called gone/);
  });
});

test(".copy(): the method form swaps THIS signal in as the copy's notes", () => {
  withResolver({ kick: () => note('c2 e2').vel(0.5) }, () => {
    const swapped = note('g3').copy('kick');
    assert.equal(values(swapped, 0).length, 1, "the new head's grid, not the copied one");
    // The copied track's note channels re-merge onto the new grid, exactly as .note() would.
    assert.equal(swapped.noteChannels.vel.sample(0, 1), 0.5, "kick's velocity channel survives the swap");
  });
});

test('.copy() on a control head warns and hands back the plain copy', () => {
  const warnings = [];
  setPatternWarn((msg) => warnings.push(msg));
  try {
    withResolver({ kick: () => note('c2 e2') }, () => {
      const out = vel('1!4').copy('kick');
      assert.deepEqual(values(out, 0), values(note('c2 e2'), 0));
      assert.match(warnings.join('\n'), /control.*after/i);
    });
  } finally {
    setPatternWarn(null);
  }
});
