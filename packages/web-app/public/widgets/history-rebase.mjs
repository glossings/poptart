// Writing into the buffer without writing into its undo history.
//
// A row that mutates as it plays (see inline-widgets.mjs) rewrites its own text once a pass. Those
// writes are the code's, not the hand's: undo has to step back through the edits the user made and
// nothing else. CodeMirror 5 records every change, so the write is made as usual and then taken
// back out - the history is put back as it was, with every entry in it moved to where its text now
// is, as if the write had always been there.
//
// The history is two stacks of events (`done`, `undone`), newest last. A change event's
// `changes` say what undoing it does: replace `from`..`to` (the text the change put there, in the
// document as it is when that event is next) with `text` (the lines it took out). So walking from
// the newest entry to the oldest, a write is carried back through each change in turn:
//
//   - wholly before the change's text: the change's span moves by what the write did;
//   - wholly after it: the change stays put, and the write moves to where it was before the change;
//   - overlapping it: the write is folded into the change - its span grows to cover both, and the
//     text undo puts back takes in what the write replaced - and goes no further back, since
//     before that change the text it touched was not there.
//
// Selections in the history move with the write the same way. Each step changes the history
// entries in place of nothing else: new positions, new change objects for those that moved.

const cmp = (a, b) => a.line - b.line || a.ch - b.ch;
const lastOf = (lines) => lines[lines.length - 1];

// Where `pos` is after a change that replaced `from`..`to` with `lines`. A position inside the
// replaced span goes to its start.
function mapPos(pos, from, to, lines, mk) {
  if (cmp(pos, from) <= 0) return pos;
  if (cmp(pos, to) < 0) return mk(from.line, from.ch);
  const endLine = from.line + lines.length - 1;
  const endCh = (lines.length === 1 ? from.ch : 0) + lastOf(lines).length;
  if (pos.line === to.line) return mk(endLine, endCh + (pos.ch - to.ch));
  return mk(pos.line + (endLine - to.line), pos.ch);
}

// The end of `lines` written at `from`.
function endOf(from, lines, mk) {
  return mk(from.line + lines.length - 1, (lines.length === 1 ? from.ch : 0) + lastOf(lines).length);
}

// The part of `lines` - text starting at `origin` - between positions `a` and `b`, as lines.
function slice(lines, origin, a, b) {
  const offset = (p) => {
    const k = p.line - origin.line;
    if (k === 0) return p.ch - origin.ch;
    let n = 0;
    for (let i = 0; i < k; i++) n += lines[i].length + 1;
    return n + p.ch;
  };
  return lines.join('\n').slice(offset(a), offset(b));
}

/**
 * Carries one write back through one stack of the history (see the top of the file). `write` is
 * `{ from, to, text, removed }` - the span it replaced, in the document as it was just before it,
 * and the lines it put in and took out. `mk(line, ch)` makes a position.
 */
export function rebaseStack(stack, write, mk) {
  let x = write;
  for (let i = stack.length - 1; i >= 0 && x; i--) {
    const ev = stack[i];
    if (ev.ranges) {
      stack[i] = moveSelection(ev, x, mk);
      continue;
    }
    for (let j = ev.changes.length - 1; j >= 0 && x; j--) {
      const c = ev.changes[j];
      if (cmp(x.to, c.from) <= 0) {
        // Before the change's text: the change moves.
        ev.changes[j] = { ...c, from: mapPos(c.from, x.from, x.to, x.text, mk), to: mapPos(c.to, x.from, x.to, x.text, mk) };
      } else if (cmp(x.from, c.to) >= 0) {
        // After it: the write moves back to where it was before the change.
        x = { ...x, from: mapPos(x.from, c.from, c.to, c.text, mk), to: mapPos(x.to, c.from, c.to, c.text, mk) };
      } else {
        // Overlapping: folded into the change, and no further back.
        const before = cmp(x.from, c.from) < 0 ? slice(x.removed, x.from, x.from, c.from) : '';
        const after = cmp(x.to, c.to) > 0 ? slice(x.removed, x.from, c.to, x.to) : '';
        const from = cmp(x.from, c.from) < 0 ? x.from : c.from;
        const to = cmp(x.to, c.to) >= 0 ? endOf(x.from, x.text, mk) : mapPos(c.to, x.from, x.to, x.text, mk);
        const folded = { from, to, text: (before + c.text.join('\n') + after).split('\n') };
        // Kept marks are per line of the text it puts back, which this has changed.
        for (const k of Object.keys(c)) if (!k.startsWith('spans_') && !(k in folded)) folded[k] = c[k];
        ev.changes[j] = folded;
        x = null;
      }
    }
  }
}

function moveSelection(sel, x, mk) {
  const ranges = sel.ranges.map((r) => {
    const anchor = mapPos(r.anchor, x.from, x.to, x.text, mk);
    const head = mapPos(r.head, x.from, x.to, x.text, mk);
    if (anchor === r.anchor && head === r.head) return r;
    return new r.constructor(anchor, head);
  });
  if (ranges.every((r, i) => r === sel.ranges[i])) return sel;
  return new sel.constructor(ranges, sel.primIndex);
}

/**
 * Applies `edits` - `[from, to, text]`, document offsets, measured before any of them - to the
 * editor `cm` as one operation, and leaves its undo history as if they had always been there.
 * Returns how many changed anything. `origin` is the change origin the editor's listeners see.
 */
export function editOutsideHistory(cm, edits, origin = 'mutate') {
  const list = [...edits].sort((a, b) => b[0] - a[0]); // back to front, so earlier offsets hold
  const doc = cm.getDoc();
  const hist = doc.history;
  const saved = hist
    ? {
      done: hist.done.slice(),
      undone: hist.undone.slice(),
      last: { lastOp: hist.lastOp, lastSelOp: hist.lastSelOp, lastOrigin: hist.lastOrigin, lastSelOrigin: hist.lastSelOrigin, lastModTime: hist.lastModTime, lastSelTime: hist.lastSelTime },
    }
    : null;
  // Nothing of this may be merged into the event the user's last edit made.
  if (hist) Object.assign(hist, { lastOp: null, lastSelOp: null, lastOrigin: null, lastSelOrigin: null });
  const writes = [];
  cm.operation(() => {
    for (const [from, to, text] of list) {
      const a = cm.posFromIndex(from);
      const b = cm.posFromIndex(to);
      const removed = cm.getRange(a, b);
      if (removed === text) continue;
      cm.replaceRange(text, a, b, origin);
      writes.push({ from: a, to: b, text: String(text).split('\n'), removed: removed.split('\n') });
    }
  });
  if (!saved) return writes.length;
  const live = doc.history;
  live.done = saved.done;
  live.undone = saved.undone;
  Object.assign(live, saved.last);
  const Pos = cm.posFromIndex(0).constructor;
  const mk = (line, ch) => new Pos(line, ch);
  for (const w of writes) {
    rebaseStack(live.done, w, mk);
    rebaseStack(live.undone, w, mk);
  }
  return writes.length;
}
