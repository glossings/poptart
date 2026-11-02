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

import { Sig, mini, channelAt, soundingEnd, timeShift, warnPattern, noteLiveRead, clipsOwnerNow, withTrackGate } from './signal.mjs';
import { CURVES } from './curves.mjs';
import { songSteps } from './arrange.mjs';
import { notePress, forgetPresses } from './triggers.mjs';
import {
  INPUT_WIDGETS, DISPLAY_WIDGETS, AUDIO_DISPLAYS, INPUT_SIZES, DISPLAY_SIZES, WIDGET_BOXES,
  parseCells, cellCount, restRow, middleRow, randomRow, DEFAULT_CELL_COUNT, MUTATE_OPTION, DEVIATION_OPTION,
} from './widget-calls.mjs';

export { INPUT_WIDGETS, DISPLAY_WIDGETS, AUDIO_DISPLAYS };

const values = new Map(); // `${deck}:${at}` -> the live value (a number, a row's text, ...)
// `${deck}:${at}` -> where a row widget's text starts in the document: a number for steps() and
// sliders(), `{ [row]: offset }` for a matrix. Seeded by the evaluation from the transpile's tag,
// moved by a set that says where the text is now (the editor writing a count out as cells), so a
// row's cells carry the spans the highlighter lights without waiting for the next evaluation.
const lits = new Map();
// `${deck}:${at}` -> { [option]: Sig, block } - a row option written as a signal or a pattern, which
// the editor asks the host for at each pass of the row (see widgetOption), and the block it is in.
const optionSigs = new Map();
// The keys that are button()s: a change of their value is a press or a release (see triggers.mjs).
const buttonKeys = new Set();
let currentDeck = 'a';
let registry = null; // { inputs, views } for the evaluation in progress, else null
let generation = 0; // counts evaluations, so what one built can tell itself from the last one's

const keyOf = (deck, at) => `${deck}:${at}`;

/** Start collecting the widgets an evaluation of `deck`'s buffer builds. */
export function beginWidgets(deck = 'a') {
  currentDeck = deck === 'b' ? 'b' : 'a';
  registry = { inputs: [], views: [], seen: new Set(), records: new Set(), recording: new Set(), sources: [], learns: [] };
  generation++;
}

/** The deck whose buffer is being evaluated (or was last), and which evaluation of it this is. */
export function evaluatingDeck() {
  return currentDeck;
}
export function widgetGeneration() {
  return generation;
}

const built = { a: 0, b: 0 }; // each deck's last evaluation that went through: its generation

/** The generation of `deck`'s last evaluation that went through (an abandoned one does not count). */
export function builtGeneration(deck) {
  return built[deck === 'b' ? 'b' : 'a'];
}

/**
 * What the evaluation built: `{ inputs, views }`, each in document order. Values of this deck's
 * widgets that the evaluation no longer has are forgotten, so a deleted slider's key can't be set.
 */
export function takeWidgets() {
  const r = registry ?? { inputs: [], views: [], seen: new Set(), records: new Set(), recording: new Set(), sources: [], learns: [] };
  if (registry) {
    built[currentDeck] = generation;
    lastSources[currentDeck] = r.sources;
    lastLearns[currentDeck] = r.learns.sort((a, b) => a.at - b.at);
  }
  registry = null;
  const live = new Set(r.inputs.map((w) => keyOf(currentDeck, w.at)));
  for (const k of [...values.keys()]) if (k.startsWith(`${currentDeck}:`) && !live.has(k)) values.delete(k);
  for (const k of [...lits.keys()]) if (k.startsWith(`${currentDeck}:`) && !live.has(k)) lits.delete(k);
  for (const k of [...optionSigs.keys()]) if (k.startsWith(`${currentDeck}:`) && !live.has(k)) optionSigs.delete(k);
  for (const k of [...buttonKeys]) if (k.startsWith(`${currentDeck}:`) && !live.has(k)) buttonKeys.delete(k);
  forgetPresses(currentDeck, live);
  r.inputs.sort((a, b) => a.at - b.at);
  r.views.sort((a, b) => a.at - b.at);
  return { inputs: r.inputs, views: r.views, records: [...r.records].sort((a, b) => a - b), recording: [...r.recording].sort((a, b) => a - b) };
}

/** An evaluation that threw built nothing: stop collecting, and keep every control as it was. */
export function abandonWidgets() {
  registry = null;
}

/**
 * The host's side: a control moved. `value` is what the widget is now set to - a number for a
 * slider/knob/toggle/button, `[x, y]` for a pad, the row's text for steps()/sliders(), and
 * `{ row, text }` for one of a matrix's rows, or `{ [row]: text, ... }` for several of them at
 * once (what randomizing a grid sends). False when no widget has that key. `lit` is where the
 * row's text now starts in the document, when the host knows: a number, or `{ [row]: offset }`
 * for a matrix's rows (see `lits`). `agoSec` is how long ago the hand did it, when the host knows: a
 * button's press is stamped then (see triggers.mjs).
 */
export function setWidgetValue(deck, at, value, lit = undefined, agoSec = 0) {
  const d = deck === 'b' ? 'b' : 'a';
  const key = keyOf(d, Number(at));
  if (!values.has(key)) return false;
  if (buttonKeys.has(key)) {
    const was = Number(values.get(key)) >= 0.5;
    const now = Number(value) >= 0.5;
    if (Number.isFinite(Number(value)) && was !== now) notePress(key, d, now, agoSec);
  }
  if (typeof lit === 'number' && Number.isFinite(lit)) lits.set(key, lit);
  else if (lit && typeof lit === 'object' && !Array.isArray(lit)) {
    const was = lits.get(key);
    const rows = was && typeof was === 'object' ? { ...was } : {};
    for (const [r, v] of Object.entries(lit)) if (Number.isFinite(Number(v))) rows[r] = Number(v);
    lits.set(key, rows);
  }
  const was = values.get(key);
  if (was && typeof was === 'object' && !Array.isArray(was) && value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 2 && typeof value.row === 'string' && typeof value.text === 'string' && value.row in was) {
      values.set(key, { ...was, [value.row]: value.text });
      return true;
    }
    if (!keys.length || !keys.every((r) => r in was && typeof value[r] === 'string')) return false;
    values.set(key, { ...was, ...value });
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

// Told about every read of a drawn control, with where it was read - motion.mjs keeps the recent
// movement of each control from it, for the header's capture (see captureMotion).
let controlReadHook = null;

/** `fn(control, pos)` on every read of a drawn control: `control` is `{ key, deck, at, kind, ranges, axes, read }`. */
export function onControlRead(fn) {
  controlReadHook = fn;
}

// A signal whose value is read from the store at every sample - polled by the scheduler like a
// macro knob, so a moved control is heard within a poll and a lookahead. `control` says which
// drawn control it is, for the read hook.
function liveSig(read, control = null) {
  const sig = new Sig((t, cps, pos) => {
    noteLiveRead();
    if (control && controlReadHook) controlReadHook(control, pos);
    return read();
  });
  sig.widgetLive = true;
  return sig;
}

// What the read hook is told about a drawn control: its key, where its call is, its value now as
// one number per axis, and the curve each axis turns on (null for linear).
function controlOf(key, at, kind, ranges, read, curves = ranges.map(() => null)) {
  return { key, deck: currentDeck, at, kind, ranges, curves, axes: ranges.length > 1 ? ['-x', '-y'] : [''], read };
}

// Each deck's live sources, as its last evaluation that went through wrote them (see _at).
const lastSources = { a: [], b: [] };
// ...and its bare cc() calls still waiting for a knob, in document order: `{ at, device }`.
const lastLearns = { a: [], b: [] };

/**
 * The transpiled form of every live source written in a buffer: `_at(AT, cc(12, 1))`,
 * `_at(AT, osc("/x"))`, `_at(AT, macro1)`. The source itself, unchanged - this only notes where it
 * is and what it reads, so the header's capture can put a `.record()` on the one that moved (see
 * motion.mjs's captureMotion). Anything else wrapped by mistake passes straight through.
 */
export function _at(at, sig) {
  if (!registry || !Number.isFinite(at) || !(sig instanceof Sig)) return sig;
  if (sig.ccLearn) {
    // Once each: a block that copy()s another builds that block's calls again.
    if (!registry.learns.some((l) => l.at === at)) registry.learns.push({ at, device: sig.ccLearn.device });
    return sig;
  }
  const ir = sig.ccIR;
  if (ir?.osc) registry.sources.push({ at, kind: 'osc', address: ir.osc, index: ir.index ?? 0 });
  else if (ir) registry.sources.push({ at, kind: 'cc', device: ir.device, cc: ir.cc, channel: ir.channel ?? null });
  else if (Number.isFinite(sig.macroIndex)) registry.sources.push({ at, kind: 'macro', index: sig.macroIndex });
  return sig;
}

/** `deck`'s live sources as of its last evaluation: `[{ at, kind, ... }]` (see _at). */
export function sourceCalls(deck) {
  return lastSources[deck === 'b' ? 'b' : 'a'];
}

/** `deck`'s bare cc() calls still waiting for a knob, in document order: `[{ at, device }]`. */
export function learnCalls(deck) {
  return lastLearns[deck === 'b' ? 'b' : 'a'];
}

/** The bare cc() at `at` has been given its knob: the next one turned goes to the call after it. */
export function learnFilled(deck, at) {
  const d = deck === 'b' ? 'b' : 'a';
  lastLearns[d] = lastLearns[d].filter((l) => l.at !== at);
}

/**
 * A `.record(` call at `at` that records a control's movement rather than a track's sound (see
 * motion.mjs) - which the editor cannot tell from the text, and opens a different panel for.
 */
export function registerMotionRecord(at) {
  if (registry && Number.isFinite(at)) registry.records.add(at);
}

/** A drawn control at `at` with a `.record()` on it: the editor draws it where its take is playing. */
export function registerRecordingControl(at) {
  if (registry && Number.isFinite(at)) registry.recording.add(at);
}

function register(entry) {
  if (!registry) return;
  // A block that copy()s another builds that block again; its widgets are the same widgets.
  const id = `${entry.kind}@${entry.at}`;
  if (registry.seen.has(id)) return;
  registry.seen.add(id);
  (entry.input ? registry.inputs : registry.views).push(entry);
}

// The key a transpiled call carries: [at, lit] for an input (a matrix adds where each row's text
// starts, by row name), at for a display.
function locOf(loc) {
  if (Array.isArray(loc)) return { at: Number(loc[0]), lit: Number(loc[1] ?? -1), rows: loc[2] ?? null };
  if (typeof loc === 'number') return { at: loc, lit: -1 };
  return null;
}

// Seeds the store from what the code says. The buffer is the truth: an evaluation replaces whatever
// a control had been moved to with the value written in the call, which is the same number unless
// the code was edited by hand since.
function seed(at, value, lit = undefined) {
  const key = keyOf(currentDeck, at);
  values.set(key, value);
  if (lit !== undefined) lits.set(key, lit);
  return key;
}

// Where a row widget's text starts now (see `lits`): a number, a matrix's `{ [row]: offset }`, or -1.
const litOf = (key) => lits.get(key) ?? -1;

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
  if (where) where.opts = inputOpts(kind, opts, where.at);
  switch (kind) {
    case 'slider': return rangedWidget('slider', where, args);
    case 'knob': return rangedWidget('knob', where, args);
    case 'toggle': return toggleWidget(where, args);
    case 'button': return buttonWidget(where);
    case 'xy': return xyWidget(where, args);
    case 'steps': return stepsWidget(where, args);
    case 'sliders': return slidersWidget(where, args);
    case 'matrix': return matrixWidget(where, args);
    case 'shiftreg': return shiftregWidget(where, args);
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
// (see WIDGET_BOXES), and a knob's or slider's `curve` (with `curveExp` for pow and sym) - checked
// like a display's: anything else is said once and ignored, and a size past the range is drawn at
// the nearest end of it.
const CURVED = new Set(['slider', 'knob']);

// The options a row of cells takes besides its size: how much it changes each pass, and - for
// sliders() - how far a value thrown again lands from the one it had. The editor does the
// changing (see inline-widgets.mjs); these are read here so a wrong one is said once.
const ROW_OPTIONS = {
  steps: [MUTATE_OPTION],
  matrix: [MUTATE_OPTION],
  shiftreg: [MUTATE_OPTION],
  sliders: [MUTATE_OPTION, DEVIATION_OPTION],
};

function inputOpts(kind, opts, at = null) {
  const out = {};
  if (at !== null) optionSigs.delete(keyOf(currentDeck, at)); // what this evaluation says replaces the last one's
  if (opts === undefined) return out;
  const ranges = { ...(INPUT_SIZES[kind] ? { size: INPUT_SIZES[kind] } : {}) };
  if (WIDGET_BOXES[kind]) Object.assign(ranges, { width: WIDGET_BOXES[kind].width, height: WIDGET_BOXES[kind].height });
  const names = [...Object.keys(ranges), ...(CURVED.has(kind) ? ['curve', 'curveExp'] : []), ...(ROW_OPTIONS[kind] ?? [])];
  for (const [k, raw] of Object.entries(opts)) {
    if (ROW_OPTIONS[kind]?.includes(k)) {
      rowOption(kind, k, raw, out, at);
      continue;
    }
    if (CURVED.has(kind) && k === 'curve') {
      const c = textOf(raw);
      if (c === null || !CURVES.includes(c)) warnPattern(`[widgets] ${kind}({ curve }) is one of ${CURVES.map((x) => `"${x}"`).join(', ')} - got ${JSON.stringify(c ?? raw)}, turning linear`);
      else out.curve = c;
      continue;
    }
    if (CURVED.has(kind) && k === 'curveExp') {
      const v = numberOf(raw, NaN);
      if (!(v > 0)) warnPattern(`[widgets] ${kind}({ curveExp }) is a number above 0 - got ${JSON.stringify(raw)}`);
      else out.curveExp = v;
      continue;
    }
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

// The range a row option's value is kept in.
const optionRange = (key) => [0, key === MUTATE_OPTION ? 1 : Infinity];

// A row option's value into `out`. A number is that number. A knob() or slider() puts its call's
// position with it as `<key>From`, so the editor reads where the control is set now. Any other
// signal or pattern - a midicc(), an lfo, "<0 0.1>" - is kept here, marked `<key>Live`, and the
// editor asks the host for its value at each pass of the row (see widgetOption). `at` is the
// row's call, null outside an evaluation.
function rowOption(kind, key, raw, out, at = null) {
  const numeric = (t) => typeof t === 'string' && /^\s*[-+]?(?:\d+\.?\d*|\.\d+)\s*$/.test(t);
  const wants = key === MUTATE_OPTION ? 'a chance from 0 to 1' : 'a number from 0 up';
  const [lo, hi] = optionRange(key);
  let sig = raw instanceof Sig ? raw : null;
  if (typeof raw === 'string' && !numeric(raw)) {
    try {
      sig = mini(raw); // a pattern written in an options object stays a plain string
    } catch {
      sig = null;
    }
  }
  const control = sig && Number.isFinite(sig.widgetAt) ? sig.widgetAt : null;
  const fixed = typeof raw === 'number' || numeric(raw) || (sig && typeof sig.constVal === 'number');
  if (sig && control === null && !fixed) {
    const first = numberOf(sig, 0);
    out[key] = Math.min(hi, Math.max(lo, Number.isFinite(first) ? first : 0));
    out[`${key}Live`] = true;
    // Filed with the block it is in, so a signal that reads its track's notes (`vel`) reads them.
    if (at !== null) optionSigs.set(keyOf(currentDeck, at), { ...optionSigs.get(keyOf(currentDeck, at)), [key]: sig, block: clipsOwnerNow().label });
    return;
  }
  const v = numberOf(sig ?? raw, NaN);
  if (!Number.isFinite(v)) {
    warnPattern(`[widgets] ${kind}({ ${key} }) is ${wants}, a signal or a pattern - got ${JSON.stringify(textOf(raw) ?? raw)}`);
    return;
  }
  if (v < lo || v > hi) warnPattern(`[widgets] ${kind}({ ${key} }) is ${wants} - got ${v}, using ${Math.min(hi, Math.max(lo, v))}`);
  out[key] = Math.min(hi, Math.max(lo, v));
  if (control !== null) out[`${key}From`] = control;
}

/**
 * What a row option written as a signal or a pattern (see rowOption) is at cycle `pos`: the
 * `mutate` of the row whose call is at `at` on `deck` as its pass begins, kept in its range. Null
 * when that row has no such option, or it reads nothing there.
 */
export function widgetOption(deck, at, key, pos, cps = 0.5) {
  const which = deck === 'b' ? 'b' : 'a';
  const entry = optionSigs.get(keyOf(which, Number(at)));
  const sig = entry?.[key];
  if (!sig) return null;
  const p = Number(pos);
  let v;
  try {
    v = Number(withTrackGate(which, entry.block, p, () => sig.sample(p / cps, cps, p)));
  } catch {
    return null;
  }
  if (!Number.isFinite(v)) return null;
  const [lo, hi] = optionRange(key);
  return Math.min(hi, Math.max(lo, v));
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
  const opts = { ...(where.opts ?? {}) };
  // An exp curve maps a ratio: a range that reaches zero or crosses it has none.
  if (opts.curve === 'exp' && !(lo > 0 && hi > 0)) {
    warnPattern(`[widgets] ${kind}({ curve: "exp" }) needs a range above zero - got ${lo} to ${hi}, turning linear`);
    delete opts.curve;
  }
  const curve = opts.curve && opts.curve !== 'lin' ? { curve: opts.curve, curveExp: opts.curveExp ?? 2 } : null;
  const key = seed(where.at, v);
  register({ input: true, kind, at: where.at, value: v, min: lo, max: hi, step: st, opts });
  const sig = liveSig(() => values.get(key) ?? v, controlOf(key, where.at, kind, [[lo, hi]], () => [Number(values.get(key) ?? v)], [curve]));
  sig.motionSource = { key, range: [lo, hi], curve }; // what .record() records (see motion.mjs)
  sig.widgetAt = where.at; // which call it is, for an option that reads it (see rowOption)
  return sig;
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
  const sig = liveSig(() => (values.get(key) ? 1 : 0), controlOf(key, where.at, 'toggle', [[0, 1]], () => [values.get(key) ? 1 : 0]));
  sig.motionSource = { key, range: [0, 1] };
  return sig;
}

/** `toggle(on)` - a switch drawn in the code: 1 while on, 0 while off. */
export function toggle(...all) {
  return toggleWidget(null, splitArgs('toggle', all).args);
}

function buttonWidget(where) {
  if (!where) return new Sig(() => 0);
  const key = seed(where.at, 0);
  buttonKeys.add(key);
  register({ input: true, kind: 'button', at: where.at, value: 0, opts: where.opts ?? {} });
  const sig = liveSig(() => (values.get(key) ? 1 : 0), controlOf(key, where.at, 'button', [[0, 1]], () => [values.get(key) ? 1 : 0]));
  sig.motionSource = { key, range: [0, 1], button: true };
  // As a rhythm (.struct(), .advance()) it is its presses, not its value (see triggers.mjs).
  sig.pressKey = key;
  return sig;
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
  let key = null;
  if (where) {
    key = seed(where.at, [vx, vy]);
    register({ input: true, kind: 'xy', at: where.at, value: [vx, vy], opts: where.opts ?? {} });
    readX = () => values.get(key)?.[0] ?? vx;
    readY = () => values.get(key)?.[1] ?? vy;
  }
  // Both axes report the whole pad, so a read of either one keeps its movement.
  const control = where ? controlOf(key, where.at, 'xy', [[0, 1], [0, 1]], () => [readX(), readY()].map(Number)) : null;
  const sx = where ? liveSig(readX, control) : new Sig(readX);
  const sy = where ? liveSig(readY, control) : new Sig(readY);
  // The pad IS its x axis, so `xy()` goes anywhere a value does; `.x` and `.y` name the two axes.
  sx.x = sx;
  sx.y = sy;
  if (where) {
    // .record() on the pad records both axes; on .y alone, that axis (see motion.mjs).
    sx.motionSource = { key, range: [0, 1], pad: [sx, sy] };
    sy.motionSource = { key, range: [0, 1] };
  }
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
// cells, parsed once per distinct text and position. `litAt()` is the document offset of the text,
// so each cell carries the span the highlighter lights; -1 for text that isn't in the buffer as
// written.
// `rests` keeps a step for every rest as well, valued null: what .bits() reads a register's
// zeros, and the spans of the cells they light, from.
function cellPattern(readText, litAt, valueOf = tokenValue, { rests = false } = {}) {
  let lastText = null;
  let lastBase = null;
  let steps = [];
  let count = 0;
  const current = () => {
    const text = readText();
    const litBase = litAt();
    if (text !== lastText || litBase !== lastBase) {
      lastText = text;
      lastBase = litBase;
      const cells = parseCells(text ?? '');
      count = cells.length;
      const w = cells.length ? 1 / cells.length : 1;
      steps = cells.map((c, i) => {
        const value = c.on ? valueOf(c.token) : null;
        const step = { start: i * w, end: (i + 1) * w, value };
        if (litBase >= 0) step.loc = [litBase + c.from, litBase + c.to];
        return step;
      }).filter((s) => rests || s.value != null);
    }
    return steps;
  };
  const stepsForCycle = () => current().map((s) => ({ ...s }));
  const sample = (t, cps, pos) => {
    const p = pos ?? t * cps;
    const phase = p - Math.floor(p);
    const hit = current().find((s) => s.value != null && phase >= s.start && phase < s.end);
    return hit ? hit.value : null;
  };
  const sig = new Sig(sample, { stepsForCycle });
  // How many cells the row has, rests and all: its step grid (see Sig#bits).
  sig.gridSize = () => {
    current();
    return count;
  };
  sig.sameEveryCycle = true; // one cycle of cells, every cycle (see .advance()'s counting)
  return sig;
}

function stepsWidget(where, [cells]) {
  const text = rowOf('steps', cells, restRow, 'steps("x . x . x . . x") or steps(8)');
  if (!where) {
    const sig = cellPattern(() => text, () => -1);
    sig.rowText = () => text;
    return sig;
  }
  const key = seed(where.at, text, where.lit);
  register({ input: true, kind: 'steps', at: where.at, value: text, opts: where.opts ?? {} });
  const sig = cellPattern(() => values.get(key) ?? text, () => litOf(key));
  sig.widgetLive = true;
  // Its text as it stands, and its key: what a button's take written as a row reads and writes.
  sig.rowText = () => values.get(key) ?? text;
  sig.rowKey = key;
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
  if (!where) return cellPattern(() => text, () => -1, valueOf);
  const key = seed(where.at, text, where.lit);
  register({ input: true, kind: 'sliders', at: where.at, value: text, min: lo, max: hi, opts: where.opts ?? {} });
  const sig = cellPattern(() => values.get(key) ?? text, () => litOf(key), valueOf);
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
  let litOfRow = () => -1;
  if (where) {
    const key = seed(where.at, { ...initial }, where.rows ?? {});
    register({ input: true, kind: 'matrix', at: where.at, value: { ...initial }, opts: where.opts ?? {} });
    read = () => values.get(key) ?? initial;
    litOfRow = (k) => litOf(key)?.[k] ?? -1;
  }
  const lanes = Object.keys(initial).map((k) => cellPattern(() => read()[k] ?? '', () => litOfRow(k), () => rowValue(k)));
  const stepsForCycle = (cycle) => lanes.flatMap((l) => l.stepsForCycle(cycle)).sort((a, b) => a.start - b.start);
  const sample = (t, cps, pos) => {
    for (const l of lanes) {
      const v = l.sample(t, cps, pos);
      if (v != null) return v;
    }
    return null;
  };
  const sig = new Sig(sample, { stepsForCycle });
  sig.sameEveryCycle = true;
  if (where) sig.widgetLive = true;
  return sig;
}

/** `matrix({ bd: "x...", sd: 8 })` - a grid of cells drawn in the code, a row per name (text, or a count of rests); a pattern of the rows' names. */
export function matrix(rows) {
  return matrixWidget(null, [rows]);
}

/** How many steps a shiftreg() reads as one value: the width of its register (see Sig#bits). */
export const SHIFTREG_BITS = 8;

// A row of cells read as a looping shift register: its pattern is the row through .bits(), a
// value for every step. Written as a count, the row is thrown at random - half its cells hits -
// and the editor writes what was thrown into the call, so the code says what plays. The second
// argument is how much it changes each pass, as steps()'s `mutate` option.
function shiftregWidget(where, [cells, mutate]) {
  const text = rowOf('shiftreg', cells, (n) => randomRow(restRow(n)), 'shiftreg("x . x x . . x .") or shiftreg(16)');
  if (!where) return cellPattern(() => text, () => -1, tokenValue, { rests: true }).bits(SHIFTREG_BITS);
  const opts = { ...(where.opts ?? {}) };
  if (mutate !== undefined) {
    delete opts[`${MUTATE_OPTION}From`];
    delete opts[`${MUTATE_OPTION}Live`];
    rowOption('shiftreg', MUTATE_OPTION, mutate, opts, where.at);
  }
  const key = seed(where.at, text, where.lit);
  register({ input: true, kind: 'shiftreg', at: where.at, value: text, opts });
  const sig = cellPattern(() => values.get(key) ?? text, () => litOf(key), tokenValue, { rests: true }).bits(SHIFTREG_BITS);
  sig.widgetLive = true;
  return sig;
}

/** `shiftreg("x . x x . . x .", mutate)` or `shiftreg(16, mutate)` - a row of cells drawn in the code, read as a looping shift register: a value from 0 to 1 every step. */
export function shiftreg(...all) {
  return shiftregWidget(null, splitArgs('shiftreg', all).args);
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
