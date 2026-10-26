// Small, self-contained note-name / scale tables - no tonal.js dependency (see
// ARCHITECTURE.md: minimizing what this package pulls in was an explicit goal).

const NOTE_LETTER_SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// MIDI convention used throughout this package: c3 = 60. This is the naming most plugin key
// displays use, so a note name written here reads the same on the synth's own keyboard - that
// match is the whole reason for the choice. Other conventions put c4 or c5 at 60, so note names
// copied from them sound an octave or two off.
// Bare MIDI numbers are unaffected either way, and most of a pattern's pitch data is numbers.
const NOTE_NAME_RE = /^([a-gA-G])([#sSbf]*)(-?\d+)?$/;

/** "c4" / "f#3" / "Bb5" -> MIDI number, or null if `name` isn't a note name. c3 = MIDI 60. */
export function noteToMidi(name) {
  const m = NOTE_NAME_RE.exec(String(name).trim());
  if (!m) return null;
  const [, letter, accidentals, octaveStr] = m;
  let semitone = NOTE_LETTER_SEMITONES[letter.toLowerCase()];
  for (const acc of accidentals) {
    if (acc === '#' || acc === 's' || acc === 'S') semitone += 1;
    else if (acc === 'b' || acc === 'f') semitone -= 1;
  }
  const octave = octaveStr !== undefined ? Number(octaveStr) : 3;
  return 60 + semitone + (octave - 3) * 12;
}

/** Parses either a plain number (already a MIDI-ish value) or a note name string. */
export function parseNoteValue(value) {
  if (typeof value === 'number') return value;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value !== '' && value !== null) return asNumber;
  const midi = noteToMidi(value);
  if (midi == null) throw new Error(`[notes] "${value}" is not a number or a recognizable note name`);
  return midi;
}

const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const SCALE_ALIASES = {
  maj: 'major',
  min: 'minor',
  m: 'minor',
  pentatonic: 'majorPentatonic',
  minpent: 'minorPentatonic',
  majpent: 'majorPentatonic',
  harmonicminor: 'harmonicMinor',
  melodicminor: 'melodicMinor',
};

// ---------------------------------------------------------------------------------------------
// Tunings. A scale is a root plus `intervals` - each degree's distance above the root in
// SEMITONES - and a `period`, the interval it repeats at (12, an octave, unless the tuning says
// otherwise). For the named modes above both are whole numbers; a tuning makes them fractional,
// and everything downstream (degrees, chords, quantizing) reads them the same way, so a degree in
// 31-EDO comes out as a fractional MIDI note the devices play exactly. What a scale name can be:
//
//   "c3 minor"                        a mode (the table above)
//   "c3 31edo"                        every step of an equal division of the octave
//   "c3 31edo major"                  a mode of it: each of the mode's steps at the nearest EDO step
//                                     (in 31-EDO that is meantone major)
//   "c3 31edo 5 5 3 5 5 5 3"          a mode of it written as step counts
//   "c3 9/8 5/4 4/3 3/2 5/3 15/8 2/1" a tuning listed as a Scala file lists it: ratios ("5/4", or
//                                     a whole number "2" for 2/1) or cents (a number with a ".",
//                                     "386.3"), the unison left out, the last entry the period
//   "c3 mytuning" / "c3 mytuning.scl" a tuning registered by name (registerTuning - the desktop
//                                     host registers the .scl files a buffer names)
//
// The root takes its usual 12-tone pitch: c3 is MIDI 60 in every tuning.
// ---------------------------------------------------------------------------------------------

const TUNINGS = new Map(); // registered by name: name (lower case, ".scl" dropped) -> { intervals, period }

const tuningKey = (name) => String(name).trim().toLowerCase().replace(/\.scl$/, '');

/** One Scala pitch line's value in semitones: cents if it has a ".", else a ratio (or n meaning n/1). */
function scalaPitch(token) {
  const t = String(token).trim();
  if (t.includes('.')) {
    const cents = Number(t);
    return Number.isFinite(cents) ? cents / 100 : null;
  }
  const m = /^(\d+)(?:\/(\d+))?$/.exec(t);
  if (!m) return null;
  const ratio = Number(m[1]) / (m[2] === undefined ? 1 : Number(m[2]));
  return ratio > 0 ? 12 * Math.log2(ratio) : null;
}

const isScalaPitch = (token) => /^-?\d*\.\d*$/.test(token) || /^\d+(\/\d+)?$/.test(token);

/** A pitch list in Scala order (no unison, last = period) -> { intervals, period }. */
function tuningFromPitches(pitches, what) {
  const values = pitches.map(scalaPitch);
  if (values.some((v) => v == null)) throw new Error(`[notes] ${what}: every pitch must be a ratio like 5/4 or cents like 386.3`);
  // A leading unison (1/1, 0.0) is tolerated: Scala leaves it out, people often write it in.
  if (values.length > 1 && Math.abs(values[0]) < 1e-9) values.shift();
  if (!values.length) throw new Error(`[notes] ${what}: a tuning needs at least its period, e.g. 2/1`);
  const period = values[values.length - 1];
  if (!(period > 0)) throw new Error(`[notes] ${what}: the last pitch is the period and must be above the root`);
  const intervals = [0, ...values.slice(0, -1)];
  if (intervals.some((iv, i) => i > 0 && !(iv > intervals[i - 1] && iv < period))) {
    // The usual cause: cents written without a ".", which Scala reads as a ratio (702 is 702/1).
    const bare = pitches.find((p) => /^\d+$/.test(String(p).trim()) && Number(p) > 16);
    const hint = bare ? ` - "${bare}" reads as the ratio ${bare}/1; for cents write ${bare}.0` : '';
    throw new Error(`[notes] ${what}: pitches must rise, and stay below the period (the last one)${hint}`);
  }
  return { intervals, period };
}

/**
 * Parses the text of a Scala .scl file into `{ description, intervals, period }`: `!` lines are
 * comments, the first other line the description, the next the pitch count, then one pitch per
 * line (anything after its first word is ignored, as the format says).
 */
export function parseScala(text, name = 'tuning') {
  const lines = String(text).split(/\r?\n/).filter((l) => !/^\s*!/.test(l));
  if (lines.length < 2) throw new Error(`[notes] ${name}: not a Scala file - it needs a description line and a count`);
  const description = lines[0].trim();
  const count = Number(lines[1].trim().split(/\s+/)[0]);
  if (!Number.isInteger(count) || count < 1) throw new Error(`[notes] ${name}: the second line must be the number of pitches`);
  const pitches = lines.slice(2).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).slice(0, count);
  if (pitches.length < count) throw new Error(`[notes] ${name}: says ${count} pitches but lists ${pitches.length}`);
  return { description, ...tuningFromPitches(pitches, name) };
}

/** Registers a tuning under `name` - Scala text, or { intervals, period } - for scale names to use. */
export function registerTuning(name, tuning) {
  const parsed = typeof tuning === 'string' ? parseScala(tuning, name) : tuning;
  TUNINGS.set(tuningKey(name), { intervals: [...parsed.intervals], period: parsed.period });
  return parsed;
}

/** The named tunings a scale name may use (for completions). */
export function tuningNames() {
  return [...TUNINGS.keys()];
}

/** Every registered tuning as data - what the host hands the editor, which parses scale names too. */
export function registeredTunings() {
  return [...TUNINGS].map(([name, { intervals, period }]) => ({ name, intervals: [...intervals], period }));
}

// "31edo", "31-edo", "31et", "31tet" -> 31.
const EDO_RE = /^(\d+)-?(?:edo|tet|et)$/i;

/** The mode word(s) after the root -> { intervals, period }, or null for an unknown word. */
function resolveMode(words, scaleName) {
  const [first, ...rest] = words;
  const edo = EDO_RE.exec(first ?? '');
  if (edo) {
    const n = Number(edo[1]);
    if (!(n >= 1 && n <= 1200)) throw new Error(`[notes] "${first}" - an EDO needs between 1 and 1200 steps (in "${scaleName}")`);
    const step = 12 / n;
    if (!rest.length) return { intervals: Array.from({ length: n }, (_, i) => i * step), period: 12 };
    if (rest.every((w) => /^\d+$/.test(w))) {
      const sizes = rest.map(Number);
      const total = sizes.reduce((a, b) => a + b, 0);
      if (total !== n) throw new Error(`[notes] the steps ${rest.join(' ')} add up to ${total}, not ${n} (in "${scaleName}")`);
      const intervals = [0];
      for (const size of sizes.slice(0, -1)) intervals.push(intervals[intervals.length - 1] + size * step);
      return { intervals, period: 12 };
    }
    const mode = resolveMode(rest, scaleName);
    if (!mode || mode.period !== 12) return null;
    const steps = [...new Set(mode.intervals.map((iv) => Math.round(iv / step)))];
    return { intervals: steps.map((k) => k * step), period: 12 };
  }
  if (words.length > 1 || isScalaPitch(first ?? '')) {
    if (!words.every(isScalaPitch)) return null;
    return tuningFromPitches(words, `"${scaleName}"`);
  }
  const key = (first ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const intervals = SCALE_INTERVALS[SCALE_ALIASES[key] ?? key];
  if (intervals) return { intervals, period: 12 };
  return TUNINGS.get(tuningKey(first ?? '')) ?? null;
}

/**
 * Parses a scale name - a root and a mode or tuning, see Tunings above - into
 * `{ rootMidi, intervals, period, tuned }`. A name with no root ("minor", "31edo") is rooted on C.
 * The root octave defaults to 3 (c3 = 60). `tuned` is true when any interval is off the 12-tone
 * grid, which is when 12-tone-only views (key signatures, pitch classes) have to approximate.
 */
export function parseScaleName(scaleName) {
  const parts = String(scaleName).trim().replace(/:/g, ' ').split(/\s+/).filter(Boolean);
  const hasRoot = parts.length >= 2 && NOTE_NAME_RE.test(parts[0]);
  const rootPart = hasRoot ? parts[0] : 'c';
  const words = hasRoot ? parts.slice(1) : parts;
  if (!words.length) throw new Error(`[notes] "${scaleName}" names no scale`);

  const mode = resolveMode(words, scaleName);
  if (!mode) {
    if (/\.scl$/i.test(words[0])) {
      throw new Error(`[notes] the tuning file "${words[0]}" isn't loaded - check the name, and that the file exists (in "${scaleName}")`);
    }
    throw new Error(`[notes] unknown scale "${words.join(' ')}" (in "${scaleName}")`);
  }

  const rootMidi = noteToMidi(/\d/.test(rootPart) ? rootPart : `${rootPart}3`);
  if (rootMidi == null) {
    throw new Error(`[notes] unrecognized scale root "${rootPart}" (in "${scaleName}")`);
  }

  const { intervals, period } = mode;
  const tuned = period !== 12 || intervals.some((iv) => !Number.isInteger(iv));
  return { rootMidi, intervals, period, tuned };
}

/** How many degrees one period of `scaleName` has (7 for a diatonic mode, 31 for "31edo"). */
export function scaleSize(scaleName) {
  return parseScaleName(scaleName).intervals.length;
}

/** The octave a scale name with no octave of its own sits in (this module's c3 = 60 convention). */
export const DEFAULT_SCALE_OCTAVE = 3;

/**
 * Splits a scale name into `{ root, octave, mode }` exactly the way parseScaleName reads it: the
 * root's letter + accidentals, the octave it named (null if it didn't), and the mode word. Lets a
 * caller rebuild the same scale somewhere else on the keyboard - see scaleAtOctave / Sig#sc.
 */
export function scaleParts(scaleName) {
  const parts = String(scaleName).trim().replace(/:/g, ' ').split(/\s+/).filter(Boolean);
  const hasRoot = parts.length >= 2 && NOTE_NAME_RE.test(parts[0]);
  const rootPart = hasRoot ? parts[0] : 'c';
  const m = NOTE_NAME_RE.exec(rootPart);
  return {
    root: m ? `${m[1]}${m[2]}` : rootPart,
    octave: m && m[3] !== undefined ? Number(m[3]) : null,
    // Everything after the root: a tuning's mode can be several words ("31edo major").
    mode: (hasRoot ? parts.slice(1) : parts).join(' '),
  };
}

/** The same scale with its root moved to `octave`: scaleAtOctave("F minor", 3) -> "f3 minor". */
export function scaleAtOctave(scaleName, octave) {
  const { root, mode } = scaleParts(scaleName);
  return `${root}${Math.round(Number(octave))} ${mode}`;
}

// ---------------------------------------------------------------------------------------------
// The global scale. A patch is nearly always in ONE key, so the key is a property of the document
// rather than of each pattern: `setscale("F minor")` sets it (the host binds that builder - see
// web-app's server.js, which also HOISTS it so the last one in a buffer wins for the whole buffer)
// and `.sc()` reads it. Re-keying a patch is then a single edit instead of one per `.scale()`.
// ---------------------------------------------------------------------------------------------

/** What .sc() falls back to when nothing has called setscale() yet. */
export const DEFAULT_SCALE = 'c major';

let currentScale = null;

/**
 * Sets the global scale, validating the name now so a typo is reported at the setscale() call
 * rather than silently at the first note. Returns the name as stored.
 */
export function setGlobalScale(scaleName) {
  if (scaleName == null) {
    // The host clears the key when entering a deck that never set one (per-deck scale - the
    // global is swapped around each deck's evaluation and holds the main deck's at rest).
    currentScale = null;
    return null;
  }
  parseScaleName(scaleName); // throws on an unknown mode/root
  currentScale = String(scaleName).trim();
  return currentScale;
}

/** The global scale name, or null if setscale() has never run in this process. */
export function globalScale() {
  return currentScale;
}

/** The scale's allowed pitch classes (0-11, sorted) - what live-note quantization snaps to. */
// In a tuning off the 12-tone grid these are approximate - each degree's nearest pitch class - since
// a pitch class is a 12-tone idea; live MIDI keys, the one thing still quantized by them, are too.
export function scalePitchClasses(scaleName) {
  const { rootMidi, intervals } = parseScaleName(scaleName);
  return [...new Set(intervals.map((iv) => (((Math.round(rootMidi + iv) % 12) + 12) % 12)))].sort((a, b) => a - b);
}

/**
 * Snaps an absolute MIDI note to the nearest pitch that belongs to `scaleName` (ties resolve
 * downward). This is what `.scale()` does to a *note* pattern - `note("c4 e4 f#4 g4")` played
 * through `.scale("C major")` bends the out-of-key f#4 to the nearest scale tone - as opposed to
 * an `n(...)` *degree* pattern, where `.scale()` reads the numbers as scale steps instead. It's
 * the exact same rule the engine applies to live midikeys() notes (see poptart.scd's quantize),
 * kept here so pattern notes and live notes snap identically.
 */
export function quantizeToScale(midi, scaleName) {
  // A tuning: the nearest of its own pitches, measured exactly (ties downward, as below).
  if (parseScaleName(scaleName).tuned) return degreeToMidi(midiToDegree(midi, scaleName), scaleName);
  const pcs = scalePitchClasses(scaleName);
  if (!pcs.length) return midi;
  const note = Math.round(midi);
  for (let d = 0; d <= 11; d++) {
    if (pcs.includes((((note - d) % 12) + 12) % 12)) return note - d;
    if (pcs.includes((((note + d) % 12) + 12) % 12)) return note + d;
  }
  return note;
}

/**
 * Converts a scale-degree number (can be negative, or beyond the scale length) to a MIDI note. A
 * fractional degree lands that far between its two neighbors - 1.5 in C major is halfway from d to
 * e - so the result is a fractional MIDI note, which the scheduler rounds for a plugin. A
 * non-number is NaN rather than a wrong note.
 */
export function degreeToMidi(degree, scaleName) {
  const { rootMidi, intervals, period } = parseScaleName(scaleName);
  const len = intervals.length;
  const at = (d) => rootMidi + intervals[((d % len) + len) % len] + period * Math.floor(d / len);
  if (!Number.isFinite(degree)) return NaN;
  const base = Math.floor(degree);
  const frac = degree - base;
  return frac === 0 ? at(base) : at(base) + (at(base + 1) - at(base)) * frac;
}

/**
 * The inverse of degreeToMidi: which degree of `scaleName` lands on `midi`. A note that isn't IN
 * the scale has no degree of its own and takes the nearest one (ties resolve downward, like
 * quantizeToScale) - so `midiToDegree(degreeToMidi(d, s), s) === d`, but the round trip the other
 * way quantizes. This is what lets a drawn roll be written out as `n(...)` degrees.
 */
export function midiToDegree(midi, scaleName) {
  const { rootMidi, intervals, period, tuned } = parseScaleName(scaleName);
  const len = intervals.length;
  // A 12-tone scale reads MIDI keys; a tuning reads the pitch exactly, since its steps fall between keys.
  const note = tuned ? Number(midi) : Math.round(midi);
  const at = (d) => rootMidi + intervals[((d % len) + len) % len] + period * Math.floor(d / len);
  // Degrees rise monotonically with pitch, so the answer is within a period of this estimate.
  const guess = Math.round(((note - rootMidi) / period) * len);
  let best = guess;
  let bestDist = Infinity;
  for (let d = guess - len - 1; d <= guess + len + 1; d++) {
    const dist = Math.abs(at(d) - note);
    if (dist < bestDist - 1e-9) { best = d; bestDist = dist; } // strict: a tie keeps the lower degree
  }
  return best;
}
