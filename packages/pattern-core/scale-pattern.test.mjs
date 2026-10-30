// .scale() over a pattern of scale names: `:` joins a scale's parts and
// mini-notation patterns them. Each note reads the scale in force at its onset, and so does
// everything downstream that steps in the key.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, note, s } from './src/signal.mjs';

const cycles = (sig, count = 2) => Array.from({ length: count }, (_, k) => sig.stepsForCycle(k).map((st) => st.value));

test('one scale, in either spelling, plays as it always has', () => {
  assert.deepEqual(cycles(n('0 2 4').scale('F2 minor')), cycles(n('0 2 4').scale('F2:minor')));
  assert.deepEqual(cycles(n('0 2 4').scale('F minor'))[0], [65, 68, 72]);
  assert.equal(cycles(n('0 1').scale('9/8 5/4 3/2 2/1'))[0].length, 2, 'a Scala ratio list stays one tuning');
});

test('a pattern of names switches scale per cycle, quoted or colon-joined', () => {
  const colon = cycles(n('0 2 4').scale('<F1:minor F2:minor>'));
  assert.deepEqual(colon, [[41, 44, 48], [53, 56, 60]]);
  const quoted = cycles(n('0 1').scale("<'F2 31edo' 'F2 31edo major'>"));
  assert.deepEqual(quoted, cycles(n('0 1').scale('<F2:31edo F2:31edo:major>')));
  assert.notDeepEqual(quoted[0], quoted[1]);
});

test('notes snap into the scale in force, and scale steps after it step in that scale', () => {
  assert.deepEqual(cycles(note('63').scale('<C3:major C3:minor>')), [[62], [63]]);
  assert.deepEqual(cycles(n('0').scale('<C3:major C3:minor>').add(n(2))), [[64], [63]]);
  assert.deepEqual(cycles(n('0').scale('<C3:major C3:minor>').chord(5)), [[60, 64, 67], [60, 63, 67]]);
});

test('a sampler repitches by the scale in force', () => {
  const sig = s('x').n('2').scale('<C3:major C3:minor>');
  assert.deepEqual([0, 1].map((k) => sig.stepsForCycle(k)[0].cfg.note), [64, 63]);
});

test('a misspelled name in the pattern is an error at evaluation', () => {
  assert.throws(() => n('0').scale('<C:major C:nope>'), /unknown scale "nope"/);
});

test('the editor locates a scale literal: a plain name still reads as one, a pattern lights its names', async () => {
  const core = await import('./src/index.mjs');
  const { injectLocations } = await import('./src/locations.mjs');
  const run = (code) => new Function(...Object.keys(core), `return ${injectLocations(code)}`)(...Object.values(core));
  const lit = (code, sig, k) => sig.stepsForCycle(k).map((st) => (st.locs ?? [st.loc]).map(([a, b]) => code.slice(a, b)).join('+'));
  assert.deepEqual(cycles(run('n("0 2").scale("F minor")')), cycles(n('0 2').scale('F minor')));
  const code = 'n("0 2").scale("<F1 F2>:31edo")';
  const sig = run(code);
  assert.deepEqual([lit(code, sig, 0), lit(code, sig, 1)], [['0+F1', '2+F1'], ['0+F2', '2+F2']]);
});

test('":" chains with the other postfix operators in either order', async () => {
  const { mini } = await import('./src/index.mjs');
  const vals = (t) => [0, 1].map((k) => mini(t).stepsForCycle(k).map((st) => `${st.value}@${st.start}`).join(' '));
  assert.deepEqual(vals('<F1 f2>*4:minor'), vals('<F1 f2>:minor*4'));
  assert.deepEqual(vals('<F1 f2>!2:minor'), vals('<F1:minor f2:minor>!2'));
  assert.deepEqual(vals('bd*2:3'), vals('bd:3*2'));
  const drops = (t) => [0, 1, 2, 3, 4, 5].map((k) => mini(t).stepsForCycle(k).map((st) => st.value != null));
  assert.deepEqual(drops('bd?0.5:3'), drops('bd?0.5'), 'the suffix leaves the coin flips alone');
  assert.deepEqual(cycles(n('0 2 3 <5 7>').scale('<F1 f2>*4:minor')), [[41, 56, 46, 61], [41, 56, 46, 65]]);
});
