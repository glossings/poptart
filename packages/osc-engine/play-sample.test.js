'use strict';

// Unit tests for playSample's config resolution - the fit/begin/end/speed math that turns the
// scheduler's per-onset config into the plain numbers the SC synth takes. No engine boot: the
// OSC send is captured, the pack registry pre-seeded (see testing notes).

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index.js');

// /poptart/playSample argument order (see playSample's _send call).
const ARG = { begin: 3, end: 4, loop: 5, speed: 6, dur: 8 };

function engineWithFile(duration) {
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  engine._packs.set('breaks', {
    status: 'ready',
    files: [{ path: 'breaks/a.wav', duration, channels: 2 }],
  });
  const sent = [];
  engine._send = (addr, args) => sent.push({ addr, args });
  return { engine, sent };
}

test('fit is computed from the whole file, so begin does not repitch', () => {
  // 4.8s file at 2s/cycle = 2.4 measures -> auto-fit target 2 -> speed 1.2, whatever begin is.
  const { engine, sent } = engineWithFile(4.8);
  for (const begin of [0, 0.25, 9 / 16]) {
    engine.playSample('t1', 'breaks', { begin, fit: 'auto', secPerCycle: 2 }, 0, 0.125);
    const args = sent.pop().args;
    assert.strictEqual(args[ARG.begin], begin);
    assert.ok(Math.abs(args[ARG.speed] - 1.2) < 1e-9, `begin ${begin}: speed ${args[ARG.speed]} stays 1.2`);
  }
});

test('explicit fit(n) also targets the whole file', () => {
  // 4.8s file at 2s/cycle = 2.4 measures; fit(4) -> speed 0.6 regardless of the window.
  const { engine, sent } = engineWithFile(4.8);
  for (const begin of [0, 0.5]) {
    engine.playSample('t1', 'breaks', { begin, fit: 4, secPerCycle: 2 }, 0, 0.125);
    assert.ok(Math.abs(sent.pop().args[ARG.speed] - 0.6) < 1e-9, `begin ${begin} does not change the fit rate`);
  }
});

test('fit multiplies an explicit speed, keeping its sign', () => {
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { speed: -1, fit: 'auto', secPerCycle: 2 }, 0, 0.125);
  assert.ok(Math.abs(sent.pop().args[ARG.speed] - -1.2) < 1e-9);
});

test('dur is the begin..end window length at the fitted rate', () => {
  // Window 0.25..1 of a 4.8s file = 3.6s of audio, played at 1.2x -> 3s.
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { begin: 0.25, fit: 'auto', secPerCycle: 2 }, 0, 0.125);
  assert.ok(Math.abs(sent.pop().args[ARG.dur] - 3) < 1e-9);
});

test('without fit, speed passes through untouched', () => {
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { begin: 0.5, speed: 2, secPerCycle: 2 }, 0, 0.125);
  assert.strictEqual(sent.pop().args[ARG.speed], 2);
});
