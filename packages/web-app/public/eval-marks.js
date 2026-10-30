'use strict';

// The editor's marks for an evaluation error or warning: a wavy underline on the span the console
// line points at, the line number tinted beside it, the message on hover. The span arrives as
// buffer offsets (pattern-core's eval-errors.mjs works them out, in both builds), so all this
// does is draw it, and take it away again:
//   - when the next evaluation of that editor succeeds (clearEvalMarks),
//   - when an edit touches a marked line - the text it was about is not the text there now.
// Loaded as a plain script before client.js, like api-docs.js, and required by
// eval-marks.test.js, which drives it with a stand-in editor.

/** The marks an editor carries, created on first use along with the edit watch that clears them. */
function evalMarkState(ed) {
  if (!ed.state.poptartEvalMarks) {
    const marks = [];
    ed.state.poptartEvalMarks = marks;
    ed.on('beforeChange', (_ed, change) => {
      for (let i = marks.length - 1; i >= 0; i--) {
        const range = marks[i].mark.find();
        if (!range || (change.from.line <= range.to.line && change.to.line >= range.from.line)) {
          dropEvalMark(ed, marks[i]);
          marks.splice(i, 1);
        }
      }
    });
  }
  return ed.state.poptartEvalMarks;
}

function dropEvalMark(ed, m) {
  m.mark.clear();
  ed.removeLineClass(m.line, 'wrap', m.lineClass);
}

/**
 * Marks `where` ({ from, to, text }: buffer offsets and the message) in `ed`. `level` is 'error'
 * or 'warn', which picks the color. Returns the mark, or null for a span outside the buffer.
 */
function markEvalProblem(ed, where, level = 'error') {
  if (!where || !Number.isInteger(where.from)) return null;
  const size = ed.getValue().length;
  if (where.from < 0 || where.from > size) return null;
  const marks = evalMarkState(ed);
  const to = Math.min(size, Math.max(where.from + 1, Number.isInteger(where.to) ? where.to : where.from + 1));
  const from = ed.posFromIndex(where.from);
  const kind = level === 'warn' ? 'warn' : 'error';
  const mark = ed.markText(from, ed.posFromIndex(to), {
    className: `cm-eval-${kind}`,
    title: where.text ?? '',
    inclusiveLeft: false,
    inclusiveRight: false,
  });
  const lineClass = `cm-eval-${kind}-line`;
  const line = ed.addLineClass(from.line, 'wrap', lineClass);
  const entry = { mark, line, lineClass };
  marks.push(entry);
  return entry;
}

/** Takes every evaluation mark off `ed` - an evaluation of it went through. */
function clearEvalMarks(ed) {
  const marks = ed?.state?.poptartEvalMarks;
  if (!marks) return;
  for (const m of marks.splice(0)) dropEvalMark(ed, m);
}

/** Puts the cursor where `where` points, and the editor's focus with it. */
function jumpToEvalProblem(ed, where) {
  if (!ed || !where || !Number.isInteger(where.from)) return;
  const pos = ed.posFromIndex(Math.min(where.from, ed.getValue().length));
  ed.focus();
  ed.setCursor(pos);
  ed.scrollIntoView(pos, 60);
}

/**
 * A warning that a device has no parameter by some name names the parameter but not where it was
 * written - it is found later, when the control applies. When that name appears exactly once in
 * the buffer as a string, that is the place: `{ from, to }`, else null.
 */
function locateNamedParam(text, doc) {
  const m = /has no (?:parameter|control) (?:called|named) ["']([^"']+)["']/.exec(String(text ?? ''));
  if (!m) return null;
  const name = m[1];
  const hits = [];
  for (const q of ['"', "'", '`']) {
    const lit = `${q}${name}${q}`;
    for (let at = doc.indexOf(lit); at >= 0; at = doc.indexOf(lit, at + 1)) hits.push(at + 1);
  }
  return hits.length === 1 ? { from: hits[0], to: hits[0] + name.length } : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { markEvalProblem, clearEvalMarks, jumpToEvalProblem, locateNamedParam };
}
