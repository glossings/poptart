// The desktop engine, the wrapper around it, and the scheduler driving both.
//
// The browser build added one thing the desktop engine cannot do - patching an audio signal onto
// a plugin parameter - and the scheduler already knew how to refuse it: ask whether the engine
// has `connectParam`, and if not, warn once and play everything else. What broke that was the
// layer in between. `MappedEngine` forwards every method the scheduler calls, which is right for
// the calls the scheduler makes outright and wrong for the ones it asks about first: the wrapper
// answered yes on the engine's behalf, the scheduler wired the route, and the call landed on
// undefined. A TypeError out of `setPattern` takes the whole evaluation down.
//
// Each half is covered on its own - param-mapping.test.js for the wrapper, pattern-core's
// param-routes.test.mjs for the scheduler's refusal - and the bug was in neither half. So this
// puts the three together and drives them the way the desktop server does.

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

test('patching audio onto a parameter is the only thing the desktop engine cannot do', () => {
  // If this list grows, the new entry needs the same treatment - either OscEngine learns it, or
  // MappedEngine.OPTIONAL hides it - and until then the desktop throws where it should warn.
  const { absent } = desktopShapedEngine();
  assert.deepEqual(absent.sort(), ['connectParam', 'disconnectParam', 'paramRoutes']);
  for (const name of absent) {
    assert.ok(MappedEngine.OPTIONAL.includes(name), `${name} is missing from OPTIONAL`);
  }
});

test('a pattern that patches audio onto a parameter warns on the desktop, and does not throw', () => {
  const { engine } = desktopShapedEngine();
  const mapped = new MappedEngine(engine);
  assert.equal(typeof mapped.connectParam, 'undefined', 'the wrapper must not claim it');

  const warnings = captureWarnings();
  try {
    const sched = new Scheduler(mapped, { trackId: '#1', label: 'lead' });
    sched.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));

    assert.equal(warnings.lines.length, 1, 'it should say so once');
    assert.match(warnings.lines[0], /cannot patch audio into a parameter/);
    assert.match(warnings.lines[0], /"Osc 1 Phase"/, 'the parameter should be named');
    assert.match(warnings.lines[0], /lead/, 'so should the track');
  } finally {
    warnings.restore();
  }
});

test('an engine that can route still gets the connection, through the same wrapper', () => {
  // The hiding is conditional, so the browser's engine - which has both - is unaffected.
  const calls = [];
  const engine = {};
  for (const name of schedulerCalls()) engine[name] = (...a) => { calls.push([name, ...a]); };
  engine.getTime = () => 0;

  const mapped = new MappedEngine(engine);
  assert.equal(typeof mapped.connectParam, 'function');

  const warnings = captureWarnings();
  try {
    const sched = new Scheduler(mapped, { trackId: '#1', label: 'lead' });
    sched.setPattern(synth('Wavetable').param('Osc 1 Phase', audio('mod')));
    assert.deepEqual(warnings.lines, [], 'an engine that can do it should not be warned about');
  } finally {
    warnings.restore();
  }

  const wired = calls.filter(([name]) => name === 'connectParam');
  assert.equal(wired.length, 1, 'the route should have been wired exactly once');
  assert.deepEqual(wired[0], ['connectParam', '#1', 0, 'Osc 1 Phase', 'mod', 1, 0]);
});
