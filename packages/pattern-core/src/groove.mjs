// Grooves - the general case of swing, as a per-slot table rather than one number.
//
// Swing delays the offbeats of a subdivision and leaves the onbeats alone (see timeShift), which is
// one shape out of many: a table saying what EVERY slot of a grid does covers it and everything
// else a groove can be. A standard swing is the alternating table, a named groove is a stored one, a
// drawn groove is one penciled by hand, and a groove taken off a recording is one that was measured.
// So the table is the model, and the amount a plain depth multiplier on it: offset = depth * value.
//
// Format: space-separated per-slot values, one per slot of a grid covering ONE cycle, so the table's
// own length is the grid - "0 1 0 1 0 1 0 1" is eight slots with the offbeats displaced. A velocity
// row follows after a slash, as many values again:
//
//   "0 0.33 0 0.33"                    four slots, the odd ones displaced by a third of a unit
//   "0 1 0 1 / 1 0.8 1 0.8"            ...and the odd ones a fifth quieter
//
//   time - how far the slot moves, in units the depth scales, where 1 is a whole slot. A slot's
//          offset is depth * value and clamps to half a slot, since past that it has swapped places
//          with the slot after it. Negative plays early.
//   vel  - what the slot does to velocity, as a multiplier: 1 leaves it alone. Optional; a table
//          with no velocity row leaves every velocity as it was.
//
// Time offsets are in fractions of a SLOT rather than of the event's own step, which is what makes a
// groove mean the same thing to a pattern of quarters and a pattern of sixteenths played under it -
// both are moved by where they sit in the bar, not by how finely they were written. It is also why a
// table describes one cycle and is not warped by .fast()/.slow(): a groove belongs to the bar, not
// to the phase of the pattern riding on it.

// A groove name has letters in it and a table does not, which is the whole discriminator: the amount
// position of .swing() takes numbers and patterns of numbers, and neither can contain a letter.
// Same question, and the same kind of answer, as looksLikeShapeData asks for lfo().
export function looksLikeGrooveData(str) {
  const text = String(str).trim();
  if (!text) return false;
  return /\d/.test(text) && !/[a-z]/i.test(text);
}

/** Whether this string names a groove rather than holding one: a plain word, possibly with digits. */
export function grooveNameLike(str) {
  return /^[a-z][a-z0-9_-]*$/i.test(String(str).trim());
}

/**
 * A groove table from its text, or from a preset's name. Returns `{ steps, time, vel }` with `time`
 * as many values as there are slots and `vel` either the same length or null.
 */
export function parseGroove(str) {
  const text = String(GROOVE_PRESETS[String(str).trim()] ?? str).trim();
  if (!text) throw new Error('[groove] a groove needs at least one slot, e.g. "0 1 0 1"');
  const rows = text.split('/');
  if (rows.length > 2) throw new Error('[groove] a groove holds one row of offsets, or two with velocities after a "/"');
  const [time, vel] = rows.map((row, idx) =>
    row
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((tok) => {
        const v = Number(tok);
        if (!Number.isFinite(v)) throw new Error(`[groove] bad ${idx ? 'velocity' : 'offset'} "${tok}" - a groove is a list of numbers, e.g. "0 1 0 1"`);
        return v;
      }),
  );
  if (!time.length) throw new Error('[groove] a groove needs at least one slot, e.g. "0 1 0 1"');
  if (vel && vel.length !== time.length) {
    throw new Error(`[groove] the velocity row has ${vel.length} slots and the offsets have ${time.length} - a groove's two rows describe the same grid`);
  }
  return freezeGroove({ steps: time.length, time, vel: vel ?? null });
}

export function serializeGroove(table) {
  const fmt = (v) => String(Math.round(v * 1000) / 1000);
  const time = table.time.map(fmt).join(' ');
  // A table that does nothing to velocity writes no velocity row, the same way a flat bend writes no
  // bend: the shorter text is the honest one, and it is what the editor reads back.
  return table.vel && table.vel.some((v) => Math.abs(v - 1) > 1e-9) ? `${time} / ${table.vel.map(fmt).join(' ')}` : time;
}

/** A groove that moves nothing and changes no velocity - what an empty or all-zero table is. */
export function grooveIsFlat(table) {
  if (!table || !table.steps) return true;
  return table.time.every((v) => Math.abs(v) < 1e-9) && !grooveHasVel(table);
}

/** Whether this table says anything about velocity, as opposed to carrying a row that does nothing. */
export function grooveHasVel(table) {
  return !!table?.vel && table.vel.some((v) => Math.abs(v - 1) > 1e-9);
}

// Slot boundaries are hit exactly by fractions that don't survive binary floating point - 1/8 * 8 is
// 0.9999999999999999 as often as it is 1 - so the slot index is taken with a nudge of its own, the
// same one timeShift's own slot arithmetic uses.
const SLOT_EPS = 1e-9;

/**
 * Which slot of `table` the cycle position `pos` falls in. Floored rather than tested for landing on
 * one, so a sixteenth inside a swung eighth rides along with the eighth it belongs to, and wrapped,
 * so a position at or past the end of the cycle (an event's END edge) reads the slot it lands on.
 */
export function grooveSlot(table, pos) {
  const n = table.steps;
  const slot = Math.floor(pos * n + SLOT_EPS);
  return ((slot % n) + n) % n;
}

/** The time offset at `pos`, in units the depth scales (see the header). */
export function grooveTimeAt(table, pos) {
  return table.time[grooveSlot(table, pos)] ?? 0;
}

/** The velocity multiplier at `pos`, 1 where the table says nothing about velocity. */
export function grooveVelAt(table, pos) {
  return table.vel ? table.vel[grooveSlot(table, pos)] ?? 1 : 1;
}

/**
 * The table a groove reference resolves to, or null where the name names nothing. A reference is
 * `{ name, steps, time, vel }`: one holding a table IS its own answer, and one holding only a name
 * is looked up here.
 *
 * Looked up at READ time rather than where the pattern was built, which is what lets a groove be
 * named above the definition that fills it in - the same rule every other named definition follows.
 *
 * `lookup` is where the grooves a buffer DEFINES are found - the registry in rolls.mjs, passed in
 * rather than imported so this file stays data-only the way shape.mjs does. It is asked first, so a
 * groove saved under a preset's name shadows the preset, which is the rule every other named
 * definition follows (see shapeNamed).
 */
export function resolveGroove(ref, lookup = null) {
  if (!ref) return null;
  if (ref.time) return ref;
  if (!ref.name) return null;
  return (lookup ? lookup(ref.name) : null) ?? grooveByName(ref.name);
}

// Only the built-ins are remembered, and only once they have been read. A name that resolves to
// nothing is deliberately NOT remembered as nothing: a groove can be defined after the pattern that
// names it has already played a cycle, and a saved one can be re-filed while it is being dragged, so
// anything that isn't a fixed preset has to be looked up afresh every time.
const presetTables = new Map();

/**
 * A groove by name: a built-in preset today, and where a saved groove will be looked for when there
 * is somewhere to save one.
 */
export function grooveByName(name) {
  const key = String(name).trim();
  if (presetTables.has(key)) return presetTables.get(key);
  if (!GROOVE_PRESETS[key]) return null;
  let table = null;
  try {
    table = parseGroove(GROOVE_PRESETS[key]);
  } catch {
    return null; // a preset that can't be read is a bug in this file, not something to throw at a pattern
  }
  presetTables.set(key, table);
  return table;
}

// The grooves that ship. Every one of these is DERIVED rather than transcribed, which is the whole
// reason the list is short: the alternating shapes are the definition of swing written out at a grid,
// and the rest come from the accent shapes in rollops.mjs, whose weights are turned into lay-back by
// (1 - weight) / 2 - metrically strong pulses land dead on, weak ones sit late by up to a whole unit.
// Reproduce any of them by running that formula over accentWeight() at the stated grid.
//
// Grooves named after a style - samba, bossa, a hip-hop drag - are deliberately NOT here. Their
// numbers are a measurement of how particular players actually played, no source states them in a
// form worth pinning, and inventing them would put a made-up feel behind a real name. They arrive by
// extraction from a recording, or from a transcription with a source, on the same terms as the
// rhythm figures in rollops.mjs.
export const GROOVE_PRESETS = {
  straight: '0',
  swing8: '0 1 0 1 0 1 0 1',
  swing16: '0 1 0 1 0 1 0 1 0 1 0 1 0 1 0 1',
  push8: '0 -1 0 -1 0 -1 0 -1',
  push16: '0 -1 0 -1 0 -1 0 -1 0 -1 0 -1 0 -1 0 -1',
  // accentWeight('downbeats', ...) at 16: the metric hierarchy, so the bar's strong pulses hold
  // still and everything between them drags - a groove template in the oldest sense.
  metric16: '0 0.8 0.5 0.8 0.3 0.8 0.5 0.8 0.15 0.8 0.5 0.8 0.3 0.8 0.5 0.8',
  // accentWeight('clave', ...) at 16 and ('3+3+2', ...) at 8: the clave and tresillo pulses land on
  // the grid and the slots either side of them lay back.
  clave16: '0 0.75 0.75 0 0.75 0.75 0 0.75 0.75 0.75 0 0.75 0 0.75 0.75 0.75',
  tresillo8: '0 0.75 0.75 0 0.75 0.75 0 0.75',
};

export const GROOVE_NAMES = Object.freeze(Object.keys(GROOVE_PRESETS));

function freezeGroove(table) {
  return Object.freeze({
    steps: table.steps,
    time: Object.freeze(table.time),
    vel: table.vel ? Object.freeze(table.vel) : null,
    name: table.name ?? null,
  });
}

/**
 * A groove reference from whatever .swing() was handed in the shape position: a name, a table's
 * text, a parsed table, or a plain list of offsets.
 *
 * A NAME is never resolved here, not even a preset's - it is carried as a name and looked up at read
 * time (see resolveGroove), so that a groove saved under a preset's name shadows it rather than
 * losing to whichever was known first.
 */
export function grooveRef(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return freezeGroove({ steps: value.length, time: value.map(Number), vel: null });
  if (typeof value === 'object') {
    if (!Array.isArray(value.time) || !value.time.length) throw new Error('[groove] a groove table needs a `time` list of per-slot offsets');
    const time = value.time.map(Number);
    const vel = value.vel ? value.vel.map(Number) : null;
    if (vel && vel.length !== time.length) throw new Error('[groove] the velocity row has to have as many slots as the offsets');
    return freezeGroove({ steps: time.length, time, vel, name: value.name ?? null });
  }
  const text = String(value).trim();
  if (grooveNameLike(text)) return Object.freeze({ name: text, steps: 0, time: null, vel: null });
  return parseGroove(text);
}
