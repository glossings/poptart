// The editor's inline widgets, as the language sees them.
//
// An INPUT widget is a call that is drawn as a control: `slider(0.5, 0, 1)` shows a slider in the
// code, and moving it does two things - the editor rewrites the call's first argument, so the
// buffer keeps saying what you hear, and the host is handed the new value under the call's key, so
// the signal the call returned follows the hand without an evaluation. The buffer stays the truth:
// every evaluation seeds the value from what the code says.
//
// A DISPLAY widget is a method that draws what a pattern is doing under its line - `.scope()` the
// track's sound, `.punchcard()` its events - and is the identity on the pattern it is called on.
// What it shows is the host's to supply: the sound from an engine tap, the events from the pattern.
//
// The key is the call's document position, which the evaluation's transpile writes into the call
// (see widget-calls.mjs and locations.mjs): `slider(0.5)` is evaluated as `_input([AT, LIT],
// 'slider', 0.5)`. Called without one - in prebake, or in a test - a widget is simply its value.
//
// Like macros.mjs this keeps its own store, apart from signal.mjs: the host writes it (POST
// /api/widgets/set) and every widget signal reads it when it is sampled.

import { Sig, channelAt, soundingEnd, timeShift, warnPattern } from './signal.mjs';
import { songSteps } from './arrange.mjs';
import {
  INPUT_WIDGETS, DISPLAY_WIDGETS, AUDIO_DISPLAYS, INPUT_SIZES, DISPLAY_SIZES, WIDGET_BOXES,
  parseCells, cellCount, restRow, middleRow, DEFAULT_CELL_COUNT,
} from './widget-calls.mjs';

export { INPUT_WIDGETS, DISPLAY_WIDGETS, AUDIO_DISPLAYS };

const values = new Map(); // `${deck}:${at}` -> the live value (a number, a row's text, ...)
let currentDeck = 'a';
let registry = null; // { inputs, views } for the evaluation in progress, else null

const keyOf = (deck, at) => `${deck}:${at}`;

/** Start collecting the widgets an evaluation of `deck`'s buffer builds. */
export function beginWidgets(deck = 'a') {
  currentDeck = deck === 'b' ? 'b' : 'a';
  registry = { inputs: [], views: [], seen: new Set() };
}

/**
 * What the evaluation built: `{ inputs, views }`, each in document order. Values of this deck's
 * widgets that the evaluation no longer has are forgotten, so a deleted slider's key can't be set.
 */
export function takeWidgets() {
  const r = registry ?? { inputs: [], views: [], seen: new Set() };
  registry = null;
  const live = new Set(r.inputs.map((w) => keyOf(currentDeck, w.at)));
  for (const k of [...values.keys()]) if (k.startsWith(`${currentDeck}:`) && !live.has(k)) values.delete(k);
  r.inputs.sort((a, b) => a.at - b.at);
  r.views.sort((a, b) => a.at - b.at);
  return { inputs: r.inputs, views: r.views };
}

/** An evaluation that threw built nothing: stop collecting, and keep every control as it was. */
export function abandonWidgets() {
  registry = null;
}

/**
 * The host's side: a control moved. `value` is what the widget is now set to - a number for a
 * slider/knob/toggle/button, `[x, y]` for a pad, the row's text for steps()/sliders(), and
 * `{ row, text }` for one of a matrix's rows. False when no widget has that key.
 */
export function setWidgetValue(deck, at, value) {
  const key = keyOf(deck === 'b' ? 'b' : 'a', Number(at));
  if (!values.has(key)) return false;
  const was = values.get(key);
  if (was && typeof was === 'object' && !Array.isArray(was) && value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.row !== 'string' || typeof value.text !== 'string' || !(value.row in was)) return false;
    values.set(key, { ...was, [value.row]: value.text });
    return true;
  }
  if (Array.isArray(was)) {
    if (!Array.isArray(value) || value.length !== was.length) return false;
    values.set(key, value.map((v, i) => finiteOr(v, was[i])));
    return true;
  }
  if (typeof was === 'string') {
    if (typeof value !== 'string') return false;
    values.set(key, value);
    return true;
  }
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  values.set(key, v);
  return true;
}

/** A widget's current value, or undefined. For the host's reports and for tests. */
export function widgetValue(deck, at) {
  return values.get(keyOf(deck === 'b' ? 'b' : 'a', Number(at)));
}

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// What an argument is worth as a plain number: a number, a constant signal, a mini string's first
// value, or a numeric string. Widget arguments are read once, when the control is built - they are
// what the code SAYS, and the control is drawn from them.
function numberOf(x, fallback) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : fallback;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (x instanceof Sig) {
    if (typeof x.constVal === 'number') return x.constVal;
    try {
      const v = Number(x.sample(0, 0.5, 0));
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }
  if (typeof x === 'string' && x.trim() !== '') {
    const v = Number(x);
    return Number.isFinite(v) ? v : fallback;
  }
  return fallback;
}

// The text an argument says: a plain string, or the source of a mini string (a buffer written
// before these calls kept their text raw would hand one over).
function textOf(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Sig && typeof x.miniText === 'string') return x.miniText;
  return null;
}

// A signal whose value is read from the store at every sample - polled by the scheduler like a
// macro knob, so a moved control is heard within a poll and a lookahead.
function liveSig(read) {
  const sig = new Sig(() => read());
  sig.widgetLive = true;
  return sig;
}

function register(entry) {
  if (!registry) return;
  // A block that copy()s another builds that block again; its widgets are the same widgets.
  const id = `${entry.kind}@${entry.at}`;
  if (registry.seen.has(id)) return;
  registry.seen.add(id);
  (entry.input ? registry.inputs : registry.views).push(entry);
}

// The key a transpiled call carries: [at, lit] for an input, at for a display.
function locOf(loc) {
  if (Array.isArray(loc)) return { at: Number(loc[0]), lit: Number(loc[1] ?? -1) };
  if (typeof loc === 'number') return { at: loc, lit: -1 };
  return null;
}

// Seeds the store from what the code says. The buffer is the truth: an evaluation replaces whatever
// a control had been moved to with the value written in the call, which is the same number unless
// the code was edited by hand since.
function seed(at, value) {
  const key = keyOf(currentDeck, at);
  values.set(key, value);
  return key;
}

// ---------------------------------------------------------------------------------------------
// Input widgets
// ---------------------------------------------------------------------------------------------

/**
 * The transpiled form of every input widget: `_input([AT, LIT], 'slider', ...args)`. Users never
 * write it; the editor's transpile does (see widget-calls.mjs).
 */
export function _input(loc, kind, ...all) {
  const where = locOf(loc);
  const { args, opts } = splitArgs(kind, all);
  if (where) where.opts = inputOpts(kind, opts);
  switch (kind) {
    case 'slider': return rangedWidget('slider', where, args);
    case 'knob': return rangedWidget('knob', where, args);
    case 'toggle': return toggleWidget(where, args);
    case 'button': return buttonWidget(where);
    case 'xy': return xyWidget(where, args);
    case 'steps': return stepsWidget(where, args);
    case 'sliders': return slidersWidget(where, args);
    case 'matrix': return matrixWidget(where, args);
    default: throw new Error(`[widgets] no input widget called ${kind}`);
  }
}

// An input's options object - `knob(0.8, { size: 48 })` - is how the drawn control is drawn, not
// one of its values, so it comes out of the argument list wherever it was written. A matrix's
// rows are an object as well; its options are the object after them.
const isOptions = (a) => !!a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Sig);

function splitArgs(kind, all) {
  if (kind === 'matrix') return { args: all.slice(0, 1), opts: isOptions(all[1]) ? all[1] : undefined };
  let opts;
  const args = [];
  for (const a of all) {
    if (isOptions(a)) opts = a;
    else args.push(a);
  }
  return { args, opts };
}

// The options an input reads - its `size`, or its `width` and `height` for a kind drawn as a box
// (see WIDGET_BOXES) - checked like a display's: anything else is said once and ignored, and a
// size past the range is drawn at the nearest end of it.
function inputOpts(kind, opts) {
  const out = {};
  if (opts === undefined) return out;
  const ranges = { ...(INPUT_SIZES[kind] ? { size: INPUT_SIZES[kind] } : {}) };
  if (WIDGET_BOXES[kind]) Object.assign(ranges, { width: WIDGET_BOXES[kind].width, height: WIDGET_BOXES[kind].height });
  const names = Object.keys(ranges);
  for (const [k, raw] of Object.entries(opts)) {
    const range = ranges[k];
    if (!range) {
      warnPattern(`[widgets] ${kind}() has no option ${JSON.stringify(k)}${names.length ? ` (it has ${names.join(', ')})` : ''}`);
      continue;
    }
    const v = numberOf(raw, NaN);
    if (!Number.isFinite(v)) {
      warnPattern(`[widgets] ${kind}({ ${k} }) takes a number of pixels`);
      continue;
    }
    out[k] = Math.round(Math.min(range.max, Math.max(range.min, v)));
  }
  return out;
}

// The row a steps() or sliders() argument says: its text, a count of cells (`steps(8)`, which
// `fill` makes into that many cells), or - when nothing is written - the default count. Anything
// else is said once and drawn as the default, so the control is there to click into.
function rowOf(kind, cells, fill, example) {
  if (cells === undefined) return fill(DEFAULT_CELL_COUNT);
  const text = textOf(cells);
  if (text !== null) return text;
  if (typeof cells === 'number') {
    const n = cellCount(cells);
    if (n !== null) return fill(n);
    warnPattern(`[widgets] ${kind}(${cells}): a count of cells is a whole number from 1 - drawing ${DEFAULT_CELL_COUNT}`);
    return fill(DEFAULT_CELL_COUNT);
  }
  warnPattern(`[widgets] ${kind}() takes its cells as text or a count, e.g. ${example} - drawing ${DEFAULT_CELL_COUNT} empty`);
  return fill(DEFAULT_CELL_COUNT);
}

function rangedWidget(kind, where, [value, min, max, step]) {
  const lo = numberOf(min, 0);
  const hi = numberOf(max, 1);
  const v = numberOf(value, lo);
  const st = step === undefined ? null : numberOf(step, null);
  if (!where) return new Sig(() => v);
  const key = seed(where.at, v);
  register({ input: true, kind, at: where.at, value: v, min: lo, max: hi, step: st, opts: where.opts ?? {} });
  return liveSig(() => values.get(key) ?? v);
}

/** `slider(value, min, max, step)` - a slider drawn in the code; the signal of where it is set. */
export function slider(...all) {
  return rangedWidget('slider', null, splitArgs('slider', all).args);
}

/** `knob(value, min, max, step)` - a knob drawn in the code; the signal of where it is set. */
export function knob(...all) {
  return rangedWidget('knob', null, splitArgs('knob', all).args);
}

function toggleWidget(where, [on]) {
  const v = numberOf(on, 0) ? 1 : 0;
  if (!where) return new Sig(() => v);
  const key = seed(where.at, v);
  register({ input: true, kind: 'toggle', at: where.at, value: v, opts: where.opts ?? {} });
  return liveSig(() => (values.get(key) ? 1 : 0));
}

/** `toggle(on)` - a switch drawn in the code: 1 while on, 0 while off. */
export function toggle(...all) {
  return toggleWidget(null, splitArgs('toggle', all).args);
}

function buttonWidget(where) {
  if (!where) return new Sig(() => 0);
  const key = seed(where.at, 0);
  register({ input: true, kind: 'button', at: where.at, value: 0, opts: where.opts ?? {} });
  return liveSig(() => (values.get(key) ? 1 : 0));
}

/** `button()` - a button drawn in the code: 1 while it is held down, 0 otherwise. */
export function button() {
  return buttonWidget(null);
}

function xyWidget(where, [x, y]) {
  const vx = numberOf(x, 0.5);
  const vy = numberOf(y, 0.5);
  let readX = () => vx;
  let readY = () => vy;
  if (where) {
    const key = seed(where.at, [vx, vy]);
    register({ input: true, kind: 'xy', at: where.at, value: [vx, vy], opts: where.opts ?? {} });
    readX = () => values.get(key)?.[0] ?? vx;
    readY = () => values.get(key)?.[1] ?? vy;
  }
  const sx = where ? liveSig(readX) : new Sig(readX);
  const sy = where ? liveSig(readY) : new Sig(readY);
  // The pad IS its x axis, so `xy()` goes anywhere a value does; `.x` and `.y` name the two axes.
  sx.x = sx;
  sx.y = sy;
  return sx;
}

/** `xy(x, y)` - a two-axis pad drawn under the line: the signal of x, with `.x` and `.y` for each axis. */
export function xy(...all) {
  return xyWidget(null, splitArgs('xy', all).args);
}

// A cell token's value: `x` is a plain hit (1), a number is that number, anything else the word.
function tokenValue(token) {
  if (token === 'x' || token === 'X') return 1;
  const n = Number(token);
  return Number.isNaN(n) ? token : n;
}

// A step pattern read off text that can change under it: every cycle is the same one cycle of
// cells, parsed once per distinct text. `litBase` is the document offset of the text, so each cell
// carries the span the highlighter lights; -1 for text that isn't in the buffer as written.
function cellPattern(readText, litBase, valueOf = tokenValue) {
  let lastText = null;
  let steps = [];
  const current = () => {
    const text = readText();
    if (text !== lastText) {
      lastText = text;
      const cells = parseCells(text ?? '');
      const w = cells.length ? 1 / cells.length : 1;
      steps = cells.map((c, i) => {
        const value = c.on ? valueOf(c.token) : null;
        const step = { start: i * w, end: (i + 1) * w, value };
        if (litBase >= 0) step.loc = [litBase + c.from, litBase + c.to];
        return step;
      }).filter((s) => s.value != null);
    }
    return steps;
  };
  const stepsForCycle = () => current().map((s) => ({ ...s }));
  const sample = (t, cps, pos) => {
    const p = pos ?? t * cps;
    const phase = p - Math.floor(p);
    const hit = current().find((s) => phase >= s.start && phase < s.end);
    return hit ? hit.value : null;
  };
  return new Sig(sample, { stepsForCycle });
}

function stepsWidget(where, [cells]) {
  const text = rowOf('steps', cells, restRow, 'steps("x . x . x . . x") or steps(8)');
  if (!where) return cellPattern(() => text, -1);
  const key = seed(where.at, text);
  register({ input: true, kind: 'steps', at: where.at, value: text, opts: where.opts ?? {} });
  const sig = cellPattern(() => values.get(key) ?? text, where.lit);
  sig.widgetLive = true;
  return sig;
}

/** `steps("x . x .")` or `steps(8)` (that many rests) - a row of cells drawn in the code, one per step; a pattern of the hits. */
export function steps(...all) {
  return stepsWidget(null, splitArgs('steps', all).args);
}

function slidersWidget(where, [cells, min, max]) {
  const lo = numberOf(min, 0);
  const hi = numberOf(max, 1);
  const text = rowOf('sliders', cells, (n) => middleRow(n, lo, hi), 'sliders("0.2 0.5 0.8 0.3") or sliders(8)');
  const valueOf = (token) => {
    const n = Number(token);
    return Number.isNaN(n) ? null : n;
  };
  if (!where) return cellPattern(() => text, -1, valueOf);
  const key = seed(where.at, text);
  register({ input: true, kind: 'sliders', at: where.at, value: text, min: lo, max: hi, opts: where.opts ?? {} });
  const sig = cellPattern(() => values.get(key) ?? text, where.lit, valueOf);
  sig.widgetLive = true;
  return sig;
}

/** `sliders("0.2 0.5 0.8", min, max)` or `sliders(8)` (that many bars, halfway up) - a bar per step drawn in the code; a pattern of their values. */
export function sliders(...all) {
  return slidersWidget(null, splitArgs('sliders', all).args);
}

// A row key as a value: a number when it reads as one (`60`), otherwise the word (`bd`, `c3`).
function rowValue(key) {
  const n = Number(key);
  return key.trim() !== '' && !Number.isNaN(n) ? n : key;
}

function matrixWidget(where, [rows]) {
  const initial = {};
  if (rows === undefined || (isOptions(rows) && !Object.keys(rows).length)) {
    warnPattern('[widgets] matrix() needs at least one row, like matrix({ bd: 8 }) - it plays nothing');
  } else if (!rows || typeof rows !== 'object' || Array.isArray(rows) || rows instanceof Sig) {
    warnPattern('[widgets] matrix() takes one row of cells per sound, like matrix({ bd: "x . . . x . . .", sd: 8 }) - it plays nothing');
  } else {
    for (const [k, v] of Object.entries(rows)) {
      const text = textOf(v);
      if (text !== null) initial[k] = text;
      else if (typeof v === 'number') {
        const n = cellCount(v);
        if (n === null) warnPattern(`[widgets] matrix(): the row ${JSON.stringify(k)} is ${v} - a count of cells is a whole number from 1, drawing ${DEFAULT_CELL_COUNT}`);
        initial[k] = restRow(n ?? DEFAULT_CELL_COUNT);
      } else {
        warnPattern(`[widgets] matrix(): the row ${JSON.stringify(k)} has to be text or a count, like "x . . x" or 8 - leaving it out`);
      }
    }
  }
  let read = () => initial;
  if (where) {
    const key = seed(where.at, { ...initial });
    register({ input: true, kind: 'matrix', at: where.at, value: { ...initial }, opts: where.opts ?? {} });
    read = () => values.get(key) ?? initial;
  }
  const lanes = Object.keys(initial).map((k) => cellPattern(() => read()[k] ?? '', -1, () => rowValue(k)));
  const stepsForCycle = (cycle) => lanes.flatMap((l) => l.stepsForCycle(cycle)).sort((a, b) => a.start - b.start);
  const sample = (t, cps, pos) => {
    for (const l of lanes) {
      const v = l.sample(t, cps, pos);
      if (v != null) return v;
    }
    return null;
  };
  const sig = new Sig(sample, { stepsForCycle });
  if (where) sig.widgetLive = true;
  return sig;
}

/** `matrix({ bd: "x...", sd: 8 })` - a grid of cells drawn in the code, a row per name (text, or a count of rests); a pattern of the rows' names. */
export function matrix(rows) {
  return matrixWidget(null, [rows]);
}

// ---------------------------------------------------------------------------------------------
// Display widgets
// ---------------------------------------------------------------------------------------------

// The options each display reads, and their ranges. Anything else is said once and ignored - an
// option misspelled is a display drawn its default way, which is no reason to stop the music.
const sizeRange = (kind) => [DISPLAY_SIZES[kind].min, DISPLAY_SIZES[kind].max];
const widthRange = [WIDGET_BOXES.scope.width.min, WIDGET_BOXES.scope.width.max];
const DISPLAY_OPTS = {
  scope: { width: widthRange, height: sizeRange('scope'), scale: [0.1, 16], window: [2, 40] },
  spectrum: { width: widthRange, height: sizeRange('spectrum'), min: [-140, 0], max: [-100, 24] },
  waveform: { width: widthRange, height: sizeRange('waveform'), cycles: [1, 16] },
  imager: { size: sizeRange('imager') },
  meter: { width: [WIDGET_BOXES.meter.width.min, WIDGET_BOXES.meter.width.max], height: [WIDGET_BOXES.meter.height.min, WIDGET_BOXES.meter.height.max] },
  punchcard: { width: widthRange, height: sizeRange('punchcard'), cycles: [1, 16] },
  plot: { width: widthRange, height: sizeRange('plot'), cycles: [1, 16], min: [-1e9, 1e9], max: [-1e9, 1e9] },
  chroma: { size: sizeRange('chroma') },
};

function displayOpts(kind, opts) {
  const out = {};
  if (opts === undefined || opts === null) return out;
  if (typeof opts !== 'object' || Array.isArray(opts) || opts instanceof Sig) {
    warnPattern(`[widgets] .${kind}() takes an options object, like .${kind}({ height: 80 }) - drawing it the default way`);
    return out;
  }
  const known = DISPLAY_OPTS[kind] ?? {};
  for (const [k, raw] of Object.entries(opts)) {
    const range = known[k];
    if (!range) {
      warnPattern(`[widgets] .${kind}() has no option ${JSON.stringify(k)}${Object.keys(known).length ? ` (it has ${Object.keys(known).join(', ')})` : ''}`);
      continue;
    }
    const v = numberOf(raw, NaN);
    if (!Number.isFinite(v)) {
      warnPattern(`[widgets] .${kind}({ ${k} }) takes a number`);
      continue;
    }
    out[k] = Math.min(range[1], Math.max(range[0], v));
  }
  return out;
}

function displayOf(sig, at, kind, opts) {
  if (!DISPLAY_WIDGETS.includes(kind)) throw new Error(`[widgets] no display called ${kind}`);
  const o = displayOpts(kind, opts);
  if (typeof at === 'number' && Number.isFinite(at)) {
    register({ input: false, kind, at, opts: o, sig, audio: AUDIO_DISPLAYS.includes(kind) });
  }
  return sig;
}

/**
 * The displays that can stand on their own line - `punchcard()`, `spectrum()` - and are drawn
 * behind the code, filling the editor: the master output for the displays of sound, every track
 * for punchcard and chroma.
 */
export const BACKGROUND_DISPLAYS = Object.freeze(['punchcard', 'spectrum', 'scope', 'waveform', 'meter', 'imager', 'chroma']);

/**
 * The transpiled form of a display: `x._display(AT, 'scope', opts)` on a pattern, drawn under its
 * line, and the bare builder `_display(AT, 'scope', opts)` on a line of its own, drawn behind the
 * code (see BACKGROUND_DISPLAYS). Users write `.scope()` and `scope()`.
 */
export function _display(at, kind, opts) {
  if (!BACKGROUND_DISPLAYS.includes(kind)) {
    warnPattern(`[widgets] ${kind}() draws a pattern - call it on one, like note("c3 e3").${kind}()`);
    return undefined;
  }
  if (!DISPLAY_WIDGETS.includes(kind)) throw new Error(`[widgets] no display called ${kind}`);
  const o = displayOpts(kind, opts);
  if (typeof at === 'number' && Number.isFinite(at)) {
    register({ input: false, kind, at, opts: o, sig: null, audio: AUDIO_DISPLAYS.includes(kind), background: true });
  }
  return undefined;
}

Sig.prototype._display = function _displayMethod(at, kind, opts) {
  return displayOf(this, at, kind, opts);
};

for (const kind of DISPLAY_WIDGETS) {
  Object.defineProperty(Sig.prototype, kind, {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function display(opts) {
      return displayOf(this, null, kind, opts);
    },
  });
}

/** `scope()` on its own line - an oscilloscope of the master output, behind the code. */
export function scope(opts) {
  return _display(null, 'scope', opts);
}
/** `spectrum()` on its own line - the master output's spectrum, behind the code. */
export function spectrum(opts) {
  return _display(null, 'spectrum', opts);
}
/** `waveform()` on its own line - the master output's level over the last few cycles, behind the code. */
export function waveform(opts) {
  return _display(null, 'waveform', opts);
}
/** `imager()` on its own line - the master output's stereo image, behind the code. */
export function imager(opts) {
  return _display(null, 'imager', opts);
}
/** `meter()` on its own line - the master output's level, behind the code. */
export function meter(opts) {
  return _display(null, 'meter', opts);
}
/** `punchcard()` on its own line - every track's events, behind the code. */
export function punchcard(opts) {
  return _display(null, 'punchcard', opts);
}
/** `chroma()` on its own line - the pitch classes every track is sounding, behind the code. */
export function chroma(opts) {
  return _display(null, 'chroma', opts);
}

// ---------------------------------------------------------------------------------------------
// What the host ships for the displays it works out from the pattern
// ---------------------------------------------------------------------------------------------

/** How finely plot() reads a signal with no steps of its own, per cycle. */
export const PLOT_POINTS_PER_CYCLE = 48;

const round = (x) => (typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : x);

/**
 * The data a pattern display draws for transport cycles [from, from + count): for punchcard() and
 * chroma(), every event as `[start, end, value, vel]` in cycles (start and end where they are
 * HEARD - nudge, swing and clip applied, as the scheduler places them); for plot(), the signal's
 * value as `[start, end, value]` runs for a step pattern or `[pos, value]` points for a continuous
 * one. `clock` is the song clock the pattern is read by (see arrange.mjs), or null.
 */
export function displayWindow(view, from, count, { clock = null, cps = 0.5 } = {}) {
  const sig = view.sig;
  if (!sig) return null;
  const base = Math.max(0, Math.floor(from));
  if (view.kind === 'punchcard' || view.kind === 'chroma') {
    // `notes`: the values are MIDI notes, so the rows can be labeled with their names.
    return { events: eventsIn(sig, base, count, clock), notes: sig.pitchKind === 'note' };
  }
  if (view.kind === 'plot') return plotIn(sig, base, count, clock, cps);
  return null;
}

function eventsIn(sig, from, count, clock) {
  if (!sig.stepsForCycle) return [];
  const out = [];
  for (let c = from; c < from + count; c++) {
    let entries;
    try {
      entries = songSteps(sig.stepsForCycle, c, c + 1, clock);
    } catch {
      continue;
    }
    for (const { step: s, cycle, delta } of entries) {
      if (s.value == null || s.cont) continue;
      const at = cycle + s.start;
      const offset = cycle - delta;
      const start = offset + s.start + timeShift(s, sig.noteChannels, at, 1, at, sig.groove);
      const end = offset + soundingEnd(s, sig.noteChannels, at, 1, at);
      const vel = Number(channelAt('vel', s, sig.noteChannels, at, 1, at));
      const values = Array.isArray(s.value) ? s.value : [s.value];
      for (const v of values) {
        if (v == null || (typeof v !== 'number' && typeof v !== 'string')) continue;
        out.push([round(start), round(Math.max(start, end)), round(v), Number.isFinite(vel) ? round(vel) : 1]);
      }
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function plotIn(sig, from, count, clock, cps) {
  if (sig.stepsForCycle) {
    const runs = [];
    for (let c = from; c < from + count; c++) {
      let entries;
      try {
        entries = songSteps(sig.stepsForCycle, c, c + 1, clock);
      } catch {
        continue;
      }
      for (const { step: s, cycle, delta } of entries) {
        const v = Number(Array.isArray(s.value) ? s.value[0] : s.value);
        if (s.value == null || !Number.isFinite(v)) continue;
        const offset = cycle - delta;
        runs.push([round(offset + s.start), round(offset + s.end), round(v)]);
      }
    }
    return { runs: runs.sort((a, b) => a[0] - b[0]), live: !!sig.widgetLive };
  }
  const points = [];
  const n = PLOT_POINTS_PER_CYCLE;
  for (let c = from; c < from + count; c++) {
    for (let k = 0; k < n; k++) {
      const pos = c + k / n;
      let v;
      try {
        v = Number(sig.sample(pos / cps, cps, pos));
      } catch {
        v = NaN;
      }
      points.push([round(pos), Number.isFinite(v) ? round(v) : null]);
    }
  }
  return { points, live: !!sig.widgetLive || !!sig.ccIR };
}

/** The value a live signal has right now, for plot()'s trace of a control moved by hand. */
export function displayNow(view, pos, cps = 0.5) {
  const sig = view.sig;
  if (!sig) return null;
  try {
    const v = Number(sig.sample(pos / cps, cps, pos));
    return Number.isFinite(v) ? round(v) : null;
  } catch {
    return null;
  }
}
