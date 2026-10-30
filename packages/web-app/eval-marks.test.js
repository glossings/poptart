'use strict';

// The editor's evaluation marks (public/eval-marks.js): placed on the span a console line points
// at, cleared by the next good evaluation and by an edit to the marked line, and the cursor jump.
// Driven with a small stand-in for CodeMirror that keeps the parts of its API these use; the real
// editor runs the same functions in the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const { markEvalProblem, clearEvalMarks, jumpToEvalProblem, locateNamedParam } = require('./public/eval-marks.js');

function fakeEditor(text) {
  let doc = text;
  const handlers = {};
  const marks = [];
  const lineClasses = new Map();
  const posFromIndex = (i) => {
    const before = doc.slice(0, i);
    return { line: before.split('\n').length - 1, ch: i - (before.lastIndexOf('\n') + 1) };
  };
  const indexFromPos = (p) => doc.split('\n').slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.ch;
  const ed = {
    state: {},
    cursor: null,
    focused: false,
    marks,
    lineClasses,
    getValue: () => doc,
    posFromIndex,
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    markText(from, to, opts) {
      const m = { from: indexFromPos(from), to: indexFromPos(to), opts, cleared: false };
      m.find = () => (m.cleared ? undefined : { from: posFromIndex(m.from), to: posFromIndex(m.to) });
      m.clear = () => { m.cleared = true; };
      marks.push(m);
      return m;
    },
    addLineClass(line, where, cls) {
      lineClasses.set(`${line}:${where}`, cls);
      return line;
    },
    removeLineClass(line, where) {
      lineClasses.delete(`${line}:${where}`);
    },
    // An edit: the handlers hear it first, as CodeMirror's beforeChange does.
    replaceRange(text2, fromIdx, toIdx) {
      const change = { from: posFromIndex(fromIdx), to: posFromIndex(toIdx), text: text2.split('\n') };
      for (const fn of handlers.beforeChange ?? []) fn(ed, change);
      doc = doc.slice(0, fromIdx) + text2 + doc.slice(toIdx);
    },
    focus() { ed.focused = true; },
    setCursor(p) { ed.cursor = p; },
    scrollIntoView() {},
  };
  return ed;
}

const SRC = 'setbpm(120)\nkick: s("bd*4").fasst(2)\nhat: s("hh*8")\n';
const WHERE = { from: 28, to: 33, text: '"fasst" is not a method - did you mean "fast"?' };

test('the span is underlined with the message on hover, and its line number tinted', () => {
  const ed = fakeEditor(SRC);
  markEvalProblem(ed, WHERE);
  const live = ed.marks.filter((m) => !m.cleared);
  assert.equal(live.length, 1);
  assert.equal(SRC.slice(live[0].from, live[0].to), 'fasst');
  assert.equal(live[0].opts.className, 'cm-eval-error');
  assert.equal(live[0].opts.title, WHERE.text);
  assert.equal(ed.lineClasses.get('1:wrap'), 'cm-eval-error-line');
});

test('a warning wears the warning color', () => {
  const ed = fakeEditor(SRC);
  markEvalProblem(ed, WHERE, 'warn');
  assert.equal(ed.marks[0].opts.className, 'cm-eval-warn');
  assert.equal(ed.lineClasses.get('1:wrap'), 'cm-eval-warn-line');
});

test('the next good evaluation clears every mark', () => {
  const ed = fakeEditor(SRC);
  markEvalProblem(ed, WHERE);
  markEvalProblem(ed, { from: 40, to: 43, text: 'x' }, 'warn');
  clearEvalMarks(ed);
  assert.ok(ed.marks.every((m) => m.cleared));
  assert.equal(ed.lineClasses.size, 0);
  clearEvalMarks(fakeEditor(SRC)); // an editor that never had one
});

test('an edit to the marked line clears that mark; an edit elsewhere leaves it', () => {
  const ed = fakeEditor(SRC);
  markEvalProblem(ed, WHERE);
  ed.replaceRange('// tempo\n', 0, 0); // above it: the mark stays
  assert.equal(ed.marks[0].cleared, false);
  ed.replaceRange('', 31 + 9, 32 + 9); // inside "fasst", now one line down
  assert.equal(ed.marks[0].cleared, true);
  assert.equal(ed.lineClasses.size, 0);
});

test('a span past the end of the buffer is not marked', () => {
  const ed = fakeEditor('a: 1');
  assert.equal(markEvalProblem(ed, { from: 99, to: 100, text: 'x' }), null);
  assert.equal(markEvalProblem(ed, null), null);
});

test('clicking the line puts the cursor on the spot', () => {
  const ed = fakeEditor(SRC);
  jumpToEvalProblem(ed, WHERE);
  assert.deepEqual(ed.cursor, { line: 1, ch: 16 });
  assert.equal(ed.focused, true);
});

test('a device-has-no-parameter warning finds its one string in the buffer', () => {
  const doc = 'a: s("bd").param("Cutof", 0.5)\nb: s("hh")';
  assert.deepEqual(locateNamedParam('[web-engine] "sampler" has no parameter called "Cutof".', doc), { from: 18, to: 23 });
  assert.equal(locateNamedParam('has no parameter named \'Res\'', doc), null);
  assert.equal(locateNamedParam('has no parameter called "Cutof"', `${doc}\nc: s("x").param("Cutof", 1)`), null); // twice: no place to point
});
