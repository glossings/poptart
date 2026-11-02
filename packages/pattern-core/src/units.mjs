// Values in a control's own units: `.param("Op 2 Ratio", "3x")`, `.param("Cutoff", "800hz")`,
// `sine.range("1x", "8x").snap([1, 2, 3, 4, 6, 8])`.
//
// A number with a unit on it is a number in that unit, and the signal it is in remembers the unit
// (Sig#unit) through arithmetic, range() and snap(). Only at the control is it turned into the
// 0..1 position the control takes, along the control's own curve - so the math, the range and the
// snapping all happen in ratios, hertz or decibels, never in knob positions. A bare number is a
// position, as it always was.
//
// The conversion is the scheduler's, so both engines get it: a value is converted as it is sent,
// and a modulator or an expression is sent as an expression whose root is the conversion (a `map`
// node and plain arithmetic, which both engines already evaluate per sample).
//
// The controls' ranges and curves come from the device catalog, which each host hands over at
// startup (registerDeviceParams). A device the catalog does not hold - a plugin - converts
// nothing: a mapping file that gives a plugin's parameter units already reads numbers in them.

import { noteToMidi } from './notes.mjs';

/**
 * Each unit a value can be written in: the family it belongs to and what one of it is in the
 * family's base. A control in `ms` reads "0.25s" as 250, one in `st` reads "50ct" as 0.5.
 */
const UNITS = Object.freeze({
  hz: ['hz', 1],
  khz: ['hz', 1000],
  s: ['s', 1],
  ms: ['s', 0.001],
  db: ['db', 1],
  st: ['ct', 100],
  ct: ['ct', 1],
  x: ['x', 1],
  bit: ['bit', 1],
  cyc: ['cyc', 1],
});

const UNIT_VALUE = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(khz|hz|ms|s|db|st|ct|x|bit|cyc)\s*$/i;

/** `"3x"` as `{ value: 3, unit: 'x' }` in the family's base (`"250ms"` is 0.25 of `s`), or null. */
export function parseUnitValue(text) {
  if (typeof text !== 'string') return null;
  const m = UNIT_VALUE.exec(text);
  if (!m) return null;
  const [family, scale] = UNITS[m[2].toLowerCase()];
  return { value: Number(m[1]) * scale, unit: family };
}

/** The family a control's unit belongs to and how many of the family's base one of it is. */
function unitOf(name) {
  const u = UNITS[String(name ?? '').trim().toLowerCase()];
  return u ? { family: u[0], scale: u[1] } : null;
}

const devices = new Map(); // lower-cased id and name -> params

/**
 * The device catalog, as each host has it: `[{ id, name, params: [{ id, name, min, max, curve,
 * curveExp, unit, options, open }] }]`. Replaces whatever was registered before.
 */
export function registerDeviceParams(list) {
  devices.clear();
  for (const d of list ?? []) {
    if (!d || !Array.isArray(d.params)) continue;
    for (const key of [d.id, d.name]) if (typeof key === 'string') devices.set(key.trim().toLowerCase(), d.params);
  }
}

/** A device's control by name or id, ignoring case, or null where the catalog has neither. */
export function deviceParamSpec(device, name) {
  if (typeof device !== 'string' || typeof name !== 'string') return null;
  const params = devices.get(device.trim().toLowerCase());
  if (!params) return null;
  const want = name.trim().toLowerCase();
  return params.find((p) => String(p.id).toLowerCase() === want || String(p.name ?? '').toLowerCase() === want) ?? null;
}

/**
 * How a value in `unit` reaches control `spec`: `{ spec, divide }`, where a value divided by
 * `divide` is in the control's own unit. A string saying why it cannot is returned instead: the
 * control has options, or no unit, or one of another kind.
 */
export function unitConversion(spec, unit) {
  if (spec.options) return 'it picks from a list of options';
  const own = unitOf(spec.unit);
  if (!own) return 'it has no unit, so it takes a 0 to 1 position';
  if (own.family !== unit) return `it is in ${spec.unit}`;
  return { spec, divide: own.scale };
}

// The 0..1 position of a value in the control's own unit, along its curve: descriptor.mjs's
// normalize, which every device applies the inverse of.
function position(spec, v) {
  const { min, max } = spec;
  const k = spec.curveExp ?? 1;
  v = Math.min(Math.max(v, min), spec.open ? Infinity : max);
  let t;
  if (spec.curve === 'exp') t = Math.log(v / min) / Math.log(max / min);
  else if (spec.curve === 'pow') t = Math.pow((v - min) / (max - min), 1 / k);
  else if (spec.curve === 'sym') {
    const u = (v - (min + max) / 2) / ((max - min) / 2);
    t = (1 + Math.sign(u) * Math.pow(Math.abs(u), 1 / k)) / 2;
  } else t = max === min ? 0 : (v - min) / (max - min);
  if (!Number.isFinite(t)) return 0;
  return Math.min(spec.open ? Infinity : 1, Math.max(0, t));
}

/** Whether a control's own unit is hertz, so a note on it is that note's frequency. */
export function takesHz(spec) {
  return String(spec?.unit ?? '').trim().toLowerCase() === 'hz' && !spec.options;
}

/**
 * One value as the control's position. A number is in the signal's unit; a note name on a
 * control in hertz is that note's frequency (c3 = MIDI 60). Anything else is passed as it is.
 */
export function unitPosition(conv, value) {
  if (typeof value === 'number') return position(conv.spec, value / conv.divide);
  if (typeof value === 'string') {
    const u = parseUnitValue(value);
    if (u) return position(conv.spec, u.value / conv.divide);
    const hz = takesHz(conv.spec) ? noteHz(value) : null;
    if (hz != null) return position(conv.spec, hz);
  }
  return value;
}

/** A MIDI note number's frequency (69 = 440 Hz). */
export function midiHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** A note name's frequency, for a control in hertz, or null. */
export function noteHz(value) {
  if (typeof value !== 'string' || !/^[a-g]/i.test(value.trim())) return null;
  const midi = noteToMidi(value.trim());
  return Number.isFinite(midi) ? midiHz(midi) : null;
}

const C = (v) => ({ k: 'const', v });
const OP = (op, a, b) => ({ k: 'op', op, a: [a, b] });

/** An expression tree of MIDI note numbers as one of their frequencies, as midiHz computes them. */
export function midiHzTree(node) {
  return OP('mul', C(440), OP('pow', C(2), OP('div', OP('sub', node, C(69)), C(12))));
}

/**
 * An expression tree whose value is in the signal's unit, as one whose value is the control's
 * position: the same curve as `position`, in nodes both engines evaluate per sample.
 */
export function unitTree(conv, node) {
  const { spec, divide } = conv;
  const k = spec.curveExp ?? 1;
  const x = divide === 1 ? node : OP('div', node, C(divide));
  if (spec.curve === 'exp') return { k: 'map', min: spec.min, max: spec.max, curve: 'log', a: [x] };
  const lin = { k: 'map', min: spec.min, max: spec.max, curve: 'lin', a: [x] };
  if (spec.curve === 'pow') return OP('pow', lin, C(1 / k));
  if (spec.curve === 'sym') {
    // (1 + sign(u)|u|^(1/k)) / 2, u running -1..1 across the range.
    const u = OP('sub', OP('mul', lin, C(2)), C(1));
    const sign = OP('sub', OP('gt', u, C(0)), OP('lt', u, C(0)));
    const bent = OP('mul', sign, OP('pow', { k: 'fn', op: 'abs', a: [u] }, C(1 / k)));
    return OP('div', OP('add', C(1), bent), C(2));
  }
  return lin;
}

const NUMBER_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const NOTE_TEXT = /^[a-g](?:#|b|s|f)*-?\d*$/i;

/** A number as somebody would type it: `digits` decimals at most, no trailing zeros. */
function numberText(v, digits) {
  const n = Number(v.toFixed(Math.max(0, Math.min(10, digits))));
  return String(Object.is(n, -0) ? 0 : n);
}

/**
 * A control's new value, written the way the `.param()` argument `written` already writes it - so
 * a turn in a device window can be put back into the code without changing how the code reads:
 *
 *   "-6db"   -> "-20.4db"   a value in units stays in that unit, in the quotes it had
 *   0.4      -> 0.9        a bare number stays a position (an index, for a choice or a switch)
 *   "sine"   -> "saw"      an option stays a name
 *   "c3"     -> "523hz"    a note on a control in hertz is written in hertz
 *
 * `to` is the control as it is now: `{ value }` in the control's own unit, `position` (0..1),
 * `unit` (the control's, e.g. "hz"), `options` and `label` (a choice's names, and the one it is
 * on), `index` (true for a choice or a switch), `decimals` (the readout's). null where `written` is not one plain value -
 * a pattern, a signal, a variable - which the hand does not get to rewrite.
 */
export function restateParamArg(written, to) {
  const text = String(written ?? '').trim();
  const bare = (t) => {
    if (!NUMBER_TEXT.test(t)) return null;
    if (to.index) return String(Math.round(to.value));
    return Number.isFinite(to.position) ? String(Number(to.position.toPrecision(4))) : null;
  };
  if (NUMBER_TEXT.test(text)) return bare(text);
  const q = text[0];
  if ((q !== '"' && q !== "'") || text[text.length - 1] !== q || text.length < 2) return null;
  const inner = text.slice(1, -1);
  if (inner.includes('\\') || inner.includes(q)) return null;
  const quote = (s) => (String(s).includes(q) || String(s).includes('\\') ? JSON.stringify(String(s)) : `${q}${s}${q}`);
  const content = inner.trim();
  const own = unitOf(to.unit);
  const u = /^(-?(?:\d+\.?\d*|\.\d+))(\s*)([a-z]+)$/i.exec(content);
  if (u && UNITS[u[3].toLowerCase()]) {
    const said = unitOf(u[3]);
    if (!own || own.family !== said.family || !Number.isFinite(to.value)) return null;
    // As many decimals as the readout shows, shifted by how much bigger the written unit is.
    const digits = (to.decimals ?? 3) + Math.round(Math.log10(said.scale / own.scale));
    return quote(`${numberText((to.value * own.scale) / said.scale, digits)}${u[2]}${u[3]}`);
  }
  if (NUMBER_TEXT.test(content)) {
    const b = bare(content);
    return b == null ? null : quote(b);
  }
  const named = (o) => String(o).trim().toLowerCase() === content.toLowerCase();
  if (to.label != null && (to.options ?? []).some((o) => o != null && named(o))) return quote(to.label);
  if (own?.family === 'hz' && own.scale === 1 && NOTE_TEXT.test(content) && noteHz(content) != null && Number.isFinite(to.value)) {
    return quote(`${numberText(to.value, to.decimals ?? 0)}hz`);
  }
  return null;
}
