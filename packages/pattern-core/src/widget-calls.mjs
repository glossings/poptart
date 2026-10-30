// Finding the editor's inline widgets in a buffer.
//
// An inline widget is a call written in the code that the editor also draws: `slider(0.5)` shows
// a slider before its name, `.scope()` an oscilloscope under its line. Two sides have to agree on
// where each one is - the evaluation, which keys a widget's live value by the call's position in
// the document, and the editor, which draws the control at that position and sends the value back
// under that key. Both find the calls with the scan below, run over the same text, so they agree
// by construction rather than by keeping two parsers in step.
//
// Kept dependency-free (like labels.mjs and locations.mjs) because the browser imports it as a
// plain module, and so locations.mjs can call it from inside its own transpile.

/** Calls that are drawn as a control and return a signal of what the control is set to. */
export const INPUT_WIDGETS = Object.freeze(['slider', 'knob', 'toggle', 'button', 'xy', 'steps', 'sliders', 'matrix']);

/** Calls that draw what a pattern is doing - its sound, or its events and values. */
export const DISPLAY_WIDGETS = Object.freeze(['scope', 'spectrum', 'waveform', 'imager', 'meter', 'punchcard', 'plot', 'chroma']);

/** The displays fed by a track's audio, which the engine has to tap. The rest are worked out from the pattern. */
export const AUDIO_DISPLAYS = Object.freeze(['scope', 'spectrum', 'waveform', 'imager', 'meter']);

/** Input widgets whose first argument is the control's DATA, written out as plain text rather than mini notation. */
export const RAW_TEXT_WIDGETS = Object.freeze(['steps', 'sliders', 'matrix']);

/**
 * The input widgets the editor draws IN PLACE of their call: the text folds away under the control
 * (it stays in the buffer, and is still what is evaluated), and right-clicking the control opens it.
 */
export const FOLDED_WIDGETS = Object.freeze(['steps', 'sliders', 'matrix']);

/**
 * Every input widget's size, in CSS pixels: what it is drawn at unless its call says `{ size }`,
 * and the range a drag on its corner can take it over. Each default is the matching control
 * elsewhere in the app - the desk's and the device windows' knob, a device window's switch, the
 * piano roll's box slider, row height and value lane, the stereo image's square - so one written
 * into the code looks like the rest of the instrument. What `size` measures, per kind: a knob's
 * diameter, a slider's or a switch's width, a pad's side, a step's cell, a bar's height.
 */
export const INPUT_SIZES = Object.freeze({
  slider: Object.freeze({ size: 92, min: 40, max: 480 }),
  knob: Object.freeze({ size: 28, min: 16, max: 160 }),
  toggle: Object.freeze({ size: 64, min: 28, max: 200 }),
  button: Object.freeze({ size: 64, min: 28, max: 200 }),
  xy: Object.freeze({ size: 96, min: 48, max: 320 }),
  steps: Object.freeze({ size: 16, min: 8, max: 48 }),
  sliders: Object.freeze({ size: 64, min: 24, max: 240 }),
  matrix: Object.freeze({ size: 16, min: 8, max: 48 }),
});

/**
 * How tall a display is drawn (`{ height }`), or how big a square one is (`{ size }`, the stereo
 * image and the pitch wheel), unless its call says otherwise: the default and the range a drag
 * on its corner, or the call, can take it over.
 */
export const DISPLAY_SIZES = Object.freeze({
  scope: Object.freeze({ key: 'height', size: 48, min: 24, max: 240 }),
  spectrum: Object.freeze({ key: 'height', size: 64, min: 32, max: 240 }),
  waveform: Object.freeze({ key: 'height', size: 48, min: 24, max: 240 }),
  plot: Object.freeze({ key: 'height', size: 48, min: 24, max: 240 }),
  punchcard: Object.freeze({ key: 'height', size: 64, min: 24, max: 240 }),
  imager: Object.freeze({ key: 'size', size: 96, min: 48, max: 240 }),
  chroma: Object.freeze({ key: 'size', size: 96, min: 48, max: 240 }),
});

const side = (size, min, max) => Object.freeze({ size, min, max });
const displayHeight = (kind) => side(DISPLAY_SIZES[kind].size, DISPLAY_SIZES[kind].min, DISPLAY_SIZES[kind].max);
const DISPLAY_WIDTH = side(320, 96, 1200);

/**
 * The kinds whose width and height are set apart, as `{ width, height }` in the call: each side's
 * default and the range a corner drag can take it over, and which side(s) a lone `{ size }` - or a
 * display's lone `{ height }` - still sets. A default of null is the control's own height as the
 * app draws it. What the sides measure: a slider's, switch's, meter's or display's whole box, a
 * step's or matrix cell's, or one bar of sliders(). The square kinds (knob, xy, imager, chroma)
 * are not here: one `{ size }` is their side.
 */
export const WIDGET_BOXES = Object.freeze({
  slider: Object.freeze({ width: INPUT_SIZES.slider, height: side(null, 14, 96), lone: 'width' }),
  toggle: Object.freeze({ width: INPUT_SIZES.toggle, height: side(null, 14, 96), lone: 'width' }),
  button: Object.freeze({ width: INPUT_SIZES.button, height: side(null, 14, 96), lone: 'width' }),
  steps: Object.freeze({ width: INPUT_SIZES.steps, height: INPUT_SIZES.steps, lone: 'both' }),
  matrix: Object.freeze({ width: INPUT_SIZES.matrix, height: INPUT_SIZES.matrix, lone: 'both' }),
  sliders: Object.freeze({ width: side(16, 6, 48), height: INPUT_SIZES.sliders, lone: 'height' }),
  meter: Object.freeze({ width: side(48, 6, 480), height: side(12, 6, 240), lone: null }),
  scope: Object.freeze({ width: DISPLAY_WIDTH, height: displayHeight('scope'), lone: 'height' }),
  spectrum: Object.freeze({ width: DISPLAY_WIDTH, height: displayHeight('spectrum'), lone: 'height' }),
  waveform: Object.freeze({ width: DISPLAY_WIDTH, height: displayHeight('waveform'), lone: 'height' }),
  plot: Object.freeze({ width: DISPLAY_WIDTH, height: displayHeight('plot'), lone: 'height' }),
  punchcard: Object.freeze({ width: DISPLAY_WIDTH, height: displayHeight('punchcard'), lone: 'height' }),
});

const clampTo = (r, v) => Math.round(Math.min(r.max, Math.max(r.min, v)));

/**
 * The `{ width, height }` a box kind is drawn at, from `read(key)` - the number its call gives a
 * key, or null. An explicit width or height wins; a lone `{ size }` sets the side(s) the kind says;
 * the rest take the default (null for a height the app's own CSS draws). Every number is clamped
 * to its side's range. Null for a kind that is not a box.
 */
export function widgetBox(kind, read) {
  const spec = WIDGET_BOXES[kind];
  if (!spec) return null;
  const num = (k) => {
    const v = read(k);
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const size = INPUT_SIZES[kind] ? num('size') : null; // a display's lone `{ height }` is its height already
  const pick = (dim) => {
    const asked = num(dim) ?? (spec.lone === dim || spec.lone === 'both' ? size : null);
    return asked === null ? spec[dim].size : clampTo(spec[dim], asked);
  };
  return { width: pick('width'), height: pick('height') };
}

/** The keys a corner drag writes for a kind - `['width', 'height']` or `['size']` - and the ones it clears. */
export function sizeKeys(kind) {
  if (WIDGET_BOXES[kind]) return { write: ['width', 'height'], drop: INPUT_SIZES[kind] ? ['size'] : [] };
  if (DISPLAY_SIZES[kind]) return { write: [DISPLAY_SIZES[kind].key], drop: [] };
  return { write: ['size'], drop: [] };
}

/** A widget's size, as its call's `{ size }` asks (clamped to its range), else its default. */
export function widgetSize(kind, asked) {
  const s = INPUT_SIZES[kind];
  if (!s) return null;
  const v = Number(asked);
  if (asked === null || asked === undefined || !Number.isFinite(v)) return s.size;
  return Math.round(Math.min(s.max, Math.max(s.min, v)));
}

const INPUT_SET = new Set(INPUT_WIDGETS);
const DISPLAY_SET = new Set(DISPLAY_WIDGETS);
const NAME_RE = new RegExp(`(${[...INPUT_WIDGETS, ...DISPLAY_WIDGETS].join('|')})\\s*\\(`, 'g');

/**
 * The code with every string's and comment's contents blanked to spaces (newlines kept, so every
 * offset still lines up), plus where each string literal is. A call written inside a string or a
 * comment is not a call.
 */
export function maskCode(code) {
  const src = String(code);
  const mask = src.split('');
  const lits = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (mask[k] !== '\n') mask[k] = ' ';
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const from = i;
      while (i < n && src[i] !== '\n') i++;
      blank(from, i);
      continue;
    }
    if (c === '/' && d === '*') {
      const from = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      blank(from, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const from = i;
      i++;
      while (i < n && src[i] !== c && (c === '`' || src[i] !== '\n')) {
        if (src[i] === '\\') i++;
        i++;
      }
      if (src[i] === c) {
        lits.push({ fullStart: from, contentStart: from + 1, fullEnd: i + 1, quote: c });
        blank(from + 1, i);
        i++;
      }
      continue;
    }
    i++;
  }
  return { masked: mask.join(''), lits };
}

/**
 * Every widget call in `code`, in document order:
 *
 *   { kind, name, at, open, method, input, lit }
 *
 * `at` is where the name starts and is the call's identity; `open` is the index of its `(`.
 * `method` says it was written after a dot (`.scope()`), `input` that it is one of the controls.
 * `lit` is where the content of a string literal written as the first argument starts, or -1.
 *
 * Input widgets are builders, so a dotted `x.slider()` is somebody else's method and is skipped.
 * Displays come in both spellings: on a pattern they show that pattern, bare they show the master.
 * A name declared as a function (`function plot(...)`) or preceded by an identifier character
 * (`myslider(`) is not one of these.
 */
export function findWidgetCalls(code, masking = null) {
  const src = String(code);
  const { masked, lits } = masking ?? maskCode(src);
  const litAt = new Map(lits.map((l) => [l.fullStart, l]));
  const out = [];
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(masked))) {
    const name = m[1];
    const at = m.index;
    const before = at > 0 ? masked[at - 1] : '';
    if (/[\w$]/.test(before)) continue;
    let j = at;
    while (j > 0 && /\s/.test(masked[j - 1])) j--;
    const method = j > 0 && masked[j - 1] === '.';
    if (!method && /\bfunction\s*\*?\s*$/.test(masked.slice(Math.max(0, j - 12), j))) continue;
    const input = INPUT_SET.has(name);
    if (input && method) continue;
    if (!input && !DISPLAY_SET.has(name)) continue;
    const open = at + m[0].length - 1;
    let k = open + 1;
    while (k < src.length && /\s/.test(src[k])) k++;
    const lit = litAt.get(k);
    const call = { kind: name, name, at, open, method, input, lit: lit ? lit.contentStart : -1 };
    // A matrix's rows are each their own literal, inside the object: where each one's text starts,
    // by row name, so a row's cells can carry the spans the highlighter lights, as steps() cells do.
    if (name === 'matrix' && src[k] === '{') {
      const rows = {};
      for (const r of matrixRows(src, k)) if (r.form === 'text' && !(r.key in rows)) rows[r.key] = r.from;
      if (Object.keys(rows).length) call.rows = rows;
    }
    out.push(call);
  }
  return out;
}

/**
 * The rewrites that tag each widget call with where it is, for the evaluation's transpile: `[from,
 * to, text]` triples over `code`, with document offsets made absolute by `base`.
 *
 *   slider(0.5, 0, 1)   ->  _input([AT, LIT], 'slider', 0.5, 0, 1)
 *   matrix({ bd: "x" })  ->  _input([AT, -1, { bd: ROW }], 'matrix', { bd: "x" })
 *   x.scope()           ->  x._display(AT, 'scope', )
 *   scope()             ->  _display(AT, 'scope', )
 *
 * An empty argument list leaves a trailing comma, which a call accepts.
 */
export function widgetCallEdits(code, base = 0, masking = null) {
  const edits = [];
  for (const c of findWidgetCalls(code, masking)) {
    const at = base + c.at;
    const lit = c.lit >= 0 ? base + c.lit : -1;
    const rows = c.rows ? `, ${JSON.stringify(Object.fromEntries(Object.entries(c.rows).map(([k, v]) => [k, base + v])))}` : '';
    const text = c.input
      ? `_input([${at}, ${lit}${rows}], '${c.kind}', `
      : `_display(${at}, '${c.kind}', `;
    edits.push([c.at, c.open + 1, text]);
  }
  return edits;
}

/**
 * The argument list of the call whose `(` is at `open`: where it closes and the span of each
 * top-level argument, trimmed - `{ close, args: [{ from, to, text }] }`, or null when the call is
 * not closed. Brackets, strings and comments nest; an empty list has no arguments. `masked` is
 * maskCode's text for `code`, for a caller that already has it.
 */
export function callArgs(code, open, masked = maskCode(String(code)).masked) {
  const src = String(code);
  if (src[open] !== '(') return null;
  const args = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        pushArg(src, args, from, i);
        return { close: i, args };
      }
    } else if (ch === ',' && depth === 1) {
      pushArg(src, args, from, i);
      from = i + 1;
    }
  }
  return null;
}

function pushArg(src, args, from, to) {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(src[a])) a++;
  while (b > a && /\s/.test(src[b - 1])) b--;
  if (a === b && args.length === 0 && /^\s*$/.test(src.slice(from, to))) return; // f() has no arguments
  args.push({ from: a, to: b, text: src.slice(a, b) });
}

/**
 * The steps a row of cells is written as: whitespace-separated tokens when there is any
 * whitespace, otherwise one character per step - `"x . x ."` and `"x.x."` are the same row. Each
 * cell is `{ token, from, to, on }` with offsets into the text; `.`, `~`, `-` and `_` are rests.
 */
export function parseCells(text) {
  const src = String(text ?? '');
  const cells = [];
  if (/\s/.test(src.trim())) {
    const re = /\S+/g;
    let m;
    while ((m = re.exec(src))) cells.push(cellOf(m[0], m.index));
  } else {
    const lead = src.length - src.trimStart().length;
    const body = src.trim();
    for (let i = 0; i < body.length; i++) cells.push(cellOf(body[i], lead + i));
  }
  return cells;
}

const REST_TOKENS = new Set(['.', '~', '-', '_']);

function cellOf(token, from) {
  return { token, from, to: from + token.length, on: !REST_TOKENS.has(token) };
}

/**
 * The row text with cell `index` switched on or off, written so nothing else in the row moves:
 * a one-character row stays one character per step, and a token row keeps its spacing - an
 * off cell becomes `.` padded to the width the hit had, a cell switched on takes `hit` (the
 * nearest hit's token to its left, else "x") when it fits the width the rest had.
 */
export function toggleCell(text, index) {
  const src = String(text ?? '');
  const cells = parseCells(src);
  const cell = cells[index];
  if (!cell) return src;
  const compact = !/\s/.test(src.trim());
  let token;
  if (cell.on) token = '.';
  else {
    const left = cells.slice(0, index).reverse().find((c) => c.on) ?? cells.find((c) => c.on);
    token = left ? left.token : 'x';
    if (compact && token.length > 1) token = 'x';
  }
  if (!compact) {
    // Keep the column: pad the shorter of the two with spaces after it, when the gap allows.
    const width = cell.to - cell.from;
    if (token.length < width) token = token.padEnd(width, ' ');
  }
  return src.slice(0, cell.from) + token + src.slice(cell.to);
}

/**
 * The text of a row of values with value `index` set to `value` - for sliders(), whose cells are
 * numbers. Written with `decimals` places, and the rest of the row left exactly as it was.
 */
export function setCellValue(text, index, value, decimals = 2) {
  const src = String(text ?? '');
  const cells = parseCells(src);
  const cell = cells[index];
  if (!cell) return src;
  return src.slice(0, cell.from) + formatNumber(value, decimals) + src.slice(cell.to);
}

/**
 * The row thrown again at random: as many hits as it has now, in new places, each spelled with
 * one of the row's own hit tokens (x when it has none). A row with no hits, or nothing but, gets
 * half its cells. Written the way the row was - one character per step, or spaced - and any
 * space around it kept, so the grid redraws in place. `random` is the generator, for tests.
 */
export function randomRow(text, random = Math.random) {
  const src = String(text ?? '');
  const cells = parseCells(src);
  const n = cells.length;
  if (!n) return src;
  const compact = !/\s/.test(src.trim());
  const hits = cells.filter((c) => c.on).map((c) => c.token);
  const pool = hits.length ? [...new Set(hits)] : ['x'];
  let k = hits.length;
  if (k === 0 || k === n) k = Math.ceil(n / 2);
  const pick = (count) => Math.min(count - 1, Math.floor(random() * count));
  const order = cells.map((_, i) => i);
  for (let i = 0; i < k; i++) { // a partial shuffle: the first k places are the hits
    const j = i + pick(n - i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const on = new Set(order.slice(0, k));
  const row = cells.map((_, i) => (on.has(i) ? pool[pick(pool.length)] : '.'));
  const lead = src.length - src.trimStart().length;
  const trail = src.length - src.trimEnd().length;
  return src.slice(0, lead) + row.join(compact ? '' : ' ') + src.slice(src.length - trail);
}

/**
 * The row of values thrown again at random: as many as now, each anywhere from `min` to `max`,
 * written with `decimals` places. `random` is the generator, for tests.
 */
export function randomValues(text, min = 0, max = 1, decimals = 2, random = Math.random) {
  const src = String(text ?? '');
  const cells = parseCells(src);
  if (!cells.length) return src;
  const lo = Number.isFinite(Number(min)) ? Number(min) : 0;
  const hi = Number.isFinite(Number(max)) ? Number(max) : 1;
  const row = cells.map(() => formatNumber(lo + (hi - lo) * random(), decimals));
  const lead = src.length - src.trimStart().length;
  const trail = src.length - src.trimEnd().length;
  return src.slice(0, lead) + row.join(' ') + src.slice(src.length - trail);
}

/** A number as a widget writes it into the code: fixed decimals, no trailing zeros past one. */
export function formatNumber(value, decimals = 2) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(Math.max(0, decimals));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** How many cells steps(), sliders() or a matrix row has when the call gives none it can read. */
export const DEFAULT_CELL_COUNT = 8;

/** A whole number of cells from a count: `8` -> 8; anything but a whole number from 1 up -> null. */
export function cellCount(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
}

/** A row of `n` rests: what `steps(8)` and a matrix row of `8` stand for. */
export function restRow(n) {
  return Array.from({ length: n }, () => '.').join(' ');
}

/** A row of `n` values, every one halfway from `min` to `max`: what `sliders(8)` stands for. */
export function middleRow(n, min = 0, max = 1) {
  const lo = Number.isFinite(Number(min)) ? Number(min) : 0;
  const hi = Number.isFinite(Number(max)) ? Number(max) : 1;
  return Array.from({ length: n }, () => formatNumber((lo + hi) / 2, 3)).join(' ');
}

// A string literal that is the whole of `text`, as `{ from, to }` of its content, or null. A
// template with a `${}` in it is code, not a row.
function wholeLiteral(text) {
  const t = String(text ?? '');
  const lit = maskCode(t).lits[0];
  if (!lit || lit.fullStart !== 0 || lit.fullEnd !== t.length) return null;
  const content = t.slice(lit.contentStart, lit.fullEnd - 1);
  if (lit.quote === '`' && content.includes('${')) return null;
  return { from: lit.contentStart, to: lit.fullEnd - 1, text: content };
}

/**
 * What the code written as a row of cells says, for the editor to draw: the cells argument of
 * steps() or sliders(), or a matrix row's value. `text` is the argument's source, or null when
 * there is none.
 *
 *   { form: 'text', text, from, to }   a string literal: its content, and where that is in `text`
 *   { form: 'count', count, valid }    a number: that many cells (`valid` false past a whole number from 1)
 *   { form: 'none' }                   nothing written
 *   { form: 'code' }                   anything else - an expression only an evaluation can read
 */
export function rowSource(text) {
  if (text === null || text === undefined || !String(text).trim()) return { form: 'none' };
  const t = String(text).trim();
  const lit = wholeLiteral(t);
  if (lit) return { form: 'text', ...lit };
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t)) {
    const count = cellCount(Number(t));
    return { form: 'count', count: count ?? DEFAULT_CELL_COUNT, valid: count !== null };
  }
  return { form: 'code' };
}

/**
 * The rows of a matrix() written as an object literal, one per entry:
 *
 *   { key, keyFrom, keyTo, form, from, to, text, count? }
 *
 * `form` is rowSource's: 'text' for `bd: "x . . ."`, where from/to span the string's CONTENT and
 * `text` is it; 'count' for `bd: 8`, where from/to span the number and `text` is that many rests;
 * 'code' for any other value, which only an evaluation can read (`text` is empty). Keys may be
 * plain words, numbers or quoted. `open` is the index of the object's `{`.
 */
export function matrixRows(code, open) {
  const src = String(code);
  if (src[open] !== '{') return [];
  const { masked, lits } = maskCode(src);
  const spans = [];
  let depth = 0;
  let from = open + 1;
  let close = -1;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth === 0) {
        spans.push([from, i]);
        close = i;
        break;
      }
    } else if (ch === ',' && depth === 1) {
      spans.push([from, i]);
      from = i + 1;
    }
  }
  if (close < 0) return [];
  const rows = [];
  for (let [a, b] of spans) {
    while (a < b && /\s/.test(src[a])) a++;
    while (b > a && /\s/.test(src[b - 1])) b--;
    if (a === b) continue;
    const colon = masked.indexOf(':', a);
    if (colon < 0 || colon >= b) continue;
    let ke = colon;
    while (ke > a && /\s/.test(src[ke - 1])) ke--;
    let key;
    let keyFrom;
    const quoted = lits.find((l) => l.fullStart === a && l.fullEnd === ke);
    if (quoted) {
      key = src.slice(quoted.contentStart, quoted.fullEnd - 1);
      keyFrom = quoted.contentStart;
    } else {
      key = src.slice(a, ke);
      keyFrom = a;
      if (!/^[\w$#]+$/.test(key)) continue;
    }
    if (!key) continue;
    let vs = colon + 1;
    while (vs < b && /\s/.test(src[vs])) vs++;
    const value = rowSource(src.slice(vs, b));
    const row = { key, keyFrom, keyTo: keyFrom + key.length, form: value.form, from: vs, to: b, text: '' };
    if (value.form === 'text') Object.assign(row, { from: vs + value.from, to: vs + value.to, text: value.text });
    else if (value.form === 'count') Object.assign(row, { text: restRow(value.count), count: value.count, valid: value.valid });
    else row.form = 'code';
    rows.push(row);
  }
  return rows;
}

/**
 * Whether the editor can draw a steps(), sliders() or matrix() call in place of its text: every
 * row it would draw is written as text or a count, or - for steps() and sliders() - not written at
 * all (drawn as the default count). A row written as an expression stays text - folding it would
 * hide code the control can't show - and so does a matrix with no rows: it has nothing to draw.
 */
export function foldable(kind, args) {
  const pos = positionalArgs(kind, args);
  if (kind === 'matrix') {
    const a = pos[0];
    if (!a || a.text[0] !== '{') return false;
    const rows = matrixRows(a.text, 0);
    return rows.length > 0 && rows.every((r) => r.form !== 'code');
  }
  return rowSource(pos[0]?.text).form !== 'code';
}

/**
 * Which of a call's arguments (callArgs's `args`) is its options object, or -1. A display takes
 * one as its only argument; an input takes one after its values - `knob(0.8, { size: 48 })` - and
 * a matrix after its rows, which are an object too.
 */
export function optionsIndex(kind, args) {
  const isObj = (a) => !!a && a.text[0] === '{';
  if (kind === 'matrix') return isObj(args[1]) ? 1 : -1;
  for (let i = args.length - 1; i >= 0; i--) if (isObj(args[i])) return i;
  return -1;
}

/** The arguments that are not the options object, in order: the ones a position names. */
export function positionalArgs(kind, args) {
  const o = optionsIndex(kind, args);
  return o < 0 ? args : args.filter((_, i) => i !== o);
}

/** The number an options object's text gives `key` (`{ size: 48 }` -> 48), or null. */
export function optionNumber(text, key) {
  const m = new RegExp(`(?:^|[{,\\s])${key}\\s*:\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+))`).exec(maskCode(String(text ?? '')).masked);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * The one edit that sets option `key` to `value` in a call - `{ from, to, text }` over the same
 * code `parsed` (callArgs's answer) was measured on. Everything else in the call stays as written:
 * a number already there is replaced in place, a key is added to an options object that lacks it,
 * and a call with no options object gets one after its last argument.
 */
export function optionEdit(kind, parsed, key, value) {
  const text = String(value);
  const o = optionsIndex(kind, parsed.args);
  if (o >= 0) {
    const arg = parsed.args[o];
    const { masked } = maskCode(arg.text);
    const m = new RegExp(`((?:^|[{,\\s])${key}\\s*:\\s*)([-+]?(?:\\d+\\.?\\d*|\\.\\d+))`).exec(masked);
    if (m) {
      const from = arg.from + m.index + m[1].length;
      return { from, to: from + m[2].length, text };
    }
    // The key is new: before the closing brace, after whatever the object holds.
    const close = arg.text.lastIndexOf('}');
    const inner = arg.text.slice(1, close);
    if (!inner.trim()) return { from: arg.from, to: arg.from + arg.text.length, text: `{ ${key}: ${text} }` };
    let end = close;
    while (end > 1 && /\s/.test(arg.text[end - 1])) end--;
    const comma = arg.text[end - 1] === ',' ? ' ' : ', ';
    const at = arg.from + end;
    return { from: at, to: at, text: `${comma}${key}: ${text}` };
  }
  const last = parsed.args[parsed.args.length - 1];
  if (!last) {
    // Nothing between the parens: the options object is the call's first argument.
    return { from: parsed.close, to: parsed.close, text: `{ ${key}: ${text} }` };
  }
  return { from: last.to, to: last.to, text: `, { ${key}: ${text} }` };
}

/**
 * The one edit that takes option `key` (a number) out of a call's options object - `{ from, to,
 * text }` like optionEdit's - with the comma that went with it, or null when it is not there.
 */
export function optionDrop(kind, parsed, key) {
  const o = optionsIndex(kind, parsed.args);
  if (o < 0) return null;
  const arg = parsed.args[o];
  const { masked } = maskCode(arg.text);
  const m = new RegExp(`(^|[{,\\s])(${key}\\s*:\\s*[-+]?(?:\\d+\\.?\\d*|\\.\\d+))`).exec(masked);
  if (!m) return null;
  let from = m.index + m[1].length;
  let to = from + m[2].length;
  const after = /^\s*,\s*/.exec(masked.slice(to));
  if (after) to += after[0].length;
  else {
    const before = /,\s*$/.exec(masked.slice(0, from));
    if (before) from -= before[0].length;
  }
  return { from: arg.from + from, to: arg.from + to, text: '' };
}


// ---------------------------------------------------------------------------- .record()

/**
 * Every `.record(...)` written on a pattern in `code`, in document order: `{ at, open, close }`,
 * `at` where the name starts and `open`/`close` the call's parentheses. Only the dotted spelling
 * counts, and nothing inside a string or a comment. An unclosed call has `close` -1.
 */
export function findRecordCalls(code, masking = null) {
  const src = String(code);
  const { masked } = masking ?? maskCode(src);
  const out = [];
  const re = /record\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const at = m.index;
    if (at > 0 && /[\w$]/.test(masked[at - 1])) continue;
    let j = at;
    while (j > 0 && /\s/.test(masked[j - 1])) j--;
    if (j === 0 || masked[j - 1] !== '.') continue;
    const open = at + m[0].length - 1;
    out.push({ at, open, close: callArgs(src, open, masked)?.close ?? -1 });
  }
  return out;
}

/**
 * The transpile's tag on each `.record(` call, so a take recorded by a control can find the call
 * that made it: `x.record({ cycles: 2 })` -> `x._record(AT, { cycles: 2 })`. `[from, to, text]`
 * triples like widgetCallEdits's.
 */
export function recordCallEdits(code, base = 0, masking = null) {
  return findRecordCalls(code, masking).map((c) => [c.at, c.open + 1, `_record(${base + c.at}, `]);
}

// The `take: "..."` entry of a `.record()` call's options object, as offsets into `code`.
function takeEntry(code, open) {
  const parsed = callArgs(code, open);
  if (!parsed) return null;
  const arg = parsed.args[0] ?? null;
  if (!arg || arg.text[0] !== '{') return { parsed, arg, lit: null };
  const { masked } = maskCode(arg.text);
  const m = /(?:^|[{,\s])take\s*:\s*/.exec(masked);
  if (!m) return { parsed, arg, lit: null };
  const vs = m.index + m[0].length;
  const q = arg.text[vs];
  if (q !== '"' && q !== "'" && q !== '`') return { parsed, arg, lit: null, code: true };
  const end = arg.text.indexOf(q, vs + 1);
  if (end < 0) return { parsed, arg, lit: null };
  return { parsed, arg, lit: { from: arg.from + vs + 1, to: arg.from + end, text: arg.text.slice(vs + 1, end) } };
}

/** The take a `.record(` call whose `(` is at `open` names - its `take: "..."` - or null. */
export function recordTakeName(code, open) {
  return takeEntry(String(code), open)?.lit?.text ?? null;
}

/**
 * The one edit that makes the `.record(` call whose `(` is at `open` name the take `name`:
 * `{ from, to, text }` over `code`, or null when the call is not closed. A `take` already written is
 * renamed in place; otherwise the entry is added to the options object (made when there is none,
 * and from a bare length - `.record(2)` - when that is what is written).
 */
export function recordTakeEdit(code, open, name) {
  const src = String(code);
  const e = takeEntry(src, open);
  if (!e) return null;
  const lit = JSON.stringify(String(name));
  if (e.lit) return { from: e.lit.from, to: e.lit.to, text: String(name) };
  const { parsed, arg } = e;
  if (!arg) return { from: open + 1, to: parsed.close, text: `{ take: ${lit} }` };
  if (arg.text[0] === '{') {
    const close = arg.text.lastIndexOf('}');
    const inner = arg.text.slice(1, close);
    if (!inner.trim()) return { from: arg.from, to: arg.to, text: `{ take: ${lit} }` };
    let end = close;
    while (end > 1 && /\s/.test(arg.text[end - 1])) end--;
    const comma = arg.text[end - 1] === ',' ? ' ' : ', ';
    return { from: arg.from + end, to: arg.from + end, text: `${comma}take: ${lit}` };
  }
  return { from: arg.from, to: arg.to, text: `{ cycles: ${arg.text}, take: ${lit} }` };
}

// ---------------------------------------------------------------------------- .color()

/**
 * Every `.color(...)` written on a pattern in `code`, in document order:
 *
 *   { at, open, close, arg, lit }
 *
 * `at` is where the name starts, `open` and `close` the call's parentheses. `arg` is the first
 * argument (`{ from, to, text }`), or null for a bare `.color()`; `lit` is that argument's content
 * span (`{ from, to, text }`) when it is a plain string literal, else null. Only the dotted
 * spelling counts - a `color(` of its own, or `.colors(`, is somebody else's - and nothing inside a
 * string or a comment. An unclosed call is left out.
 */
export function findColorCalls(code, masking = null) {
  const src = String(code);
  const { masked } = masking ?? maskCode(src);
  const out = [];
  const re = /color\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const at = m.index;
    if (at > 0 && /[\w$]/.test(masked[at - 1])) continue;
    let j = at;
    while (j > 0 && /\s/.test(masked[j - 1])) j--;
    if (j === 0 || masked[j - 1] !== '.') continue;
    const open = at + m[0].length - 1;
    const parsed = callArgs(src, open, masked);
    if (!parsed) continue;
    const arg = parsed.args[0] ?? null;
    let lit = null;
    if (arg) {
      const q = arg.text[0];
      const plain = arg.text.length >= 2 && (q === '"' || q === "'" || q === '`') && arg.text[arg.text.length - 1] === q
        && !arg.text.slice(1, -1).includes(q) && !(q === '`' && arg.text.includes('${'));
      if (plain) lit = { from: arg.from + 1, to: arg.to - 1, text: arg.text.slice(1, -1) };
    }
    out.push({ at, open, close: parsed.close, arg, lit });
  }
  return out;
}

/**
 * The `.color(...)` call `idx` is in - on its name or anywhere up to its closing parenthesis - as
 * findColorCalls gives it, with `onName` saying the index is on the name itself. Null elsewhere.
 */
export function findColorCallAt(code, idx) {
  for (const c of findColorCalls(code)) {
    if (idx >= c.at && idx <= c.close) return { ...c, onName: idx >= c.at && idx <= c.at + 'color'.length };
  }
  return null;
}

/**
 * The one edit that makes `call` say `hex`: `{ from, to, text }` over the code it was found in.
 * A string literal keeps its quotes and only its content changes; a bare call gets the color as a
 * double-quoted string; any other first argument is replaced by one. Whatever else the call holds -
 * further arguments, the spacing and comments around them - is left as written.
 */
export function colorCallEdit(call, hex) {
  if (call.lit) return { from: call.lit.from, to: call.lit.to, text: hex };
  if (call.arg) return { from: call.arg.from, to: call.arg.to, text: JSON.stringify(hex) };
  return { from: call.open + 1, to: call.close, text: JSON.stringify(hex) };
}
