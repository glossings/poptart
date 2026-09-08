// Slice sets - where a sample's chops are.
//
// The positions for one file are an ascending list, each 0..1: slice k runs from positions[k] to
// positions[k+1], and the last one runs to the end of the file. That is exactly the shape the
// engine's own transient detector produces, which is what lets a hand-drawn set take its place
// with nothing downstream knowing the difference (see Sig#slices and playSample).
//
// A named SET is those positions PER FILE - `{ "breaks/amen.wav": [0, 0.131, …], "breaks/think.wav":
// [...] }` - because markers only mean anything on the sample they were drawn on. That is what lets
// one name follow a changing `.i()`: `_slices("main", …)` holds a `main` for each break, and tweaking
// the index moves between chop maps that each fit their own audio instead of dragging one file's
// markers onto another's transients. A file the set says nothing about chops on its own transients,
// exactly as an unnamed sample does.
//
// A bare ARRAY is still a set: one map for whatever plays, which is what an inline
// `.slices([0, 0.5])` means and what a set written by hand most naturally says.
//
// An entry can also carry a FIT - `{ fit: 2, marks: [...] }` - because how many cycles a file is
// repitched to last is a fact about that file, not about the pattern playing it: four breaks under
// one name will want four different answers, and one of them may want none. It is what the chain's
// `.fit()` would have said, and the chain's own `.fit()` overrides it wherever there is one, so
// nothing here can take that control away from the pattern (see playSample).
//
// The file KEY is the engine's doing, not this module's: it is a sample's path relative to the
// library root (see osc-engine/samples.js sampleKey), so a set travels with the library and reads
// as the file you drew it on.
//
// This lives apart from signal.mjs, like shape.mjs and pianoroll.mjs, because the EDITOR needs the
// same operations the language does - read a `_slices(...)` definition, tidy it, write it back -
// and a browser that had to import signal.mjs to get them would pull in the whole runtime. One
// copy of the rule, two callers.

/** How many decimals a written position keeps. Well past a single sample frame in a long file, and
 * short enough that a definition stays a line you can read. */
export const SLICE_DECIMALS = 5;

/**
 * A slice set as everything downstream wants it: ascending, each 0..1, no duplicates.
 *
 * Sorted rather than trusted - a marker dragged past its neighbor arrives out of order - and
 * duplicates dropped, since two markers on the same frame describe an empty slice that would play
 * nothing at all. Deliberately does NOT force a leading 0: a set that starts at 0.1 means the
 * pickup before the first marker is never played, which is a thing you may want.
 */
export function normalizeSlicePositions(list) {
  const nums = (Array.isArray(list) ? list : [list])
    .map((raw) => Number(raw))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.min(1, Math.max(0, n)))
    .sort((a, b) => a - b);
  return nums.filter((p, k) => k === 0 || p - nums[k - 1] > 1e-6);
}

/**
 * The positions a `_slices("id", [...])` definition lists, read off the code: every number after
 * the id. Read with a scan rather than JSON.parse so a hand-edited list survives whatever spacing,
 * trailing comma or stray comment it was left with - the same forgiveness packEntriesOf gives a
 * pack's file list.
 */
export function parseSlicePositions(body) {
  const nums = String(body ?? '').match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  return normalizeSlicePositions(nums.map(Number));
}

/** A list of positions as the definition should say it. */
export function serializeSlicePositions(list) {
  const out = normalizeSlicePositions(list).map((p) => {
    const rounded = Number(p.toFixed(SLICE_DECIMALS));
    return String(Number.isInteger(rounded) ? rounded : rounded);
  });
  return `[${out.join(', ')}]`;
}

/**
 * A whole set as everything downstream wants it: either one tidied list (any file), or a map of
 * file key -> tidied list. A file whose list comes out empty is dropped rather than kept as an
 * empty entry, so "this set says nothing about that sample" has exactly one spelling.
 */
export function normalizeSliceSet(set) {
  if (set == null) return [];
  if (Array.isArray(set) || typeof set !== 'object') return normalizeSlicePositions(set);
  const out = {};
  for (const [key, raw] of Object.entries(set)) {
    const entry = normalizeSliceEntry(raw);
    if (entry) out[String(key)] = entry;
  }
  return out;
}

/**
 * One file's entry, canonically: a bare list where all it has is markers, and `{ fit, marks }`
 * where it also carries a fit. Two spellings would be two ways to say the same thing, so the short
 * one is used wherever it can be; an entry that says nothing at all comes back null and is dropped.
 */
export function normalizeSliceEntry(raw) {
  if (raw == null) return null;
  const marks = normalizeSlicePositions(Array.isArray(raw) || typeof raw !== 'object' ? raw : raw.marks);
  const fit = normalizeSliceFit(Array.isArray(raw) || typeof raw !== 'object' ? null : raw.fit);
  if (fit == null) return marks.length ? marks : null;
  return marks.length ? { fit, marks } : { fit };
}

/** A fit as the set may hold it: 'auto', a positive number of cycles, or null for "says nothing". */
export function normalizeSliceFit(fit) {
  if (fit == null || fit === '' || fit === false) return null;
  if (fit === 'auto' || fit === true) return 'auto';
  const n = Number(fit);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** True for a set that chops nothing - the state a set the editor has only just named is in. */
export function sliceSetIsEmpty(set) {
  if (!set) return true;
  return Array.isArray(set) ? set.length === 0 : Object.keys(set).length === 0;
}

/**
 * The positions this set draws on `key`, or null for "it says nothing about that file" - which
 * downstream means the sample's own transients chop it (see playSample). A bare array applies to
 * whatever is playing; a map applies only where it has an entry, which is the point of keying it.
 *
 * Just the markers - see sliceEntryFor for everything the set says about a file.
 */
export function slicePositionsFor(set, key) {
  return sliceEntryFor(set, key)?.marks ?? null;
}

/**
 * Everything the set says about `key`: `{ marks, fit }`, or null where it says nothing at all. A
 * bare array applies to whatever is playing; a map applies only where it has an entry, which is the
 * point of keying it.
 *
 * The engine has its own copy of this rule (samples.js sliceEntryFor) because it can't import ESM;
 * they are a few lines each and must agree.
 */
export function sliceEntryFor(set, key) {
  if (!set) return null;
  const raw = Array.isArray(set) ? set : typeof set === 'object' ? set[key] : null;
  if (raw == null) return null;
  const marks = Array.isArray(raw) ? raw : Array.isArray(raw.marks) ? raw.marks : [];
  const fit = Array.isArray(raw) ? null : normalizeSliceFit(raw.fit);
  if (!marks.length && fit == null) return null;
  return { marks: marks.length ? marks : null, fit };
}

/** Every file a set has markers for - what the editor lists as "also in this set". */
export function sliceSetKeys(set) {
  return set && !Array.isArray(set) && typeof set === 'object' ? Object.keys(set) : [];
}

/**
 * A `_slices("id", …)` definition's body, read off the code: a map where it is written as one, a
 * plain list where it is written as one. Scanned rather than JSON.parse'd for the same reason
 * parseSlicePositions is - a hand-edited definition should survive its own spacing.
 */
export function parseSliceSet(body) {
  const text = String(body ?? '');
  if (!/^\s*\{/.test(text)) return parseSlicePositions(text);
  const out = {};
  const re = /(["'])((?:\\.|(?!\1)[\s\S])*?)\1\s*:\s*/g;
  let m;
  while ((m = re.exec(text))) {
    const open = re.lastIndex;
    const close = closingBracket(text, open);
    if (close < 0) continue; // not a value we can read - skip to whatever the next key is
    let key = m[2];
    try { key = JSON.parse(`"${m[2]}"`); } catch { /* whatever it says literally, then */ }
    const value = text.slice(open, close + 1);
    const entry = normalizeSliceEntry(text[open] === '['
      ? parseSlicePositions(value)
      : { fit: /\bfit\s*:\s*(["']?)(\w+(?:\.\d+)?)\1/.exec(value)?.[2], marks: parseSlicePositions(/\bmarks\s*:\s*\[([^\]]*)\]/.exec(value)?.[1]) });
    if (entry) out[key] = entry;
    re.lastIndex = close + 1; // past the whole value, so its own keys are not read as file names
  }
  return out;
}

/** The index of the "]"/"}" closing the bracket at `open`, or -1 if that isn't a bracket at all. */
function closingBracket(text, open) {
  const shut = text[open] === '[' ? ']' : text[open] === '{' ? '}' : null;
  if (!shut) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === shut && --depth === 0) return i;
  }
  return -1;
}

/** A set as the definition should say it - what the slice editor writes back into the code. */
export function serializeSliceSet(set) {
  const tidy = normalizeSliceSet(set);
  if (Array.isArray(tidy)) return serializeSlicePositions(tidy);
  const body = Object.entries(tidy).map(([key, entry]) => `${JSON.stringify(key)}: ${serializeSliceEntry(entry)}`);
  return `{${body.length ? ` ${body.join(', ')} ` : ''}}`;
}

function serializeSliceEntry(entry) {
  if (Array.isArray(entry)) return serializeSlicePositions(entry);
  const fit = `fit: ${entry.fit === 'auto' ? '"auto"' : Number(Number(entry.fit).toFixed(4))}`;
  const marks = entry.marks?.length ? `, marks: ${serializeSlicePositions(entry.marks)}` : '';
  return `{ ${fit}${marks} }`;
}
