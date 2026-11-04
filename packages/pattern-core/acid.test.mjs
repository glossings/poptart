// acid(): a line of 0..1 values with accents, long gates, slides and octaves, the throw and
// mutation that write it, and the widget the evaluation builds for the editor.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './src/index.mjs';
import {
  parseAcidRow, acidNotes, throwAcidRow, mutateAcidRow, setAcidStep, acidToken, acidKnob, acidLoop, setAcidLoop,
  ACID_ACCENT_VEL, ACID_PLAIN_VEL, ACID_GATE,
} from './src/acid.mjs';

const { acid, injectLocations, beginWidgets, takeWidgets, setWidgetValue, setPatternWarn } = core;

// A generator that gives the same numbers every run.
function seeded(x = 7) {
  return () => ((x = (x * 16807) % 2147483647) / 2147483647);
}

function evalLines(code, base = 0, deck = 'a') {
  const out = injectLocations(code, base);
  const names = Object.keys(core);
  const values = names.map((k) => core[k]);
  beginWidgets(deck);
  const lines = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  const sigs = lines.map((l) => new Function(...names, `return ${l.replace(/^\s*[\w$]+:\s*/, '')}`)(...values));
  return { out, sigs, widgets: takeWidgets() };
}

const values = (sig) => sig.stepsForCycle(0).map((s) => s.value);

test('a row: values with octave, accent and gate marks, and rests', () => {
  assert.deepEqual(parseAcidRow("0 0.5'!~ .25, . 1'' x 3").map((s) => [s.kind, s.value, s.octave, s.accent, s.long]), [
    ['on', 0, 0, false, false],
    ['on', 0.5, 1, true, true],
    ['on', 0.25, -1, false, false],
    ['rest', null, 0, false, false],
    ['on', 1, 2, false, false],
    ['rest', null, 0, false, false],
    ['on', 1, 0, false, false],
  ]);
  assert.equal(acidToken({ value: 0.5, octave: 1, accent: true, long: true }), "0.5'!~");
  assert.equal(acidToken({ value: 0.333, octave: -1 }), '0.33,');
});

test('a long gate into the same note is a tie; into another note, a slide', () => {
  const notes = acidNotes(parseAcidRow('0~ 0 0.2~ 0.4 . 0.4~ . 0.1'));
  assert.deepEqual(notes.map((n) => [n.index, n.length, n.value, n.slide]), [[0, 2, 0, false], [2, 1, 0.2, false], [3, 1, 0.4, true], [5, 1, 0.4, false], [7, 1, 0.1, false]]);
  assert.equal(notes[0].gate, (1 + ACID_GATE) / 2);
  assert.equal(notes[1].gate, 1);
  assert.equal(notes[2].gate, ACID_GATE);
  assert.equal(notes[4].slide, false);
});

test('acid(): a pattern of the values, 0 to 1; the rest rides on each note', () => {
  assert.deepEqual(values(acid("0 0.25 0.5' 1,")), [0, 0.25, 0.5, 1]);
  const st = acid("0! 0.2~ 0.4 . 0~ 0 0.5'").stepsForCycle(0);
  assert.deepEqual(st.map((s) => [s.vel, s.clip, s.slide ?? 0, s.octave ?? 0]), [
    [ACID_ACCENT_VEL, ACID_GATE, 0, 0],
    [ACID_PLAIN_VEL, 1, 0, 0],
    [ACID_PLAIN_VEL, ACID_GATE, 1, 0],
    [ACID_PLAIN_VEL, (1 + ACID_GATE) / 2, 0, 0],
    [ACID_PLAIN_VEL, ACID_GATE, 0, 1],
  ]);
});

test('acid(): .range() is the ordinary .range(), through any transform before it', () => {
  const line = "0 0! 0! 0 0 0 0~ 0! 0! 0 0,! 0!~ 0' 0 0! 0!";
  const direct = acid('0 0.5 1').range('F0', 'F4');
  assert.deepEqual(values(direct), [29, 53, 77]);
  // .slow(2) in between: the same values, over two cycles.
  const slowed = acid('0 0.5 1').slow(2).range('F0', 'F4');
  // (the middle step straddles the two cycles, so each holds a piece of it)
  assert.deepEqual([...new Set([...slowed.stepsForCycle(0), ...slowed.stepsForCycle(1)].map((s) => s.value))], [29, 53, 77]);
  // The accents, slides, gates and octaves go through untouched.
  const before = acid(line).stepsForCycle(0).map((s) => [s.vel, s.clip, s.slide ?? 0, s.octave ?? 0]);
  const after = acid(line).range('F0', 'F4').stepsForCycle(0).map((s) => [s.vel, s.clip, s.slide ?? 0, s.octave ?? 0]);
  assert.deepEqual(after, before);
  assert.ok(values(acid(line).slow(2).range('F0', 'F4')).every((v) => v === 29));
});

test('acid(): the evaluation keys it, the host sets its row', () => {
  const { sigs, widgets } = evalLines('acid("0 0.2 . 0.4", { mutate: 0.1 })');
  const entry = widgets.inputs.find((w) => w.kind === 'acid');
  assert.equal(entry.value, '0 0.2 . 0.4');
  assert.equal(entry.opts.mutate, 0.1);
  assert.ok(setWidgetValue('a', entry.at, '1 1 1 1'));
  assert.deepEqual(values(sigs[0]), [1, 1, 1, 1]);
});

test('acid(): each note carries the span of its step, for the highlighter', () => {
  const code = 'acid("0~ 0 . 0.4!")';
  const { sigs } = evalLines(code, 100);
  const open = code.indexOf('"') + 1;
  assert.deepEqual(sigs[0].stepsForCycle(0).map((s) => s.loc), [[100 + open, 100 + open + 2], [100 + open + 7, 100 + open + 11]]);
});

test('acid(): a count throws a row of that many steps; nothing written is sixteen', () => {
  const { widgets } = evalLines('acid(8)\nacid()');
  assert.equal(parseAcidRow(widgets.inputs[0].value).length, 8);
  assert.equal(parseAcidRow(widgets.inputs[1].value).length, 16);
  assert.ok(Number.isFinite(widgets.inputs[0].seed));
});

test('acid(): an option it does not have is said', () => {
  const said = [];
  setPatternWarn((m) => said.push(m));
  try {
    evalLines('acid("0 1", { density: 0.5 })');
  } finally {
    setPatternWarn(null);
  }
  assert.ok(said.some((m) => /no option "density"/.test(m)));
});

test('a seeded throw: the same seed is the same row, and a knob moves it without scrambling it', () => {
  assert.equal(throwAcidRow(16, { density: 0.5 }, 9), throwAcidRow(16, { density: 0.5 }, 9));
  assert.notEqual(throwAcidRow(16, {}, 9), throwAcidRow(16, {}, 10));
  const on = (d) => parseAcidRow(throwAcidRow(32, { density: d }, 9)).flatMap((s, i) => (s.kind === 'on' ? [i] : []));
  let before = [];
  for (const d of [0, 0.25, 0.5, 0.75, 1]) {
    const now = on(d);
    assert.ok(before.every((i) => now.includes(i)), `density ${d} dropped a step`);
    before = now;
  }
  assert.deepEqual(on(0), []);
  assert.equal(on(1).length, 32);
  const zeros = (g) => parseAcidRow(throwAcidRow(32, { density: 1, gravity: g }, 9)).flatMap((s, i) => (s.value === 0 ? [i] : []));
  assert.ok(zeros(0.3).every((i) => zeros(0.7).includes(i)));
  assert.equal(zeros(1).length, 32);
  const used = (n) => new Set(parseAcidRow(throwAcidRow(64, { density: 1, gravity: 0, notes: n }, 9)).map((s) => s.value));
  assert.deepEqual([...used(1)], [0]);
  assert.ok(used(3).size <= 3 && used(3).has(0));
  assert.ok([...used(3)].every((v) => used(5).has(v)));
  assert.ok([...used(8)].every((v) => v >= 0 && v <= 1));
});

test('a thrown row has accents, long gates and octaves, and they stay put when a knob moves', () => {
  const row = parseAcidRow(throwAcidRow(64, { density: 1 }, 3));
  assert.ok(row.some((s) => s.accent) && row.some((s) => s.long) && row.some((s) => s.octave !== 0));
  const marks = (g) => parseAcidRow(throwAcidRow(32, { density: 1, gravity: g }, 3)).map((s) => [s.accent, s.long, s.octave]);
  assert.deepEqual(marks(0.2), marks(0.8));
});

test('mutation throws steps again, from the values the row has', () => {
  const src = '0 0.2 . 0.4 0 0.2';
  const { text, edits } = mutateAcidRow(src, 1, { density: 1, notes: 3 }, seeded());
  const steps = parseAcidRow(text);
  assert.equal(steps.length, 6);
  assert.ok(steps.every((s) => s.kind === 'on' && [0, 0.2, 0.4].includes(s.value)));
  assert.ok(edits.length > 0);
  assert.deepEqual(mutateAcidRow(src, 0, {}, seeded()), { text: src, edits: [] });
});

test('a step set by hand: off, or what it says changed, the rest of the row as it was', () => {
  assert.equal(setAcidStep("0 0.4'! .", 1, '.'), '0 . .');
  assert.equal(setAcidStep("0 0.4'! .", 1, { value: 0.75 }), "0 0.75'! .");
  assert.equal(setAcidStep("0 0.4'! .", 1, { long: true, octave: 0 }), '0 0.4!~ .');
  assert.equal(setAcidStep('0 . 0.2', 1, { accent: true }), '0 0! 0.2');
  assert.equal(setAcidStep('0 | 0.2 0.4 |', 1, { value: 0.3 }), '0 | 0.3 0.4 |');
});

test('the knobs', () => {
  assert.equal(acidKnob('density', 3), 1);
  assert.equal(acidKnob('notes', 4.6), 5);
  assert.equal(acidKnob('notes', 'x'), 3);
});

test('loop marks: the steps between two | play, spread over the cycle', () => {
  assert.deepEqual(acidLoop('0 0.2 | 0 0.4 . 0.2 | 0.3'), { from: 2, to: 6 });
  assert.deepEqual(acidLoop('0 0.2 0.3'), { from: 0, to: 3 });
  assert.deepEqual(acidLoop('0 | 0.2 0.3'), { from: 1, to: 3 });
  assert.equal(parseAcidRow('0 0.2 | 0 0.4 . 0.2 | 0.3').length, 7);
  assert.equal(setAcidLoop('0 0.2 0 0.4 . 0.2 0.3', 2, 6), '0 0.2 | 0 0.4 . 0.2 | 0.3');
  assert.equal(setAcidLoop('0 0.2 | 0 0.4 . 0.2 | 0.3', 0, 7), '0 0.2 0 0.4 . 0.2 0.3');
  const st = acid('0 0.2 | 0.4 . 0.5~ 0.7 | 0.9').stepsForCycle(0);
  assert.deepEqual(st.map((s) => [s.value, s.start, s.end, s.slide ?? 0]), [[0.4, 0, 0.25, 0], [0.5, 0.5, 0.75, 0], [0.7, 0.75, 1, 1]]);
});
