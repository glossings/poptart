// The editor's inline widgets, language side: how a call is found and tagged, what each control
// returns and how a moved control reaches it, what a display registers, and what the host ships.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './src/index.mjs';

const {
  injectLocations, findWidgetCalls, callArgs, parseCells, toggleCell, setCellValue, randomRow, randomValues, formatNumber, matrixRows,
  beginWidgets, takeWidgets, abandonWidgets, setWidgetValue, widgetValue, displayWindow, createWidgetHost, setPatternWarn,
} = core;

// Evaluates a buffer the way the hosts do: transpiled at `base`, every builder in scope, one value
// per line (a `label:` prefix is dropped).
function evalLines(code, base = 0, deck = 'a') {
  const out = injectLocations(code, base);
  const names = Object.keys(core);
  const values = names.map((n) => core[n]);
  beginWidgets(deck);
  const lines = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  const sigs = lines.map((l) => new Function(...names, `return ${l.replace(/^\s*[\w$]+:\s*/, '')}`)(...values));
  return { out, sigs, widgets: takeWidgets() };
}

test('the transpile tags each widget call with where it is', () => {
  const code = 'a: note("c3").gain(slider(0.5, 0, 1)).scope()';
  const out = injectLocations(code, 100);
  assert.match(out, /_input\(\[119, -1\], 'slider', 0\.5, 0, 1\)/);
  assert.match(out, /\._display\(138, 'scope', \)/);
  assert.match(out, /note\(mini\("c3", 109\)\)/);
});

test('calls in comments and strings are not widgets, and neither is a dotted input', () => {
  const code = '// slider(1)\nconst t = "scope()";\nx.slider(2)\nfunction plot(a) {}\nmyslider(3)\nknob(1)';
  const found = findWidgetCalls(code);
  assert.deepEqual(found.map((c) => c.kind), ['knob']);
});

test('a bare display is the master; a dotted one is the pattern it is called on', () => {
  const found = findWidgetCalls('scope()\nnote("c").spectrum()\n  .meter()');
  assert.deepEqual(found.map((c) => [c.kind, c.method]), [['scope', false], ['spectrum', true], ['meter', true]]);
});

test('the data widgets keep their text raw, and know where it starts', () => {
  const code = 'b: s("bd").struct(steps("x . x ."))';
  const out = injectLocations(code, 0);
  assert.match(out, /_input\(\[18, 25\], 'steps', "x \. x \."\)/);
});

test('a slider is its value, live: a moved control is read without an evaluation', () => {
  const { sigs, widgets } = evalLines('a: slider(0.25, 0, 10)', 50);
  const [w] = widgets.inputs;
  assert.deepEqual({ kind: w.kind, value: w.value, min: w.min, max: w.max }, { kind: 'slider', value: 0.25, min: 0, max: 10 });
  assert.equal(sigs[0].sample(0, 0.5, 0), 0.25);
  assert.equal(setWidgetValue('a', w.at, 7.5), true);
  assert.equal(sigs[0].sample(1, 0.5, 0.5), 7.5);
  // ...and the buffer is the truth: the next evaluation seeds the value from the code again.
  evalLines('a: slider(0.25, 0, 10)', 50);
  assert.equal(widgetValue('a', w.at), 0.25);
});

test('every argument may be a pattern: a mini literal is read as the number it says', () => {
  const { widgets } = evalLines('a: slider("0.5", "100", 900)');
  assert.deepEqual([widgets.inputs[0].value, widgets.inputs[0].min, widgets.inputs[0].max], [0.5, 100, 900]);
});

test('a moved control that no longer exists is refused', () => {
  evalLines('a: knob(0.5)');
  const { widgets } = evalLines('b: note("c")\na: toggle(1)');
  assert.equal(setWidgetValue('a', 3, 0.9), false); // knob's key is gone
  assert.equal(setWidgetValue('a', widgets.inputs[0].at, 0), true);
});

test('the two decks keep separate controls at the same position', () => {
  const a = evalLines('a: slider(0.1)', 0, 'a');
  evalLines('a: slider(0.9)', 0, 'b');
  assert.equal(widgetValue('a', a.widgets.inputs[0].at), 0.1);
  assert.equal(widgetValue('b', a.widgets.inputs[0].at), 0.9);
});

test('toggle and button are 0/1; xy has two axes', () => {
  const { sigs, widgets } = evalLines('a: toggle(1)\nb: button()\nc: xy(0.2, 0.8)');
  assert.equal(sigs[0].sample(0, 1, 0), 1);
  assert.equal(sigs[1].sample(0, 1, 0), 0);
  setWidgetValue('a', widgets.inputs[1].at, 1);
  assert.equal(sigs[1].sample(0, 1, 0), 1);
  assert.equal(sigs[2].sample(0, 1, 0), 0.2);
  assert.equal(sigs[2].y.sample(0, 1, 0), 0.8);
  assert.equal(setWidgetValue('a', widgets.inputs[2].at, [0.6, 0.1]), true);
  assert.equal(sigs[2].x.sample(0, 1, 0), 0.6);
  assert.equal(sigs[2].y.sample(0, 1, 0), 0.1);
  assert.equal(setWidgetValue('a', widgets.inputs[2].at, 3), false); // not a pair
});

test('steps() is a step pattern of its hits, with the spans the highlighter lights', () => {
  const { sigs, widgets } = evalLines('a: steps("x . 3 bd")', 10);
  const steps = sigs[0].stepsForCycle(0);
  assert.deepEqual(steps.map((s) => [s.start, s.value]), [[0, 1], [0.5, 3], [0.75, 'bd']]);
  // 'a: steps("' is 10 characters, so the content starts at 10 + 10.
  assert.deepEqual(steps[0].loc, [20, 21]);
  setWidgetValue('a', widgets.inputs[0].at, '. x . .');
  assert.deepEqual(sigs[0].stepsForCycle(5).map((s) => [s.start, s.value]), [[0.25, 1]]);
});

test('steps() reads one character per step when the row has no spaces', () => {
  assert.deepEqual(core.steps('x..x').stepsForCycle(0).map((s) => s.start), [0, 0.75]);
});

test('sliders() plays its numbers; matrix() plays its rows\' names', () => {
  const { sigs, widgets } = evalLines('a: sliders("0.2 0.9 . 0.5")\nb: matrix({ bd: "x . x .", sd: ". x . x", 60: "x..." })');
  assert.deepEqual(sigs[0].stepsForCycle(0).map((s) => s.value), [0.2, 0.9, 0.5]);
  const m = sigs[1].stepsForCycle(0).map((s) => [s.start, s.value]);
  assert.deepEqual(m.sort((x, y) => x[0] - y[0] || String(x[1]).localeCompare(String(y[1]))), [[0, 60], [0, 'bd'], [0.25, 'sd'], [0.5, 'bd'], [0.75, 'sd']]);
  assert.equal(setWidgetValue('a', widgets.inputs[1].at, { row: 'sd', text: 'x . . .' }), true);
  assert.deepEqual(sigs[1].stepsForCycle(0).filter((s) => s.value === 'sd').map((s) => s.start), [0]);
  assert.equal(setWidgetValue('a', widgets.inputs[1].at, { row: 'hh', text: 'x' }), false); // no such row
  // Several rows at once, as randomizing a grid sends them - every one has to be a row it has.
  assert.equal(setWidgetValue('a', widgets.inputs[1].at, { bd: '. . . x', sd: 'x . . .' }), true);
  assert.deepEqual(sigs[1].stepsForCycle(0).filter((s) => s.value === 'bd').map((s) => s.start), [0.75]);
  assert.equal(setWidgetValue('a', widgets.inputs[1].at, { bd: 'x . . .', hh: 'x' }), false); // one it hasn't
  assert.equal(setWidgetValue('a', widgets.inputs[1].at, {}), false);
});

test('a display registers what it is called on and returns it untouched', () => {
  const { sigs, widgets } = evalLines('a: note("c3 e3").punchcard({ cycles: 2 })\nscope()');
  assert.equal(sigs[0].stepsForCycle(0).length, 2);
  assert.deepEqual(widgets.views.map((v) => [v.kind, !!v.sig, v.audio, v.opts]), [['punchcard', true, false, { cycles: 2 }], ['scope', false, true, {}]]);
});

test('a display\'s unknown option is said once and the display is drawn its default way', () => {
  const said = [];
  setPatternWarn((line) => said.push(line));
  try {
    const { widgets } = evalLines('a: note("c3").plot({ thickness: 1, height: 9999 })');
    assert.deepEqual(widgets.views[0].opts, { height: 240 });
    assert.match(said.join('\n'), /no option "thickness"/);
  } finally {
    setPatternWarn(null);
  }
});

test('copy() building a block twice registers its widgets once', () => {
  beginWidgets('a');
  core._input([5, -1], 'slider', 0.5);
  core._input([5, -1], 'slider', 0.5);
  assert.equal(takeWidgets().inputs.length, 1);
});

test('a failed evaluation keeps every control', () => {
  const { widgets } = evalLines('a: slider(0.3)');
  beginWidgets('a');
  abandonWidgets();
  assert.equal(setWidgetValue('a', widgets.inputs[0].at, 0.6), true);
});

test('punchcard data: events as heard, in cycles', () => {
  const { widgets } = evalLines('a: note("c3 e3").clip(0.5).punchcard()');
  const data = displayWindow(widgets.views[0], 0, 2);
  assert.deepEqual(data.events, [[0, 0.25, 60, 1], [0.5, 0.75, 64, 1], [1, 1.25, 60, 1], [1.5, 1.75, 64, 1]]);
});

test('plot data: runs for a step pattern, points for a continuous one, and a live control says so', () => {
  const { widgets } = evalLines('a: mini("1 3").plot()\nb: sine(1).plot()\nc: slider(0.4).plot()');
  assert.deepEqual(displayWindow(widgets.views[0], 0, 1).runs, [[0, 0.5, 1], [0.5, 1, 3]]);
  const pts = displayWindow(widgets.views[1], 0, 1).points;
  assert.equal(pts.length, core.PLOT_POINTS_PER_CYCLE);
  assert.ok(pts.every(([, v]) => v >= 0 && v <= 1));
  assert.equal(displayWindow(widgets.views[2], 0, 1).live, true);
});

test('callArgs splits a call at its top-level commas', () => {
  const code = 'slider(0.5, f(1, 2), "a,b") + 1';
  const r = callArgs(code, 6);
  assert.deepEqual(r.args.map((a) => a.text), ['0.5', 'f(1, 2)', '"a,b"']);
  assert.equal(code[r.close], ')');
  assert.deepEqual(callArgs('knob()', 4).args, []);
});

test('cells toggle without moving the rest of the row', () => {
  assert.equal(toggleCell('x . x .', 1), 'x x x .');
  assert.equal(toggleCell('bd . sd .', 3), 'bd . sd sd');
  assert.equal(toggleCell('bd . sd .', 0), '.  . sd .');
  assert.equal(toggleCell('x..x', 1), 'xx.x');
  assert.deepEqual(parseCells(' x . ').map((c) => [c.token, c.from, c.on]), [['x', 1, true], ['.', 3, false]]);
});

test('a cell value is written with fixed decimals and the row left as it was', () => {
  assert.equal(setCellValue('0.2 0.5  0.8', 1, 0.333), '0.2 0.33  0.8');
  assert.equal(formatNumber(2, 2), '2');
  assert.equal(formatNumber(-0.0001, 2), '0');
  assert.equal(formatNumber(440.004, 1), '440');
});

test('a row randomized keeps its count of hits and its own tokens', () => {
  const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
  // Two hits of eight stay two: the places come from the first draws, the tokens from the next.
  assert.equal(randomRow('0 . 3 . . . . .', seq(0.99, 0.5, 0.1, 0.9)), '. . . . 0 . . 3');
  const hitsOf = (row) => parseCells(row).filter((c) => c.on);
  // A one-character row stays one character per step.
  const compact = randomRow('x..x....');
  assert.equal(compact.length, 8);
  assert.equal(hitsOf(compact).length, 2);
  // An empty row, or a full one, gets half its cells; an empty row's hits are x.
  assert.equal(hitsOf(randomRow('. . . .')).length, 2);
  assert.equal(hitsOf(randomRow('x x x x')).length, 2);
  assert.ok(hitsOf(randomRow('. . . . .')).every((c) => c.token === 'x'));
  assert.equal(hitsOf(randomRow('. . . . .')).length, 3);
  // Space around the row is kept, and a row with nothing in it is left alone.
  assert.match(randomRow(' x . '), /^ [x.] [x.] $/);
  assert.equal(randomRow(''), '');
});

test('values randomized stay in range, with the decimals asked for', () => {
  assert.equal(randomValues('0.2 0.5 0.8', 10, 20, 1, () => 0.25), '12.5 12.5 12.5');
  const cells = parseCells(randomValues('0 0 0 0', -1, 1, 2));
  assert.equal(cells.length, 4);
  assert.ok(cells.every((c) => Number(c.token) >= -1 && Number(c.token) <= 1));
  assert.equal(randomValues('  ', 0, 1), '  ');
});

test('matrix rows are found with their keys, quoted or not', () => {
  const code = 'matrix({ bd: "x...", "c#3": "..x.", 60: "x" })';
  const rows = matrixRows(code, code.indexOf('{'));
  assert.deepEqual(rows.map((r) => [r.key, r.text, code.slice(r.from, r.to)]), [['bd', 'x...', 'x...'], ['c#3', '..x.', '..x.'], ['60', 'x', 'x']]);
});

// ---------------------------------------------------------------------------- the host

function fakeEngine() {
  const calls = [];
  return {
    calls,
    over: [],
    viewTaps(list) {
      calls.push(list);
      const armed = list.slice(0, 1).map((w) => w.id);
      return { armed, over: list.slice(1).filter((w) => w.id !== '*').map((w) => w.id) };
    },
    viewRead() {
      return { '#1': { level: { pl: 0.5, rl: 0.2, pr: 0.5, rr: 0.2 } }, '*': { level: { pl: 1, rl: 0.5, pr: 1, rr: 0.5 } } };
    },
  };
}

test('the host finds what each display shows: its track, the master, or nothing', () => {
  const code = 'kick: s("bd*4").scope()\nnote("c").spectrum()\nscope()\nlead: note("c3 e3").punchcard()';
  const blocks = [{ label: 'kick', start: 0, end: 23 }, { label: 'lead', start: code.indexOf('lead'), end: code.length }];
  const { widgets } = evalLines(code);
  const eng = fakeEngine();
  const ids = { kick: '#1', lead: '#2' };
  const host = createWidgetHost({ engine: () => eng, engineId: (_d, key) => ids[key] ?? null, setTimer: () => 0, clearTimer: () => {} });
  const report = host.afterEval('a', widgets, blocks, { from: 0, count: 2 });
  assert.deepEqual(report.views.map((v) => [v.kind, v.target]), [['scope', 'kick'], ['spectrum', null], ['scope', '*'], ['punchcard', 'lead']]);
  assert.equal(report.views[3].data.events.length, 4);
  // Nothing is tapped until the editor asks for frames.
  assert.equal(eng.calls.length, 0);
  const f = host.frames('a');
  assert.deepEqual(eng.calls[0], [{ id: '#1', fft: false }, { id: '*', fft: false }]);
  assert.deepEqual(Object.keys(f.frames).sort(), ['*', 'kick']);
  // Asking again for the same set arms nothing new.
  host.frames('a');
  assert.equal(eng.calls.length, 1);
});

test('past the engine\'s budget a display is reported as left out', () => {
  const code = 'a: s("bd").scope()\nb: s("sd").spectrum()';
  const blocks = [{ label: 'a', start: 0, end: 18 }, { label: 'b', start: 19, end: code.length }];
  const { widgets } = evalLines(code);
  const eng = fakeEngine();
  const host = createWidgetHost({ engine: () => eng, engineId: (_d, key) => `#${key}`, setTimer: () => 0, clearTimer: () => {} });
  host.afterEval('a', widgets, blocks);
  const f = host.frames('a');
  assert.deepEqual(eng.calls[0], [{ id: '#a', fft: false }, { id: '#b', fft: true }]);
  assert.deepEqual(f.over, ['b']);
});

test('the taps come down when the editor stops asking', () => {
  const code = 'a: s("bd").scope()';
  const { widgets } = evalLines(code);
  const eng = fakeEngine();
  let fire = null;
  const host = createWidgetHost({ engine: () => eng, engineId: () => '#1', setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  host.afterEval('a', widgets, [{ label: 'a', start: 0, end: code.length }]);
  host.frames('a');
  assert.deepEqual(eng.calls.at(-1), [{ id: '#1', fft: false }]);
  fire();
  assert.deepEqual(eng.calls.at(-1), []);
});

test('a live control\'s plot reports its value with every frame', () => {
  const code = 'a: slider(0.3).plot()';
  const { widgets } = evalLines(code);
  const host = createWidgetHost({ engine: () => null, setTimer: () => 0, clearTimer: () => {} });
  host.afterEval('a', widgets, [{ label: 'a', start: 0, end: code.length }]);
  setWidgetValue('a', widgets.inputs[0].at, 0.7);
  assert.deepEqual(Object.values(host.frames('a').now), [0.7]);
});

test('an input\'s options object is how it is drawn, not one of its values', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    const { widgets } = evalLines('a: knob(0.8, { size: 48 })\nb: matrix({ bd: "x . x ." }, { size: 1000 })\nc: slider(0.2, 0, 1, { colour: 2 })');
    const [knob, matrix, slider] = widgets.inputs;
    assert.equal(knob.value, 0.8);
    assert.deepEqual(knob.opts, { size: 48 });
    assert.equal(knob.min, 0); // the object did not land in min's place
    assert.deepEqual(matrix.opts, { size: core.INPUT_SIZES.matrix.max });
    assert.deepEqual(matrix.value, { bd: 'x . x .' });
    assert.deepEqual(slider.opts, {});
    assert.ok(warned.some((m) => /slider\(\) has no option "colour"/.test(m)));
  } finally {
    setPatternWarn(null);
  }
});

test('a count is that many empty cells: steps(8), sliders(8) and a matrix row of 8', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    const { widgets, sigs } = evalLines('a: steps(4)\nb: sliders(3, 0, 2)\nc: matrix({ bd: "x . . .", sd: 4 })\nd: steps()\ne: sliders()');
    assert.equal(widgets.inputs[0].value, '. . . .');
    assert.equal(widgets.inputs[1].value, '1 1 1');
    assert.deepEqual(widgets.inputs[2].value, { bd: 'x . . .', sd: '. . . .' });
    assert.equal(widgets.inputs[3].value, core.restRow(core.DEFAULT_CELL_COUNT));
    assert.equal(widgets.inputs[4].value, '0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5');
    assert.deepEqual(warned, []);
    assert.deepEqual(sigs[0].stepsForCycle(0), []); // all rests: silent until a cell is clicked
    // A click writes the row as text; the host takes it under the same key.
    assert.equal(setWidgetValue('a', widgets.inputs[0].at, 'x . . .'), true);
    assert.equal(sigs[0].stepsForCycle(0).length, 1);
    assert.equal(setWidgetValue('a', widgets.inputs[2].at, { row: 'sd', text: '. . x .' }), true);
  } finally {
    setPatternWarn(null);
  }
});

test('a malformed row warns and is still drawn as cells to click into', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    const { widgets } = evalLines('a: matrix({ bd: "x . . .", sd: 2.5, hh: [1] })\nb: steps(0)\nc: sliders(true)\nd: matrix("x . x .")');
    assert.deepEqual(widgets.inputs[0].value, { bd: 'x . . .', sd: core.restRow(8) });
    assert.equal(widgets.inputs[1].value, core.restRow(8));
    assert.equal(widgets.inputs[2].value.split(' ').length, 8);
    assert.deepEqual(widgets.inputs[3].value, {});
    assert.equal(warned.length, 5);
  } finally {
    setPatternWarn(null);
  }
});

test('the editor reads a row as text, a count, nothing, or code it leaves unfolded', () => {
  assert.deepEqual(core.rowSource('"x . x"'), { form: 'text', from: 1, to: 6, text: 'x . x' });
  assert.deepEqual(core.rowSource("'x.x.'"), { form: 'text', from: 1, to: 5, text: 'x.x.' });
  assert.deepEqual(core.rowSource('8'), { form: 'count', count: 8, valid: true });
  assert.deepEqual(core.rowSource('0'), { form: 'count', count: core.DEFAULT_CELL_COUNT, valid: false });
  assert.deepEqual(core.rowSource(null), { form: 'none' });
  assert.deepEqual(core.rowSource('pat'), { form: 'code' });
  assert.deepEqual(core.rowSource('`x ${n}`'), { form: 'code' });
  const args = (code) => callArgs(code, code.indexOf('(')).args;
  assert.equal(core.foldable('steps', args('steps(8)')), true);
  assert.equal(core.foldable('steps', args('steps()')), true);
  assert.equal(core.foldable('steps', args('steps({ size: 20 })')), true);
  assert.equal(core.foldable('steps', args('steps(myRow)')), false);
  assert.equal(core.foldable('matrix', args('matrix({ bd: 8, sd: "x . . ." })')), true);
  assert.equal(core.foldable('matrix', args('matrix()')), false);
  assert.equal(core.foldable('matrix', args('matrix({})')), false);
  assert.equal(core.foldable('matrix', args('matrix({ bd: row })')), false);
  assert.equal(core.foldable('matrix', args('matrix(rows)')), false);
  const code = 'matrix({ bd: 4, sd: "x . . ." })';
  const rows = matrixRows(code, code.indexOf('{'));
  assert.deepEqual(rows.map((r) => [r.key, r.form, r.text, code.slice(r.from, r.to)]), [['bd', 'count', '. . . .', '4'], ['sd', 'text', 'x . . .', 'x . . .']]);
});

test('setting one option rewrites only that option, keeping the rest of the call as written', () => {
  const set = (code, kind, key, value) => {
    const open = code.indexOf('(');
    const e = core.optionEdit(kind, callArgs(code, open), key, value);
    return code.slice(0, e.from) + e.text + code.slice(e.to);
  };
  assert.equal(set('knob(0.8)', 'knob', 'size', 48), 'knob(0.8, { size: 48 })');
  assert.equal(set('knob(0.8, 0, 1, { size: 30 })', 'knob', 'size', 48), 'knob(0.8, 0, 1, { size: 48 })');
  assert.equal(set('knob()', 'knob', 'size', 40), 'knob({ size: 40 })');
  assert.equal(set('matrix({ bd: "x . . ." })', 'matrix', 'size', 20), 'matrix({ bd: "x . . ." }, { size: 20 })');
  assert.equal(set('matrix({ bd: "x" }, { other: 1 })', 'matrix', 'size', 20), 'matrix({ bd: "x" }, { other: 1, size: 20 })');
  assert.equal(set('scope({})', 'scope', 'height', 80), 'scope({ height: 80 })');
  assert.equal(set('steps("x . x .", {size:12})', 'steps', 'size', 20), 'steps("x . x .", {size:20})');
  assert.equal(core.optionNumber('{ size: 48, height: 2 }', 'height'), 2);
  assert.equal(core.optionNumber('{ xsize: 4 }', 'size'), null);
  assert.equal(core.optionNumber('{ label: "size: 9" }', 'size'), null); // not inside a string
  const args = callArgs('knob(0.8, { size: 4 }, 2)', 4).args;
  assert.deepEqual(core.positionalArgs('knob', args).map((a) => a.text), ['0.8', '2']);
});

test('a widget is drawn at its kind\'s size unless the call asks for one inside its range', () => {
  assert.equal(core.widgetSize('knob', null), core.INPUT_SIZES.knob.size);
  assert.equal(core.widgetSize('knob', 48), 48);
  assert.equal(core.widgetSize('knob', 2), core.INPUT_SIZES.knob.min);
  assert.equal(core.widgetSize('matrix', 'x'), core.INPUT_SIZES.matrix.size);
  for (const kind of core.FOLDED_WIDGETS) assert.ok(core.INPUT_WIDGETS.includes(kind));
});

test('a box kind is drawn at { width, height }; a lone size or height still sets what it did', () => {
  const read = (o) => (k) => (k in o ? o[k] : null);
  const B = core.WIDGET_BOXES;
  assert.deepEqual(core.widgetBox('scope', read({})), { width: B.scope.width.size, height: B.scope.height.size });
  assert.deepEqual(core.widgetBox('scope', read({ height: 80 })), { width: B.scope.width.size, height: 80 });
  assert.deepEqual(core.widgetBox('scope', read({ width: 500, height: 80 })), { width: 500, height: 80 });
  assert.deepEqual(core.widgetBox('steps', read({ size: 20 })), { width: 20, height: 20 });
  assert.deepEqual(core.widgetBox('steps', read({ size: 20, height: 30 })), { width: 20, height: 30 });
  assert.deepEqual(core.widgetBox('sliders', read({ size: 100 })), { width: B.sliders.width.size, height: 100 });
  assert.deepEqual(core.widgetBox('slider', read({ size: 120 })), { width: 120, height: null });
  assert.deepEqual(core.widgetBox('meter', read({ width: 10, height: 9999 })), { width: 10, height: B.meter.height.max });
  assert.equal(core.widgetBox('knob', read({})), null);
  assert.deepEqual(core.sizeKeys('knob'), { write: ['size'], drop: [] });
  assert.deepEqual(core.sizeKeys('imager'), { write: ['size'], drop: [] });
  assert.deepEqual(core.sizeKeys('steps'), { write: ['width', 'height'], drop: ['size'] });
  assert.deepEqual(core.sizeKeys('scope'), { write: ['width', 'height'], drop: [] });
  const drop = (code, kind, key) => {
    const e = core.optionDrop(kind, callArgs(code, code.indexOf('(')), key);
    return e ? code.slice(0, e.from) + e.text + code.slice(e.to) : code;
  };
  assert.equal(drop('steps("x", { size: 20, width: 30, height: 30 })', 'steps', 'size'), 'steps("x", { width: 30, height: 30 })');
  assert.equal(drop('steps("x", { width: 30, height: 30, size: 20 })', 'steps', 'size'), 'steps("x", { width: 30, height: 30 })');
  assert.equal(drop('steps("x", { width: 30 })', 'steps', 'size'), 'steps("x", { width: 30 })');
});

test('width and height are options of the box kinds, the meter included', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    const { widgets } = evalLines('a: steps("x", { width: 20, height: 9999 })\nb: s("bd").scope({ width: 400, height: 60 })\nc: s("bd").meter({ width: 12, height: 80 })\nd: knob(0.5, { width: 3 })');
    assert.deepEqual(widgets.inputs[0].opts, { width: 20, height: core.WIDGET_BOXES.steps.height.max });
    assert.deepEqual(widgets.views[0].opts, { width: 400, height: 60 });
    assert.deepEqual(widgets.views[1].opts, { width: 12, height: 80 });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /knob\(\) has no option "width"/);
  } finally {
    setPatternWarn(null);
  }
});


test('a display on a line of its own is drawn behind the code: the master, or every track', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    const code = 'punchcard()\nspectrum({ min: -90 })\nchroma()\nplot()\nkick: s("bd*4").color("pink")\nlead: note("c3 e3")';
    const { widgets } = evalLines(code);
    assert.deepEqual(widgets.views.map((v) => [v.kind, !!v.background]), [['punchcard', true], ['spectrum', true], ['chroma', true]]);
    assert.equal(warned.length, 1); // plot() draws a pattern: it has to be called on one
    const kickAt = code.indexOf('kick');
    const leadAt = code.indexOf('lead');
    const sigs = evalLines(code).sigs;
    const blocks = [{ label: 'kick', start: kickAt, end: leadAt, sig: sigs[4] }, { label: 'lead', start: leadAt, end: code.length, sig: sigs[5] }];
    const host = createWidgetHost({ engine: () => fakeEngine(), setTimer: () => 0, clearTimer: () => {} });
    const report = host.afterEval('a', widgets, blocks, { from: 0, count: 1 });
    assert.deepEqual(report.views.map((v) => [v.kind, v.target, v.background]), [['punchcard', null, true], ['spectrum', '*', true], ['chroma', null, true]]);
    const tracks = report.views[0].data.tracks;
    assert.deepEqual(tracks.map((t) => [t.label, t.color, t.events.length]), [['kick', 'pink', 4], ['lead', null, 2]]);
    assert.equal(tracks[1].notes, true);
    assert.deepEqual(host.window('a', 1, 1).views[0].data.tracks.map((t) => t.events.length), [4, 2]);
    // The line taken out and the buffer evaluated again: nothing is drawn behind it.
    const again = evalLines('kick: s("bd*4")');
    assert.deepEqual(host.afterEval('a', again.widgets, []).views, []);
  } finally {
    setPatternWarn(null);
  }
});

test('an inline display reports the track it belongs to and that track\'s .color()', () => {
  const code = 'kick: s("bd*4").scope().color("Tomato")';
  const { widgets, sigs } = evalLines(code);
  const host = createWidgetHost({ engine: () => fakeEngine(), setTimer: () => 0, clearTimer: () => {} });
  const report = host.afterEval('a', widgets, [{ label: 'kick', start: 0, end: code.length, sig: sigs[0] }]);
  assert.deepEqual(report.views[0].track, { label: 'kick', color: 'tomato' });
});

test('.color() is metadata: a CSS name or hex, carried down the chain, never in the sound', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    assert.equal(core.trackColorOf('#FF7A9C'), '#ff7a9c');
    assert.equal(core.trackColorOf('#abc'), '#abc');
    assert.equal(core.trackColorOf('RebeccaPurple'), 'rebeccapurple');
    assert.equal(core.trackColorOf('pinkish'), null);
    assert.equal(core.trackColorOf('#12'), null);
    assert.equal(core.trackColorOf(3), null);
    const plain = core.s('bd sd');
    const colored = plain.color('pink').fast(2).gain(0.5);
    assert.equal(colored.trackColor, 'pink');
    assert.deepEqual(plain.fast(2).gain(0.5).stepsForCycle(0), colored.stepsForCycle(0));
    const bad = plain.color('nope');
    assert.equal(bad.trackColor, null);
  } finally {
    setPatternWarn(null);
  }
});

test('a matrix with no rows says so, plays nothing, and is left as text', () => {
  const warned = [];
  setPatternWarn((m) => warned.push(m));
  try {
    const { widgets, sigs } = evalLines('a: s(matrix())\nb: s(matrix({}))');
    assert.deepEqual(widgets.inputs.map((w) => w.value), [{}, {}]);
    assert.deepEqual(sigs.map((x) => x.stepsForCycle(0)), [[], []]);
    assert.equal(warned.length, 2);
    for (const m of warned) assert.match(m, /matrix\(\) needs at least one row, like matrix\(\{ bd: 8 \}\)/);
  } finally {
    setPatternWarn(null);
  }
});

