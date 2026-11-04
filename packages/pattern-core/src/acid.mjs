// acid(): a line of steps, one token per step: a value from 0 to 1, with a gate, an accent and an
// octave each.
//
// A token is a value with marks after it: `'` an octave up (`''` two), `,` an octave down, `!` an
// accent, `~` a long gate - `0.5'!~`. `.` is a step that is off. Two `|` mark
// the part of the row that loops - `0 2 | 0 4 . 2 | 3` plays the four steps between them. A long gate
// into the same note is a tie (the note held on); into a different note, a slide (see Sig#slide).
// The row is what the music reads; density, gravity and notes are the widget's, and only move how
// a new row is thrown:
//
//   density   the chance a step plays
//   gravity   the chance a step that plays is 0
//   notes     how many different values the row uses, 0 among them
//
// Kept dependency-free like widget-calls.mjs: the editor throws and draws the row with this code.

/** The knobs the widget throws a row by. */
export const ACID_KNOBS = Object.freeze([
  Object.freeze({ key: 'density', min: 0, max: 1, step: null, default: 0.75 }),
  Object.freeze({ key: 'gravity', min: 0, max: 1, step: null, default: 0.5 }),
  Object.freeze({ key: 'notes', min: 1, max: 8, step: 1, default: 3 }),
]);

const BY_KEY = Object.fromEntries(ACID_KNOBS.map((k) => [k.key, k]));

/** The velocity of an accented note, and of one that is not. */
export const ACID_ACCENT_VEL = 1;
export const ACID_PLAIN_VEL = 0.7;

/** How much of its step a note sounds for: a plain gate, and a long one (held into the next step). */
export const ACID_GATE = 0.5;
export const ACID_LONG_GATE = 1;

/** How many steps acid() with no row throws. */
export const ACID_DEFAULT_STEPS = 16;

// The chances a thrown step that plays is accented, long, and an octave off.
const ACCENTS = 0.3;
const LONGS = 0.25;
const OCTAVES = 0.2;


/** A knob's value, kept in its range; anything that is not a number is its default. */
export function acidKnob(key, v) {
  const k = BY_KEY[key];
  if (!k) return undefined;
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return k.default;
  const kept = Math.min(k.max, Math.max(k.min, n));
  return k.step ? Math.round(kept) : kept;
}

const knobsOf = (k = {}) => Object.fromEntries(ACID_KNOBS.map((o) => [o.key, acidKnob(o.key, k[o.key])]));

const TOKEN = /^(\d*\.?\d+)(''|'|,)?(!)?(~)?$/;

/**
 * The row's steps: `[{ kind, value, octave, accent, long, from, to }]` - `kind` 'on' or 'rest' -
 * with where each token is in the text. A token that is not a value with marks is a rest.
 */
export function parseAcidRow(text) {
  const src = String(text ?? '');
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === '|') continue;
    const at = { from: m.index, to: m.index + m[0].length };
    const k = TOKEN.exec(m[0]);
    if (!k) out.push({ kind: 'rest', value: null, octave: 0, accent: false, long: false, ...at });
    else {
      out.push({
        kind: 'on', value: Math.min(1, Number(k[1])), octave: k[2] === "''" ? 2 : k[2] === "'" ? 1 : k[2] ? -1 : 0,
        accent: !!k[3], long: !!k[4], ...at,
      });
    }
  }
  return out;
}

/** A step that plays, written as its token. */
export function acidToken({ value = 0, octave = 0, accent = false, long = false }) {
  const o = Math.max(-1, Math.min(2, Math.round(Number(octave) || 0)));
  return `${fmt(value)}${o === 2 ? "''" : o === 1 ? "'" : o === -1 ? ',' : ''}${accent ? '!' : ''}${long ? '~' : ''}`;
}

// A value as the row writes it: two decimals at most, no trailing zeros.
function fmt(v) {
  const n = Math.min(1, Math.max(0, Number(v) || 0));
  return String(Number(n.toFixed(2)));
}

const samePitch = (a, b) => a.value === b.value && a.octave === b.octave;

/**
 * The notes the row plays: `[{ index, length, value, octave, accent, slide, gate }]`. A long gate
 * into the same note holds it on (one note over both steps); into a different note, that note
 * slides from it. `gate` is how much of the note's length it sounds for.
 */
export function acidNotes(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'on') continue;
    let len = 1;
    while (steps[i + len - 1].long && steps[i + len]?.kind === 'on' && samePitch(steps[i + len], s)) len++;
    const last = steps[i + len - 1];
    const before = out[out.length - 1];
    const slide = !!before && before.index + before.length === i && steps[i - 1].long;
    const gate = (len - 1 + (last.long ? ACID_LONG_GATE : ACID_GATE)) / len;
    out.push({ index: i, length: len, value: s.value, octave: s.octave, accent: s.accent, slide, gate });
    i += len - 1;
  }
  return out;
}

// A draw from 0 to 1 that is the same every time for the same seed, step and lane.
function draw(seed, i, lane) {
  let h = (Math.imul((seed >>> 0) ^ 0x5bd1e995, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77) ^ Math.imul(lane + 1, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A seed for throwAcidRow: a whole number. */
export const newAcidSeed = (random = Math.random) => Math.floor(random() * 2 ** 31);

// The values a seed's row uses: 0, then `notes - 1` more, each drawn by the seed.
function poolFor(seed, notes) {
  return [0, ...Array.from({ length: Math.max(0, notes - 1) }, (_, j) => Number(fmt(0.05 + 0.95 * draw(seed, j, 9))))];
}

// One step from its draws: the same draws read against other knobs move the step a little.
function stepFrom(r, k, pool) {
  if (!(r(0) < k.density)) return '.';
  const value = r(2) < k.gravity ? 0 : pool[Math.floor(r(3) * pool.length) % pool.length];
  const octave = r(6) < OCTAVES ? (r(7) < 0.65 ? 1 : r(7) < 0.92 ? -1 : 2) : 0;
  return acidToken({ value, octave, accent: r(5) < ACCENTS, long: r(1) < LONGS });
}

/**
 * The row of `n` steps `knobs` make of `seed`: every step's draws fixed by the seed, and each knob a
 * threshold they are read against - so turning a knob moves the row a little rather than throwing
 * it anew: more density adds steps and keeps the ones on, more gravity puts more of them on 0,
 * more notes adds values and keeps the ones there. A new seed is a new row.
 */
export function throwAcidRow(n, knobs = {}, seed = 0) {
  const k = knobsOf(knobs);
  const count = Math.max(1, Math.round(Number(n) || ACID_DEFAULT_STEPS));
  const pool = poolFor(seed, k.notes);
  return Array.from({ length: count }, (_, i) => stepFrom((lane) => draw(seed, i, lane), k, pool)).join(' ');
}

/**
 * The row after one pass of mutation: each step thrown again with probability `p`, from the values
 * the row already has (topped up to `notes` with new ones). `{ text, edits }` as widget-calls' mutateRow gives:
 * the new row, and the edits over the old one, one per step changed, in order.
 */
export function mutateAcidRow(text, p, knobs = {}, random = Math.random) {
  const src = String(text ?? '');
  const k = knobsOf(knobs);
  const steps = parseAcidRow(src);
  const prob = Math.min(1, Math.max(0, Number(p) || 0));
  const pool = [0];
  for (const s of steps) if (s.kind === 'on' && !pool.includes(s.value)) pool.push(s.value);
  while (pool.length < k.notes) pool.push(Number(fmt(0.05 + 0.95 * random())));
  const edits = [];
  for (const s of steps) {
    if (!(random() < prob)) continue;
    const next = stepFrom(() => random(), k, pool);
    if (next !== src.slice(s.from, s.to)) edits.push({ from: s.from, to: s.to, text: next });
  }
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += src.slice(at, e.from) + e.text;
    at = e.to;
  }
  return { text: out + src.slice(at), edits };
}

/**
 * The row with step `index` changed: `'.'` turns it off, an object (`{ value, octave, accent,
 * long }`, any of them) changes what it says - a step that is off is turned on at 0 to carry it. The rest of the row is as it was.
 */
export function setAcidStep(text, index, change) {
  const src = String(text ?? '');
  const s = parseAcidRow(src)[index];
  if (!s) return src;
  const was = s.kind === 'on' ? s : { value: 0, octave: 0, accent: false, long: false };
  const t = change === '.' ? '.' : acidToken({ ...was, ...change });
  return src.slice(0, s.from) + t + src.slice(s.to);
}


/**
 * The steps the row loops, `{ from, to }` (to exclusive): between its two `|` marks, or the whole
 * row when it has fewer than two (a lone mark loops from it to the end).
 */
export function acidLoop(text) {
  const src = String(text ?? '');
  const marks = [];
  let step = 0;
  for (const t of src.split(/\s+/).filter(Boolean)) {
    if (t === '|') marks.push(step);
    else step++;
  }
  const from = Math.min(marks[0] ?? 0, step);
  const to = marks.length >= 2 ? Math.max(from, Math.min(marks[1], step)) : step;
  return to > from ? { from, to } : { from: 0, to: step };
}

/** The row with its loop marks around steps `from` to `to` (exclusive); none when that is all of it. */
export function setAcidLoop(text, from, to) {
  const tokens = String(text ?? '').split(/\s+/).filter((t) => t && t !== '|');
  const a = Math.max(0, Math.min(tokens.length, Math.round(from)));
  const b = Math.max(a, Math.min(tokens.length, Math.round(to)));
  if ((a === 0 && b === tokens.length) || a === b) return tokens.join(' ');
  return [...tokens.slice(0, a), '|', ...tokens.slice(a, b), '|', ...tokens.slice(b)].join(' ');
}
