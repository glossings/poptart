'use strict';

// poptart's own devices on the desktop: the catalog, and what a name in a pattern resolves to.
//
// `synth("Plaits")` and `fx("Galactic")` name devices poptart ships rather than plugins the
// machine happens to have - the same devices, with the same controls and the same 0..1 control
// positions, that the browser build plays (packages/web-engine/src/devices/). On the desktop
// they are a scsynth extension (native/devices/) and this is the list of what is in it, written
// by the build that compiles them (packages/web-engine/build/devices/native.mjs) so the catalog
// and the binary can never disagree about what exists or what a control is called.
//
// THE LIST IS WHAT MAKES A NAME A DEVICE. Everything upstream of here - the pattern language,
// the scheduler - passes a name through without caring which kind of thing it names, exactly as
// it does on the web; the engine resolves it, because the engine is the half that knows what it
// can host. A name that is not in here goes on to the plugin scan as it always did.

const fs = require('node:fs');

const { DEVICE_CATALOG } = require('./extensions');

/** Read once: the file ships with the engine and cannot change under a running process. */
let cache;

/** Every device this build of poptart can host, or [] where the catalog is missing. */
function nativeDevices({ catalogPath = DEVICE_CATALOG } = {}) {
  if (cache) return cache;
  try {
    const doc = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    cache = Array.isArray(doc.devices) ? doc.devices : [];
  } catch {
    // No catalog is a legitimate state - a checkout whose device extension was never built -
    // and it means exactly one thing: every name goes to the plugin path, as before.
    cache = [];
  }
  return cache;
}

/** For tests, which write their own catalogs. */
function forgetNativeDevices() {
  cache = undefined;
}

/**
 * The device a pattern's name means, or null.
 *
 * Matched case-insensitively against the id and the display name, which is how a device name
 * resolves everywhere else in poptart (the browser's catalog does the same) - `fx("galactic")`
 * is the same effect as `fx("Galactic")`.
 */
function nativeDevice(name, opts) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const want = name.trim().toLowerCase();
  for (const device of nativeDevices(opts)) {
    if (device.id.toLowerCase() === want) return device;
    if ((device.name ?? '').toLowerCase() === want) return device;
  }
  return null;
}

/**
 * The device's controls as OSC arguments: id, name, id, name...
 *
 * Sent with the load, because this is all sclang needs to turn `.param("LPG Color", 0.3)` into a
 * control index, and it saves the engine's two halves keeping a second copy of the catalog in
 * step. Flat arguments rather than JSON so nothing has to be escaped or parsed: a control name
 * is upstream's own text, and some of it has quotes in.
 */
function deviceParamArgs(device) {
  const out = [];
  for (const p of device.params) {
    out.push(String(p.id));
    out.push(String(p.name));
  }
  return out;
}

/** One of a device's controls, by the id or the display name `.param()` was given. */
function deviceParam(device, name) {
  if (!device || typeof name !== 'string') return null;
  const want = name.trim().toLowerCase();
  for (const p of device.params) {
    if (p.id.toLowerCase() === want || (p.name ?? '').toLowerCase() === want) return p;
  }
  return null;
}

/** Whether a control is a two-state switch, whatever widget it asked for. */
function isToggle(param) {
  return param.ui === 'toggle' || (param.min === 0 && param.max === 1 && param.step === 1 && !param.options);
}

function clampParam(param, value) {
  let v = Number(value);
  if (!Number.isFinite(v)) return param.default;
  if (param.step) v = Math.round(v / param.step) * param.step;
  if (v < param.min) return param.min;
  if (v > param.max) return param.max;
  return v;
}

/** A real value as the 0..1 position its control sits at. */
function normalize(param, value) {
  const v = clampParam(param, value);
  const span = param.max - param.min;
  let t;
  if (param.curve === 'exp') t = Math.log(v / param.min) / Math.log(param.max / param.min);
  else if (param.curve === 'pow') t = ((v - param.min) / span) ** (1 / param.curveExp);
  else t = span === 0 ? 0 : (v - param.min) / span;
  return Math.min(1, Math.max(0, t));
}

function denormalize(param, position) {
  const t = Math.min(1, Math.max(0, Number(position) || 0));
  let v;
  if (param.curve === 'exp') v = param.min * (param.max / param.min) ** t;
  else if (param.curve === 'pow') v = param.min + (param.max - param.min) * t ** param.curveExp;
  else v = param.min + (param.max - param.min) * t;
  return clampParam(param, v);
}

/**
 * THE 0..1 POSITION A `.param()` ARGUMENT MEANS on one of poptart's own controls, or null for an
 * argument the control cannot take.
 *
 * This is descriptor.mjs's argToValue followed by its normalize, and it has to be: the rule for
 * what an argument means is not the same for every kind of control, and a song that means one
 * thing in the browser and another on the desktop is the one thing this port exists to prevent.
 *
 *   - an enum takes its option's LABEL, spelled any way, or a whole-number INDEX. A number is an
 *     index and not a position, which is why this conversion cannot be skipped for being a
 *     no-op: `.param("Engine", 14)` is Plaits' chord engine, and passed through as a position it
 *     would pin the control at the last engine in the list instead.
 *   - a toggle takes 0 or 1, and anything from a half up is on.
 *   - everything else takes a position already, and comes back unchanged but for its clamping.
 *
 * A plugin parameter stays what it was - a bare number, nothing else - and goes nowhere near
 * this: a VST has no labels to resolve and no curve poptart knows.
 */
function paramPosition(device, name, arg) {
  const param = deviceParam(device, name);
  if (!param) return null;
  if (param.options) {
    let index = null;
    if (typeof arg === 'string') {
      const want = arg.trim().toLowerCase();
      const found = param.options.findIndex((o) => String(o).trim().toLowerCase() === want);
      if (found >= 0) index = found;
      else {
        const n = Number(arg);
        index = Number.isInteger(n) && n >= param.min && n <= param.max ? n : null;
      }
    } else {
      const n = Number(arg);
      index = Number.isFinite(n) ? clampParam(param, Math.round(n)) : null;
    }
    return index === null ? null : normalize(param, index);
  }
  const n = Number(arg);
  if (!Number.isFinite(n)) return null;
  if (isToggle(param)) return n >= 0.5 ? 1 : 0;
  return normalize(param, denormalize(param, n));
}

module.exports = {
  nativeDevices,
  nativeDevice,
  deviceParam,
  deviceParamArgs,
  paramPosition,
  forgetNativeDevices,
};
