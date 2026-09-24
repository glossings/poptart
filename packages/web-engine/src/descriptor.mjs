// The device descriptor - what a web synth or effect tells the rest of poptart about itself.
//
// On desktop a plugin describes itself: VSTPlugin reports its parameter names and the host asks
// for them at scan time. In the browser there is nobody to ask, so every device ships a
// descriptor instead, and that descriptor is the whole contract:
//
//   - `synth("Wavetable")` / `fx("Distort")` resolve an id here,
//   - `.param("Cutoff", 0.5)` resolves a parameter here (by id OR by display name, the way a
//     VST parameter resolves by its real name),
//   - the params panel, the editor's autocomplete and the generic device UI are all generated
//     from this list,
//   - and a later SuperCollider mirror of a web device would match these names and units.
//
// A PARAMETER TAKES 0..1, exactly as a plugin parameter does. That is the rule the pattern
// language is built on - `lfo()` runs 0..1 unless told otherwise, a macro is 0..1, a MIDI control
// is 0..1 - and a device that took Hz where every other control took a position would be the one
// control in the language that a modulator could not be pointed at without a `.range()`. So the
// value `.param()` writes is a position on the control, and the descriptor says what that position
// MEANS: `min`, `max` and `curve` turn it into the real number the DSP wants and the readout prints
// (a cutoff sweeps by ratio, a semitone knob lands on whole steps), and `unit` labels it. The two
// exceptions are the controls that are not a sweep at all: an enum takes its option's label (or an
// index), and a toggle takes 0 or 1. See argToValue() and valueToArg(), which are the two
// directions of that rule and the only place it is written.
//
// The descriptor is also the auto-UI. `ui` says which widget the parameter wants, `group` says
// which panel section it sits in, `unit` labels the readout, and `options` labels an enum's
// values. A device that fills those in honestly gets a usable panel without anybody drawing one.
// A device we wrote can go further and declare `figures` - the pictures its panel draws, bound to
// its own parameters - which is figures.mjs's business rather than this file's.

/** Parameter value curves: how a 0..1 position maps onto the parameter's real range. */
const CURVES = new Set(['lin', 'exp', 'pow']);

/**
 * Widget kinds the generic panel knows how to draw. A `number` is a value dragged up and down or
 * typed in: the honest widget for a count or a transposition, where a knob's sweep says nothing
 * a number does not say better.
 */
const UI_KINDS = new Set(['knob', 'slider', 'toggle', 'enum', 'button', 'number']);

/** Parameter rates: 'a' is per-sample (a signal can drive it), 'k' is per-block. */
const RATES = new Set(['a', 'k']);

/** Device kinds - the two halves of a chain, exactly as synth() and fx() spell them. */
const KINDS = new Set(['synth', 'fx']);

/**
 * What a parameter can be handed besides a number.
 *
 * 'sample' means a string naming a sample - `"pack:3"` or `"pack:kick.wav"` - is accepted and
 * the engine loads that file into the device: a wavetable into an oscillator, an impulse
 * response into a convolver. 'shape' means a drawn curve - `"0,0 0.1,1 1,0"`, the same
 * breakpoint format `lfo()` takes - is accepted and the engine samples it into a table the
 * device reads: a grain's window, drawn rather than picked off a list.
 *
 * Only an enum can take either, since what the string becomes is a new entry on the option
 * list - which is what makes a loaded file or a drawn curve nameable in the code afterwards.
 */
const TAKES = new Set(['sample', 'shape']);

/**
 * Units we attach meaning to. The string is what a readout prints, so it is the real symbol and
 * not a name; '' is a bare number (a normalized depth, a ratio, a count).
 *
 * 'st' is semitones and 'ct' is cents - a musical distance, the same choice .bend() makes, so a
 * detune means the same thing to a sampler, a synth and a person reading the panel.
 */
const UNITS = new Set(['', 'Hz', 'dB', 's', 'ms', '%', 'st', 'ct', 'x', 'bit', 'deg', 'cyc']);

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** A parameter's display name is what `.param()` matches case-insensitively; so is its id. */
function normalizeKey(key) {
  return String(key).trim().toLowerCase();
}

function fail(deviceId, message) {
  throw new Error(`[web-engine] device "${deviceId}": ${message}`);
}

/**
 * Validates and freezes one parameter spec. Everything optional has a default chosen so that the
 * shortest honest spelling - `{ id: 'mix', name: 'Mix', min: 0, max: 1, default: 1 }` - is a
 * complete a-rate knob.
 */
function defineParam(deviceId, spec, seen) {
  if (!spec || typeof spec !== 'object') fail(deviceId, 'each param must be an object');
  const id = String(spec.id ?? '').trim();
  if (!id) fail(deviceId, 'every param needs an id');
  if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/.test(id)) {
    fail(deviceId, `param id "${id}" must be lowercase dotted words, e.g. "osc1.position"`);
  }
  const name = String(spec.name ?? '').trim();
  if (!name) fail(deviceId, `param "${id}" needs a display name`);

  const ui = spec.ui ?? (Array.isArray(spec.options) ? 'enum' : 'knob');
  if (!UI_KINDS.has(ui)) fail(deviceId, `param "${id}" has unknown ui "${ui}"`);

  const rate = spec.rate ?? 'a';
  if (!RATES.has(rate)) fail(deviceId, `param "${id}" has unknown rate "${rate}"`);

  const unit = spec.unit ?? '';
  if (!UNITS.has(unit)) fail(deviceId, `param "${id}" has unknown unit "${unit}"`);

  const curve = spec.curve ?? 'lin';
  if (!CURVES.has(curve)) fail(deviceId, `param "${id}" has unknown curve "${curve}"`);

  let options = null;
  if (spec.options !== undefined) {
    if (!Array.isArray(spec.options) || spec.options.length === 0) {
      fail(deviceId, `param "${id}": options must be a non-empty array of labels`);
    }
    options = spec.options.map((o) => String(o));
  }

  const takes = spec.takes ?? null;
  if (takes !== null && !TAKES.has(takes)) fail(deviceId, `param "${id}" has unknown takes "${takes}"`);
  if (takes && !options) fail(deviceId, `param "${id}" takes a ${takes}, so it needs an option list for the loaded ones to join`);
  // What a loaded sample becomes: 'audio' is played or convolved as it is; 'wavetable' is cut
  // into frames and band-limited before it reaches the device, which is work the engine does on
  // the main thread so the audio thread never pays for it.
  const sampleAs = takes === 'sample' ? (spec.sampleAs ?? 'audio') : null;
  if (sampleAs !== null && !['audio', 'wavetable'].includes(sampleAs)) fail(deviceId, `param "${id}" has unknown sampleAs "${sampleAs}"`);

  // An enum's range is its option list; saying it twice is a chance to disagree. One that takes
  // files may reserve room past its list - `capacity` slots in all - for what gets loaded.
  let capacity = null;
  if (options) {
    capacity = spec.capacity ?? options.length;
    if (!Number.isInteger(capacity) || capacity < options.length) {
      fail(deviceId, `param "${id}": capacity must be a whole number no smaller than the option list`);
    }
  } else if (spec.capacity !== undefined) {
    fail(deviceId, `param "${id}": only an enum has a capacity`);
  }
  const min = options ? 0 : spec.min;
  const max = options ? capacity - 1 : spec.max;
  if (!isFiniteNumber(min) || !isFiniteNumber(max)) fail(deviceId, `param "${id}" needs numeric min and max`);
  if (!(max > min)) fail(deviceId, `param "${id}": max must be above min`);

  const def = spec.default;
  if (!isFiniteNumber(def)) fail(deviceId, `param "${id}" needs a numeric default`);
  if (def < min || def > max) fail(deviceId, `param "${id}": default ${def} is outside ${min}..${max}`);

  if (curve === 'exp' && min <= 0) {
    fail(deviceId, `param "${id}": an exp curve needs min above zero (it maps a ratio)`);
  }
  const curveExp = spec.curveExp ?? 2;
  if (curve === 'pow' && !(isFiniteNumber(curveExp) && curveExp > 0)) {
    fail(deviceId, `param "${id}": a pow curve needs a positive curveExp`);
  }

  // When this control is live at all.
  //
  // A rate knob beside a sync switch is the case: the two say the same thing in different units
  // and only one of them is being read, and a panel that shows both leaves somebody turning the
  // one that does nothing. `active: { param: 'sync', is: 'free' }` says which - the panel draws
  // the control only when the named parameter is on that setting, and swaps them when it moves.
  const active = spec.active === undefined ? null : Object.freeze({
    param: String(spec.active.param ?? ''),
    is: spec.active.is,
  });

  // How many digits after the point the readout prints. The span says it well enough for most
  // controls (see decimalsFor); a parameter whose useful values are all crowded into one end of
  // a long range - a few milliseconds of a ten-second envelope - says so itself.
  const decimals = spec.decimals ?? null;
  if (decimals !== null && !(Number.isInteger(decimals) && decimals >= 0 && decimals <= 6)) {
    fail(deviceId, `param "${id}": decimals must be a whole number from 0 to 6`);
  }

  // `step` quantizes the value. An enum and a toggle are integer-stepped whether they say so or
  // not: half of "mode 3" is not a mode.
  let step = spec.step ?? null;
  if (options || ui === 'toggle') step = 1;
  if (step !== null && !(isFiniteNumber(step) && step > 0)) {
    fail(deviceId, `param "${id}": step must be a positive number`);
  }

  if (seen.has(normalizeKey(id))) fail(deviceId, `duplicate param id "${id}"`);
  if (seen.has(normalizeKey(name))) fail(deviceId, `param name "${name}" collides with another param's id or name`);
  seen.add(normalizeKey(id));
  seen.add(normalizeKey(name));

  return Object.freeze({
    id,
    name,
    min,
    max,
    default: def,
    unit,
    rate,
    ui,
    curve,
    curveExp,
    active,
    decimals,
    step,
    options: options ? Object.freeze(options) : null,
    capacity,
    takes,
    sampleAs,
    group: String(spec.group ?? '').trim() || null,
    description: String(spec.description ?? '').trim() || null,
  });
}

/**
 * The figure kinds a panel can draw, each with the roles it cannot be drawn without.
 *
 * A ROLE is what figures.mjs asks for - 'cutoff', 'attack', 'position' - and a figure maps each
 * one onto a parameter of the device's own. The indirection is the point: the drawing code asks
 * for a role, so a device names its parameters whatever suits it, and two oscillators get the
 * same picture from the same code by pointing the same roles at different parameters. Roles
 * beyond these are optional, read where a device names one and left out where it does not.
 *
 * The list lives here rather than beside the drawing because it is part of the contract a
 * descriptor is checked against, and because a descriptor is bundled into the audio worklet that
 * plays the device - so this file imports nothing it would carry in there unused.
 */
const FIGURE_KINDS = new Map([
  ['wavetable', ['table', 'position']],
  ['unison', ['count', 'detune', 'spread']],
  ['response', ['mode', 'cutoff', 'resonance']],
  ['adsr', ['attack', 'decay', 'sustain', 'release']],
  // A multi-band equalizer's summed response. Its roles are numbered per band - `type1`,
  // `freq1`, `gain1`, `q1` and so on - so the required list is only the count.
  ['eq', ['bands']],
  // A region of the spectrum between two corners.
  ['band', ['low', 'high']],
  // A modulation matrix: roles `m<from>.<to>` per cell and `level<n>` per operator.
  ['matrix', ['ops']],
  // A file, with where it is being read from drawn on it.
  ['sample', ['sample', 'position']],
  // One grain's amplitude across its own length.
  ['grain', ['shape']],
  // What a device is DOING to the level, read from its own report rather than from a control:
  // an auto gain's correction, a compressor's gain reduction. `amount` names the control it
  // explains, so the picture is drawn beside the switch that turns it on.
  ['meter', ['amount']],
  // A compressor's transfer curve: what comes out for what goes in, with the knee drawn and the
  // level it is working at right now marked on it.
  ['transfer', ['threshold', 'ratio']],
]);

/**
 * Validates and freezes one figure spec.
 *
 * Every reference is resolved against the device's own parameters here, at load time, because the
 * failure it prevents is silent: a figure naming a parameter that does not exist draws a picture
 * stuck at a default, which looks like a broken synth rather than like a typo.
 */
function defineFigure(deviceId, spec, params, seen) {
  if (!spec || typeof spec !== 'object') fail(deviceId, 'each figure must be an object');
  const id = String(spec.id ?? '').trim();
  if (!id) fail(deviceId, 'every figure needs an id');
  if (seen.has(id)) fail(deviceId, `duplicate figure id "${id}"`);
  seen.add(id);

  const kind = String(spec.kind ?? '').trim();
  if (!FIGURE_KINDS.has(kind)) {
    fail(deviceId, `figure "${id}" has unknown kind "${kind}" (known: ${[...FIGURE_KINDS.keys()].join(', ')})`);
  }

  const roles = {};
  for (const [role, paramId] of Object.entries(spec.params ?? {})) {
    if (!params.some((p) => p.id === paramId)) {
      fail(deviceId, `figure "${id}" names parameter "${paramId}", which this device does not have`);
    }
    roles[role] = paramId;
  }
  if (kind === 'eq') {
    const bands = Number(spec.bands);
    if (!Number.isInteger(bands) || bands < 1) fail(deviceId, `figure "${id}" (eq) needs a band count`);
    for (let b = 1; b <= bands; b++) {
      for (const role of ['type', 'freq', 'gain', 'q']) {
        if (!roles[`${role}${b}`]) fail(deviceId, `figure "${id}" (eq) needs a parameter for "${role}${b}"`);
      }
    }
  } else if (kind === 'matrix') {
    const ops = Number(spec.ops);
    if (!Number.isInteger(ops) || ops < 1) fail(deviceId, `figure "${id}" (matrix) needs an operator count`);
    for (let a = 1; a <= ops; a++) {
      if (!roles[`level${a}`]) fail(deviceId, `figure "${id}" (matrix) needs a parameter for "level${a}"`);
      for (let b = 1; b <= ops; b++) {
        if (!roles[`m${a}.${b}`]) fail(deviceId, `figure "${id}" (matrix) needs a parameter for "m${a}.${b}"`);
      }
    }
  } else {
    for (const role of FIGURE_KINDS.get(kind)) {
      if (!roles[role]) fail(deviceId, `figure "${id}" (${kind}) needs a parameter for "${role}"`);
    }
  }

  // Roles whose knobs the figure replaces rather than joins: the whole reason to draw an envelope
  // as a curve is to stop drawing its four knobs, and the panel needs telling which four.
  const subsumes = (spec.subsumes ?? []).map((role) => {
    if (!roles[role]) fail(deviceId, `figure "${id}" subsumes "${role}", which it has no parameter for`);
    return role;
  });

  // Which roles a drag across the figure moves. A figure with no `drag` is a readout that follows
  // the knobs; one with it takes the same gesture a knob takes, on the same terms.
  const drag = spec.drag ? Object.freeze({ ...spec.drag }) : null;
  if (drag) {
    for (const role of Object.values(drag)) {
      if (!roles[role]) fail(deviceId, `figure "${id}" drags "${role}", which it has no parameter for`);
    }
  }

  return Object.freeze({
    id,
    kind,
    // Which panel section the figure is drawn at the head of. One with no group is drawn above
    // every section, which is what a device with a single picture and no sections wants.
    group: String(spec.group ?? '').trim() || null,
    title: String(spec.title ?? '').trim() || null,
    description: String(spec.description ?? '').trim() || null,
    params: Object.freeze(roles),
    bands: kind === 'eq' ? Number(spec.bands) : null,
    // A meter's scale, in decibels. Its own rather than shared: a gain reduction runs from zero
    // downwards and an auto gain runs both ways.
    range: kind === 'meter' ? Object.freeze([...(spec.range ?? [-24, 24])]) : null,
    ops: kind === 'matrix' ? Number(spec.ops) : null,
    subsumes: Object.freeze(subsumes),
    drag,
  });
}

/**
 * The panel layout a device may ask for: how wide its window is, and which sections sit beside
 * one another. Without it every section is a row of its own, which is the right answer for a
 * ported module with one section and the wrong one for a synth whose two oscillators are twins.
 */
function definePanel(deviceId, spec, params) {
  if (spec === undefined) return null;
  if (!spec || typeof spec !== 'object') fail(deviceId, 'panel must be an object');
  const width = spec.width ?? null;
  if (width !== null && !(isFiniteNumber(width) && width >= 320)) fail(deviceId, 'panel width must be at least 320');
  const groups = new Set(params.map((p) => p.group));
  const rows = (spec.rows ?? []).map((row) => {
    if (!Array.isArray(row) || row.length === 0) fail(deviceId, 'each panel row is a non-empty list of section names');
    for (const g of row) if (!groups.has(g)) fail(deviceId, `panel row names section "${g}", which no parameter is in`);
    return Object.freeze([...row]);
  });
  return Object.freeze({ width, rows: Object.freeze(rows) });
}

/**
 * Validates and freezes a device descriptor.
 *
 * `id` is what userland types - capitalized product-style ("Wavetable", "Plaits", "Galactic"),
 * lowercase only where the project that wrote the DSP stylizes it that way. It is matched
 * case-insensitively at lookup so nobody has to remember the capitals.
 *
 * `version` is the sound's version. A shipped device's sound is frozen because shared songs
 * depend on it, so an improvement that changes what a song sounds like is a new version (or a
 * new id), never an edit in place - see the registry, which keeps every version registered.
 */
export function defineDevice(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('[web-engine] defineDevice() needs a descriptor object');
  const id = String(spec.id ?? '').trim();
  if (!id) throw new Error('[web-engine] every device needs an id');
  if (!/^[A-Za-z][A-Za-z0-9 .+-]*$/.test(id)) {
    throw new Error(`[web-engine] device id "${id}" must start with a letter and hold only letters, digits, spaces, dots, + and -`);
  }

  const kind = spec.kind;
  if (!KINDS.has(kind)) fail(id, `kind must be "synth" or "fx", not ${JSON.stringify(kind)}`);

  const version = spec.version ?? 1;
  if (!Number.isInteger(version) || version < 1) fail(id, 'version must be a positive integer');

  const seen = new Set();
  const paramSpecs = Array.isArray(spec.params) ? spec.params : [];
  const params = paramSpecs.map((p) => defineParam(id, p, seen));
  // `active` names another control, so it can only be checked once they all exist.
  for (const p of params) {
    if (!p.active) continue;
    const on = params.find((x) => x.id === p.active.param);
    if (!on) fail(id, `param "${p.id}" is active on "${p.active.param}", which this device does not have`);
    if (argToValue(on, p.active.is) === null) fail(id, `param "${p.id}" is active on "${p.active.param}" being ${JSON.stringify(p.active.is)}, which is not one of its values`);
  }

  // Pictures the panel draws instead of, or as well as, some of those knobs - see figures.mjs,
  // which owns what each kind means. A device that declares none gets the knobs and nothing else,
  // which is the right answer for a ported module whose controls are a list.
  const figureSpecs = Array.isArray(spec.figures) ? spec.figures : [];
  const figureIds = new Set();
  const figures = figureSpecs.map((f) => defineFigure(id, f, params, figureIds));
  // There is no separate list of signal inputs: a parameter a signal can drive IS one, and a
  // device that wants phase modulation gives its phase a knob. See signalDestinations().
  if (spec.inputs !== undefined) fail(id, 'inputs are not a thing - an a-rate param is a signal destination already');

  const channels = {
    in: spec.channels?.in ?? (kind === 'fx' ? 2 : 0),
    out: spec.channels?.out ?? 2,
  };
  if (!Number.isInteger(channels.in) || channels.in < 0) fail(id, 'channels.in must be a non-negative integer');
  if (!Number.isInteger(channels.out) || channels.out < 1) fail(id, 'channels.out must be a positive integer');
  if (kind === 'fx' && channels.in === 0) fail(id, 'an fx device needs an input');

  // A second audio input, fed by `.audio("other")` on the effect: the carrier for a cross-
  // modulator, the key for a ducker. It is a separate port on the node rather than two more
  // channels, so the track's own signal and the other one never get mixed up.
  const sidechain = spec.sidechain === true;
  if (sidechain && kind !== 'fx') fail(id, 'only an effect can take a sidechain');

  const license = String(spec.license ?? '').trim();
  if (!license) fail(id, 'every device records its license (it ends up in the About screen)');

  return Object.freeze({
    id,
    kind,
    version,
    license,
    vendor: String(spec.vendor ?? 'poptart').trim(),
    source: String(spec.source ?? '').trim() || null,
    description: String(spec.description ?? '').trim() || null,
    // How the engine builds the node: 'worklet' names an AudioWorkletProcessor, 'nodes' means a
    // builder function assembles stock Web Audio nodes, 'wasm' is a compiled worklet that loads
    // its own binary.
    build: spec.build ?? 'worklet',
    processor: String(spec.processor ?? '').trim() || null,
    channels: Object.freeze(channels),
    sidechain,
    params: Object.freeze(params),
    figures: Object.freeze(figures),
    panel: definePanel(id, spec.panel, params),
    // Free-form, device-specific setup the engine hands the processor at construction
    // (wavetable frames, an impulse response name). Never automation.
    options: Object.freeze({ ...(spec.options ?? {}) }),
  });
}

/**
 * Finds a parameter by id or display name, case-insensitively, exactly the way `.param()` finds
 * a VST parameter by its real name. Returns null when nothing matches - the caller decides
 * whether that is a warning or an error (userland mistakes warn and keep playing).
 */
export function findParam(descriptor, key) {
  if (!descriptor || key == null) return null;
  const want = normalizeKey(key);
  for (const p of descriptor.params) {
    if (normalizeKey(p.id) === want || normalizeKey(p.name) === want) return p;
  }
  return null;
}

/**
 * Anything a signal can be piped into: every a-rate param. This is the list
 * `.param("Osc 1 Phase", audio("mod"))` checks against, and the one the panel marks as
 * modulatable.
 */
export function signalDestinations(descriptor) {
  const out = [];
  for (const p of descriptor.params) if (p.rate === 'a') out.push({ id: p.id, name: p.name });
  return out;
}

/** Clamps to the parameter's range and applies its step. */
export function clampParam(param, value) {
  let v = Number(value);
  if (!Number.isFinite(v)) return param.default;
  if (param.step) v = Math.round(v / param.step) * param.step;
  if (v < param.min) return param.min;
  if (v > param.max) return param.max;
  return v;
}

/**
 * 0..1 position to a real value. `exp` is the ratio sweep a frequency wants (20 Hz to 20 kHz
 * feels linear on a log knob); `pow` bends a linear range so the useful end gets more travel (a
 * 0..1 depth where everything happens below 0.2).
 *
 * This is the one function that gives a `.param()` value its meaning, and every device applies
 * it on the audio thread: a control arrives as a position and leaves this as the number the DSP
 * reads. The knob and the readout go through the same function, so the three can never disagree.
 */
export function denormalize(param, position) {
  const t = Math.min(1, Math.max(0, Number(position) || 0));
  let v;
  if (param.curve === 'exp') {
    v = param.min * Math.pow(param.max / param.min, t);
  } else if (param.curve === 'pow') {
    v = param.min + (param.max - param.min) * Math.pow(t, param.curveExp);
  } else {
    v = param.min + (param.max - param.min) * t;
  }
  return clampParam(param, v);
}

/** The inverse of denormalize(): a real value to the 0..1 position its control sits at. */
export function normalize(param, value) {
  const v = clampParam(param, value);
  let t;
  if (param.curve === 'exp') {
    t = Math.log(v / param.min) / Math.log(param.max / param.min);
  } else if (param.curve === 'pow') {
    t = Math.pow((v - param.min) / (param.max - param.min), 1 / param.curveExp);
  } else {
    t = (v - param.min) / (param.max - param.min);
  }
  return Math.min(1, Math.max(0, t));
}

/** Whether a parameter is a two-state switch, whatever widget it asked for. */
export function isToggle(param) {
  return param.ui === 'toggle' || (param.min === 0 && param.max === 1 && param.step === 1 && !param.options);
}

/**
 * What a `.param()` argument means, as the parameter's real value - or null for one it cannot
 * take, which the caller turns into the warning userland sees.
 *
 *   - an enum takes its option's label, spelled any way, or a whole-number index;
 *   - a toggle takes 0 or 1 (anything from a half up is on);
 *   - everything else takes a 0..1 position on its curve.
 *
 * A parameter that takes a sample is not resolved here: a string that is not one of its labels
 * names a file, and loading one is the engine's business.
 */
export function argToValue(param, arg) {
  if (param.options) {
    if (typeof arg === 'string') {
      const want = normalizeKey(arg);
      const index = param.options.findIndex((o) => normalizeKey(o) === want);
      if (index >= 0) return index;
      const n = Number(arg);
      return Number.isInteger(n) && n >= param.min && n <= param.max ? n : null;
    }
    const n = Number(arg);
    if (!Number.isFinite(n)) return null;
    return clampParam(param, Math.round(n));
  }
  const n = Number(arg);
  if (!Number.isFinite(n)) return null;
  if (isToggle(param)) return n >= 0.5 ? 1 : 0;
  return denormalize(param, n);
}

/**
 * The other direction: a real value as the argument somebody would write in a `.param()` call.
 * An enum is written as its label, so a reordering of the option list cannot change a song; a
 * position is written with no more digits than a knob can be set to.
 */
export function valueToArg(param, value) {
  const v = clampParam(param, value);
  if (param.options) return JSON.stringify(param.options[Math.round(v)] ?? String(Math.round(v)));
  if (isToggle(param)) return v >= 0.5 ? '1' : '0';
  return trimNumber(normalize(param, v));
}

/** A number with no trailing zero noise - what somebody would have typed. */
export function trimNumber(v) {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(4)));
}

/** Every parameter's default, as the `{ id: value }` map the engine sets a fresh device to. */
export function defaultValues(descriptor) {
  const out = {};
  for (const p of descriptor.params) out[p.id] = p.default;
  return out;
}

/** The same map as positions, which is what a processor is handed and what a test hands one. */
export function positionsOf(descriptor, values = {}) {
  const out = {};
  for (const p of descriptor.params) out[p.id] = normalize(p, values[p.id] ?? p.default);
  return out;
}

/**
 * Parameters in panel order, split into their `group`s. Ungrouped parameters come first under a
 * null heading, which is what a small device (one row of knobs, no sections) wants.
 */
export function paramGroups(descriptor) {
  const order = [];
  const byGroup = new Map();
  for (const p of descriptor.params) {
    const g = p.group;
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g).push(p);
  }
  return order.map((g) => ({ group: g, params: byGroup.get(g) }));
}

/**
 * How many digits after the point a readout prints, FIXED for the whole of a parameter's range.
 *
 * Fixed rather than significant: a knob is turned while its number is being read, and significant
 * figures change the number's WIDTH as it moves - 999.9 to 1000 to 1001 - so every readout on the
 * panel shifts sideways on each frame of the drag and the whole window flickers. A width that
 * never changes is worth more here than a digit at the quiet end of the range.
 *
 * The count comes from the span, since that is what says how fine a reading is worth printing: a
 * 0..1 depth wants three decimals and a 20 Hz to 20 kHz cutoff wants none.
 */
export function decimalsFor(param) {
  if (param.decimals !== null) return param.decimals;
  if (param.step && Number.isInteger(param.step)) return 0;
  const span = Math.abs(param.max - param.min);
  if (span >= 100) return 0;
  if (span >= 10) return 1;
  if (span >= 2) return 2;
  return 3;
}

/**
 * How a value prints in a readout: the unit appended, an enum printed as its label. Shared by the
 * panel and by any log line that quotes a parameter, so a value reads the same everywhere.
 * `extras` names the option slots a device filled at run time, past the descriptor's own list.
 */
export function formatValue(param, value, extras = null) {
  const v = clampParam(param, value);
  if (param.options) {
    const i = Math.round(v);
    return param.options[i] ?? extras?.[i] ?? (i < (param.capacity ?? param.options.length) ? 'empty' : String(v));
  }
  if (param.ui === 'toggle') return v >= 0.5 ? 'on' : 'off';
  // Trailing zeros kept on purpose - stripping them is the same width problem again.
  const text = v.toFixed(decimalsFor(param));
  return param.unit ? `${text} ${param.unit}` : text;
}
