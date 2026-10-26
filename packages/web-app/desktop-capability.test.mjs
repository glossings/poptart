// The desktop engine, the wrapper around it, and the scheduler driving both.
//
// Some engine calls the scheduler asks about before making (an expression on a control, which
// carries audio - see pattern-core's Expressions): ask whether the engine has `setParamExpr`, and
// if not, warn once about audio and play everything else. What broke that once was the layer in
// between: `MappedEngine` forwards every method the scheduler calls, and answering yes on the
// engine's behalf sent the call to undefined - a TypeError out of `setPattern` takes the whole
// evaluation down. So this puts the three together and drives them the way the desktop server does.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Scheduler, audio, setPatternWarn, synth } from '@poptart/pattern-core';

const require = createRequire(import.meta.url);
const { MappedEngine } = require('./param-mapping.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), 'utf8');

/** Every `this.engine.X` the scheduler names, read from its source rather than listed here. */
function schedulerCalls() {
  const src = fs.readFileSync(
    path.join(path.dirname(require.resolve('@poptart/pattern-core')), 'scheduler.mjs'),
    'utf8',
  );
  return [...new Set([...src.matchAll(/this\.engine\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
}

/** An engine with exactly the methods OscEngine defines, and no others. */
function desktopShapedEngine() {
  const osc = read('..', 'osc-engine', 'index.js');
  const engine = {};
  const absent = [];
  for (const name of schedulerCalls()) {
    if (new RegExp(`^\\s{2}(async )?${name}\\(`, 'm').test(osc)) engine[name] = () => {};
    else absent.push(name);
  }
  engine.getTime = () => 0;
  return { engine, absent };
}

const captureWarnings = () => {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  return { lines, restore: () => setPatternWarn(null) };
};

test('the desktop engine has every call the scheduler makes, the optional ones included', () => {
  // If this list grows, the new entry needs the same treatment it once had for patching audio
  // onto a parameter - either OscEngine learns it, or MappedEngine.OPTIONAL hides it - and until
  // then the desktop throws where it should warn.
  const { absent } = desktopShapedEngine();
  assert.deepEqual(absent.sort(), []);
});

test('a pattern that patches audio onto a parameter is sent on the desktop, not warned about', () => {
  const { engine } = desktopShapedEngine();
  const calls = [];
  engine.setParamExpr = (...a) => calls.push(a);
  const mapped = new MappedEngine(engine);
  assert.equal(typeof mapped.setParamExpr, 'function', 'the wrapper should pass the capability on');

  const warnings = captureWarnings();
  try {
    const sched = new Scheduler(mapped, { trackId: '#1', label: 'lead' });
    sched.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));
    assert.deepEqual(warnings.lines, [], 'an engine that can do it should not be warned about');
  } finally {
    warnings.restore();
  }
  assert.deepEqual(calls, [['#1', 0, 'Osc 1 Phase', { k: 'in', i: 0, rate: 'ar', source: 'mod' }]]);
});

test('an engine without expressions is warned about once for audio, and does not throw', () => {
  const { engine } = desktopShapedEngine();
  delete engine.setParamExpr;
  delete engine.clearParamExpr;
  delete engine.paramExprs;
  const mapped = new MappedEngine(engine);
  assert.equal(typeof mapped.setParamExpr, 'undefined', 'the wrapper must not claim it');

  const warnings = captureWarnings();
  try {
    const sched = new Scheduler(mapped, { trackId: '#1', label: 'lead' });
    sched.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));

    assert.equal(warnings.lines.length, 1, 'it should say so once');
    assert.match(warnings.lines[0], /cannot patch audio into a control/);
    assert.match(warnings.lines[0], /"Osc 1 Phase"/, 'the parameter should be named');
    assert.match(warnings.lines[0], /lead/, 'so should the track');
  } finally {
    warnings.restore();
  }
});
