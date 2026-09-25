import test from 'node:test';
import assert from 'node:assert/strict';

import {
  argToValue,
  clampParam,
  defaultValues,
  defineDevice,
  denormalize,
  findParam,
  formatValue,
  isToggle,
  normalize,
  paramGroups,
  signalDestinations,
  valueToArg,
} from './src/descriptor.mjs';

const minimal = (over = {}) => ({
  id: 'Test',
  kind: 'fx',
  license: 'AGPL-3.0-only',
  params: [{ id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 }],
  ...over,
});

test('a minimal descriptor fills in the defaults a short spelling leaves out', () => {
  const d = defineDevice(minimal());
  assert.equal(d.version, 1);
  assert.equal(d.vendor, 'poptart');
  assert.equal(d.build, 'worklet');
  assert.deepEqual({ ...d.channels }, { in: 2, out: 2 });
  const p = d.params[0];
  assert.equal(p.rate, 'a');
  assert.equal(p.ui, 'knob');
  assert.equal(p.curve, 'lin');
  assert.equal(p.unit, '');
  assert.equal(p.step, null);
  assert.equal(p.group, null);
});

test('a synth defaults to no input, an fx must have one', () => {
  const s = defineDevice(minimal({ kind: 'synth' }));
  assert.equal(s.channels.in, 0);
  assert.throws(() => defineDevice(minimal({ channels: { in: 0, out: 2 } })), /needs an input/);
});

test('descriptors are frozen all the way down', () => {
  const d = defineDevice(minimal());
  assert.throws(() => { d.id = 'Other'; }, TypeError);
  assert.throws(() => { d.params[0].min = 5; }, TypeError);
  assert.throws(() => { d.params.push({}); }, TypeError);
});

test('a malformed descriptor is rejected by name, not silently accepted', () => {
  assert.throws(() => defineDevice(minimal({ id: '' })), /needs an id/);
  assert.throws(() => defineDevice(minimal({ id: '9Lives' })), /must start with a letter/);
  assert.throws(() => defineDevice(minimal({ kind: 'instrument' })), /kind must be/);
  assert.throws(() => defineDevice(minimal({ license: '' })), /records its license/);
  assert.throws(() => defineDevice(minimal({ version: 0 })), /positive integer/);
});

test('a malformed param names the param it is complaining about', () => {
  const p = (over) => minimal({ params: [{ id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, ...over }] });
  assert.throws(() => defineDevice(p({ id: 'Mix Amount' })), /param id "Mix Amount" must be lowercase/);
  assert.throws(() => defineDevice(p({ name: '' })), /needs a display name/);
  assert.throws(() => defineDevice(p({ max: 0 })), /max must be above min/);
  assert.throws(() => defineDevice(p({ default: 4 })), /default 4 is outside 0..1/);
  assert.throws(() => defineDevice(p({ ui: 'dial' })), /unknown ui "dial"/);
  assert.throws(() => defineDevice(p({ rate: 'x' })), /unknown rate "x"/);
  assert.throws(() => defineDevice(p({ unit: 'furlongs' })), /unknown unit "furlongs"/);
  assert.throws(() => defineDevice(p({ curve: 'sine' })), /unknown curve "sine"/);
  assert.throws(() => defineDevice(p({ step: -1 })), /step must be a positive number/);
});

test('an exp curve needs a min above zero, because it maps a ratio', () => {
  const spec = minimal({ params: [{ id: 'freq', name: 'Freq', min: 0, max: 20000, default: 1000, curve: 'exp' }] });
  assert.throws(() => defineDevice(spec), /exp curve needs min above zero/);
});

test('two params cannot share a name or an id, in either direction', () => {
  const dup = (b) => minimal({ params: [{ id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 }, b] });
  assert.throws(() => defineDevice(dup({ id: 'mix', name: 'Wet', min: 0, max: 1, default: 1 })), /duplicate param id/);
  assert.throws(() => defineDevice(dup({ id: 'wet', name: 'Mix', min: 0, max: 1, default: 1 })), /collides/);
  // And an id may not collide with another parameter's display name, since .param() matches both.
  assert.throws(() => defineDevice(dup({ id: 'mix2', name: 'mix', min: 0, max: 1, default: 1 })), /collides/);
});

test('an enum takes its range from its options and steps by whole modes', () => {
  const d = defineDevice(minimal({
    params: [{ id: 'mode', name: 'Mode', default: 1, options: ['soft', 'hard', 'fold'] }],
  }));
  const p = d.params[0];
  assert.equal(p.ui, 'enum');
  assert.equal(p.min, 0);
  assert.equal(p.max, 2);
  assert.equal(p.step, 1);
  assert.equal(clampParam(p, 1.4), 1);
  assert.equal(clampParam(p, 9), 2);
  assert.equal(formatValue(p, 2), 'fold');
});

test('params resolve by id or by display name, case-insensitively, like a plugin parameter', () => {
  const d = defineDevice(minimal({
    params: [{ id: 'filter.cutoff', name: 'Filter Cutoff', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' }],
  }));
  assert.equal(findParam(d, 'filter.cutoff')?.id, 'filter.cutoff');
  assert.equal(findParam(d, 'Filter Cutoff')?.id, 'filter.cutoff');
  assert.equal(findParam(d, 'filter cutoff')?.id, 'filter.cutoff');
  assert.equal(findParam(d, 'FILTER.CUTOFF')?.id, 'filter.cutoff');
  assert.equal(findParam(d, 'filtercutoff'), null, 'a name still has to be spelled right');
  assert.equal(findParam(d, 'nonesuch'), null);
  assert.equal(findParam(d, null), null);
});

test('signal destinations are every a-rate param, and nothing else', () => {
  const d = defineDevice(minimal({
    kind: 'synth',
    params: [
      { id: 'level', name: 'Level', min: 0, max: 1, default: 1 },
      { id: 'phase', name: 'Phase', min: -4, max: 4, default: 0 },
      { id: 'voices', name: 'Voices', min: 1, max: 16, default: 8, rate: 'k', step: 1 },
    ],
  }));
  assert.deepEqual(signalDestinations(d).map((s) => s.id), ['level', 'phase']);
});

test('a separate list of signal inputs is refused: a parameter a signal can drive already is one', () => {
  const spec = minimal({
    params: [{ id: 'level', name: 'Level', min: 0, max: 1, default: 0 }],
    inputs: [{ id: 'phase', name: 'Phase' }],
  });
  assert.throws(() => defineDevice(spec), /inputs are not a thing/);
});

test('normalize and denormalize round-trip on every curve', () => {
  const d = defineDevice(minimal({
    params: [
      { id: 'lin', name: 'Lin', min: -12, max: 12, default: 0 },
      { id: 'freq', name: 'Freq', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' },
      { id: 'depth', name: 'Depth', min: 0, max: 1, default: 0.5, curve: 'pow', curveExp: 3 },
    ],
  }));
  for (const p of d.params) {
    for (const t of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
      const v = denormalize(p, t);
      assert.ok(Math.abs(normalize(p, v) - t) < 1e-9, `${p.id} at ${t} round-tripped to ${normalize(p, v)}`);
    }
  }
});

test('an exp curve sweeps by ratio: half travel is the geometric middle', () => {
  const d = defineDevice(minimal({
    params: [{ id: 'freq', name: 'Freq', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' }],
  }));
  const mid = denormalize(d.params[0], 0.5);
  assert.ok(Math.abs(mid - Math.sqrt(20 * 20000)) < 1e-6, `got ${mid}`);
});

test('positions outside 0..1 and junk values land on something sane', () => {
  const d = defineDevice(minimal());
  const p = d.params[0];
  assert.equal(denormalize(p, -5), 0);
  assert.equal(denormalize(p, 5), 1);
  assert.equal(clampParam(p, NaN), p.default);
  assert.equal(clampParam(p, 'nonsense'), p.default);
  assert.equal(normalize(p, -99), 0);
});

test('defaults come out as the map the engine sets a fresh device to', () => {
  const d = defineDevice(minimal({
    params: [
      { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 },
      { id: 'drive', name: 'Drive', min: 0, max: 40, default: 6, unit: 'dB' },
    ],
  }));
  assert.deepEqual(defaultValues(d), { mix: 1, drive: 6 });
});

test('groups keep declaration order, and ungrouped params come first', () => {
  const d = defineDevice(minimal({
    params: [
      { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 },
      { id: 'a.one', name: 'A One', min: 0, max: 1, default: 0, group: 'A' },
      { id: 'b.one', name: 'B One', min: 0, max: 1, default: 0, group: 'B' },
      { id: 'a.two', name: 'A Two', min: 0, max: 1, default: 0, group: 'A' },
    ],
  }));
  const groups = paramGroups(d);
  assert.deepEqual(groups.map((g) => g.group), [null, 'A', 'B']);
  assert.deepEqual(groups[1].params.map((p) => p.id), ['a.one', 'a.two']);
});

test('a readout prints enough digits to see a change, with the unit', () => {
  const d = defineDevice(minimal({
    params: [
      { id: 'freq', name: 'Freq', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' },
      { id: 'drive', name: 'Drive', min: 0, max: 40, default: 6, unit: 'dB' },
      { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 },
      { id: 'bypass', name: 'Bypass', min: 0, max: 1, default: 0, ui: 'toggle' },
      { id: 'voices', name: 'Voices', min: 1, max: 16, default: 8, step: 1, rate: 'k' },
    ],
  }));
  const [freq, drive, mix, bypass, voices] = d.params;
  // Digits after the point are FIXED per parameter, from its span, so a readout keeps its width
  // as the control is dragged rather than flickering wider and narrower per frame.
  assert.equal(formatValue(freq, 1234.56), '1235 Hz');
  assert.equal(formatValue(freq, 45.321), '45 Hz');
  assert.equal(formatValue(drive, 6.25), '6.3 dB');
  assert.equal(formatValue(mix, 0.5), '0.500');
  assert.equal(formatValue(mix, 1 / 3), '0.333');
  assert.equal(formatValue(bypass, 1), 'on');
  assert.equal(formatValue(bypass, 0), 'off');
  assert.equal(formatValue(voices, 8), '8');
});

test('a param() argument is a position, a label or a switch, and comes back the same way', () => {
  const d = defineDevice(minimal({
    params: [
      { id: 'freq', name: 'Freq', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' },
      { id: 'semi', name: 'Semi', min: -24, max: 24, default: 0, step: 1, ui: 'number' },
      { id: 'mode', name: 'Mode', default: 0, options: ['soft', 'hard', 'fold'] },
      { id: 'on', name: 'On', min: 0, max: 1, default: 0, ui: 'toggle' },
      { id: 'table', name: 'Table', default: 0, options: ['Basic'], capacity: 4, takes: 'sample' },
    ],
  }));
  const [freq, semi, mode, on, table] = d.params;
  // A sweep takes a position on its own curve.
  assert.ok(Math.abs(argToValue(freq, 0.5) - Math.sqrt(20 * 20000)) < 1e-6);
  assert.equal(argToValue(freq, 2), 20000, 'past the end is the end');
  assert.equal(valueToArg(freq, Math.sqrt(20 * 20000)), '0.5');
  // A stepped one lands on its steps.
  assert.equal(argToValue(semi, 0.5), 0);
  assert.equal(argToValue(semi, 0.75), 12);
  assert.equal(valueToArg(semi, 12), '0.75');
  // An enum takes its label, spelled any way, or a whole-number index - not a position.
  assert.equal(argToValue(mode, 'fold'), 2);
  assert.equal(argToValue(mode, 'HARD'), 1);
  assert.equal(argToValue(mode, 1), 1);
  assert.equal(argToValue(mode, 'nonesuch'), null, 'a word that is no label is refused');
  assert.equal(valueToArg(mode, 2), '"fold"');
  // A switch takes 0 or 1 and anything from a half up is on.
  assert.equal(argToValue(on, 0.7), 1);
  assert.equal(argToValue(on, 0.2), 0);
  assert.equal(valueToArg(on, 1), '1');
  assert.equal(isToggle(on), true);
  // A loaded slot past the option list prints as empty until something is loaded, and a name
  // the engine loaded is printed once it says so.
  assert.equal(formatValue(table, 2), 'empty');
  assert.equal(formatValue(table, 2, { 2: 'files:kick' }), 'files:kick');
  assert.equal(argToValue(table, 'files:kick'), null, 'a file name is the engine\'s to resolve, not a label');
});

test('a descriptor can lay its panel out, and a sample-taking enum reserves room past its list', () => {
  const d = defineDevice(minimal({
    params: [
      { id: 'a', name: 'A', min: 0, max: 1, default: 0, group: 'One' },
      { id: 'b', name: 'B', min: 0, max: 1, default: 0, group: 'Two' },
      { id: 'ir', name: 'IR', default: 0, options: ['room', 'hall'], capacity: 8, takes: 'sample' },
    ],
    panel: { width: 800, rows: [['One', 'Two']] },
  }));
  assert.equal(d.panel.width, 800);
  assert.deepEqual(d.panel.rows, [['One', 'Two']]);
  assert.equal(d.params[2].max, 7, 'the range reaches to the capacity');
  assert.equal(d.params[2].capacity, 8);
  assert.throws(() => defineDevice(minimal({ params: [{ id: 'x', name: 'X', min: 0, max: 1, default: 0, takes: 'sample' }] })), /needs an option list/);
  assert.throws(() => defineDevice(minimal({ params: [{ id: 'x', name: 'X', default: 0, options: ['a', 'b'], capacity: 1 }] })), /capacity/);
  assert.throws(() => defineDevice(minimal({ sidechain: true, kind: 'synth' })), /only an effect can take a sidechain/);
});
