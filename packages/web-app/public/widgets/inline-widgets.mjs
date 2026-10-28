// The editor's inline widgets: controls drawn in the code and displays drawn under it.
//
//   slider(0.5, 0, 1)   a box slider before the call's name; dragging it rewrites the first argument
//   knob() toggle() button()                       ...and the other controls of that kind
//   steps("x . x .") sliders("...") matrix({...})   drawn IN PLACE of their call: the call's text
//                                                   folds away under the control (see makeFold)
//   xy()                                            a pad in a row under the line
//   .scope() .spectrum() .waveform() .imager()     the track's sound, from the engine's taps
//   .meter()                                        the track's level, before the call's name
//   .punchcard() .plot() .chroma()                  the pattern itself, from data the host works out
//   punchcard() spectrum() ... on their own line    drawn BEHIND the code (see drawBackground)
//
// How they are found and keyed: the evaluation and this editor run the same scan over the same
// text (pattern-core's widget-calls.mjs), so the position each call sits at when its buffer is
// evaluated is the key both sides use. beforeEval() drops a bookmark on every call it finds in the
// code being sent; afterEval() keeps the ones the host reports back and builds a widget at each.
// The bookmark moves with the text, and the key it was evaluated under stays its key until the next
// evaluation - so a widget keeps reaching its control however the code around it is edited.
//
// The buffer is the truth. A control's gesture writes its new value into the call - the same text
// an evaluation reads - and hands it to the host, whose store the call's signal reads, so it is
// heard without an evaluation. Typing a new number into the call moves the control to match.
//
// Every control is drawn at the size of the app's own control of its kind (see pattern-core's
// INPUT_SIZES and WIDGET_BOXES), and its corner drags it bigger or smaller: the size is written
// into the call when the hand lets go - `{ width, height }`, or `{ size }` for a square kind -
// only those options, the rest of the call as it was written.
//
// Nothing here is part of client.js's own state: the editor hands this module what it needs (the
// CodeMirror instance, its request helper, its clock mirror), and calls a few things back.

import * as M from './widget-math.mjs';

const INLINE_KINDS = new Set(['slider', 'knob', 'toggle', 'button', 'meter']);
const AUDIO_KINDS = new Set(['scope', 'spectrum', 'waveform', 'imager', 'meter']);
const SQUARE_DISPLAYS = new Set(['imager', 'chroma']);

// The piano roll's box slider: the sideways travel for its whole range, a tenth of it with shift.
const BOX_SWEEP_PX = 170;
// The desk's and the device windows' knob: the upward travel for the whole range, and with shift.
const KNOB_SWEEP_PX = 150;
const KNOB_FINE_PX = 1200;
// A knob's or a box slider's wheel step, as a share of the range (a tenth of it with shift).
const WHEEL_STEP = 0.02;

const FRAME_POLL_MS = 40;
const WINDOW_PREFETCH = 4; // cycles of headroom before a display's data runs out
const LEVEL_KEEP_MS = 20000;

let cssLoaded = false;
function loadCss() {
  if (cssLoaded || typeof document === 'undefined') return;
  cssLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./inline-widgets.css', import.meta.url).href;
  document.head.append(link);
}

/**
 * One editor's widgets. `cm` is the CodeMirror instance, `calls` pattern-core's widget-calls.mjs,
 * `api(method, path, body)` the editor's request helper, `deck` which deck the buffer is.
 * `cyclePos()` is the deck's clock now, `cycleAtMs(ms)` the same at a wall-clock time, and
 * `isPlaying()` whether it runs. `trackColor(label)`, when given, is the color a track is drawn
 * in across the app; without it a track takes its .color() or its name's own from the palette.
 */
export function createInlineWidgets({
  cm,
  calls,
  api,
  deck = 'a',
  cyclePos = () => 0,
  cycleAtMs = null,
  isPlaying = () => false,
  trackColor = null,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
}) {
  loadCss();
  let widgets = []; // every live widget built from an evaluation, in document order
  let folds = []; // every folded control (steps, sliders, matrix), whether evaluated or not
  let backs = []; // the displays behind the code - a bare punchcard(), spectrum(), ... - in the order written
  let bg = null; // the canvas they are drawn on, behind the text: { canvas, ctx, width, height, left, still }
  let keys = []; // { kind, at, entry, mark } - the evaluated key of each folded call (see keyOf)
  const rows = new Map(); // line handle -> { lw, el } holding that line's block widgets
  let colors = null;
  let colorsAt = 0;
  let rafId = 0;
  let polling = false;
  let pendingRelayout = false;
  const frames = new Map(); // target -> latest frame
  const levels = new Map(); // target -> [{ ms, pk, l, r }]
  let over = new Set(); // targets the engine's tap budget left out
  let liveNow = {}; // plot at -> value right now
  const dataWin = { from: 0, to: 0, fetching: false };
  const FOLDED = new Set(calls.FOLDED_WIDGETS ?? ['steps', 'sliders', 'matrix']);

  // ---------------------------------------------------------------------------- the code side

  // Where a widget's call starts: a bookmark's position, or the start of a fold's range.
  function startOf(w) {
    const found = w.mark?.find();
    if (!found) return null;
    return found.from ?? found;
  }

  /** Whether a widget's call is still where its mark is. */
  function alive(w) {
    const pos = startOf(w);
    if (!pos) return false;
    const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec((cm.getLine(pos.line) ?? '').slice(pos.ch));
    return !!m && m[1] === w.kind;
  }

  /**
   * Where a widget's call is now: `base` (the name's index), `open` (its paren, from base), every
   * argument (`args`, see callArgs), the ones a position names (`pos`), the options object
   * (`opts`, or null), and `close` - all of them offsets from base.
   */
  function locate(w) {
    const found = w.mark?.find();
    if (!found) return null;
    const pos = found.from ?? found;
    const line = cm.getLine(pos.line) ?? '';
    const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(line.slice(pos.ch));
    if (!m || m[1] !== w.kind) return null;
    const base = cm.indexFromPos(pos);
    // A folded call is exactly its fold's range; anything else is read far enough to close.
    let end = found.to;
    if (!end) {
      const last = Math.min(cm.lineCount() - 1, pos.line + 60);
      end = { line: last, ch: (cm.getLine(last) ?? '').length };
    }
    const text = cm.getRange(pos, end);
    const open = m[0].length - 1;
    const parsed = calls.callArgs(text, open) ?? { close: -1, args: [] };
    const oi = calls.optionsIndex(w.kind, parsed.args);
    return {
      base,
      open,
      args: parsed.args,
      pos: calls.positionalArgs(w.kind, parsed.args),
      opts: oi >= 0 ? parsed.args[oi] : null,
      close: parsed.close,
      parsed,
      text,
    };
  }

  function replaceIdx(from, to, text) {
    const a = cm.posFromIndex(from);
    const b = cm.posFromIndex(to);
    if (cm.getRange(a, b) === text) return;
    cm.replaceRange(text, a, b, '+widget');
  }

  /**
   * Rewrites the call's positional arguments - `[[i, text], ...]` - inserting one that is not
   * written yet when it is the next in line. The options object, if any, stays where it is.
   */
  function writeArgs(w, texts) {
    const at = locate(w);
    if (!at) return false;
    cm.operation(() => {
      // Back to front, so the earlier spans stay where they were measured.
      const edits = [];
      for (const [i, text] of texts) {
        const a = at.pos[i];
        if (a) edits.push([at.base + a.from, at.base + a.to, text]);
        else if (i === at.pos.length) {
          if (at.pos.length) {
            const where = at.base + at.pos[at.pos.length - 1].to;
            edits.push([where, where, `, ${text}`]);
          } else {
            const where = at.base + at.open + 1;
            edits.push([where, where, at.opts ? `${text}, ` : text]);
          }
        }
      }
      edits.sort((x, y) => y[0] - x[0]);
      for (const [from, to, text] of edits) replaceIdx(from, to, text);
    });
    return true;
  }

  /** Rewrites the content of a positional argument that is a string literal. */
  function writeLiteral(w, text, argIndex = 0) {
    const at = locate(w);
    const a = at?.pos[argIndex];
    const lit = a && M.stringContent(a.text);
    if (!lit) return false;
    replaceIdx(at.base + a.from + lit.from, at.base + a.from + lit.to, text);
    return true;
  }

  /** Sets one option of the call (`{ size }`, `{ height }`), leaving everything else as written. */
  function writeOption(w, key, value) {
    const at = locate(w);
    if (!at || at.parsed.close < 0) return false;
    const e = calls.optionEdit(w.kind, at.parsed, key, value);
    cm.operation(() => replaceIdx(at.base + e.from, at.base + e.to, e.text));
    return true;
  }

  /** The number an option of the call says right now, or null. */
  function optionOf(w, key) {
    const at = locate(w);
    if (!at) return null;
    // A display's only argument is its options object.
    const text = at.opts?.text ?? (!w.input && at.args[0]?.text[0] === '{' ? at.args[0].text : null);
    return text ? calls.optionNumber(text, key) : null;
  }

  // The key a widget's value goes to the host under: its own, for one built from an evaluation;
  // for a fold, the key the evaluation gave the call it covers - none until it has been evaluated.
  function keyOf(w) {
    if (!w.folded) return w.at;
    const start = startOf(w);
    if (!start) return null;
    const idx = cm.indexFromPos(start);
    const k = keys.find((x) => x.kind === w.kind && x.mark.find() && cm.indexFromPos(x.mark.find()) === idx);
    return k ? k.at : null;
  }

  // One value in flight per widget, and the newest one waiting behind it: a drag makes more values
  // than any host needs, and the last one is the one that matters.
  function push(w, value) {
    const at = keyOf(w);
    if (at == null) return; // not evaluated yet: the code is all there is, and it has been written
    w.want = { value, at };
    if (w.sending) return;
    const send = () => {
      const next = w.want;
      w.want = null;
      if (!next) {
        w.sending = false;
        return;
      }
      w.sending = true;
      Promise.resolve(api('POST', '/api/widgets/set', { deck, at: next.at, value: next.value }))
        .catch(() => {})
        .finally(send);
    };
    send();
  }

  // ---------------------------------------------------------------------------- theme

  function theme() {
    const now = Date.now();
    if (colors && now - colorsAt < 1000) return colors;
    colorsAt = now;
    const css = win && doc ? win.getComputedStyle(doc.documentElement) : null;
    const v = (name, fallback) => (css?.getPropertyValue(name).trim() || fallback);
    colors = {
      accent: v('--accent', '#ff7a9c'),
      text: v('--text', '#d7dbe4'),
      dim: v('--text-dim', '#8189a0'),
      border: v('--border', '#262a34'),
      panel: v('--bg-panel', '#191c23'),
      bg: v('--bg', '#0e0f13'),
      ok: v('--ok', '#7ed896'),
      warn: v('--warn', '#ffcb6b'),
      err: v('--err', '#ff8080'),
      mono: v('--mono', 'ui-monospace, Menlo, monospace'),
    };
    colors.palette = M.trackPalette(colors.accent, colors.bg);
    return colors;
  }

  // Whether the browser can draw a .color() - a name it does not know is drawn the automatic way.
  const isColor = (x) => (win?.CSS?.supports ? win.CSS.supports('color', x) : true);

  // The color a display draws its track in: the track's .color(), or its name's own from the
  // theme's palette; the accent for a display that belongs to no track.
  function traceColor(w, c = theme()) {
    return colorOfTrack(w.entry?.track, c);
  }

  function colorOfTrack(track, c = theme()) {
    if (trackColor && track?.label) return trackColor(track.label) ?? c.accent;
    return M.resolveTrackColor(track, c.palette, { isColor, fallback: c.accent });
  }

  // ---------------------------------------------------------------------------- building

  function el(tag, cls) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function sizeCanvas(w, canvas, width, height) {
    const dpr = win?.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    w.ctx = canvas.getContext?.('2d') ?? null;
    w.ctx?.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    w.cw = width;
    w.ch = height;
  }

  // Pointer drags on a control: report every move, end on release. The moves are listened for on
  // the document, not on the control: each one rewrites the code, the editor redraws the line,
  // and an inline control is taken out of the page and put back - which drops a pointer capture,
  // and with it every move after the first.
  function onDrag(node, { down, move, up }) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (down?.(e) === false) return;
      const onMove = (ev) => move?.(ev);
      const onUp = (ev) => {
        doc.removeEventListener('pointermove', onMove);
        doc.removeEventListener('pointerup', onUp);
        doc.removeEventListener('pointercancel', onUp);
        up?.(ev);
      };
      doc.addEventListener('pointermove', onMove);
      doc.addEventListener('pointerup', onUp);
      doc.addEventListener('pointercancel', onUp);
    });
    // Neither a click nor a double-click on a control is the editor's to see, and pressing one
    // leaves the keyboard where it was: in the code.
    node.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
    });
    node.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // The resize gesture: a grip over the control's lower right corner - drawn only while hovered,
  // like the app's other grips - that drags the control bigger or smaller, previewed as the hand
  // moves and written into the call when it lets go. A square kind (knob, pad, stereo image,
  // pitch wheel) keeps its one `size`, whichever way the hand went further (see draggedSize); every
  // other kind takes each side from the hand's own travel along it and writes `{ width, height }`
  // (see draggedBox and pattern-core's WIDGET_BOXES).
  function addGrip(w, root, { axis = 'xy', key = 'size', range, current, preview, box = false }) {
    const grip = el('span', `iw-grip iw-grip-${axis}`);
    grip.title = box ? 'drag to resize - written into the code as { width, height }' : `drag to resize - written into the code as { ${key} }`;
    root.append(grip);
    let start = null;
    onDrag(grip, {
      down: (e) => {
        const r = root.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, size: current(), box: { width: r.width, height: r.height } };
        if (box) {
          // A side the app's own CSS draws (a slider's height) starts from what is on screen.
          const s = start.size;
          start.size = { width: s.width ?? r.width, height: s.height ?? r.height };
        }
        grip.classList.add('dragging');
        doc.body.classList.add('iw-resizing');
        w.resizing = true;
      },
      move: (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (box) {
          const next = M.draggedBox(start.size, start.box, dx, dy, calls.WIDGET_BOXES[w.kind]);
          if (w.previewBox && next.width === w.previewBox.width && next.height === w.previewBox.height) return;
          w.previewBox = next;
          preview(next);
        } else {
          const next = M.draggedSize(start.size, start.box, dx, dy, axis, range);
          if (next === w.previewSize) return;
          w.previewSize = next;
          preview(next);
        }
        w.marker()?.changed?.();
      },
      up: () => {
        grip.classList.remove('dragging');
        doc.body.classList.remove('iw-resizing');
        w.resizing = false;
        if (box) {
          const next = w.previewBox;
          w.previewBox = null;
          if (start && next && (next.width !== start.size.width || next.height !== start.size.height)) writeSize(w, next);
        } else {
          const next = w.previewSize;
          w.previewSize = null;
          if (start && next != null && next !== start.size) writeOption(w, key, next);
        }
        start = null;
        w.dirty = true;
      },
    });
    return grip;
  }

  // The size a square control is drawn at: mid-drag, what the hand is showing; otherwise what its
  // call says, or the kind's default.
  function inputSize(w) {
    if (w.previewSize != null) return w.previewSize;
    return calls.widgetSize(w.kind, optionOf(w, 'size'));
  }

  // The `{ width, height }` a box kind is drawn at: mid-drag what the hand shows, otherwise what
  // its call says (a lone `{ size }` or `{ height }` counting as it always did), or the default.
  function boxOf(w) {
    if (w.previewBox) return w.previewBox;
    return calls.widgetBox(w.kind, (k) => optionOf(w, k) ?? w.entry?.opts?.[k] ?? null);
  }

  // The row a steps() or sliders() call draws, and how a new row is written back: the content of
  // its string in place, or - for a count, or nothing written - the whole row as a string where
  // the count was (see pattern-core's rowSource). `fill(n)` makes the n cells a count stands for.
  function rowOfCall(w, fill) {
    const a = locate(w)?.pos[0];
    const src = calls.rowSource(a?.text);
    if (src.form === 'text') return { text: src.text, write: (next) => writeLiteral(w, next) };
    const n = src.form === 'count' ? src.count : calls.DEFAULT_CELL_COUNT;
    return { text: fill(n), write: (next) => writeArgs(w, [[0, quoteRow(next)]]) };
  }

  const quoteRow = (text) => `"${String(text).replace(/["\\]/g, '\\$&')}"`;

  // A cell's tooltip: where it is and what it does - the only words the grid carries.
  function cellTitle(rowKey, i, count, token) {
    const where = `${rowKey ? `${rowKey} · ` : ''}step ${i + 1} of ${count}`;
    return `${where}: ${token ?? 'rest'} - click to switch, drag to paint; right-click to edit as text`;
  }

  // A grid's cells: `--iw-cell` wide and `--iw-cell-h` tall.
  function cellSize(node, b) {
    node.style.setProperty('--iw-cell', `${b.width}px`);
    node.style.setProperty('--iw-cell-h', `${b.height}px`);
  }

  // An inline control's box: its width, and its height only when the call gives one (otherwise
  // the app's own CSS draws it), its text centered in whatever height it has.
  function sizeBox(node, b) {
    node.style.width = `${b.width}px`;
    node.style.height = b.height == null ? '' : `${b.height}px`;
    node.style.lineHeight = b.height == null ? '' : `${Math.max(0, b.height - 4)}px`;
  }

  // A finished drag's size, written into the call: both sides, and a lone `size` they now replace.
  function writeSize(w, box) {
    const keys = calls.sizeKeys(w.kind);
    cm.operation(() => {
      for (const k of keys.write) writeOption(w, k, box[k]);
      for (const k of keys.drop) {
        const at = locate(w);
        if (!at || at.parsed.close < 0) continue;
        const e = calls.optionDrop(w.kind, at.parsed, k);
        if (e) replaceIdx(at.base + e.from, at.base + e.to, e.text);
      }
    });
  }

  function build(entry, mark) {
    const w = {
      kind: entry.kind, at: entry.at, entry, mark, input: !!calls.INPUT_WIDGETS?.includes(entry.kind),
      inline: INLINE_KINDS.has(entry.kind), folded: false, dirty: true,
    };
    const make = BUILDERS[entry.kind];
    if (!make) return null;
    w.el = make(w);
    w.el.classList.add('iw', `iw-${entry.kind}`);
    if (!w.el.title) w.el.title = entry.kind;
    if (w.inline) {
      // The widget rides a bookmark of its own, just before the name; the plain one keeps the key.
      w.widgetMark = cm.setBookmark(mark.find(), { widget: w.el, insertLeft: false, handleMouseEvents: true });
    }
    w.marker = () => w.widgetMark ?? rows.get(anchorLine(w))?.lw ?? null;
    return w;
  }

  function destroy(w) {
    w.widgetMark?.clear();
    if (!w.folded) w.mark?.clear();
    w.el?.remove();
    w.gone = true;
  }

  // ---- input controls

  function rangedState(w) {
    const at = locate(w);
    const e = w.entry ?? {};
    const min = numArg(at, 1, e.min ?? 0);
    const max = numArg(at, 2, e.max ?? 1);
    const step = at?.pos[3] ? M.literalNumber(at.pos[3].text) : e.step ?? null;
    const value = numArg(at, 0, w.value ?? e.value ?? min);
    return { min, max, step, value };
  }

  function numArg(at, i, fallback) {
    const a = at?.pos[i];
    if (!a) return fallback;
    const v = M.literalNumber(a.text);
    return v === null ? fallback : v;
  }

  function setRanged(w, value) {
    const s = rangedState(w);
    const v = M.snapValue(value, s.min, s.max, s.step);
    const decimals = M.decimalsFor(s.min, s.max, s.step);
    const text = calls.formatNumber(v, decimals);
    if (Number(text) === s.value && at0(w)) return;
    w.value = Number(text);
    writeArgs(w, [[0, text]]);
    push(w, w.value);
    w.dirty = true;
  }
  // Whether the call already writes its value out (a bare `knob()` has none to keep as it is).
  const at0 = (w) => !!locate(w)?.pos[0];

  // A ranged control's wheel: a fiftieth of the range a notch, a tenth of that with shift - the
  // desk's knobs' step.
  function onWheel(node, w) {
    node.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const s = rangedState(w);
      const t = M.positionOf(s.value, s.min, s.max) + (e.deltaY < 0 ? 1 : -1) * WHEEL_STEP * (e.shiftKey ? 0.1 : 1);
      setRanged(w, M.valueAt(t, s.min, s.max));
    }, { passive: false });
  }

  const BUILDERS = {
    // The piano roll's box slider: a value box with a fill behind the number, dragged sideways.
    slider(w) {
      const root = el('span', 'pr-box-slider');
      const fill = el('span', 'pr-box-fill');
      const val = el('span', 'pr-box-val');
      root.append(fill, val);
      let start = null;
      onDrag(root, {
        down: (e) => {
          const s = rangedState(w);
          start = { x: e.clientX, t: M.positionOf(s.value, s.min, s.max) };
          root.classList.add('dragging');
        },
        move: (e) => {
          if (!start) return;
          const s = rangedState(w);
          const t = start.t + ((e.clientX - start.x) / BOX_SWEEP_PX) * (e.shiftKey ? 0.1 : 1);
          setRanged(w, M.valueAt(t, s.min, s.max));
          if (t < 0 || t > 1) start = { x: e.clientX, t: Math.min(1, Math.max(0, t)) };
        },
        up: () => {
          start = null;
          root.classList.remove('dragging');
        },
      });
      onWheel(root, w);
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: (b) => sizeBox(root, b) });
      w.render = () => {
        const s = rangedState(w);
        const t = M.positionOf(s.value, s.min, s.max);
        const decimals = M.decimalsFor(s.min, s.max, s.step);
        sizeBox(root, boxOf(w));
        fill.style.left = '0';
        fill.style.width = `${t * 100}%`;
        val.textContent = calls.formatNumber(s.value, decimals);
        root.title = `${s.min} - ${s.max}`;
      };
      return root;
    },

    // The desk's knob, as the device windows draw it.
    knob(w) {
      const root = el('span', 'mix-knob');
      let start = null;
      onDrag(root, {
        down: (e) => {
          const s = rangedState(w);
          start = { y: e.clientY, t: M.positionOf(s.value, s.min, s.max) };
          root.classList.add('dragging');
        },
        move: (e) => {
          if (!start) return;
          const s = rangedState(w);
          const t = start.t + (start.y - e.clientY) / (e.shiftKey ? KNOB_FINE_PX : KNOB_SWEEP_PX);
          setRanged(w, M.valueAt(t, s.min, s.max));
          if (t < 0 || t > 1) start = { y: e.clientY, t: Math.min(1, Math.max(0, t)) };
        },
        up: () => {
          start = null;
          root.classList.remove('dragging');
        },
      });
      onWheel(root, w);
      addGrip(w, root, {
        axis: 'xy',
        range: calls.INPUT_SIZES.knob,
        current: () => inputSize(w),
        preview: (n) => { root.style.width = root.style.height = `${n}px`; },
      });
      w.render = () => {
        const s = rangedState(w);
        const t = M.positionOf(s.value, s.min, s.max);
        const n = inputSize(w);
        root.style.width = root.style.height = `${n}px`;
        root.style.setProperty('--ang', `${-135 + t * 270}deg`);
        root.title = `${calls.formatNumber(s.value, M.decimalsFor(s.min, s.max, s.step))}  (${s.min} - ${s.max})`;
      };
      return root;
    },

    // A device window's switch.
    toggle(w) {
      const root = el('button', 'small device-toggle iw-switch');
      onDrag(root, {
        down: () => {
          const at = locate(w);
          const on = numArg(at, 0, w.entry.value ?? 0) ? 0 : 1;
          writeArgs(w, [[0, String(on)]]);
          push(w, on);
          w.dirty = true;
        },
      });
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: (b) => sizeBox(root, b) });
      w.render = () => {
        const on = !!numArg(locate(w), 0, w.entry.value ?? 0);
        sizeBox(root, boxOf(w));
        root.classList.toggle('on', on);
        root.firstChild.nodeValue = on ? 'on' : 'off';
      };
      root.prepend(doc.createTextNode('off'));
      return root;
    },

    // The same switch, lit for as long as it is held.
    button(w) {
      const root = el('button', 'small device-toggle iw-switch');
      root.prepend(doc.createTextNode('press'));
      root.title = 'button: 1 while held';
      onDrag(root, {
        down: () => {
          root.classList.add('on');
          push(w, 1);
        },
        up: () => {
          root.classList.remove('on');
          push(w, 0);
        },
      });
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: (b) => sizeBox(root, b) });
      w.render = () => sizeBox(root, boxOf(w));
      return root;
    },

    xy(w) {
      const root = el('div', 'iw-block');
      const pad = el('div', 'device-figure-canvas iw-pad');
      const dot = el('span', 'iw-pad-dot');
      pad.append(dot);
      root.append(pad);
      const place = (e) => {
        const r = pad.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
        const y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / Math.max(1, r.height)));
        const tx = calls.formatNumber(x, 2);
        const ty = calls.formatNumber(y, 2);
        writeArgs(w, [[0, tx], [1, ty]]);
        push(w, [Number(tx), Number(ty)]);
        w.dirty = true;
      };
      onDrag(pad, { down: place, move: place });
      const sizeTo = (n) => { pad.style.width = pad.style.height = `${n}px`; };
      addGrip(w, root, { axis: 'xy', range: calls.INPUT_SIZES.xy, current: () => inputSize(w), preview: sizeTo });
      w.render = () => {
        const at = locate(w);
        const [x0, y0] = Array.isArray(w.entry.value) ? w.entry.value : [0.5, 0.5];
        const x = numArg(at, 0, x0);
        const y = numArg(at, 1, y0);
        sizeTo(inputSize(w));
        dot.style.left = `${x * 100}%`;
        dot.style.top = `${(1 - y) * 100}%`;
        pad.title = `x ${calls.formatNumber(x, 2)}  y ${calls.formatNumber(y, 2)}`;
      };
      return root;
    },

    // ---- the folded controls: drawn in place of their call (see makeFold)

    steps(w) {
      const root = el('span');
      const box = el('span', 'iw-cells');
      root.append(box);
      let cells = [];
      let paint = null;
      const row = () => rowOfCall(w, calls.restRow);
      const setCell = (i, on) => {
        const r = row();
        const parsed = calls.parseCells(r.text);
        if (!parsed[i] || parsed[i].on === on) return;
        const next = calls.toggleCell(r.text, i);
        r.write(next);
        push(w, next);
        w.dirty = true;
      };
      onDrag(box, {
        down: (e) => {
          const i = cellIndex(e.target);
          if (i < 0) return false;
          paint = !calls.parseCells(row().text)[i]?.on;
          setCell(i, paint);
          return true;
        },
        move: (e) => {
          if (paint === null) return;
          const i = cellIndex(doc.elementFromPoint?.(e.clientX, e.clientY), box);
          if (i >= 0) setCell(i, paint);
        },
        up: () => { paint = null; },
      });
      const sizeTo = (b) => cellSize(root, b);
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: sizeTo });
      w.render = () => {
        const parsed = calls.parseCells(row().text);
        sizeTo(boxOf(w));
        if (parsed.length !== cells.length) {
          box.textContent = '';
          cells = parsed.map((_, i) => {
            const c = el('span', 'iw-cell');
            c.dataset.c = String(i);
            if (M.beatStart(i, parsed.length)) c.classList.add('beat');
            box.append(c);
            return c;
          });
        }
        parsed.forEach((p, i) => {
          cells[i].classList.toggle('on', p.on);
          cells[i].title = cellTitle(null, i, parsed.length, p.on ? p.token : null);
        });
      };
      w.tick = (pos, running) => {
        const at = running ? M.cellAt(pos, cells.length) : -1;
        if (at === w.lit) return;
        if (w.lit >= 0) cells[w.lit]?.classList.remove('now');
        if (at >= 0) cells[at]?.classList.add('now');
        w.lit = at;
      };
      w.lit = -1;
      return root;
    },

    sliders(w) {
      const root = el('span');
      const box = el('span', 'iw-bars');
      root.append(box);
      let bars = [];
      let dragging = false;
      const state = () => {
        const at = locate(w);
        const min = numArg(at, 1, w.entry?.min ?? 0);
        const max = numArg(at, 2, w.entry?.max ?? 1);
        return { ...rowOfCall(w, (n) => calls.middleRow(n, min, max)), min, max };
      };
      const setAt = (e) => {
        const r = box.getBoundingClientRect();
        const s = state();
        const cells = calls.parseCells(s.text);
        if (!cells.length) return;
        // The bar under the hand, or the nearest one at either end of the row.
        let i = cellIndex(doc.elementFromPoint?.(e.clientX, r.top + r.height / 2), box);
        if (i < 0) i = e.clientX < r.left ? 0 : cells.length - 1;
        const t = 1 - (e.clientY - r.top) / Math.max(1, r.height);
        const v = M.valueAt(t, s.min, s.max);
        const next = calls.setCellValue(s.text, i, v, M.decimalsFor(s.min, s.max));
        if (next === s.text) return;
        s.write(next);
        push(w, next);
        w.dirty = true;
      };
      onDrag(box, {
        down: (e) => { dragging = true; setAt(e); },
        move: (e) => { if (dragging) setAt(e); },
        up: () => { dragging = false; },
      });
      const sizeTo = (b) => {
        root.style.setProperty('--iw-bar-w', `${b.width}px`);
        root.style.setProperty('--iw-bar-h', `${b.height}px`);
      };
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: sizeTo });
      w.render = () => {
        const s = state();
        const cells = calls.parseCells(s.text);
        sizeTo(boxOf(w));
        if (cells.length !== bars.length) {
          box.textContent = '';
          bars = cells.map((_, i) => {
            const b = el('span', 'iw-bar');
            b.dataset.c = String(i);
            if (M.beatStart(i, cells.length)) b.classList.add('beat');
            const f = el('span', 'iw-bar-fill');
            b.append(f);
            box.append(b);
            return f;
          });
        }
        cells.forEach((c, i) => {
          const v = Number(c.token);
          const bar = bars[i].parentNode;
          bar.classList.toggle('rest', !Number.isFinite(v));
          bar.title = `step ${i + 1} of ${cells.length}: ${c.token} (${s.min} - ${s.max}) - drag up or down to set`;
          bars[i].style.height = `${Number.isFinite(v) ? M.positionOf(v, s.min, s.max) * 100 : 0}%`;
        });
      };
      w.tick = (pos, running) => {
        const at = running ? M.cellAt(pos, bars.length) : -1;
        if (at === w.lit) return;
        if (w.lit >= 0) bars[w.lit]?.parentNode.classList.remove('now');
        if (at >= 0) bars[at]?.parentNode.classList.add('now');
        w.lit = at;
      };
      w.lit = -1;
      return root;
    },

    matrix(w) {
      const root = el('span');
      const grid = el('span', 'iw-matrix');
      root.append(grid);
      let shape = '';
      let rowEls = [];
      let paint = null;
      // The rows the call draws: an object's rows written as text or a count. A call with none is
      // never folded (see pattern-core's foldable), so there is always one here.
      const rowsNow = () => {
        const at = locate(w);
        const a = at?.pos[0];
        if (!a || a.text[0] !== '{') return [];
        return calls.matrixRows(a.text, 0).filter((r) => r.form !== 'code').map((r) => ({ ...r, abs: at.base + a.from }));
      };
      const toggleAt = (rowIndex, cellIndex, on) => {
        const rows = rowsNow();
        const row = rows[rowIndex];
        if (!row) return;
        const cells = calls.parseCells(row.text);
        if (!cells[cellIndex] || cells[cellIndex].on === on) return;
        const next = calls.toggleCell(row.text, cellIndex);
        if (row.form === 'text') replaceIdx(row.abs + row.from, row.abs + row.to, next);
        else replaceIdx(row.abs + row.from, row.abs + row.to, quoteRow(next)); // a count, written out
        push(w, { row: row.key, text: next });
        w.dirty = true;
      };
      const hit = (target) => {
        const cell = target?.closest?.('.iw-cell');
        if (!cell || !grid.contains(cell)) return null;
        return { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
      };
      onDrag(grid, {
        down: (e) => {
          const h = hit(e.target);
          if (!h) return false;
          const row = rowsNow()[h.r];
          paint = !calls.parseCells(row?.text ?? '')[h.c]?.on;
          toggleAt(h.r, h.c, paint);
          return true;
        },
        move: (e) => {
          if (paint === null) return;
          const h = hit(doc.elementFromPoint?.(e.clientX, e.clientY));
          if (h) toggleAt(h.r, h.c, paint);
        },
        up: () => { paint = null; },
      });
      const sizeTo = (b) => cellSize(root, b);
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: sizeTo });
      w.render = () => {
        const rows = rowsNow();
        const parsed = rows.map((r) => calls.parseCells(r.text));
        sizeTo(boxOf(w));
        const key = rows.map((r, i) => `${r.key}:${parsed[i].length}`).join('|');
        if (key !== shape) {
          shape = key;
          grid.textContent = '';
          // Every label the width of the longest, so the rows' first cells line up.
          const labelCh = Math.min(12, Math.max(2, ...rows.map((x) => x.key.length)));
          rowEls = rows.map((r, ri) => {
            const line = el('span', 'iw-mrow');
            const label = el('span', 'iw-mlabel');
            label.textContent = r.key;
            label.title = `${r.key}: what this row plays`;
            label.style.width = `${labelCh + 1}ch`;
            line.append(label);
            const cells = parsed[ri].map((_, ci) => {
              const c = el('span', 'iw-cell');
              c.dataset.r = String(ri);
              c.dataset.c = String(ci);
              if (M.beatStart(ci, parsed[ri].length)) c.classList.add('beat');
              line.append(c);
              return c;
            });
            grid.append(line);
            return cells;
          });
        }
        parsed.forEach((cells, ri) => cells.forEach((p, ci) => {
          const c = rowEls[ri]?.[ci];
          if (!c) return;
          c.classList.toggle('on', p.on);
          c.title = cellTitle(rows[ri].key, ci, cells.length, p.on ? p.token : null);
        }));
      };
      w.tick = (pos, running) => {
        const key = running ? rowEls.map((cells) => M.cellAt(pos, cells.length)).join(',') : '';
        if (key === w.lit) return;
        w.lit = key;
        const at = key ? key.split(',').map(Number) : [];
        rowEls.forEach((cells, ri) => cells.forEach((c, ci) => c.classList.toggle('now', at[ri] === ci)));
      };
      w.lit = '';
      return root;
    },

    // ---- displays of sound

    // The level, drawn like the desk's channel meters (client.js mixMeterPaint): segments lit to
    // the RMS, a peak line, and a held peak that waits 1.2s and then falls - left and right side
    // by side. Taller than it is wide it stands up with the desk's dB ticks beside it (when there
    // is room for them); otherwise it lies along the line.
    meter(w) {
      const root = el('span');
      const canvas = el('canvas', 'iw-canvas');
      root.append(canvas);
      const st = { l: { rms: -90, peak: -90, hold: -90, holdAt: 0 }, r: { rms: -90, peak: -90, hold: -90, holdAt: 0 }, ms: 0 };
      let drawnAt = '';
      const fit = (b) => {
        const k = `${b.width}x${b.height}`;
        if (k === drawnAt) return;
        drawnAt = k;
        sizeCanvas(w, canvas, b.width, b.height);
      };
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: (b) => { fit(b); w.draw?.(); } });
      w.render = () => fit(boxOf(w));
      fit(boxOf(w));
      w.draw = () => {
        const ctx = w.ctx;
        if (!ctx) return;
        const c = theme();
        const now = win?.performance?.now?.() ?? Date.now();
        const dt = st.ms ? Math.min(0.25, (now - st.ms) / 1000) : 0;
        st.ms = now;
        const lv = latestLevel(w.entry.target);
        const fall = 36 * dt;
        const follow = (d, peakLin, rmsLin) => {
          const pk = M.toDb(peakLin, -90);
          const rm = M.toDb(rmsLin, -90);
          d.rms = rm > d.rms ? rm : Math.max(rm, d.rms - fall);
          d.peak = pk > d.peak ? pk : Math.max(pk, d.peak - fall);
          if (pk >= d.hold) { d.hold = pk; d.holdAt = now; } else if (now - d.holdAt > 1200) d.hold = Math.max(d.hold - fall, d.peak);
        };
        follow(st.l, lv?.pl ?? 0, lv?.rl ?? 0);
        follow(st.r, lv?.pr ?? 0, lv?.rr ?? 0);
        const W = w.cw;
        const H = w.ch;
        ctx.clearRect(0, 0, W, H);
        const { min, max } = M.METER_DB;
        const vertical = M.meterVertical(W, H);
        const ticks = vertical && W >= 30 ? M.meterTicks(H - 8) : [];
        const pad = ticks.length ? 4 : 0;
        const along = vertical ? H - pad * 2 : W; // the scale's length
        const across = vertical ? W - (ticks.length ? 16 : 0) : H; // room for the two bars
        const barW = Math.max(1, (across - 1) / 2);
        const pos = (db) => ((Math.min(max, Math.max(min, db)) - min) / (max - min)) * along;
        const rect = (bar, from, len, thick = barW) => {
          const off = bar * (barW + 1);
          if (vertical) ctx.fillRect(off, pad + along - from - len, thick, len);
          else ctx.fillRect(from, off, len, thick);
        };
        [st.l, st.r].forEach((d, bar) => {
          for (let p = 0; p < along; p += 4) {
            const segDb = min + (p / along) * (max - min);
            ctx.globalAlpha = segDb <= d.rms ? 1 : 0.14;
            ctx.fillStyle = M.meterColor(segDb);
            rect(bar, p, Math.min(3, along - p));
          }
          ctx.globalAlpha = 1;
          if (d.peak > min) { ctx.fillStyle = M.meterColor(d.peak); rect(bar, pos(d.peak) - 1.5, 1.5); }
          if (d.hold > min) { ctx.fillStyle = M.meterColor(d.hold); rect(bar, pos(d.hold) - 1, 1); }
        });
        if (ticks.length) {
          ctx.font = `8px ${c.mono}`;
          ctx.fillStyle = c.dim;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          for (const db of ticks) ctx.fillText(db > 0 ? `+${db}` : String(db), across + 3, pad + along - pos(db));
        }
        root.title = over.has(w.entry.target)
          ? 'not drawn: more tracks have displays than the engine taps at once'
          : `meter${st.l.hold > -90 ? `: peak ${Math.max(st.l.hold, st.r.hold).toFixed(1)} dB` : ''}`;
      };
      return root;
    },

    scope(w) {
      return displayBlock(w, (ctx, c, width, height) => {
        const f = frames.get(w.entry.target)?.scope;
        midline(ctx, c, width, height);
        if (!f) return; // nothing to show yet: stopped, not armed, or past the tap budget
        const windowMs = w.entry.opts?.window ?? 20;
        const span = Math.max(8, Math.min(f.l.length - 1, Math.round((windowMs / 1000) * f.rate)));
        const mono = new Float32Array(f.l.length);
        for (let i = 0; i < mono.length; i++) mono[i] = (f.l[i] + f.r[i]) * 0.5;
        const start = M.scopeTrigger(mono, span);
        const scale = w.entry.opts?.scale ?? 1;
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let i = 0; i <= span; i++) {
          const v = mono[start + i] ?? 0;
          const x = (i / span) * width;
          const y = height / 2 - v * scale * (height / 2 - 2);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });
    },

    // The device windows' frequency axis (100, 1k, 10k along the foot) and the mixer spectrum's
    // level grid (a line every 12 dB), labeled down the left edge. Both are fixed by the size and
    // the range alone: the levels move, the axes never do.
    spectrum(w) {
      return displayBlock(w, (ctx, c, width, height) => {
        const f = frames.get(w.entry.target)?.spec;
        const lo = w.entry.opts?.min ?? -90;
        const hi = w.entry.opts?.max ?? 0;
        const yOf = (db) => height - ((db - lo) / (hi - lo)) * height;
        const ticks = M.spectrumTicks(lo, hi, height);
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 1;
        for (const db of ticks.lines) {
          const y = Math.round(yOf(db)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
        for (const hz of [100, 1000, 10000]) {
          const x = Math.round(M.freqX(hz, width)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        if (f) {
          const cols = M.spectrumColumns(f.db, f.binHz, width);
          w.smooth = M.decay(w.smooth, cols, 1.2);
          ctx.beginPath();
          ctx.moveTo(0, height);
          for (let x = 0; x < width; x++) {
            const t = Math.min(1, Math.max(0, (w.smooth[x] - lo) / (hi - lo)));
            ctx.lineTo(x, height - t * height);
          }
          ctx.lineTo(width, height);
          ctx.closePath();
          ctx.globalAlpha = 0.28;
          ctx.fillStyle = c.accent;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = c.accent;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
        // The labels last, over the curve, so a loud low end never hides them.
        ctx.font = '8px ui-monospace, monospace';
        ctx.fillStyle = c.dim;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        for (const hz of [100, 1000, 10000]) ctx.fillText(M.freqLabel(hz), Math.round(M.freqX(hz, width)) + 2, height - 10);
        ctx.textBaseline = 'middle';
        for (const db of ticks.labels) {
          const y = yOf(db);
          if (y > height - 12) continue; // the foot is the frequency labels'
          ctx.fillText(String(db), 2, Math.max(5, y)); // the top line's label just inside the edge
        }
      });
    },

    waveform(w) {
      return displayBlock(w, (ctx, c, width, height, pos) => {
        const cycles = w.entry.opts?.cycles ?? 2;
        const page = Math.floor(pos / cycles) * cycles;
        const hist = levels.get(w.entry.target) ?? [];
        // Beat and cycle lines.
        for (let b = 0; b <= cycles * 4; b++) {
          const x = (b / (cycles * 4)) * width;
          ctx.strokeStyle = b % 4 === 0 ? c.dim : c.border;
          ctx.globalAlpha = b % 4 === 0 ? 0.5 : 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, height);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (!hist.length || !cycleAtMs) return;
        const mid = height / 2;
        const drawPage = (from, alpha, untilPos) => {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = c.accent;
          for (const h of hist) {
            const p = cycleAtMs(h.ms);
            if (p === null || p < from || p >= from + cycles || p > untilPos) continue;
            const x = ((p - from) / cycles) * width;
            const a = Math.min(1, h.pk) * (mid - 1);
            ctx.fillRect(x, mid - a, Math.max(1, width / 240), a * 2);
          }
        };
        // What the page played last time round, dimmed, ahead of the playhead - then this page.
        drawPage(page - cycles, 0.25, Infinity);
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.panel;
        const px = ((pos - page) / cycles) * width;
        ctx.globalAlpha = 0.6;
        ctx.fillRect(0, 0, px, height);
        drawPage(page, 1, pos);
        ctx.globalAlpha = 1;
        playhead(ctx, c, px, height);
      });
    },

    imager(w) {
      return displayBlock(w, (ctx, c, width, height) => {
        const cx = width / 2;
        const bottom = height - 8;
        const radius = Math.min(cx, bottom) - 2;
        // The safe lines: left and right channel alone, and the edge where correlation turns negative.
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, bottom);
        ctx.lineTo(cx - radius * Math.SQRT1_2, bottom - radius * Math.SQRT1_2);
        ctx.moveTo(cx, bottom);
        ctx.lineTo(cx + radius * Math.SQRT1_2, bottom - radius * Math.SQRT1_2);
        ctx.moveTo(cx, bottom);
        ctx.lineTo(cx, bottom - radius);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, bottom, radius, Math.PI, 2 * Math.PI);
        ctx.stroke();
        const f = frames.get(w.entry.target)?.scope;
        if (!f) return; // nothing to show yet: stopped, not armed, or past the tap budget
        const { pts, correlation } = M.imagerPoints(f.l, f.r);
        ctx.fillStyle = c.accent;
        ctx.globalAlpha = 0.5;
        for (let i = 0; i < pts.length; i += 2) {
          // Both halves of the field fold onto the upper one: a negative mid is the same image.
          const sgn = pts[i + 1] < 0 ? -1 : 1;
          const x = cx + pts[i] * sgn * radius;
          const y = bottom - Math.abs(pts[i + 1]) * radius;
          ctx.fillRect(x, y, 1.2, 1.2);
        }
        ctx.globalAlpha = 1;
        // The correlation bar: -1 at the left, +1 at the right.
        ctx.fillStyle = c.border;
        ctx.fillRect(4, height - 4, width - 8, 2);
        ctx.fillStyle = correlation < 0 ? c.err : c.ok;
        const x0 = cx;
        const x1 = cx + correlation * (width / 2 - 4);
        ctx.fillRect(Math.min(x0, x1), height - 5, Math.max(2, Math.abs(x1 - x0)), 4);
      });
    },

    // ---- displays of the pattern

    punchcard(w) {
      return displayBlock(w, (ctx, c, width, height, pos) => {
        const cycles = w.entry.opts?.cycles ?? 4;
        const left = pos - cycles / 2;
        const events = (w.data?.events ?? []).filter((e) => e[1] > left && e[0] < left + cycles);
        const { rows: lanes, count } = M.punchcardRows(events);
        for (let k = Math.ceil(left); k < left + cycles; k++) {
          const x = ((k - left) / cycles) * width;
          ctx.strokeStyle = c.border;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, height);
          ctx.stroke();
        }
        if (!count) return;
        const rowH = height / Math.max(count, 1);
        for (const e of events) {
          const x0 = ((e[0] - left) / cycles) * width;
          const x1 = ((e[1] - left) / cycles) * width;
          const r = lanes.get(e[2]) ?? 0;
          const y = height - (r + 1) * rowH;
          const active = pos >= e[0] && pos < e[1];
          ctx.globalAlpha = active ? 1 : 0.35 + 0.4 * Math.min(1, e[3] ?? 1);
          ctx.fillStyle = active ? c.accent : c.dim;
          ctx.fillRect(x0 + 0.5, y + 1, Math.max(1.5, x1 - x0 - 1), Math.max(1, rowH - 2));
        }
        ctx.globalAlpha = 1;
        // The rows' names, where they fit.
        if (rowH >= 9) {
          ctx.font = `8px ${c.mono}`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          for (const [value, r] of lanes) {
            const y = height - (r + 0.5) * rowH;
            const label = M.valueLabel(value, !!w.data?.notes);
            ctx.fillStyle = c.bg;
            ctx.globalAlpha = 0.7;
            ctx.fillRect(1, y - 5, ctx.measureText?.(label).width + 4 || 24, 10);
            ctx.globalAlpha = 1;
            ctx.fillStyle = c.dim;
            ctx.fillText(label, 3, y + 0.5);
          }
        }
        playhead(ctx, c, width / 2, height);
      });
    },

    plot(w) {
      return displayBlock(w, (ctx, c, width, height, pos) => {
        const cycles = w.entry.opts?.cycles ?? 2;
        const left = pos - cycles / 2;
        const d = w.data ?? {};
        const inView = (p) => p >= left - 0.05 && p <= left + cycles + 0.05;
        const runs = (d.runs ?? []).filter((r) => r[1] > left && r[0] < left + cycles);
        const points = (d.points ?? []).filter((p) => inView(p[0]));
        const trace = w.trace ?? [];
        const [lo, hi] = M.plotRange([
          ...runs.map((r) => r[2]), ...points.map((p) => p[1]), ...trace.map((p) => p[1]),
        ], w.entry.opts?.min ?? null, w.entry.opts?.max ?? null);
        const y = (v) => height - 2 - ((v - lo) / (hi - lo)) * (height - 4);
        const x = (p) => ((p - left) / cycles) * width;
        ctx.strokeStyle = c.border;
        for (let k = Math.ceil(left); k < left + cycles; k++) {
          ctx.beginPath();
          ctx.moveTo(Math.round(x(k)) + 0.5, 0);
          ctx.lineTo(Math.round(x(k)) + 0.5, height);
          ctx.stroke();
        }
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        if (d.live && trace.length) {
          // A control moved by hand has no future to draw: its trace is what it has been.
          trace.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
        } else if (runs.length) {
          for (const r of runs) {
            ctx.moveTo(x(r[0]), y(r[2]));
            ctx.lineTo(x(r[1]), y(r[2]));
          }
        } else {
          let pen = false;
          for (const p of points) {
            if (p[1] === null) { pen = false; continue; }
            if (pen) ctx.lineTo(x(p[0]), y(p[1]));
            else ctx.moveTo(x(p[0]), y(p[1]));
            pen = true;
          }
        }
        ctx.stroke();
        playhead(ctx, c, width / 2, height);
        // The range, so the line can be read.
        ctx.fillStyle = c.dim;
        ctx.font = `9px ${c.mono}`;
        ctx.textBaseline = 'top';
        ctx.fillText(fmtAxis(hi), 3, 2);
        ctx.textBaseline = 'bottom';
        ctx.fillText(fmtAxis(lo), 3, height - 1);
      });
    },

    chroma(w) {
      return displayBlock(w, (ctx, c, width, height, pos) => {
        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(cx, cy) - 10;
        const events = w.data?.events ?? [];
        const lit = new Map(); // pitch class -> brightness
        for (const e of events) {
          if (e[0] > pos || e[1] < pos - 1) continue;
          const pc = M.pitchClassOf(e[2]);
          if (pc === null) continue;
          const sounding = pos >= e[0] && pos < e[1];
          const b = sounding ? 1 : Math.max(0, 0.45 - (pos - e[1]) * 0.45);
          lit.set(pc, Math.max(lit.get(pc) ?? 0, b));
        }
        ctx.font = `9px ${c.mono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const at = (pc, r) => {
          const a = (pc / 12) * Math.PI * 2 - Math.PI / 2;
          return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
        };
        // The sounding notes joined up, so a chord reads as a shape.
        const on = [...lit.entries()].filter(([, b]) => b >= 1).map(([pc]) => pc).sort((a, b) => a - b);
        if (on.length > 1) {
          ctx.strokeStyle = c.accent;
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          on.forEach((pc, i) => {
            const [px, py] = at(pc, radius);
            if (i) ctx.lineTo(px, py);
            else ctx.moveTo(px, py);
          });
          ctx.closePath();
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        for (let pc = 0; pc < 12; pc++) {
          const [px, py] = at(pc, radius);
          const b = lit.get(pc) ?? 0;
          if (b > 0) {
            ctx.fillStyle = c.accent;
            ctx.globalAlpha = 0.25 + 0.75 * b;
            ctx.beginPath();
            ctx.arc(px, py, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          ctx.fillStyle = b >= 1 ? c.bg : b > 0 ? c.text : c.dim;
          ctx.fillText(M.pitchName(pc), px, py + 0.5);
        }
      });
    },
  };

  // The cell a pointer is over, by its index in the row, or -1.
  function cellIndex(target, within = null) {
    const cell = target?.closest?.('[data-c]');
    if (!cell || (within && !within.contains(cell))) return -1;
    return Number(cell.dataset.c);
  }

  function fmtAxis(v) {
    const a = Math.abs(v);
    return String(a >= 100 ? Math.round(v) : a >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000);
  }

  // A square display's side: its call's `{ size }`, mid-drag what the hand shows, else the default.
  function displaySize(w) {
    if (w.previewSize != null) return w.previewSize;
    const spec = calls.DISPLAY_SIZES[w.kind];
    const asked = optionOf(w, spec.key) ?? w.entry.opts?.[spec.key];
    const v = Number(asked);
    return Math.round(Math.min(spec.max, Math.max(spec.min, Number.isFinite(v) && asked != null ? v : spec.size)));
  }

  // A display: a canvas in a box under the line. A square one (stereo image, pitch wheel) keeps
  // its one `{ size }`; the rest are `{ width, height }`, a lone `{ height }` as it always was.
  function displayBlock(w, paint) {
    const spec = calls.DISPLAY_SIZES[w.kind];
    const square = SQUARE_DISPLAYS.has(w.kind);
    const root = el('div', 'iw-block');
    const canvas = el('canvas', 'iw-canvas');
    root.append(canvas);
    let drawnAt = '';
    const fit = (b) => {
      const k = `${b.width}x${b.height}`;
      if (k === drawnAt) return;
      drawnAt = k;
      sizeCanvas(w, canvas, b.width, b.height);
      w.drawnStill = false;
    };
    const sizeNow = () => {
      if (!square) return boxOf(w);
      const n = displaySize(w);
      return { width: n, height: n };
    };
    const redraw = (b) => { fit(b); w.draw?.(cyclePos(), isPlaying()); };
    if (square) {
      addGrip(w, root, { axis: 'xy', key: spec.key, range: spec, current: () => displaySize(w), preview: (n) => redraw({ width: n, height: n }) });
    } else {
      addGrip(w, root, { box: true, current: () => boxOf(w), preview: redraw });
    }
    w.render = () => fit(sizeNow());
    fit(sizeNow());
    w.draw = (pos, running) => {
      const ctx = w.ctx;
      if (!ctx) return;
      const base = theme();
      const c = { ...base, accent: traceColor(w, base) };
      ctx.clearRect(0, 0, w.cw, w.ch);
      paint(ctx, c, w.cw, w.ch, pos, running);
      root.title = AUDIO_KINDS.has(w.kind) && over.has(w.entry.target)
        ? 'not drawn: more tracks have displays than the engine taps at once'
        : AUDIO_KINDS.has(w.kind) && !w.entry.target ? 'not drawn: this is not inside a track' : w.kind;
    };
    return root;
  }

  function midline(ctx, c, width, height) {
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(height / 2) + 0.5);
    ctx.lineTo(width, Math.round(height / 2) + 0.5);
    ctx.stroke();
  }

  function playhead(ctx, c, x, height) {
    ctx.strokeStyle = c.text;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function latestLevel(target) {
    const h = levels.get(target);
    return h?.length ? h[h.length - 1] : null;
  }

  // ---------------------------------------------------------------------------- folds

  /**
   * A folded control: steps(), sliders() or matrix() drawn in place of the call itself. The editor
   * makes one for each such call when it folds the buffer (client.js's foldConfigBlobs, beside the
   * rolls and the arrangement), hands its element to a mark that replaces the call's text, and then
   * `attach`es the mark. The text under it is the control's state: every gesture rewrites it in
   * place, inside the mark, so copy, paste and undo all carry the code - and the control redraws
   * from whatever the text says after any edit. Folds are re-made on every refold; a fold whose
   * mark has gone is dropped.
   */
  function makeFold(kind) {
    if (!FOLDED.has(kind) || !BUILDERS[kind]) return null;
    const f = { kind, at: null, entry: {}, mark: null, input: true, inline: false, folded: true, dirty: true };
    f.el = BUILDERS[kind](f);
    f.el.classList.add('iw', `iw-${kind}`, 'iw-fold');
    f.el.title = f.el.title || kind;
    f.marker = () => f.mark;
    f.attach = (mark) => {
      f.mark = mark;
      mark.poptartWidget = f;
      folds.push(f);
      try { f.render(); } catch { /* a call half-typed */ }
      f.dirty = false;
      ensureLoop();
    };
    return f;
  }

  function pruneFolds() {
    const before = folds.length;
    folds = folds.filter((f) => f.mark?.find());
    return folds.length !== before;
  }

  // ---------------------------------------------------------------------------- layout

  // Which line a block widget sits under: the one its call closes on, so a chain written over
  // several lines gets its display under the whole of it rather than splitting it.
  function anchorLine(w) {
    const at = locate(w);
    if (!at) return null;
    const closeIdx = at.close >= 0 ? at.base + at.close : at.base;
    return cm.getLineHandle(cm.posFromIndex(closeIdx).line);
  }

  function relayout() {
    pendingRelayout = false;
    const wanted = new Map(); // line handle -> [widgets]
    for (const w of widgets) {
      if (w.inline || w.gone) continue;
      const line = anchorLine(w);
      if (!line) continue;
      if (!wanted.has(line)) wanted.set(line, []);
      wanted.get(line).push(w);
    }
    for (const [line, row] of [...rows]) {
      if (wanted.has(line) && cm.getLineNumber(line) !== null) continue;
      row.lw.clear();
      rows.delete(line);
    }
    for (const [line, list] of wanted) {
      let row = rows.get(line);
      if (!row) {
        const node = el('div', 'iw-row');
        row = { el: node, lw: null };
        rows.set(line, row);
      }
      // Indented to the code it belongs to.
      const text = line.text ?? '';
      const indent = text.length - text.trimStart().length;
      row.el.style.paddingLeft = `${indent * (cm.defaultCharWidth?.() ?? 8)}px`;
      const order = list.map((w) => w.el);
      const same = order.length === row.el.children.length && order.every((n, i) => row.el.children[i] === n);
      if (!same) {
        for (const n of order) row.el.append(n);
        if (row.lw) row.lw.changed();
      }
      if (!row.lw) row.lw = cm.addLineWidget(line, row.el, { coverGutter: false, noHScroll: true });
    }
  }

  function scheduleRelayout() {
    if (pendingRelayout) return;
    pendingRelayout = true;
    Promise.resolve().then(() => {
      if (pendingRelayout) relayout();
    });
  }

  // ---------------------------------------------------------------------------- data

  // Every display that draws: the ones in the code and the ones behind it.
  const allViews = () => (backs.length ? widgets.concat(backs) : widgets);

  function adoptData(report) {
    const byAt = new Map((report?.views ?? []).map((v) => [v.at, v]));
    for (const w of allViews()) {
      const v = byAt.get(w.at);
      if (v && 'data' in v) w.data = v.data ?? null;
    }
    dataWin.from = report?.from ?? 0;
    dataWin.to = (report?.from ?? 0) + (report?.count ?? 0);
    dataWin.fetching = false;
  }

  function topUp(pos) {
    if (dataWin.fetching) return;
    if (!allViews().some((w) => w.data !== undefined && !AUDIO_KINDS.has(w.kind))) return;
    const behind = pos < dataWin.from;
    if (!behind && pos < dataWin.to - WINDOW_PREFETCH) return;
    dataWin.fetching = true;
    const from = behind || pos > dataWin.to ? Math.max(0, Math.floor(pos) - 2) : dataWin.to;
    Promise.resolve(api('GET', `/api/widgets/window?deck=${deck}&from=${from}&count=16`))
      .then((res) => {
        const byAt = new Map((res?.views ?? []).map((v) => [v.at, v.data]));
        const keepFrom = Math.floor(pos) - 8;
        for (const w of allViews()) {
          const add = byAt.get(w.at);
          if (!add) continue;
          if (behind || from !== dataWin.to || !w.data) {
            w.data = add;
            continue;
          }
          if (add.tracks) {
            // Behind the code: each track's events kept on from where they were, by its name.
            const was = new Map((w.data.tracks ?? []).map((t) => [t.label, t]));
            w.data.tracks = add.tracks.map((t) => ({ ...t, events: [...(was.get(t.label)?.events ?? []).filter((e) => e[1] >= keepFrom), ...t.events] }));
            continue;
          }
          if (add.events) w.data.events = [...(w.data.events ?? []).filter((e) => e[1] >= keepFrom), ...add.events];
          if (add.runs) w.data.runs = [...(w.data.runs ?? []).filter((r) => r[1] >= keepFrom), ...add.runs];
          if (add.points) w.data.points = [...(w.data.points ?? []).filter((p) => p[0] >= keepFrom), ...add.points];
        }
        if (behind || from !== dataWin.to) dataWin.from = res.from;
        dataWin.to = res.from + res.count;
      })
      .catch(() => {})
      .finally(() => { dataWin.fetching = false; });
  }

  function wantsFrames() {
    return allViews().some((w) => AUDIO_KINDS.has(w.kind) && w.entry.target) || widgets.some((w) => w.kind === 'plot' && w.data?.live);
  }

  function pollFrames() {
    if (polling) return;
    if (!wantsFrames() || !isPlaying() || doc?.hidden) return;
    polling = true;
    Promise.resolve(api('GET', `/api/widgets/frames?deck=${deck}`))
      .then((res) => {
        if (!res) return;
        over = new Set(res.over ?? []);
        liveNow = res.now ?? {};
        const ms = res.at ?? Date.now();
        for (const [target, f] of Object.entries(res.frames ?? {})) {
          frames.set(target, f);
          if (f.level) {
            const h = levels.get(target) ?? [];
            h.push({ ms, pk: Math.max(f.level.pl, f.level.pr), ...f.level });
            while (h.length && h[0].ms < ms - LEVEL_KEEP_MS) h.shift();
            levels.set(target, h);
          }
        }
        const pos = cyclePos();
        for (const w of widgets) {
          if (w.kind !== 'plot' || !w.data?.live || !(w.at in liveNow)) continue;
          const v = liveNow[w.at];
          if (v === null || v === undefined) continue;
          w.trace = [...(w.trace ?? []).filter((p) => p[0] > pos - 16), [pos, v]];
        }
      })
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          polling = false;
          pollFrames();
        }, FRAME_POLL_MS);
      });
  }

  // ---------------------------------------------------------------------------- behind the code

  // A display written on a line of its own - `punchcard()`, `spectrum()` - is drawn behind the
  // code rather than under its line: on a canvas under the editor's text, filling the pane beside
  // the gutter, standing still while the code scrolls. Several share it in horizontal bands, one
  // each, top to bottom in the order they were written. Each is drawn by the same code as its
  // inline kind, on a canvas of its own the size of its band, and copied onto the background
  // faintly, so the code in front stays as readable as ever. Only while the deck plays - once more
  // when it stops - at the display's own refresh (the frame loop is the browser's).
  const BACKGROUND_ALPHA = 0.22;
  const BACKGROUND_LABEL_ALPHA = 0.55; // a row's name: dim, but there to be read

  function buildBackground(entry) {
    const w = { kind: entry.kind, at: entry.at, entry, input: false, inline: false, background: true, dirty: false };
    const make = BACK_BUILDERS[entry.kind] ?? BUILDERS[entry.kind];
    if (!make) return null;
    w.marker = () => null;
    w.el = make(w);
    w.canvas = w.el.querySelector?.('canvas') ?? null;
    w.render = () => {}; // its size is its band's
    return w.canvas ? w : null;
  }

  function dropBackground() {
    bg?.canvas.remove();
    bg = null;
  }

  function drawBackground(pos, running) {
    if (!backs.length) {
      dropBackground();
      return;
    }
    const wrap = cm.getWrapperElement?.();
    if (!wrap) return;
    const left = cm.getGutterElement?.()?.offsetWidth ?? 0;
    const width = Math.max(0, wrap.clientWidth - left);
    const height = wrap.clientHeight;
    if (!width || !height) return;
    if (!bg) {
      const canvas = el('canvas', 'iw-bg');
      canvas.setAttribute('aria-hidden', 'true');
      wrap.prepend(canvas);
      bg = { canvas, ctx: null, width: 0, height: 0, left: -1, still: false };
    }
    if (bg.width !== width || bg.height !== height || bg.left !== left) {
      const dpr = win?.devicePixelRatio || 1;
      bg.canvas.width = Math.round(width * dpr);
      bg.canvas.height = Math.round(height * dpr);
      bg.canvas.style.width = `${width}px`;
      bg.canvas.style.height = `${height}px`;
      bg.canvas.style.left = `${left}px`;
      bg.ctx = bg.canvas.getContext?.('2d') ?? null;
      bg.ctx?.setTransform?.(dpr, 0, 0, dpr, 0, 0);
      Object.assign(bg, { width, height, left, still: false });
    }
    if (!running && bg.still) return;
    const ctx = bg.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const bands = M.backgroundBands(backs.length, height);
    const codeRight = codeExtents(wrap, left, height);
    backs.forEach((b, i) => {
      const band = bands[i];
      b.bandY = band.y;
      b.codeRight = codeRight;
      if (b.cw !== width || b.ch !== band.height) sizeCanvas(b, b.canvas, width, band.height);
      try { b.draw?.(pos, running); } catch { /* nothing to draw yet */ }
      ctx.globalAlpha = BACKGROUND_ALPHA;
      ctx.drawImage(b.canvas, 0, band.y, width, band.height);
      ctx.globalAlpha = BACKGROUND_LABEL_ALPHA;
      if (b.labels?.length) {
        const c = theme();
        ctx.font = `11px ${c.mono}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'right';
        for (const l of b.labels) {
          ctx.fillStyle = l.color;
          ctx.fillText(l.text, l.x, l.y);
        }
      }
      ctx.globalAlpha = 1;
    });
    bg.still = !running;
  }

  // Where the code's text reaches across the background: `codeRight(y0, y1)` is the furthest right
  // (in the background's pixels) that any line between those heights ends. Measured from the lines
  // on screen at most five times a second - a label behind the code reads it to stay clear of text.
  let extentsAt = 0;
  let extents = [];
  function codeExtents(wrap, left, height) {
    const now = Date.now();
    if (now - extentsAt > 200) {
      extentsAt = now;
      extents = [];
      const box = wrap.getBoundingClientRect();
      const vp = cm.getViewport?.() ?? { from: 0, to: 0 };
      for (let ln = vp.from; ln < vp.to; ln++) {
        const len = (cm.getLine(ln) ?? '').length;
        if (!len) continue;
        const r = cm.charCoords({ line: ln, ch: len }, 'window');
        const top = r.top - box.top;
        const bottom = r.bottom - box.top;
        if (bottom < 0 || top > height) continue;
        extents.push([top, bottom, r.right - box.left - left]);
      }
    }
    return (y0, y1) => extents.reduce((m, [t, b, x]) => (b > y0 && t < y1 ? Math.max(m, x) : m), 0);
  }

  // The two displays of patterns drawn differently behind the code: every track at once, each in
  // its own color. Their data is `{ tracks: [{ label, color, events, notes }] }` (see the host).
  const BACK_BUILDERS = {
    // A row per track, top to bottom in the order written: its events as bars in its color, the
    // values it plays stacked inside the row, and its name at the row's left.
    punchcard(w) {
      return displayBlock(w, (ctx, c, width, height, pos) => {
        const cycles = w.entry.opts?.cycles ?? 4;
        const left = pos - cycles / 2;
        const tracks = w.data?.tracks ?? [];
        for (let k = Math.ceil(left); k < left + cycles; k++) {
          const x = ((k - left) / cycles) * width;
          ctx.strokeStyle = c.border;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, height);
          ctx.stroke();
        }
        w.labels = [];
        if (!tracks.length) return;
        const rowH = height / tracks.length;
        ctx.font = `11px ${c.mono}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'right';
        tracks.forEach((t, i) => {
          const color = colorOfTrack(t, c);
          const events = t.events.filter((e) => e[1] > left && e[0] < left + cycles);
          const { rows: lanes, count } = M.punchcardRows(events);
          const laneH = (rowH - 4) / Math.max(1, count);
          const top = i * rowH + 2;
          ctx.fillStyle = color;
          for (const e of events) {
            const x0 = ((e[0] - left) / cycles) * width;
            const x1 = ((e[1] - left) / cycles) * width;
            const y = top + (rowH - 4) - ((lanes.get(e[2]) ?? 0) + 1) * laneH;
            ctx.globalAlpha = pos >= e[0] && pos < e[1] ? 1 : 0.55;
            ctx.fillRect(x0 + 0.5, y + 1, Math.max(1.5, x1 - x0 - 1), Math.max(1, laneH - 2));
          }
          ctx.globalAlpha = 1;
          // Each row's name at its right edge, where the code's lines run out rather than start -
          // and left out of a frame where a line of code reaches that far, never drawn under text.
          if (rowH >= 14) {
            const y = (w.bandY ?? 0) + top;
            const x = width - 6;
            const room = x - ctx.measureText(t.label).width - 8;
            // Written onto the background by drawBackground, stronger than the faint display.
            if (!w.codeRight || w.codeRight(y, y + 13) < room) w.labels.push({ text: t.label, x, y: y + 1, color });
          }
        });
        playhead(ctx, c, width / 2, height);
      });
    },

    // The pitch wheel, each pitch class lit in the color of the track sounding it loudest.
    chroma(w) {
      return displayBlock(w, (ctx, c, width, height, pos) => {
        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.max(8, Math.min(cx, cy) - 14);
        const lit = new Map(); // pitch class -> { b, color }
        for (const t of w.data?.tracks ?? []) {
          const color = colorOfTrack(t, c);
          for (const e of t.events) {
            if (e[0] > pos || e[1] < pos - 1) continue;
            const pc = M.pitchClassOf(e[2]);
            if (pc === null) continue;
            const b = pos >= e[0] && pos < e[1] ? 1 : Math.max(0, 0.45 - (pos - e[1]) * 0.45);
            if (b > (lit.get(pc)?.b ?? 0)) lit.set(pc, { b, color });
          }
        }
        ctx.font = `11px ${c.mono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let pc = 0; pc < 12; pc++) {
          const a = (pc / 12) * Math.PI * 2 - Math.PI / 2;
          const px = cx + Math.cos(a) * radius;
          const py = cy + Math.sin(a) * radius;
          const on = lit.get(pc);
          if (on) {
            ctx.fillStyle = on.color;
            ctx.globalAlpha = 0.25 + 0.75 * on.b;
            ctx.beginPath();
            ctx.arc(px, py, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          ctx.fillStyle = on && on.b >= 1 ? c.bg : c.dim;
          ctx.fillText(M.pitchName(pc), px, py + 0.5);
        }
      });
    },
  };

  // ---------------------------------------------------------------------------- the frame loop

  function frame() {
    rafId = 0;
    pruneFolds();
    if (!widgets.length && !folds.length && !backs.length) {
      dropBackground();
      return;
    }
    const running = isPlaying();
    const pos = cyclePos();
    if (running) {
      topUp(pos);
      pollFrames();
    }
    for (const w of widgets) {
      if (w.gone) continue;
      if (w.dirty && !w.resizing) {
        w.dirty = false;
        try { w.render?.(); } catch { /* a call half-typed */ }
      }
      w.tick?.(pos, running);
      if (w.draw && (running || w.drawnStill !== true)) {
        w.draw(pos, running);
        w.drawnStill = !running;
      }
    }
    drawBackground(pos, running);
    for (const f of folds) {
      if (f.dirty && !f.resizing) {
        f.dirty = false;
        try { f.render(); } catch { /* a call half-typed */ }
      }
      // The playhead walks a fold's cells once the call is playing - evaluated, and its deck running.
      f.tick?.(pos, running && keyOf(f) != null);
    }
    if (!running) {
      // Stopped: nothing moves, so the frames that were drawing go quiet.
      frames.clear();
    }
    rafId = win?.requestAnimationFrame ? win.requestAnimationFrame(frame) : 0;
  }

  function ensureLoop() {
    if (!rafId && win?.requestAnimationFrame && (widgets.length || folds.length || backs.length || bg)) rafId = win.requestAnimationFrame(frame);
  }

  // Text edits: drop widgets whose call is gone, redraw the ones whose arguments changed by hand,
  // and move a row of displays when the line its call closes on moved.
  const onChanges = () => {
    let removed = false;
    for (const w of widgets) {
      if (!alive(w)) {
        destroy(w);
        removed = true;
      } else {
        w.dirty = true;
      }
    }
    if (removed) widgets = widgets.filter((w) => !w.gone);
    pruneFolds();
    for (const f of folds) f.dirty = true;
    keys = keys.filter((k) => {
      if (k.mark.find()) return true;
      k.mark.clear();
      return false;
    });
    scheduleRelayout();
    ensureLoop();
  };
  cm.on('changes', onChanges);

  // ---------------------------------------------------------------------------- evaluation

  /**
   * Called with the code about to be evaluated, before anything else touches the buffer: a
   * bookmark on every widget call in it, so the answer can be matched to the calls it was about.
   * The bookmark goes with the text typed in front of the call, so it stays at the call's name.
   */
  function beforeEval(code) {
    const found = calls.findWidgetCalls(code);
    return {
      code,
      marks: found.map((c) => ({ call: c, mark: cm.setBookmark(cm.posFromIndex(c.at), { insertLeft: false }) })),
    };
  }

  /**
   * The evaluation answered. `report` is its `widgets` (null when it failed - then every widget
   * stays as it was). Widgets still at the same call are kept, with their new key; the rest are
   * built or taken down. A folded call keeps only its key: its control is the fold's.
   */
  function afterEval(snap, report) {
    if (!snap) return;
    if (!report) {
      for (const { mark } of snap.marks) mark.clear();
      return;
    }
    const entries = [...(report.inputs ?? []), ...(report.views ?? [])];
    const byAt = new Map(entries.map((e) => [e.at, e]));
    const next = [];
    const nextBacks = [];
    const keep = new Set();
    for (const k of keys) k.mark.clear();
    keys = [];
    for (const { call, mark } of snap.marks) {
      const entry = byAt.get(call.at);
      const pos = mark.find();
      if (!entry || !pos || entry.kind !== call.kind) {
        mark.clear();
        continue;
      }
      if (FOLDED.has(entry.kind)) {
        keys.push({ kind: entry.kind, at: entry.at, entry, mark });
        continue;
      }
      if (entry.background) {
        mark.clear();
        const b = buildBackground(entry);
        if (b) nextBacks.push(b);
        continue;
      }
      const idx = cm.indexFromPos(pos);
      const old = widgets.find((w) => !keep.has(w) && w.kind === entry.kind && w.mark.find() && cm.indexFromPos(w.mark.find()) === idx);
      if (old) {
        keep.add(old);
        old.mark.clear();
        old.mark = mark;
        old.at = entry.at;
        old.entry = entry;
        old.value = undefined;
        old.dirty = true;
        old.drawnStill = false;
        next.push(old);
      } else {
        const w = build(entry, mark);
        if (w) next.push(w);
        else mark.clear();
      }
    }
    for (const w of widgets) if (!keep.has(w)) destroy(w);
    widgets = next;
    backs = nextBacks;
    if (bg) bg.still = false;
    adoptData(report);
    relayout();
    ensureLoop();
  }

  /** Takes every widget down - a buffer swapped out wholesale. */
  function clear() {
    for (const w of widgets) destroy(w);
    widgets = [];
    backs = [];
    dropBackground();
    for (const k of keys) k.mark.clear();
    keys = [];
    for (const row of rows.values()) row.lw?.clear();
    rows.clear();
    frames.clear();
    levels.clear();
  }

  return {
    beforeEval,
    afterEval,
    makeFold,
    clear,
    get widgets() { return widgets; },
    get folds() { return folds; },
    /** For tests: run one frame now. */
    _frame: frame,
  };
}
