// A pattern's steps read as a looping shift register (.bits()), the shiftreg() widget built on it,
// and the row options (`mutate`, `deviation`) the evaluation reads for the editor.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './src/index.mjs';

const { steps, shiftreg, mini, n, registerWords, injectLocations, beginWidgets, takeWidgets, setWidgetValue, setPatternWarn, parseCells, SHIFTREG_BITS } = core;

// The register's words a pattern's .bits(width) gives for one cycle, as whole numbers.
const words = (sig, width = 8, cycle = 0) => sig.bits(width).stepsForCycle(cycle).map((s) => Math.round(s.value * (2 ** width - 1)));

function evalLines(code, base = 0, deck = 'a') {
  const out = injectLocations(code, base);
  const names = Object.keys(core);
  const values = names.map((k) => core[k]);
  beginWidgets(deck);
  const lines = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  const sigs = lines.map((l) => new Function(...names, `return ${l.replace(/^\s*[\w$]+:\s*/, '')}`)(...values));
  return { out, sigs, widgets: takeWidgets() };
}

test('bits: one value per step of the grid, the current step the top bit of the window', () => {
  const st = steps('x . x x . . x .').bits(8).stepsForCycle(0);
  assert.equal(st.length, 8);
  assert.deepEqual(st.map((s) => [s.start, s.end]), Array.from({ length: 8 }, (_, i) => [i / 8, (i + 1) / 8]));
  // Step 0 is 1, then reading back round the loop: steps 7..1 are 0 1 0 0 1 1 0.
  assert.equal(Math.round(st[0].value * 255), 0b10100110);
  assert.ok(st.every((s) => s.value >= 0 && s.value <= 1));
});

test('bits: each value is the new step\'s bit on top of the one before shifted down a place', () => {
  for (const row of ['x . x x . . x .', 'x x . . . x . x x . . . . x . x', '. . . x', 'x x x x']) {
    for (const width of [3, 8, 12]) {
      const cells = parseCells(row).map((c) => (c.on ? 1 : 0));
      const w = words(steps(row), width);
      for (let i = 0; i < w.length; i++) {
        const prev = w[(i - 1 + w.length) % w.length];
        assert.equal(w[i], cells[i] * 2 ** (width - 1) + Math.floor(prev / 2), `${row} width ${width} step ${i}`);
      }
    }
  }
});

test('bits: the window wraps round the cycle, and past it when wider than the loop', () => {
  // The first step looks back over the end of the same cycle.
  assert.deepEqual(words(steps('x . . .'), 4), [0b1000, 0b0100, 0b0010, 0b0001]);
  // The last step's hit is the bit just under the top on the first step of the next pass.
  assert.deepEqual(words(steps('. . . x'), 4), [0b0100, 0b0010, 0b0001, 0b1000]);
  // Eight wide over a loop of four: the loop read twice.
  assert.deepEqual(words(steps('x . . .'), 8), [0b10001000, 0b01000100, 0b00100010, 0b00010001]);
  assert.equal(registerWords([1, 0, 1], 5)[0], 0b11011);
});

test('bits: a run of rests falls away by halves, and a hit leaps up', () => {
  const w = words(steps('x . . . . . . .'), 8);
  assert.deepEqual(w, [128, 64, 32, 16, 8, 4, 2, 1]);
});

test('bits: every step of the grid has a value, rests included; all rests read 0', () => {
  const st = steps('. . . .').bits().stepsForCycle(0);
  assert.equal(st.length, 4);
  assert.ok(st.every((s) => s.value === 0));
});

test('bits: a step is 1 when an event starts in it with a value that is not a rest, 0 or false', () => {
  assert.deepEqual(words(n(mini('1 0 ~ 3')), 4), [0b1100, 0b0110, 0b0011, 0b1001]);
  // The grid is the finest one every event lies on, with or without its rests written as steps.
  assert.deepEqual(words(n(mini('[1 ~] 2')), 4), [0b1010, 0b0101, 0b1010, 0b0101]);
});

test('bits: the width can be patterned, read at the start of each cycle', () => {
  const sig = steps('x . . .').bits(mini('<2 4>'));
  assert.deepEqual(sig.stepsForCycle(0).map((s) => s.value * 3), [2, 1, 0, 0]);
  assert.deepEqual(sig.stepsForCycle(1).map((s) => Math.round(s.value * 15)), [8, 4, 2, 1]);
});

test('bits: the default is eight wide; a pattern with no steps is said to need them', () => {
  assert.deepEqual(steps('x . . . . . . .').bits().stepsForCycle(0).map((s) => Math.round(s.value * 255)), [128, 64, 32, 16, 8, 4, 2, 1]);
  assert.throws(() => core.sine().bits(), /needs a step pattern/);
});

test('bits: a step carries the spans of the cell it reads', () => {
  const st = steps('x . x x').bits().stepsForCycle(0);
  // Outside an evaluation the row has no place in a buffer: nothing to light.
  assert.ok(st.every((s) => !s.locs?.length));
  const { sigs } = evalLines('shiftreg("x . x x")', 0);
  const lit = sigs[0].stepsForCycle(0).map((s) => s.locs);
  assert.deepEqual(lit, [[[10, 11]], [[12, 13]], [[14, 15]], [[16, 17]]]);
});

test('shiftreg: its pattern is its row through .bits(), eight wide', () => {
  assert.equal(SHIFTREG_BITS, 8);
  const row = 'x . x x . . x . x x . . . x . x';
  const { sigs, widgets } = evalLines(`shiftreg("${row}", 0.05)`, 0);
  assert.deepEqual(sigs[0].stepsForCycle(0).map((s) => s.value), steps(row).bits(8).stepsForCycle(0).map((s) => s.value));
  assert.equal(widgets.inputs[0].kind, 'shiftreg');
  assert.equal(widgets.inputs[0].value, row);
  assert.equal(widgets.inputs[0].opts.mutate, 0.05);
  // Works as a pattern of values like any other: n(shiftreg(...).range(0, 7)).
  const degrees = n(sigs[0].range(0, 7)).stepsForCycle(0).map((s) => s.value);
  assert.equal(degrees.length, 16);
  assert.ok(degrees.every((d) => d >= 0 && d <= 7));
});

test('shiftreg: a count throws a row of that many cells, half of them hits, for the editor to write', () => {
  const { sigs, widgets } = evalLines('shiftreg(16, 0.05)', 0);
  const thrown = widgets.inputs[0].value;
  const cells = parseCells(thrown);
  assert.equal(cells.length, 16);
  assert.equal(cells.filter((c) => c.on).length, 8);
  assert.match(thrown, /^[x.](?: [x.]){15}$/);
  // What plays is the row thrown.
  assert.deepEqual(sigs[0].stepsForCycle(0).map((s) => s.value), steps(thrown).bits(8).stepsForCycle(0).map((s) => s.value));
  // Nothing written: eight cells.
  assert.equal(parseCells(evalLines('shiftreg()', 0).widgets.inputs[0].value).length, 8);
});

test('shiftreg: a new row from the host is what the next query reads', () => {
  const { sigs, widgets } = evalLines('shiftreg("x . . .")', 0);
  assert.deepEqual(sigs[0].stepsForCycle(0).map((s) => Math.round(s.value * 255)), [0b10001000, 0b01000100, 0b00100010, 0b00010001]);
  assert.equal(setWidgetValue('a', widgets.inputs[0].at, '. . . .'), true);
  assert.deepEqual(sigs[0].stepsForCycle(1).map((s) => s.value), [0, 0, 0, 0]);
});

test('row options: mutate on steps, matrix and shiftreg; mutate and deviation on sliders', () => {
  const { widgets } = evalLines([
    'steps("x . x .", { mutate: 0.1 })',
    'sliders("0.2 0.5", 0, 1, { mutate: 0.2, deviation: 0.3 })',
    'matrix({ bd: "x . . ." }, { mutate: 0.05 })',
    'shiftreg("x . x .", { mutate: 0.4 })',
  ].join('\n'), 0);
  assert.deepEqual(widgets.inputs.map((w) => [w.kind, w.opts]), [
    ['steps', { mutate: 0.1 }],
    ['sliders', { mutate: 0.2, deviation: 0.3 }],
    ['matrix', { mutate: 0.05 }],
    ['shiftreg', { mutate: 0.4 }],
  ]);
});

test('row options: a knob or slider is read where it is set now - its call goes with the option', () => {
  const code = 'const amt = knob(0.05)\nsteps("x . x .", { mutate: amt })\nshiftreg("x . x .", slider(0.3))';
  // `const` lines are not values here, so read the knob's call position from the transpile.
  const out = injectLocations(code, 0);
  const names = Object.keys(core);
  const values = names.map((k) => core[k]);
  beginWidgets('a');
  new Function(...names, `${out.split('\n')[0]}\nreturn [${out.split('\n').slice(1).join(', ')}]`)(...values);
  const { inputs } = takeWidgets();
  const knobAt = inputs.find((w) => w.kind === 'knob').at;
  const sliderAt = inputs.find((w) => w.kind === 'slider').at;
  assert.deepEqual(inputs.find((w) => w.kind === 'steps').opts, { mutate: 0.05, mutateFrom: knobAt });
  assert.deepEqual(inputs.find((w) => w.kind === 'shiftreg').opts, { mutate: 0.3, mutateFrom: sliderAt });
});

test('row options: a number past its range is said and kept in it; one that cannot be read is said', () => {
  const said = [];
  setPatternWarn((line) => said.push(line));
  try {
    const { widgets } = evalLines('steps("x .", { mutate: 1.5 })\nsliders("0.5", 0, 1, { deviation: -1 })\nsteps("x .", { mutate: "0.25" })\nsteps("x .", { mutate: "[[" })', 0);
    assert.deepEqual(widgets.inputs.map((w) => w.opts), [{ mutate: 1 }, { deviation: 0 }, { mutate: 0.25 }, {}]);
    assert.ok(said.some((l) => /steps\(\{ mutate \}\) is a chance from 0 to 1 - got 1\.5, using 1/.test(l)), said.join('\n'));
    assert.ok(said.some((l) => /sliders\(\{ deviation \}\) is a number from 0 up - got -1, using 0/.test(l)), said.join('\n'));
    assert.ok(said.some((l) => /steps\(\{ mutate \}\) is a chance from 0 to 1, a signal or a pattern - got "\[\["/.test(l)), said.join('\n'));
    assert.equal(said.length, 3);
  } finally {
    setPatternWarn(null);
  }
});

test('row options: a signal or a pattern is taken without a word, and read at each pass as it begins', () => {
  const said = [];
  setPatternWarn((line) => said.push(line));
  try {
    const { widgets } = evalLines('steps("x . x .", { mutate: "<0 0.5 2>" })\nsteps("x .", { mutate: sine() })\nsliders("0.5 0.2", 0, 12, { deviation: saw().range(0, 2) })', 0);
    assert.deepEqual(said, []);
    const [pat, lfo, bars] = widgets.inputs;
    assert.equal(pat.opts.mutateLive, true);
    assert.equal(bars.opts.deviationLive, true);
    // The pattern's value on the cycle the pass starts on, kept in 0..1.
    assert.deepEqual([0, 1, 2, 3].map((c) => core.widgetOption('a', pat.at, 'mutate', c)), [0, 0.5, 1, 0]);
    // A sine at the start of each cycle is halfway; a quarter in, at its top.
    assert.equal(core.widgetOption('a', lfo.at, 'mutate', 4), 0.5);
    assert.ok(Math.abs(core.widgetOption('a', lfo.at, 'mutate', 4.25) - 1) < 1e-9);
    assert.equal(core.widgetOption('a', bars.at, 'deviation', 3.5), 1);
    // A row with no such option, or none written as a signal, reads nothing.
    assert.equal(core.widgetOption('a', bars.at, 'mutate', 0), null);
  } finally {
    setPatternWarn(null);
  }
});

test('row options: a midicc() mutate is read where the controller is at each pass', async () => {
  const { feedMidiCC } = await import('./src/midi.mjs');
  const device = 'Mutate Test Twister Port';
  feedMidiCC(device, 1, 12, 0.1);
  const { widgets } = evalLines(`note(sliders("0.26 0.92 0.74", { mutate: midicc("${device}")(12) }).range(24, 60))`, 0);
  const row = widgets.inputs.find((w) => w.kind === 'sliders');
  assert.equal(row.opts.mutateLive, true);
  // Through the host's route, as the editor asks: at the pass, then after the knob turns.
  const host = core.createWidgetHost({ engine: () => null, cycleNow: () => 7 });
  assert.ok(Math.abs(host.option('a', row.at, 'mutate', 8).value - 0.1) < 1e-9);
  feedMidiCC(device, 1, 12, 0.75);
  assert.ok(Math.abs(host.option('a', row.at, 'mutate', 9).value - 0.75) < 1e-9);
  // No position given: the deck's clock now.
  assert.ok(Math.abs(host.option('a', row.at, 'mutate').value - 0.75) < 1e-9);
  // A row the evaluation no longer has reads nothing.
  evalLines('steps("x .")', 0);
  assert.equal(host.option('a', row.at, 'mutate', 10).value, null);
});

test('row options: deviation belongs to sliders only', () => {
  const said = [];
  setPatternWarn((line) => said.push(line));
  try {
    const { widgets } = evalLines('steps("x .", { deviation: 0.2 })', 0);
    assert.deepEqual(widgets.inputs[0].opts, {});
    assert.ok(said.some((l) => /steps\(\) has no option "deviation" \(it has size, width, height, mutate\)/.test(l)), said.join('\n'));
  } finally {
    setPatternWarn(null);
  }
});
