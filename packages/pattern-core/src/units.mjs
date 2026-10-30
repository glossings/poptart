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

/**
 * One value as the control's position. A number is in the signal's unit; a note name on a
 * control in hertz is that note's frequency (c3 = MIDI 60). Anything else is passed as it is.
 */
export function unitPosition(conv, value) {
  if (typeof value === 'number') return position(conv.spec, value / conv.divide);
  if (typeof value === 'string') {
    const u = parseUnitValue(value);
    if (u) return position(conv.spec, u.value / conv.divide);
  }
  return value;
}

/** A note name's frequency, for a control in hertz, or null. */
export function noteHz(value) {
  if (typeof value !== 'string' || !/^[a-g]/i.test(value.trim())) return null;
  const midi = noteToMidi(value.trim());
  return Number.isFinite(midi) ? 440 * Math.pow(2, (midi - 69) / 12) : null;
}

const C = (v) => ({ k: 'const', v });
const OP = (op, a, b) => ({ k: 'op', op, a: [a, b] });

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
