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
let internalCache;

function readCatalog(catalogPath) {
  try {
    const doc = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    cache = Array.isArray(doc.devices) ? doc.devices : [];
    internalCache = Array.isArray(doc.internal) ? doc.internal : [];
  } catch {
    // No catalog is a legitimate state - a checkout whose device extension was never built -
    // and it means exactly one thing: every name goes to the plugin path, as before.
    cache = [];
    internalCache = [];
  }
}

/** Every device this build of poptart can host, or [] where the catalog is missing. */
function nativeDevices({ catalogPath = DEVICE_CATALOG } = {}) {
  if (!cache) readCatalog(catalogPath);
  return cache;
}

/**
 * A device the engine builds for itself (a .bands() crossover), by id, or null. Kept apart from
 * nativeDevices: no name a pattern writes, no device list and no completion reaches one.
 */
function internalDevice(id, { catalogPath = DEVICE_CATALOG } = {}) {
  if (!internalCache) readCatalog(catalogPath);
  return internalCache.find((d) => d.id === id) ?? null;
}

/** For tests, which write their own catalogs. */
function forgetNativeDevices() {
  cache = undefined;
  internalCache = undefined;
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
 * The device's controls as OSC arguments: id, name, default position, id, name, default position...
 *
 * Sent with the load, because this is all sclang needs to turn `.param("LPG Color", 0.3)` into a
 * control index, and it saves the engine's two halves keeping a second copy of the catalog in
 * step. Flat arguments rather than JSON so nothing has to be escaped or parsed: a control name
 * is upstream's own text, and some of it has quotes in.
 *
 * The default is there because the controller answers "where is this control" from its own
 * record (PoptartDevice.sc's `get`, which .hold()/.release() read), and the UGen opens every
 * control at its default - so the record has to start there too, not at 0. Position 0 is the
 * bottom of the range: -24 semitones on Shift's pitch, not no shift.
 */
function deviceParamArgs(device) {
  const out = [];
  for (const p of device.params) {
    out.push(String(p.id));
    out.push(String(p.name));
    out.push(normalize(p, p.default));
  }
  return out;
}

/**
 * A device's settings as a captured state - THE BROWSER'S FORMAT, byte for byte in shape: the
 * device, its version, every control by id in real units, and the file each file-playing control
 * is pointed at (web-audio-engine.mjs's getPluginState). Base64 of the JSON, no compression, as
 * the browser writes it. One format is what lets a preset made on either engine open on the
 * other: a song is the same song wherever it is played.
 *
 * `positions` is by control id, 0..1; `files` is by control id, option slot -> the reference
 * loaded there (the engine's deviceSlot answers both).
 */
function deviceStateText(device, positions = {}, files = {}) {
  const params = {};
  const refs = {};
  for (const p of device.params) {
    // A control that is a gesture rather than part of the sound (a looper's Record) is never
    // saved: a song saved mid-gesture would replay it when opened.
    if (p.saved === false) continue;
    const value = denormalize(p, positions[p.id] ?? normalize(p, p.default));
    // Trimmed to what a control can mean, so a linear 0 does not come back as -1.8e-15.
    params[p.id] = Number(value.toFixed(6));
    if (p.takes) {
      const ref = files[p.id]?.[Math.round(value)];
      if (ref) refs[p.id] = ref;
    }
  }
  const json = JSON.stringify({ device: device.id, version: device.version, params, files: refs });
  return Buffer.from(json, 'utf8').toString('base64');
}

/**
 * A state saved by an earlier version of a device, as the current version would have saved it:
 * the parameter map with renamed, merged or split controls brought across.
 *
 * The browser's descriptors carry this as each device's `migrate` (descriptor.mjs's
 * migrateState), which this engine cannot load - the catalog it reads is data. So the mappings
 * are written out again here, one per device version that changed shape, and
 * native-devices.test.js holds them to the browser's. A state at the current version, or of a
 * device that never changed, passes through untouched.
 */
function migrateDeviceState(device, doc) {
  const from = Number.isInteger(doc.version) && doc.version >= 1 ? doc.version : 1;
  const params = { ...doc.params };
  if (device.id === 'FreqShift' && from < 2) {
    // v1 had an unsigned Freq and an up/down/split Direction; v2 has a signed Freq and a Wide
    // switch (split = the right channel the other way).
    const direction = Math.round(Number(params.direction ?? params.Direction) || 0);
    const freq = Number(params.freq ?? params.Freq);
    delete params.direction; delete params.Direction;
    if (Number.isFinite(freq)) params.freq = direction === 1 ? -freq : freq;
    params.wide = direction === 2 ? 1 : 0;
  }
  return params;
}

/**
 * A captured state read back for one device: where each control it names goes, as positions,
 * and the files it points controls at - or null when it is not a state of this device at all.
 *
 * Reads the browser's format, which is also what the desktop now writes (deviceStateText): real
 * units by control id. A display name is accepted where an id is expected, as `.param()` accepts
 * both. Controls the state does not name keep where they are; names the device does not have
 * (a state from a later version) are skipped.
 */
function readDeviceState(device, doc) {
  if (!doc || typeof doc !== 'object' || !doc.params || typeof doc.params !== 'object') return null;
  if (doc.device != null && String(doc.device).toLowerCase() !== device.id.toLowerCase()) return null;
  const positions = {};
  for (const [name, value] of Object.entries(migrateDeviceState(device, doc))) {
    const p = deviceParam(device, name);
    if (!p || p.saved === false || typeof value !== 'number' || !Number.isFinite(value)) continue;
    positions[p.id] = normalize(p, value);
  }
  const files = {};
  for (const [name, ref] of Object.entries(doc.files ?? {})) {
    const p = deviceParam(device, name);
    if (p?.takes && p.saved !== false && typeof ref === 'string' && ref) files[p.id] = ref;
  }
  return { positions, files };
}

/**
 * A device's answer to /report, read back: where each control is, by id, and what the device says
 * it is doing, in the shape the browser's processor reports it (its report()) - or null.
 *
 * `values` is what the UGen sent, past the request id: [count, position..., reportCount,
 * report...] (PoptartDevice.cpp's report), with a count of -1 for no answer. The positions are
 * the device's own reading of its controls, so a control a modulator is moving is where the
 * modulator has got to. The report's layout is each device's own (its pd_report), and only the
 * devices that have one are read here.
 */
function readDeviceLive(device, values) {
  if (!Array.isArray(values) || !(values[0] >= 0)) return null;
  const count = values[0];
  const positions = {};
  for (let i = 0; i < count && i < device.params.length; i++) {
    const v = values[1 + i];
    if (Number.isFinite(v)) positions[device.params[i].id] = v;
  }
  const reportCount = Number(values[1 + count]) || 0;
  const raw = values.slice(2 + count, 2 + count + reportCount);
  return { positions, report: readReport(device.id, raw) };
}

/** One device's pd_report floats, as the browser's processor reports the same thing. */
function readReport(id, raw) {
  if (!raw.length) return null;
  switch (id) {
    case 'Granular': {
      // Four floats a grain: where it started and how far through its life it is, its pan, and
      // the stretch of the file it plays (own/granular.cc's pd_report).
      const grains = [];
      for (let i = 0; i + 4 <= raw.length; i += 4) grains.push(raw.slice(i, i + 4));
      return { grains };
    }
    case 'Distort':
      return { meters: { autogain: raw[0], level: raw[1] } };
    case 'Compressor':
    case 'Limiter': {
      const curve = curveLane(raw);
      return curve ? { meters: { curve } } : null;
    }
    case 'Multiband': {
      // Three lanes in turn, low, mid, high - each under the id of the picture it is drawn on.
      const meters = {};
      let at = 0;
      for (const band of ['low', 'mid', 'high']) {
        const lane = curveLane(raw, at);
        if (!lane) return null;
        meters[`${band}.curve`] = lane;
        at += 5 + 2 * lane.history.inDb.length;
      }
      return { meters };
    }
    case 'Ducker':
      return duckLane(raw);
    case 'Filterbank':
    case 'Resonator': {
      // Every sounding band: the count, then each one's frequency, then each one's level
      // (own/dsp/filterbank.h's BandBank::report) - the browser's { bands: { hz, level } }.
      const n = Number(raw[0]) | 0;
      if (!(n >= 0) || raw.length < 1 + 2 * n) return null;
      return { bands: { hz: raw.slice(1, 1 + n), level: raw.slice(1 + n, 1 + 2 * n) } };
    }
    case 'Chorus':
    case 'Flanger':
    case 'Phaser':
      // Where the LFO is, in cycles: the playhead on the sweep's picture.
      return Number.isFinite(raw[0]) ? { phase: raw[0] } : null;
    default:
      return null;
  }
}

/**
 * A ducker's lane as own/ducker.cc's pd_report lays it out - whether anything drives the dip,
 * what does (0 the clock, 1 notes, 2 audio), the count written, the seconds an entry stands
 * for, the ring length, the transport seconds at the newest entry, then the gain, output and
 * key rings - in the shape the browser's ducker reports. The key ring is only there while
 * something is keying, as in the browser.
 */
function duckLane(raw) {
  const n = Number(raw[4]) | 0;
  if (!(n > 0) || raw.length < 6 + 3 * n) return null;
  const keyed = raw[0] >= 0.5;
  const trigger = raw[1] >= 1.5 ? 'audio' : raw[1] >= 0.5 ? 'notes' : 'clock';
  return {
    history: { gain: raw.slice(6, 6 + n), out: raw.slice(6 + n, 6 + 2 * n), key: keyed ? raw.slice(6 + 2 * n, 6 + 3 * n) : null, end: raw[2], blockSec: raw[3], at: raw[5] },
    keyed,
    trigger,
  };
}

/**
 * A dynamics lane as own/dsp/history.h's reportCurveLane lays it out - the level in and the gain
 * reduction now, how many entries the rings have written, the seconds an entry stands for, the
 * ring length, then the level ring and the reduction ring - in the shape the browser's compressor
 * reports (its report().meters.curve), which is what the transfer figure reads. Null for an
 * answer cut short.
 */
function curveLane(raw, from = 0) {
  const n = Number(raw[from + 4]) | 0;
  if (!(n > 0) || raw.length < from + 5 + 2 * n) return null;
  return {
    inDb: raw[from], grDb: raw[from + 1],
    history: { inDb: raw.slice(from + 5, from + 5 + n), grDb: raw.slice(from + 5 + n, from + 5 + 2 * n), end: raw[from + 2], blockSec: raw[from + 3] },
  };
}

/**
 * The devices in the shape the editor reads a PLUGIN row in: the list the plugin browser draws
 * and the list `synth("`/`fx("` completes against.
 *
 * Devices are offered beside the plugins rather than in a list of their own because to whoever is
 * typing they are the same decision - what goes in this slot - and because a device that is not
 * in that list is a feature nobody can find. The browser build hands over exactly this shape
 * (web-app/public/web/host.mjs, devicesAsPlugins), down to the "built in" format, so a row reads
 * the same on either engine.
 */
function deviceRows(opts) {
  return nativeDevices(opts).map((d) => ({
    name: d.name ?? d.id,
    format: 'built in',
    isInstrument: d.kind === 'synth',
  }));
}

/**
 * A device's controls as the params endpoints answer: what `.param("…` completes against, and
 * what the params panel draws.
 *
 * Answered from the catalog rather than by asking the engine, which is the difference between a
 * control list that is there as soon as the name is typed and one that waits for the device to
 * open. The index is the position in this list, which is the index every other path on the
 * desktop addresses a control by (see PoptartDeviceDesc.findParamIndex).
 */
function deviceParamRows(device) {
  if (!device) return [];
  return device.params.map((p, index) => ({
    name: p.name ?? p.id,
    label: p.unit ?? '',
    index,
    id: p.id,
    min: p.min,
    max: p.max,
    default: p.default,
    ui: p.ui ?? null,
    options: p.options ? [...p.options] : null,
    rate: p.rate ?? null,
  }));
}

/**
 * Where every control of a freshly loaded device rests, by control id, as positions.
 *
 * The UGen holds a control at its default until something moves it, so this is what the engine
 * knows about a slot the moment it is filled - and what a device window opened before any
 * `.param()` has run has to draw. Positions rather than values because a position is what the
 * engine sends, what a modulator speaks in, and what every other half of this already carries.
 */
function devicePositions(device) {
  const out = {};
  if (!device) return out;
  for (const p of device.params) out[p.id] = normalize(p, p.default);
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
  // An open control (descriptor.mjs's: an enum that takes files, a voice count) has no top.
  if (v > param.max && !param.open) return param.max;
  return v;
}

/** A real value as the 0..1 position its control sits at. */
function normalize(param, value) {
  const v = clampParam(param, value);
  const span = param.max - param.min;
  let t;
  if (param.curve === 'exp') t = Math.log(v / param.min) / Math.log(param.max / param.min);
  else if (param.curve === 'pow') t = ((v - param.min) / span) ** (1 / param.curveExp);
  else if (param.curve === 'sym') {
    const u = (v - (param.min + param.max) / 2) / (span / 2);
    t = (1 + Math.sign(u) * Math.abs(u) ** (1 / param.curveExp)) / 2;
  } else t = span === 0 ? 0 : (v - param.min) / span;
  return Math.min(param.open ? Infinity : 1, Math.max(0, t));
}

function denormalize(param, position) {
  const t = Math.min(param.open ? Infinity : 1, Math.max(0, Number(position) || 0));
  let v;
  if (param.curve === 'exp') v = param.min * (param.max / param.min) ** t;
  else if (param.curve === 'pow') v = param.min + (param.max - param.min) * t ** param.curveExp;
  else if (param.curve === 'sym') {
    const u = 2 * t - 1;
    v = (param.min + param.max) / 2 + ((param.max - param.min) / 2) * Math.sign(u) * Math.abs(u) ** param.curveExp;
  } else v = param.min + (param.max - param.min) * t;
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
 *   - an open count (a synth's voices) takes the count itself, past the knob's reach too.
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
        index = Number.isInteger(n) && n >= param.min && (param.open || n <= param.max) ? n : null;
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
  // An open count is the count; a fraction strictly between 0 and 1 is a position written before
  // it was open, and means what it meant then, across the range it had (descriptor.mjs's
  // argToValue, rule for rule).
  if (param.open) {
    const legacy = param.legacyMax != null && n > 0 && n < 1;
    return normalize(param, clampParam(param, legacy ? param.min + (param.legacyMax - param.min) * n : n));
  }
  return normalize(param, denormalize(param, n));
}

module.exports = {
  internalDevice,
  nativeDevices,
  nativeDevice,
  deviceParam,
  deviceParamArgs,
  deviceParamRows,
  devicePositions,
  deviceRows,
  deviceStateText,
  readDeviceState,
  readDeviceLive,
  readReport,
  paramPosition,
  forgetNativeDevices,
};
