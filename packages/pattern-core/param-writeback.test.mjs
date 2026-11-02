// A device control turned in its window, where the code sets it with a .param(): the value is
// written back into that .param() spelled the way it was (units.mjs's restateParamArg), and the
// scheduler stops polling the code's value over the hand's until the code is played again
// (Scheduler#takeParamByHand).

import test from 'node:test';
import assert from 'node:assert/strict';

import { restateParamArg } from './src/units.mjs';
import { n, Scheduler } from './src/index.mjs';

const hz = (value) => ({ value, position: 0.5, unit: 'Hz', decimals: 0 });

test('a value in units stays in its unit, in its quotes', () => {
  assert.equal(restateParamArg('"-6db"', { value: -20.41, unit: 'dB', decimals: 1 }), '"-20.4db"');
  assert.equal(restateParamArg("'800hz'", hz(1234.6)), "'1235hz'");
  assert.equal(restateParamArg('"800Hz"', hz(1234.6)), '"1235Hz"', 'the unit as it was typed');
  assert.equal(restateParamArg('"800 hz"', hz(1234.6)), '"1235 hz"', 'and the space');
  assert.equal(restateParamArg('"0.8khz"', hz(1234.6)), '"1.235khz"', 'a bigger unit carries more decimals');
  assert.equal(restateParamArg('"1.5ms"', { value: 0.0042, unit: 's', decimals: 4 }), '"4.2ms"');
  assert.equal(restateParamArg('"250ms"', { value: 0.4567, unit: 's', decimals: 2 }), '"457ms"');
  assert.equal(restateParamArg('"-6db"', { value: -0.04, unit: 'dB', decimals: 1 }), '"0db"', 'no negative zero');
});

test('a bare number stays a position; a choice or a switch stays an index', () => {
  assert.equal(restateParamArg('0.4', { value: 5000, position: 0.912345, unit: 'Hz' }), '0.9123');
  assert.equal(restateParamArg('.4', { value: 1, position: 0.25 }), '0.25');
  assert.equal(restateParamArg('1', { value: 2, position: 1, index: true }), '2');
  assert.equal(restateParamArg('0', { value: 1, position: 1, index: true }), '1');
  assert.equal(restateParamArg("'0.4'", { position: 0.25 }), "'0.25'", 'a quoted number keeps its quotes');
});

test('an option stays a name', () => {
  const to = { value: 2, index: true, options: ['sine', 'tri', 'saw'], label: 'saw' };
  assert.equal(restateParamArg('"sine"', to), '"saw"');
  assert.equal(restateParamArg("'Sine'", to), "'saw'");
  assert.equal(restateParamArg('"1/8."', { value: 0, index: true, options: ['1/8.', '1/4'], label: '1/4' }), '"1/4"');
});

test('a note on a control in hertz is written in hertz', () => {
  assert.equal(restateParamArg('"c3"', hz(523.25)), '"523hz"');
  assert.equal(restateParamArg('"c3"', { value: 1, position: 0.2, unit: 'dB' }), null);
});

test('anything that is not one plain value is the code\'s, and left alone', () => {
  const to = { value: 1000, position: 0.5, unit: 'Hz', decimals: 0, options: null };
  for (const written of ['"<0.2 0.5>"', '"0.2 0.5"', 'sine.range(0.2, 0.8)', 'cut', 'cut * 2', '0.2 + 0.1',
    'knob(0.4)', '`0.4`', '"3x"', '"sine"', '"a\\"b"']) {
    assert.equal(restateParamArg(written, to), null, written);
  }
  assert.equal(restateParamArg('"-6db"', { value: 3, unit: null }), null, 'a control with no unit');
  assert.equal(restateParamArg('"tri saw"', { value: 2, index: true, options: ['sine', 'tri', 'saw'], label: 'saw' }), null);
});

// An engine that records what it is sent.
function recorder() {
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) });
  return { calls, engine };
}
const sentTo = (calls, name) => calls.filter((c) => c.method === 'setParam' && c.args[2] === name).map((c) => c.args[3]);

test('a control taken by hand is not polled back to the code until the next pattern', () => {
  const { calls, engine } = recorder();
  const sched = new Scheduler(engine, { trackId: 'f', cps: 1 });
  const play = () => sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.4).param('Resonance', 0.2));
  play();
  sched._pollGenericParams(0);
  assert.deepEqual(sentTo(calls, 'Cutoff'), [0.4]);
  sched.takeParamByHand(1, ['cutoff', 'Cutoff']);
  calls.length = 0;
  sched._pollGenericParams(0.1);
  assert.deepEqual(sentTo(calls, 'Cutoff'), [], 'the hand has it');
  assert.deepEqual(sentTo(calls, 'Resonance'), [0.2], 'the control beside it still plays its code');
  sched.takeParamByHand(0, ['cutoff']);
  play();
  calls.length = 0;
  sched._pollGenericParams(0.2);
  assert.deepEqual(sentTo(calls, 'Cutoff'), [0.4], 'the code is played again');
});

test('only the slot the hand is on', () => {
  const { calls, engine } = recorder();
  const sched = new Scheduler(engine, { trackId: 'f', cps: 1 });
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.4).fx('Filter').param('Cutoff', 0.6));
  sched.takeParamByHand(2, ['Cutoff']);
  sched._pollGenericParams(0);
  assert.deepEqual(calls.filter((c) => c.method === 'setParam' && c.args[2] === 'Cutoff').map((c) => [c.args[1], c.args[3]]), [[1, 0.4]]);
});

test('a control the new code sets steadily where it had a pattern is held again, saying so', () => {
  const { calls, engine } = recorder();
  const sched = new Scheduler(engine, { trackId: 'f', cps: 1 });
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', '<0.2 0.5>'));
  sched._pollGenericParams(0);
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.4));
  sched._pollGenericParams(0.1);
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', 0.5));
  const holds = calls.filter((c) => c.method === 'holdParam').map((c) => c.args[3]);
  assert.deepEqual(holds, [{ steady: false }, { steady: true }], 'and not again while it stays steady');
});

test('a hand cannot take a control a pattern drives, and is given one back on request', () => {
  const { calls, engine } = recorder();
  const sched = new Scheduler(engine, { trackId: 'f', cps: 1 });
  sched.setPattern(n('0*4').synth('FM').fx('Filter').param('Cutoff', '<0.2 0.6>').param('Resonance', 0.2));
  sched._pollGenericParams(0);
  assert.equal(sched.takeParamByHand(1, ['Cutoff']), false, 'the pattern keeps it');
  assert.equal(sched.takeParamByHand(1, ['Resonance']), true);
  calls.length = 0;
  sched._pollGenericParams(0.1);
  assert.ok(sentTo(calls, 'Cutoff').length, 'the pattern still plays');
  assert.deepEqual(sentTo(calls, 'Resonance'), []);
  sched.releaseParamByHand(1, ['Resonance']);
  assert.deepEqual(calls.filter((c) => c.method === 'releaseParamHands').map((c) => c.args), [['f', 1, 'Resonance']]);
  calls.length = 0;
  sched._pollGenericParams(0.2);
  assert.deepEqual(sentTo(calls, 'Resonance'), [0.2], 'the code has it again');
});

test('every evaluation gives back what a hand took in a plugin window', () => {
  const { calls, engine } = recorder();
  const sched = new Scheduler(engine, { trackId: 'f', cps: 1 });
  sched.setPattern(n('0*4').synth('FM').param('Cutoff', 0.4));
  const released = calls.filter((c) => c.method === 'releaseParamHands');
  assert.deepEqual(released.map((c) => c.args), [['f']]);
});
