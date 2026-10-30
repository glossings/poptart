// Values in a control's own units ("3x", "800hz", "-6db", "250ms", a note name on a control in
// hertz), range() between them and snap() to a set - and the position each control is sent. The
// conversion is the scheduler's, so the tree an engine is sent is checked by evaluating it the way
// the browser engine does (web-engine's compileExpr, which the desktop's own tests hold to).

import test from 'node:test';
import assert from 'node:assert/strict';

import { mini, setPatternWarn, sine, synth } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { parseUnitValue, registerDeviceParams, unitConversion, unitPosition, unitTree, deviceParamSpec } from './src/units.mjs';
import { compileExpr } from '../web-engine/src/dsp/expr.mjs';

registerDeviceParams([
  {
    id: 'FM',
    name: 'FM',
    params: [
      { id: 'op2ratio', name: 'Op 2 Ratio', min: 0.25, max: 32, curve: 'lin', unit: 'x' },
      { id: 'attack', name: 'Attack', min: 0, max: 10, curve: 'pow', curveExp: 3, unit: 's' },
      { id: 'mode', name: 'Mode', min: 0, max: 3, curve: 'lin', unit: '', options: ['a', 'b', 'c', 'd'] },
      { id: 'mix', name: 'Mix', min: 0, max: 1, curve: 'lin', unit: '' },
    ],
  },
  {
    id: 'Filter',
    name: 'Filter',
    params: [
      { id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, curve: 'exp', unit: 'Hz' },
      { id: 'pan', name: 'Pan', min: -100, max: 100, curve: 'sym', curveExp: 2, unit: 'ct' },
      { id: 'time', name: 'Time', min: 1, max: 1000, curve: 'lin', unit: 'ms' },
      { id: 'gain', name: 'Gain', min: -24, max: 24, curve: 'lin', unit: 'dB' },
    ],
  },
]);

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function mockEngine() {
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, {
    get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }),
  });
  return { engine, callsTo: (m) => calls.filter((c) => c.method === m) };
}

/** What the scheduler sends control `name` once a pattern is set and polled at time 0. */
function sends(pattern, name) {
  const { engine, callsTo } = mockEngine();
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(pattern);
  sched._pollGenericParams(0);
  const of = (m) => callsTo(m).filter((c) => c.args[2] === name || String(c.args[2]).endsWith(`~${name}`));
  return {
    values: of('setParam').map((c) => c.args[3]),
    tree: of('setParamExpr').at(-1)?.args[3] ?? null,
    lfo: callsTo('setParamLFO').filter((c) => String(c.args[2]).endsWith(name)).at(-1)?.args[3] ?? null,
  };
}

/** A tree evaluated as the browser engine evaluates it, with its inputs at `inputs`. */
const evalTree = (tree, ...inputs) => compileExpr(tree)(inputs);

function warnings(fn) {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  try { fn(); } finally { setPatternWarn(null); }
  return lines;
}

test('a number with a unit is the number in its family\'s base', () => {
  assert.deepEqual(parseUnitValue('3x'), { value: 3, unit: 'x' });
  assert.deepEqual(parseUnitValue('800Hz'), { value: 800, unit: 'hz' });
  assert.deepEqual(parseUnitValue('1.5khz'), { value: 1500, unit: 'hz' });
  assert.deepEqual(parseUnitValue('-6db'), { value: -6, unit: 'db' });
  assert.deepEqual(parseUnitValue('250ms'), { value: 0.25, unit: 's' });
  assert.deepEqual(parseUnitValue('7st'), { value: 700, unit: 'ct' });
  assert.equal(parseUnitValue('3'), null);
  assert.equal(parseUnitValue('c4'), null);
  assert.equal(parseUnitValue('bd'), null);
});

test('a pattern carries its unit through arithmetic, range and snap', () => {
  assert.deepEqual(mini('<1x 2x>').stepsForCycle(1).map((s) => s.value), [2]);
  assert.equal(mini('<1x 2x>').unit, 'x');
  assert.equal(mini('<1x 2x>').add(1).unit, 'x');
  assert.equal(mini('0 1').unit, null);
  const r = sine(1).range('1x', '8x');
  assert.equal(r.unit, 'x');
  assert.deepEqual([r.lfoIR.min, r.lfoIR.max], [1, 8], 'still one native modulator');
  assert.equal(r.snap([1, 2, 4]).unit, 'x');
  assert.equal(mini('0.3').snap(['1x', '2x']).unit, 'x');
});

test('two units in one pattern are said, and the first is the pattern\'s', () => {
  const lines = warnings(() => assert.equal(mini('<1x 800hz>').unit, 'x'));
  assert.match(lines.join('\n'), /mixes units \(x, hz\)/);
});

test('snap moves each value to the nearest of a set, the lower on a tie', () => {
  const values = (sig, cycles) => cycles.map((c) => sig.stepsForCycle(c)[0].value);
  assert.deepEqual(values(mini('<1.2 2.7 5 7.1 40>').snap([1, 2, 3, 4, 6, 8]), [0, 1, 2, 3, 4]), [1, 3, 4, 8, 8]);
  assert.deepEqual(values(mini('<1.2 2.7>').snap(mini('1,2,4', 7)), [0, 1]), [1, 2], 'the editor\'s mini("1,2,4", …)');
  assert.deepEqual(values(mini('<1.2 2.7>').snap('1x, 3x'), [0, 1]), [1, 3]);
  assert.deepEqual(values(mini('<1.4 2.6>').snap('<[1,2] [1,3]>'), [0, 1]), [1, 3], 'a set per cycle');
  assert.equal(mini('<1.4 2.6>').snap('<[1,2] [1,3]>').sample(2.5, 1, 1.5), 3, 'sampled as well as stepped');
  const lines = warnings(() => assert.deepEqual(values(mini('5').snap([]), [0]), [5]));
  assert.match(lines.join('\n'), /no numbers to snap to/);
});

test('every curve\'s tree agrees with the JavaScript conversion', () => {
  const cases = [
    ['FM', 'Op 2 Ratio', 'x', [0.25, 1, 3, 17.5, 32, 50]],
    ['FM', 'Attack', 's', [0, 0.01, 0.5, 4, 10]],
    ['Filter', 'Cutoff', 'hz', [20, 100, 800, 12000, 20000]],
    ['Filter', 'Pan', 'ct', [-100, -30, 0, 12, 100]],
    ['Filter', 'Time', 's', [0.001, 0.25, 1]],
    ['Filter', 'Gain', 'db', [-24, -6, 0, 3, 24]],
  ];
  for (const [device, name, unit, values] of cases) {
    const conv = unitConversion(deviceParamSpec(device, name), unit);
    const tree = unitTree(conv, { k: 'in', i: 0, rate: 'kr' });
    for (const v of values) {
      const js = unitPosition(conv, v);
      assert.ok(near(evalTree(tree, v), js), `${name} at ${v}${unit}: tree ${evalTree(tree, v)}, js ${js}`);
      assert.ok(js >= 0 && js <= 1);
    }
  }
  const ratio = unitConversion(deviceParamSpec('FM', 'op 2 ratio'), 'x');
  assert.ok(near(unitPosition(ratio, 3), (3 - 0.25) / 31.75));
  const time = unitConversion(deviceParamSpec('Filter', 'Time'), 's');
  assert.ok(near(unitPosition(time, 0.25), (250 - 1) / 999), '0.25 s on a control in ms is 250');
});

test('a constant in units is sent as its position; a bare number is a position as before', () => {
  assert.ok(near(sends(synth('FM').param('Op 2 Ratio', '3x'), 'Op 2 Ratio').values.at(-1), (3 - 0.25) / 31.75));
  assert.ok(near(sends(synth('FM').param('Op 2 Ratio', mini('3x', 40)), 'Op 2 Ratio').values.at(-1), (3 - 0.25) / 31.75));
  assert.ok(near(sends(synth('X').fx('Filter').param('Cutoff', '800hz'), 'Cutoff').values.at(-1), Math.log(40) / Math.log(1000)));
  assert.equal(sends(synth('FM').param('Op 2 Ratio', 0.5), 'Op 2 Ratio').values.at(-1), 0.5);
});

test('a note name on a control in hertz is its frequency', () => {
  // a3 is MIDI 69 here (c3 = 60): 440 Hz.
  const pos = sends(synth('X').fx('Filter').param('Cutoff', 'a3'), 'Cutoff').values.at(-1);
  assert.ok(near(pos, Math.log(22) / Math.log(1000)));
  assert.equal(sends(synth('X').fx('Filter').param('Cutoff', 0.3), 'Cutoff').values.at(-1), 0.3);
});

test('a modulator in units runs natively under a conversion the engine evaluates', () => {
  const { tree, lfo } = sends(synth('FM').param('Op 2 Ratio', sine(1).range('1x', '8x')), 'Op 2 Ratio');
  assert.ok(tree, 'sent as an expression');
  assert.deepEqual([lfo.min, lfo.max], [1, 8], 'its input is the native modulator, in ratios');
  assert.ok(near(evalTree(tree, 1), (1 - 0.25) / 31.75));
  assert.ok(near(evalTree(tree, 8), (8 - 0.25) / 31.75));
});

test('a snapped modulator lands on the set\'s positions', () => {
  const { tree } = sends(synth('FM').param('Op 2 Ratio', sine(1).range('1x', '8x').snap([1, 2, 3, 4, 6, 8])), 'Op 2 Ratio');
  const at = (r) => evalTree(tree, r);
  for (const [input, snapped] of [[1.2, 1], [2.6, 3], [4.9, 4], [5.1, 6], [7.9, 8]]) {
    assert.ok(near(at(input), (snapped - 0.25) / 31.75), `${input} -> ${snapped}`);
  }
});

test('a unit the control does not read is said, and the control is left alone', () => {
  let out;
  const lines = warnings(() => { out = sends(synth('X').fx('Filter').param('Cutoff', '3x'), 'Cutoff'); });
  assert.deepEqual(out.values, []);
  assert.match(lines.join('\n'), /"Cutoff" on Filter can't take a value in x: it is in Hz/);
  const mix = warnings(() => sends(synth('FM').param('Mix', '3x'), 'Mix'));
  assert.match(mix.join('\n'), /no unit/);
  const opts = warnings(() => sends(synth('FM').param('Mode', '3x'), 'Mode'));
  assert.match(opts.join('\n'), /list of options/);
});

test('a plugin\'s parameter gets the number as written, for its mapping file to read', () => {
  assert.equal(sends(synth('Serum 2').param('Filter 1 Freq', '800hz'), 'Filter 1 Freq').values.at(-1), 800);
});

test('an option name with a space, written bare, is said once', () => {
  registerDeviceParams([{ id: 'Filter', name: 'Filter', params: [{ id: 'mode', name: 'Mode', min: 0, max: 1, options: ['lowpass', 'lowpass 24'] }] }]);
  const lines = warnings(() => {
    sends(synth('X').fx('Filter').param('Mode', mini('lowpass 24', 9)), 'Mode');
    sends(synth('X').fx('Filter').param('Mode', mini("'lowpass 24'", 9)), 'Mode');
    sends(synth('X').fx('Filter').param('Mode', mini('lowpass', 9)), 'Mode');
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"lowpass 24" on Filter's Mode plays as separate steps\. For the option, quote it inside: "'lowpass 24'"/);
});
