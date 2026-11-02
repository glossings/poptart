// Writing into the buffer outside its undo history (public/widgets/history-rebase.mjs): what a row
// that mutates as it plays writes, which undo steps over while still undoing the hand's own edits.
//
// The editor here is a small stand-in for CodeMirror 5's: a document, and a history kept the way
// CodeMirror keeps one - events of changes that say what undoing them does (replace `from`..`to`
// with `text`), selection entries between them, newest last, and a redo stack of the same.

import test from 'node:test';
import assert from 'node:assert/strict';
import { editOutsideHistory, rebaseStack } from './public/widgets/history-rebase.mjs';

class Pos {
  constructor(line, ch) {
    this.line = line;
    this.ch = ch;
  }
}
class Range {
  constructor(anchor, head) {
    this.anchor = anchor;
    this.head = head;
  }
}
class Selection {
  constructor(ranges, primIndex) {
    this.ranges = ranges;
    this.primIndex = primIndex;
  }
}

function fakeEditor(text) {
  let value = text;
  const history = { done: [], undone: [], lastOp: null, lastSelOp: null, lastOrigin: null, lastSelOrigin: null, lastModTime: 0, lastSelTime: 0 };
  const posFromIndex = (i) => {
    const before = value.slice(0, i).split('\n');
    return new Pos(before.length - 1, before[before.length - 1].length);
  };
  const indexFromPos = (p) => value.split('\n').slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.ch;
  const getRange = (a, b) => value.slice(indexFromPos(a), indexFromPos(b));
  const endOf = (from, lines) => new Pos(from.line + lines.length - 1, (lines.length === 1 ? from.ch : 0) + lines[lines.length - 1].length);
  // Replaces a..b, returning the history change that undoes it.
  const apply = (lines, a, b) => {
    const removed = getRange(a, b).split('\n');
    value = value.slice(0, indexFromPos(a)) + lines.join('\n') + value.slice(indexFromPos(b));
    return { from: a, to: endOf(a, lines), text: removed };
  };
  const step = (source, dest) => {
    while (source.length && source[source.length - 1].ranges) source.pop();
    const ev = source.pop();
    if (!ev) return;
    const anti = [];
    for (let i = ev.changes.length - 1; i >= 0; i--) {
      const c = ev.changes[i];
      anti.push(apply(c.text, c.from, c.to));
    }
    dest.push({ changes: anti });
  };
  const cm = {
    getDoc: () => ({ history: cm.history }),
    history,
    posFromIndex,
    getRange,
    operation: (fn) => fn(),
    replaceRange(text, a, b = a) {
      const h = cm.history;
      h.undone.length = 0;
      h.done.push(new Selection([new Range(a, a)], 0));
      h.done.push({ changes: [apply(String(text).split('\n'), a, b)] });
      h.lastOp = 99;
      h.lastOrigin = 'x';
    },
    undo: () => step(cm.history.done, cm.history.undone),
    redo: () => step(cm.history.undone, cm.history.done),
    value: () => value,
    edit(at, to, text) {
      cm.replaceRange(text, posFromIndex(at), posFromIndex(to));
    },
  };
  return cm;
}

test('a write outside the history is not undone; the edit before it still is', () => {
  const cm = fakeEditor('a: steps("x . x .")\nb: note("c")');
  cm.edit(cm.value().length, cm.value().length, '.fast(2)');
  const lit = cm.value().indexOf('x . x .');
  assert.equal(editOutsideHistory(cm, [[lit + 2, lit + 3, 'x']]), 1);
  assert.equal(cm.value(), 'a: steps("x x x .")\nb: note("c").fast(2)');
  cm.undo();
  assert.equal(cm.value(), 'a: steps("x x x .")\nb: note("c")');
  assert.equal(cm.history.done.filter((e) => !e.ranges).length, 0);
  cm.redo();
  assert.equal(cm.value(), 'a: steps("x x x .")\nb: note("c").fast(2)');
});

test('an edit on the same line, before the row, is undone where it now is', () => {
  const cm = fakeEditor('x: sliders("0.2 0.5 0.8")');
  cm.edit(0, 1, 'hats');
  const lit = cm.value().indexOf('0.2');
  editOutsideHistory(cm, [[lit + 4, lit + 7, '0.55'], [lit, lit + 3, '0.125']]);
  assert.equal(cm.value(), 'hats: sliders("0.125 0.55 0.8")');
  cm.undo();
  assert.equal(cm.value(), 'x: sliders("0.125 0.55 0.8")');
});

test('a write over text an edit put there folds into that edit: undoing it puts back what it replaced', () => {
  const cm = fakeEditor('steps("x . x .")');
  const lit = cm.value().indexOf('x . x .');
  cm.edit(lit + 6, lit + 7, 'x'); // a click switches cell 3 on
  editOutsideHistory(cm, [[lit + 4, lit + 7, 'x . .'], [lit, lit + 1, '.']]); // overlapping it, and cell 0
  assert.equal(cm.value(), 'steps(". . x . .")');
  cm.undo(); // the click's undo covers what the write did over it, and nothing at cell 0
  assert.equal(cm.value(), 'steps(". . x .")');
});

test('writes between edits on other lines, undone and redone in turn', () => {
  const cm = fakeEditor('row: steps("x . . .")\n');
  cm.edit(0, 0, '// one\n');
  cm.edit(0, 0, '// two\n');
  let lit = cm.value().indexOf('x . . .');
  editOutsideHistory(cm, [[lit + 2, lit + 3, 'x']]);
  cm.edit(cm.value().length, cm.value().length, '!');
  lit = cm.value().indexOf('x x . .');
  editOutsideHistory(cm, [[lit + 6, lit + 7, 'x\n']]); // a write that adds a line, too
  assert.equal(cm.value(), '// two\n// one\nrow: steps("x x . x\n")\n!');
  cm.undo();
  assert.equal(cm.value(), '// two\n// one\nrow: steps("x x . x\n")\n');
  cm.undo();
  cm.undo();
  assert.equal(cm.value(), 'row: steps("x x . x\n")\n');
  cm.redo();
  cm.redo();
  cm.redo();
  assert.equal(cm.value(), '// two\n// one\nrow: steps("x x . x\n")\n!');
});

test('a write while there is something to redo keeps it, moved to where its text is', () => {
  const cm = fakeEditor('a("x . . .")\nb()');
  cm.edit(0, 0, '// c\n');
  cm.edit(cm.value().length, cm.value().length, 'Z');
  cm.undo();
  cm.undo();
  editOutsideHistory(cm, [[3, 4, '.'], [9, 10, 'x']]);
  assert.equal(cm.value(), 'a(". . . x")\nb()');
  cm.redo();
  cm.redo();
  assert.equal(cm.value(), '// c\na(". . . x")\nb()Z');
});

test('nothing of the write is left to merge into: the last edit\'s bookkeeping is as it was', () => {
  const cm = fakeEditor('steps("x . . .") ');
  cm.edit(cm.value().length, cm.value().length, 'a');
  editOutsideHistory(cm, [[7, 8, '.']]);
  assert.equal(cm.history.lastOp, 99);
  assert.equal(cm.history.lastOrigin, 'x');
  // A write that changes nothing is no write.
  assert.equal(editOutsideHistory(cm, [[7, 8, '.']]), 0);
});

test('selections in the history move with the write', () => {
  const stack = [new Selection([new Range(new Pos(0, 10), new Pos(0, 12))], 0)];
  rebaseStack(stack, { from: new Pos(0, 2), to: new Pos(0, 3), text: ['abc'], removed: ['x'] }, (l, c) => new Pos(l, c));
  assert.deepEqual([stack[0].ranges[0].anchor, stack[0].ranges[0].head].map((p) => [p.line, p.ch]), [[0, 12], [0, 14]]);
  assert.ok(stack[0] instanceof Selection);
});
