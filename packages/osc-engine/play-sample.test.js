'use strict';

// Unit tests for playSample's config resolution - the fit/begin/end/speed math that turns the
// scheduler's per-onset config into the plain numbers the SC synth takes. No engine boot: the
// OSC send is captured, the pack registry pre-seeded (see testing notes).

const { test } = require('node:test');
const assert = require('node:assert');

const { OscEngine } = require('./index.js');

// /poptart/playSample argument order (see playSample's _send call).
const ARG = { begin: 3, end: 4, loop: 5, speed: 6, dur: 8, onset: 9, offset: 10, cut: 12 };

function engineWithFile(duration) {
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  engine.getTime = () => 0; // so the onset/offset args are the raw event times, not wall-clock deltas
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

test('flip negates speed and plays the head of the window when it is longer than the step', () => {
  // 4.8s file, flip on, 1.2s step: the step covers 1.2s of audio, so playback runs 0.25 -> 0
  // (and no longer needs a gate-off, since dur now matches the step).
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { flip: 1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.speed], -1, 'flip reverses the rate');
  assert.strictEqual(args[ARG.begin], 0);
  assert.ok(Math.abs(args[ARG.end] - 0.25) < 1e-9, `end ${args[ARG.end]} is begin + one step of audio`);
  assert.ok(Math.abs(args[ARG.dur] - 1.2) < 1e-9);
  assert.strictEqual(args[ARG.onset], 0, 'it already fills the step, so it starts on time');
  assert.strictEqual(args[ARG.cut], 0);
});

test('a flipped one-shot shorter than its step is delayed so it lands on begin at the step end', () => {
  // 0.5s file, whole window, flip on, 1.2s step: "begin + one step of audio" is past `end`, so
  // the head is silence - the voice just starts 0.7s late and finishes on `begin` at 1.2s.
  const { engine, sent } = engineWithFile(0.5);
  engine.playSample('t1', 'breaks', { flip: 1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.end], 1, 'the whole window still plays');
  assert.ok(Math.abs(args[ARG.dur] - 0.5) < 1e-9);
  assert.ok(Math.abs(args[ARG.onset] - 0.7) < 1e-9, `onset ${args[ARG.onset]} is offset - dur`);
  assert.ok(Math.abs(args[ARG.onset] + args[ARG.dur] - args[ARG.offset]) < 1e-9, 'it ends exactly at the step end');
  assert.strictEqual(args[ARG.cut], 0);
});

test('the flip delay follows the played length, not the file length', () => {
  // 0.5s file flipped at speed 2 is 0.25s of playback, so it starts 0.95s into the 1.2s step.
  const { engine, sent } = engineWithFile(0.5);
  engine.playSample('t1', 'breaks', { flip: 1, speed: 2, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.speed], -2);
  assert.ok(Math.abs(args[ARG.dur] - 0.25) < 1e-9);
  assert.ok(Math.abs(args[ARG.onset] - 0.95) < 1e-9, `onset ${args[ARG.onset]}`);
});

test('the flipped window starts at begin and scales with |speed|', () => {
  // begin 0.5 of a 4.8s file flipped at speed 2: 1.2s at double rate = 2.4s of audio = half the file.
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { begin: 0.5, speed: 2, flip: 1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.begin], 0.5);
  assert.ok(Math.abs(args[ARG.end] - 1) < 1e-9, `end ${args[ARG.end]}`);
});

test('a flipped sub-window lands on its own begin, not on 0', () => {
  const { engine, sent } = engineWithFile(0.5);
  engine.playSample('t1', 'breaks', { begin: 0.25, end: 0.75, flip: 1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.begin], 0.25);
  assert.strictEqual(args[ARG.end], 0.75);
  assert.ok(Math.abs(args[ARG.dur] - 0.25) < 1e-9);
  assert.ok(Math.abs(args[ARG.onset] - 0.95) < 1e-9);
});

test('flip is a switch: 0.5 and below leave the voice alone', () => {
  const { engine, sent } = engineWithFile(0.5);
  for (const flip of [0, 0.5]) {
    engine.playSample('t1', 'breaks', { flip, secPerCycle: 2 }, 0, 1.2);
    const args = sent.pop().args;
    assert.strictEqual(args[ARG.speed], 1, `flip ${flip} does not reverse`);
    assert.strictEqual(args[ARG.onset], 0, `flip ${flip} does not delay`);
  }
});

test('flip on an already-negative speed plays forward, on the beat', () => {
  // Two negations cancel, and a forward voice has no reason to be re-anchored to the step end.
  const { engine, sent } = engineWithFile(0.5);
  engine.playSample('t1', 'breaks', { speed: -1, flip: 1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.speed], 1);
  assert.strictEqual(args[ARG.onset], 0);
});

test('a negative speed loops the region backwards, keeping the window as it is', () => {
  // The window is a circle: leaving `begin` backwards wraps round to `end`, so .speed(-1) is
  // "backwards from the end" - the synth's own reset point - repeating until the event's gate-off.
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { speed: -1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.begin], 0, 'the window is untouched');
  assert.strictEqual(args[ARG.end], 1);
  assert.strictEqual(args[ARG.speed], -1);
  assert.strictEqual(args[ARG.loop], 1, 'a negative speed loops by default');
  assert.strictEqual(args[ARG.onset], 0, 'and starts on the beat');
  assert.strictEqual(args[ARG.cut], 0, 'loops are gated at the event end, not cut');
});

test('a sub-window played backwards loops within itself', () => {
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { begin: 0.25, end: 0.5, speed: -1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.begin], 0.25);
  assert.strictEqual(args[ARG.end], 0.5);
  assert.strictEqual(args[ARG.loop], 1);
  assert.ok(Math.abs(args[ARG.dur] - 1.2) < 1e-9, 'dur is the window length at this rate');
});

test('loop(0) opts a negative speed out of looping - one backwards pass', () => {
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { speed: -1, loop: 0, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.loop], 0);
  assert.ok(Math.abs(args[ARG.dur] - 4.8) < 1e-9);
  assert.strictEqual(args[ARG.cut], 1, 'and is gated at the step end like any long one-shot');
});

test('a positive speed does not loop unless asked', () => {
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { speed: 1, secPerCycle: 2 }, 0, 1.2);
  assert.strictEqual(sent.pop().args[ARG.loop], 0);
});

test('flip reverses without picking up the auto-loop - it is one anchored pass', () => {
  const { engine, sent } = engineWithFile(0.5);
  engine.playSample('t1', 'breaks', { flip: 1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.speed], -1);
  assert.strictEqual(args[ARG.loop], 0, 'flip must not loop, or it could not land on the beat');
  assert.ok(Math.abs(args[ARG.onset] - 0.7) < 1e-9);
});

test('forward playback is neither trimmed nor delayed - it starts at begin, on the beat', () => {
  // Both sides of the flip branch: longer than the step (gated) and shorter (rings out early).
  for (const [duration, expectCut] of [[4.8, 1], [0.5, 0]]) {
    const { engine, sent } = engineWithFile(duration);
    engine.playSample('t1', 'breaks', { speed: 1, secPerCycle: 2 }, 0, 1.2);
    const args = sent.pop().args;
    assert.strictEqual(args[ARG.end], 1);
    assert.ok(Math.abs(args[ARG.dur] - duration) < 1e-9);
    assert.strictEqual(args[ARG.onset], 0, `a ${duration}s forward sample starts on the step`);
    assert.strictEqual(args[ARG.cut], expectCut);
  }
});

test('a flipped loop is untouched - it wraps from end and fills the step itself', () => {
  const { engine, sent } = engineWithFile(4.8);
  engine.playSample('t1', 'breaks', { flip: 1, loop: 1, secPerCycle: 2 }, 0, 1.2);
  const args = sent.pop().args;
  assert.strictEqual(args[ARG.end], 1);
  assert.ok(Math.abs(args[ARG.dur] - 4.8) < 1e-9);
  assert.strictEqual(args[ARG.onset], 0);
});
