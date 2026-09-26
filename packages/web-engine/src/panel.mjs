// The generic device panel, as data.
//
// Every web device gets a usable editor window for free: there is no plugin GUI to open, so the
// panel is generated from the descriptor. This module does the deciding and none of the drawing
// - it turns a descriptor plus a value map into a list of sections and widgets, which the
// browser renders and a test can assert on without a DOM.
//
// The layout rule is the descriptor's own `group` field, in declaration order, and its `panel`
// hint says which sections sit beside one another. Nothing here invents sections.

import { argToValue, clampParam, decimalsFor, formatValue, isToggle, normalize, paramGroups, valueToArg } from './descriptor.mjs';
import { buildFigures, subsumedParams } from './figures.mjs';

/** How wide a device window is when its descriptor does not say. */
export const DEFAULT_PANEL_WIDTH = 560;

/**
 * Which widget a parameter gets. The descriptor's `ui` is taken at its word; this only fills in
 * what an honest descriptor leaves implicit, which is the "detect it" half of the job:
 *
 *   - options          -> a select, labeled by the options
 *   - a 0..1 unit step -> a toggle (half of "on" is not a value)
 *   - an unnamed group of one -> still a knob; a lone slider looks like a mistake
 *
 * A device that wants a slider or a number box says so; knobs are the default because a rack of
 * knobs reads as one instrument and a rack of sliders reads as a mixer.
 */
export function widgetFor(param) {
  if (param.options) return 'enum';
  if (param.ui === 'toggle') return 'toggle';
  if (param.ui === 'button') return 'button';
  if (isToggle(param)) return 'toggle';
  return param.ui;
}

/**
 * Builds the panel model for a device.
 *
 * `values` is the current `{ paramId: value }` map in real units (missing entries fall back to
 * the default). `modulated` is the set of parameter ids something is currently driving - a
 * signal piped in with `.param("phase", audio("mod"))`, an LFO, an automation lane. A modulated
 * knob is drawn read-only with its source named, because turning it would only be overwritten on
 * the next block, and because the person wants to know what is moving it.
 *
 * `opts` carries what a figure needs and a knob does not: the synth's own wavetables, the sample
 * rate a response curve is computed at, and `extras` - the option labels a device filled in at
 * run time, past its descriptor's list.
 */
export function buildPanel(descriptor, values = {}, modulated = new Map(), opts = {}) {
  const extras = opts.extras ?? null;
  const figures = buildFigures(descriptor, values, { ...opts, modulated });
  const byGroup = new Map();
  for (const f of figures) {
    if (!byGroup.has(f.group)) byGroup.set(f.group, []);
    byGroup.get(f.group).push(f);
  }
  const subsumed = subsumedParams(descriptor);

  const groups = paramGroups(descriptor);
  const sectioned = new Set(groups.map((g) => g.group));

  // Whether a control that is only live on another one's setting is live right now.
  const liveNow = (p) => {
    if (!p.active) return true;
    const on = descriptor.params.find((x) => x.id === p.active.param);
    if (!on) return true;
    const has = values[on.id] === undefined ? on.default : clampParam(on, values[on.id]);
    return [p.active.is].flat().some((is) => Math.abs(has - argToValue(on, is)) < 1e-9);
  };

  const widgetFor_ = (p) => {
      const raw = values[p.id];
      const value = raw === undefined ? p.default : clampParam(p, raw);
      const driver = modulated instanceof Map ? modulated.get(p.id) : modulated?.[p.id];
      const loaded = extras?.[p.id] ?? null;
      return {
        id: p.id,
        name: p.name,
        widget: widgetFor(p),
        value,
        position: normalize(p, value),
        text: formatValue(p, value, loaded),
        unit: p.unit,
        min: p.min,
        max: p.max,
        step: p.step,
        // Digits after the point, fixed for the whole range, so a number box dragged from one
        // end to the other never changes width (see decimalsFor).
        decimals: decimalsFor(p),
        // An enum's choices: the descriptor's own, then whatever was loaded into its spare slots.
        options: p.options ? optionsWithExtras(p, loaded) : null,
        optionGroups: p.optionGroups,
        takes: p.takes,
        // What a file loaded here becomes, and how many of the options are the device's OWN -
        // the ones past that are files somebody loaded, and the picker tells the two apart.
        sampleAs: p.sampleAs,
        fixed: p.options ? p.options.length : null,
        // A knob is drawn on the parameter's own curve, so an exp frequency knob moves by
        // ratio and the useful end of the range is not squeezed into the last degree of travel.
        curve: p.curve,
        // Can a signal be piped in here? Only a-rate parameters can, and saying so in the panel
        // is how somebody discovers that `.param("phase", audio("mod"))` is available at all.
        modulatable: p.rate === 'a',
        modulatedBy: driver ?? null,
        description: p.description,
        // Where the knob sits when nothing has touched it. A panel needs somewhere to put a
        // control back to, and the descriptor's default is the only honest candidate.
        default: p.default,
        defaultPosition: normalize(p, p.default),
        isDefault: value === p.default,
        // False for a control another one has switched out of the way - a rate knob beside a
        // sync switch that is not on `free`. The panel leaves it out rather than drawing a
        // control nothing reads.
        active: liveNow(p),
      };
  };

  // A control a figure took over is not drawn under it - it is drawn IN it, on the figure's own
  // heading. That is what a table control wants: the name of the table belongs on the picture of
  // the table, and a second copy of it in a row of knobs underneath says nothing twice.
  const byId = new Map(descriptor.params.map((p) => [p.id, p]));
  for (const f of figures) {
    const spec = descriptor.figures.find((x) => x.id === f.id);
    const taken = (spec?.subsumes ?? []).map((role) => byId.get(spec.params[role])).filter(Boolean);
    f.widgets = taken.filter((p) => p.takes).map(widgetFor_);
  }

  const sections = groups.map(({ group, params }) => ({
    title: group,
    figures: byGroup.get(group) ?? [],
    widgets: params.filter((p) => !subsumed.has(p.id)).map(widgetFor_).filter((w) => w.active),
  }));

  // The rows the descriptor asked for, as indexes into `sections`, with any section it did not
  // place given a row of its own after them - so a section added to a device is never lost.
  const placed = new Set();
  const rows = [];
  for (const row of descriptor.panel?.rows ?? []) {
    const indexes = row.map((title) => sections.findIndex((s) => s.title === title)).filter((i) => i >= 0);
    for (const i of indexes) placed.add(i);
    if (indexes.length) rows.push(indexes);
  }
  sections.forEach((s, i) => { if (!placed.has(i)) rows.push([i]); });

  return {
    id: descriptor.id,
    version: descriptor.version,
    // Controls that switch other controls in and out. Moving one of these changes what the
    // window HAS, not just what it reads, so the editor redraws the panel rather than the knob.
    relayoutOn: Object.freeze([...new Set(descriptor.params.filter((p) => p.active).map((p) => p.active.param))]),
    kind: descriptor.kind,
    title: descriptor.id,
    description: descriptor.description,
    width: descriptor.panel?.width ?? DEFAULT_PANEL_WIDTH,
    sections,
    rows,
    // Figures naming a group that holds no parameters at all. There is no section for them to be
    // handed to, so they are drawn above the lot rather than silently dropped. A figure with no
    // group belongs to the ungrouped section, which is a section like any other.
    figures: figures.filter((f) => !sectioned.has(f.group)),
    // Named on the heading's tooltip, and the reason every descriptor is made to carry a license.
    credit: descriptor.vendor === 'poptart' ? null : { vendor: descriptor.vendor, license: descriptor.license, source: descriptor.source },
  };
}

/** An enum's labels with the loaded slots filled in, and the empty ones marked so. */
function optionsWithExtras(param, loaded) {
  const out = [...param.options];
  const capacity = param.capacity ?? param.options.length;
  for (let i = param.options.length; i < capacity; i++) {
    const name = loaded?.[i];
    if (name !== undefined) out[i] = name;
  }
  return out;
}

/**
 * What the panel sends back when a knob moves: the parameter's real value for a 0..1 position.
 * Everything downstream of here deals in real units; the engine turns the value back into the
 * position it stores when it is set.
 */
export function valueFromPosition(descriptor, paramId, position) {
  const param = descriptor.params.find((p) => p.id === paramId);
  if (!param) return null;
  const t = Math.min(1, Math.max(0, Number(position) || 0));
  let v;
  if (param.curve === 'exp') v = param.min * Math.pow(param.max / param.min, t);
  else if (param.curve === 'pow') v = param.min + (param.max - param.min) * Math.pow(t, param.curveExp);
  else v = param.min + (param.max - param.min) * t;
  return clampParam(param, v);
}

/**
 * How a value is written in code: the second argument of the `.param()` call - a position for a
 * sweep, a label for an enum, 0 or 1 for a switch. A loaded sample keeps the name it was loaded
 * by, so the call that comes back is the one that loads it again.
 *
 * Separate from the call around it because the editor has its own writer, which overwrites the
 * argument of a call that is already there rather than appending a second one - so it needs the
 * argument alone as often as it needs the whole call.
 */
export function paramArgFor(descriptor, paramId, value, extras = null) {
  const param = descriptor.params.find((p) => p.id === paramId);
  if (!param) return null;
  const v = clampParam(param, value);
  if (param.options) {
    const i = Math.round(v);
    const loaded = extras?.[paramId]?.[i];
    if (i >= param.options.length && loaded) return JSON.stringify(loaded);
  }
  return valueToArg(param, v);
}

/**
 * The `.param(...)` call a panel edit writes into the buffer. The editor keeps the code as the
 * single source of truth - the same rule the roll and the LFO shape editor keep - so moving a
 * knob has to come back as text somebody could have typed.
 */
export function paramCallFor(descriptor, paramId, value, extras = null) {
  const arg = paramArgFor(descriptor, paramId, value, extras);
  if (arg == null) return null;
  const param = descriptor.params.find((p) => p.id === paramId);
  return `.param(${JSON.stringify(param.name)}, ${arg})`;
}
