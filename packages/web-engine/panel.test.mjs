import test from 'node:test';
import assert from 'node:assert/strict';

import { argToValue, defaultValues, defineDevice, findParam, normalize } from './src/descriptor.mjs';
import { buildPanel, paramArgFor, paramCallFor, valueFromPosition, widgetFor } from './src/panel.mjs';
import { DELAY } from './src/devices/delay.mjs';
import { FILTER } from './src/devices/filter.mjs';

const device = defineDevice({
  id: 'Distort',
  kind: 'fx',
  license: 'AGPL-3.0-only',
  description: 'Waveshaping with a mode switch.',
  params: [
    { id: 'mode', name: 'Mode', default: 0, options: ['soft', 'hard', 'fold'], group: 'Shape' },
    { id: 'drive', name: 'Drive', min: 0, max: 40, default: 6, unit: 'dB', group: 'Shape' },
    { id: 'tone', name: 'Tone', min: 200, max: 18000, default: 12000, curve: 'exp', unit: 'Hz', group: 'Out' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 1, group: 'Out' },
    { id: 'oversample', name: 'Oversample', default: 1, options: ['1x', '2x', '4x'], rate: 'k', group: 'Out' },
    { id: 'autogain', name: 'Auto Gain', min: 0, max: 1, default: 1, ui: 'toggle', rate: 'k', group: 'Out' },
  ],
});

test('widgets are inferred where the descriptor leaves them implicit', () => {
  const by = (id) => device.params.find((p) => p.id === id);
  assert.equal(widgetFor(by('mode')), 'enum');
  assert.equal(widgetFor(by('drive')), 'knob');
  assert.equal(widgetFor(by('autogain')), 'toggle');
});

test('a 0..1 param stepped by one reads as a toggle even without saying so', () => {
  const d = defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [{ id: 'bypass', name: 'Bypass', min: 0, max: 1, default: 0, step: 1 }],
  });
  assert.equal(widgetFor(d.params[0]), 'toggle');
});

test('the panel follows the descriptor group order and nothing else', () => {
  const panel = buildPanel(device);
  assert.deepEqual(panel.sections.map((s) => s.title), ['Shape', 'Out']);
  assert.deepEqual(panel.sections[0].widgets.map((w) => w.id), ['mode', 'drive']);
  assert.equal(panel.title, 'Distort');
  assert.equal(panel.kind, 'fx');
});

test('a widget carries its value, its knob position and its printed text together', () => {
  const panel = buildPanel(device, { drive: 20 });
  const drive = panel.sections[0].widgets[1];
  assert.equal(drive.value, 20);
  assert.equal(drive.position, 0.5);
  assert.equal(drive.text, '20.0 dB');
  assert.equal(drive.decimals, 1, 'and the panel says how many digits it prints, so a number box matches');
  assert.equal(drive.isDefault, false);
});

test('a missing value falls back to the default and says so', () => {
  const panel = buildPanel(device, {});
  const mix = panel.sections[1].widgets.find((w) => w.id === 'mix');
  assert.equal(mix.value, 1);
  assert.equal(mix.isDefault, true);
});

test('an out-of-range stored value is clamped rather than drawn off the end of the knob', () => {
  const panel = buildPanel(device, { drive: 999, mix: -3 });
  assert.equal(panel.sections[0].widgets[1].value, 40);
  assert.equal(panel.sections[1].widgets.find((w) => w.id === 'mix').value, 0);
});

test('only a-rate parameters advertise themselves as modulatable', () => {
  const panel = buildPanel(device);
  const flat = panel.sections.flatMap((s) => s.widgets);
  assert.equal(flat.find((w) => w.id === 'drive').modulatable, true);
  assert.equal(flat.find((w) => w.id === 'oversample').modulatable, false);
  assert.equal(flat.find((w) => w.id === 'autogain').modulatable, false);
});

test('a driven parameter names what is driving it, from a Map or a plain object alike', () => {
  const fromMap = buildPanel(device, {}, new Map([['drive', 'lfo']]));
  assert.equal(fromMap.sections[0].widgets[1].modulatedBy, 'lfo');
  const fromObject = buildPanel(device, {}, { drive: 'audio("mod")' });
  assert.equal(fromObject.sections[0].widgets[1].modulatedBy, 'audio("mod")');
  assert.equal(fromObject.sections[1].widgets[0].modulatedBy, null);
});

test('a panel says which of its controls a signal can drive, and that is the a-rate ones', () => {
  const panel = buildPanel(device);
  const byId = Object.fromEntries(panel.sections.flatMap((s) => s.widgets).map((w) => [w.id, w.modulatable]));
  assert.equal(byId.drive, true);
  assert.equal(byId.mix, true);
  assert.equal(byId.oversample, false, 'a k-rate setting is not a destination');
  assert.equal(byId.autogain, false);
});

test('our own devices carry no credit line; a ported one does', () => {
  assert.equal(buildPanel(device).credit, null);
  const ported = defineDevice({
    id: 'Density', kind: 'fx', license: 'MIT', vendor: 'airwindows', source: 'https://example.invalid/d',
    params: [{ id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 }],
  });
  assert.deepEqual(buildPanel(ported).credit, {
    vendor: 'airwindows', license: 'MIT', source: 'https://example.invalid/d',
  });
});

test('a knob position converts back to a real value on the parameter curve', () => {
  assert.equal(valueFromPosition(device, 'drive', 0.25), 10);
  const tone = valueFromPosition(device, 'tone', 0.5);
  assert.ok(Math.abs(tone - Math.sqrt(200 * 18000)) < 1e-6, `got ${tone}`);
  assert.equal(valueFromPosition(device, 'mode', 1), 2, 'an enum lands on a whole mode');
  assert.equal(valueFromPosition(device, 'nonesuch', 0.5), null);
});

test('a knob edit comes back as the call somebody could have typed, as a position', () => {
  // The call takes 0..1 like every control in the language; twelve of forty decibels is 0.3.
  assert.equal(paramCallFor(device, 'drive', 12), '.param("Drive", 0.3)');
  assert.equal(paramCallFor(device, 'mix', 0.3333333), '.param("Mix", 0.3333)');
  assert.equal(paramCallFor(device, 'tone', Math.sqrt(200 * 18000)), '.param("Tone", 0.5)', 'on the parameter curve');
  assert.equal(paramCallFor(device, 'autogain', 1), '.param("Auto Gain", 1)', 'a switch is written as 0 or 1');
  assert.equal(paramCallFor(device, 'nonesuch', 1), null);
});

test('an enum edit is written as its label, so reordering the options cannot change a song', () => {
  assert.equal(paramCallFor(device, 'mode', 2), '.param("Mode", "fold")');
  assert.equal(paramCallFor(device, 'oversample', 1), '.param("Oversample", "2x")');
});

test('the argument alone is what the editor writes over a call that is already there', () => {
  // The whole call is what an insert needs; the argument alone is what an overwrite needs, and
  // the editor does one or the other depending on whether the call is already in the buffer.
  assert.equal(paramArgFor(device, 'drive', 12), '0.3');
  assert.equal(paramArgFor(device, 'mode', 2), '"fold"');
  assert.equal(paramArgFor(device, 'nonesuch', 1), null);
  assert.equal(paramCallFor(device, 'drive', 12), `.param("Drive", ${paramArgFor(device, 'drive', 12)})`);
});

test('a widget says where it sits when nothing has touched it, so a panel can put it back', () => {
  const panel = buildPanel(device, { tone: 200 });
  const tone = panel.sections[1].widgets.find((w) => w.id === 'tone');
  assert.equal(tone.position, 0, 'the stored value is at the bottom of the range');
  assert.equal(tone.default, 12000);
  assert.equal(tone.defaultPosition, normalize(device.params[2], 12000));
  assert.ok(tone.defaultPosition > 0.9, 'and this default is near the top of its exp curve');
});

test('a loaded slot on an enum that takes samples is written by the name it was loaded under', () => {
  const d = defineDevice({
    id: 'T', kind: 'synth', license: 'AGPL-3.0-only',
    params: [{ id: 'table', name: 'Table', default: 0, options: ['Basic', 'Odd'], capacity: 8, takes: 'sample', rate: 'k' }],
  });
  const extras = { table: { 2: 'files:kick' } };
  assert.equal(paramArgFor(d, 'table', 2, extras), '"files:kick"');
  assert.equal(paramArgFor(d, 'table', 1, extras), '"Odd"');
  const panel = buildPanel(d, { table: 2 }, new Map(), { extras });
  const widget = panel.sections[0].widgets[0];
  assert.equal(widget.text, 'files:kick');
  assert.equal(widget.options[2], 'files:kick', 'the loaded name joins the option list');
  assert.equal(widget.options.length, 3, 'and the empty slots are not listed');
});

test('a panel says how wide it wants to be and which sections sit side by side', () => {
  const d = defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [
      { id: 'a', name: 'A', min: 0, max: 1, default: 0, group: 'One' },
      { id: 'b', name: 'B', min: 0, max: 1, default: 0, group: 'Two' },
      { id: 'c', name: 'C', min: 0, max: 1, default: 0, group: 'Three' },
    ],
    panel: { width: 800, rows: [['One', 'Two']] },
  });
  const panel = buildPanel(d);
  assert.equal(panel.width, 800);
  assert.deepEqual(panel.rows, [[0, 1], [2]], 'a section the rows leave out gets a row of its own');
  assert.equal(buildPanel(device).width, 560, 'and a device that says nothing gets the default');
  assert.deepEqual(buildPanel(device).rows, [[0], [1]]);
  assert.throws(() => defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [{ id: 'a', name: 'A', min: 0, max: 1, default: 0, group: 'One' }],
    panel: { rows: [['Nonesuch']] },
  }), /names section "Nonesuch"/);
});

test('a number box is a widget of its own, for a count or a transposition', () => {
  const d = defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [{ id: 'semi', name: 'Semi', min: -24, max: 24, default: 0, step: 1, ui: 'number', unit: 'st' }],
  });
  assert.equal(widgetFor(d.params[0]), 'number');
  assert.equal(buildPanel(d, { semi: 7 }).sections[0].widgets[0].text, '7 st');
});

// --- a control that is only live on another one's setting ---------------------------------------

test('a control switched out of the way by another is left off the panel, not drawn dead', () => {
  // The case: a rate knob beside a sync switch. The two say the same thing in different units
  // and only one of them is being read, so a window that shows both leaves somebody turning the
  // one that does nothing.
  const free = buildPanel(DELAY, defaultValues(DELAY));
  const ids = (p) => p.sections.flatMap((s) => s.widgets).map((w) => w.id);
  assert.ok(ids(free).includes('time'), 'free-running: the time knob is the one being read');

  const sync = findParam(DELAY, 'sync');
  const eighth = buildPanel(DELAY, { ...defaultValues(DELAY), sync: argToValue(sync, '1/8') });
  assert.ok(!ids(eighth).includes('time'), 'synced: there is no time knob to turn');
  assert.ok(ids(eighth).includes('sync'), 'and the switch that decided it is still there');

  // The editor has to know which controls do this, because moving one changes what the window
  // HAS rather than what it reads - so the panel is rebuilt rather than a knob repainted.
  assert.deepEqual(free.relayoutOn, ['sync']);
  assert.deepEqual(buildPanel(FILTER, {}).relayoutOn, [], 'a device with no such control says so');
});

test('a device that names a control nobody has, or a value it cannot take, is refused', () => {
  const base = {
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [
      { id: 'mode', name: 'Mode', default: 0, options: ['free', 'synced'] },
      { id: 'rate', name: 'Rate', min: 0, max: 1, default: 0.5, active: { param: 'mode', is: 'free' } },
    ],
  };
  assert.ok(defineDevice(base), 'a well-formed one is fine');
  assert.throws(
    () => defineDevice({ ...base, params: [base.params[0], { ...base.params[1], active: { param: 'nonesuch', is: 'free' } }] }),
    /active on "nonesuch", which this device does not have/,
  );
  assert.throws(
    () => defineDevice({ ...base, params: [base.params[0], { ...base.params[1], active: { param: 'mode', is: 'sideways' } }] }),
    /which is not one of its values/,
  );
});
