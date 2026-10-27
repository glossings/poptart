// The env() editor's reads and code edits (src/envctl.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { ENV_DEFAULTS, applyEnvEdits, envCallEdits, findEnvCallAt, readEnvCall } from './src/envctl.mjs';
import { env } from './src/signal.mjs';

/** The call around the first `env` in `code`, and `code` with `set` written into it. */
function at(code, nth = 0) {
  let idx = -1;
  for (let k = 0; k <= nth; k++) idx = code.indexOf('env(', idx + 1);
  return findEnvCallAt(code, idx + 1);
}
function write(code, set) {
  const { edits, skipped } = envCallEdits(code, at(code), set);
  return { code: applyEnvEdits(code, edits), skipped };
}

test('the name is the handle; the arguments are code', () => {
  const code = 'a: note("c3").gain(env({ attack: 0.2 }))';
  const start = code.indexOf('env(');
  const onName = findEnvCallAt(code, start + 1);
  assert.equal(onName.start, start);
  assert.equal(onName.open, start + 3);
  assert.equal(onName.close, code.indexOf('))'));
  assert.equal(onName.onName, true);
  assert.equal(findEnvCallAt(code, code.indexOf('0.2')).onName, false);
  assert.equal(findEnvCallAt(code, code.indexOf('note')), null);
});

test('only a real env( call is found', () => {
  assert.equal(findEnvCallAt('// gain(env())', 10), null, 'commented out');
  assert.equal(findEnvCallAt('s("env()")', 4), null, 'in a string');
  assert.equal(findEnvCallAt('x.env()', 3), null, 'somebody else\'s method');
  assert.equal(findEnvCallAt('myenv()', 3), null, 'a longer name');
  assert.equal(findEnvCallAt('s("x").envscale(2)', 8), null, 'envscale is the sampler\'s');
  assert.equal(findEnvCallAt('gain(env({ attack: 1 )', 6), null, 'never closes');
  assert.ok(findEnvCallAt('gain(env ())', 6)?.onName, 'space before the paren');
});

test('a missing setting reads as env()\'s own default', () => {
  assert.deepEqual(ENV_DEFAULTS, (({ attack, decay, sustain, release, curve }) => ({ attack, decay, sustain, release, curve }))(env().envIR));
  const code = 'gain(env({ attack: 0.05, retrigger: true }))';
  const read = readEnvCall(code, at(code));
  assert.deepEqual(read.values, { ...ENV_DEFAULTS, attack: 0.05 });
  assert.deepEqual(Object.keys(read.fields), ['attack']);
});

test('an existing literal is rewritten in place, other keys and layout untouched', () => {
  const code = 'gain(env({ attack: 0.01, retrigger: true, release: 0.3 }))';
  assert.equal(write(code, { attack: 0.123456, release: 1 }).code, 'gain(env({ attack: 0.1235, retrigger: true, release: 1 }))');
});

test('missing settings are added after the last entry, in the order the editor lists them', () => {
  const code = 'gain(env({ attack: 0.01, retrigger: true }))';
  assert.equal(write(code, { release: 0.5, decay: 0.2 }).code, 'gain(env({ attack: 0.01, retrigger: true, decay: 0.2, release: 0.5 }))');
  // A trailing comma stays trailing.
  assert.equal(write('env({ attack: 0.01, })', { sustain: 0.5 }).code, 'env({ attack: 0.01, sustain: 0.5, })');
});

test('an object laid out a line to an entry gets its new entries on lines of their own', () => {
  const code = 'gain(env({\n    attack: 0.01, // fast\n    retrigger: true,\n  }))';
  assert.equal(write(code, { decay: 0.4 }).code, 'gain(env({\n    attack: 0.01, // fast\n    retrigger: true,\n    decay: 0.4,\n  }))');
  const bare = 'env({\n  attack: 0.01\n})';
  assert.equal(write(bare, { release: 2 }).code, 'env({\n  attack: 0.01,\n  release: 2\n})');
});

test('env() with no argument gets an object written in', () => {
  assert.equal(write('gain(env())', { attack: 0.05 }).code, 'gain(env({ attack: 0.05 }))');
  assert.equal(write('gain(env({}))', { attack: 0.05, sustain: 0.25 }).code, 'gain(env({ attack: 0.05, sustain: 0.25 }))');
  assert.equal(write('gain(env().range(0, 1))', { release: 1.5 }).code, 'gain(env({ release: 1.5 }).range(0, 1))');
});

test('a setting that is not a plain number is shown and never overwritten', () => {
  const code = 'gain(env({ attack: "<0.01 0.2>", decay: d, sustain: 0.5 * 2, release }))';
  const read = readEnvCall(code, at(code));
  assert.deepEqual(read.values, ENV_DEFAULTS, 'the picture falls back to the defaults');
  assert.equal(read.fields.attack.text, '"<0.01 0.2>"');
  assert.equal(read.fields.attack.literal, false);
  assert.equal(read.fields.decay.text, 'd');
  assert.equal(read.fields.sustain.text, '0.5 * 2');
  assert.equal(read.fields.release.text, 'release', 'shorthand reads a variable');
  const out = write(code, { attack: 0.1, decay: 0.2, sustain: 0.3, release: 0.4, curve: 2 });
  assert.equal(out.code, 'gain(env({ attack: "<0.01 0.2>", decay: d, sustain: 0.5 * 2, release, curve: 2 }))');
  assert.deepEqual(out.skipped, ['attack', 'decay', 'sustain', 'release']);
});

test('an argument the editor cannot see into is read-only throughout', () => {
  const code = 'gain(env(opts))';
  const read = readEnvCall(code, at(code));
  assert.deepEqual(read.arg, { kind: 'opaque', text: 'opts' });
  const out = write(code, { attack: 0.1 });
  assert.equal(out.code, code);
  assert.deepEqual(out.skipped, ['attack']);
});

test('a chained .curve() is the curve that plays, so that is where a curve edit goes', () => {
  const code = 'gain(env({ curve: 2 }).range(0, 1).curve(-2))';
  assert.equal(readEnvCall(code, at(code)).values.curve, -2);
  assert.equal(write(code, { curve: 0 }).code, 'gain(env({ curve: 2 }).range(0, 1).curve(0))');
  const patterned = 'gain(env().curve(c))';
  const out = write(patterned, { curve: 1, attack: 0.2 });
  assert.equal(out.code, 'gain(env({ attack: 0.2 }).curve(c))', 'not written into the object either');
  assert.deepEqual(out.skipped, ['curve']);
});

test('an unchanged value writes nothing', () => {
  assert.deepEqual(envCallEdits('env({ attack: 0.01 })', at('env({ attack: 0.01 })'), { attack: 0.01 }).edits, []);
});

test('quoted keys and comments inside the object are read the way JavaScript reads them', () => {
  const code = 'env({ /* soft */ "attack": 0.3, \'release\': 1 /* long */ })';
  const read = readEnvCall(code, at(code));
  assert.equal(read.values.attack, 0.3);
  assert.equal(read.values.release, 1);
  assert.equal(write(code, { release: 2 }).code, 'env({ /* soft */ "attack": 0.3, \'release\': 2 /* long */ })');
});
