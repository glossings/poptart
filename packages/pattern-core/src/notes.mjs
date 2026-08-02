// Small, self-contained note-name / scale tables - no tonal.js dependency (see
// ARCHITECTURE.md: minimizing what this package pulls in was an explicit goal).

const NOTE_LETTER_SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// MIDI convention used throughout this package: c5 = 60 (matches general MIDI's "middle C",
// and is the same convention Strudel itself uses).
const NOTE_NAME_RE = /^([a-gA-G])([#sSbf]*)(-?\d+)?$/;

/** "c4" / "f#3" / "Bb5" -> MIDI number, or null if `name` isn't a note name. c5 = MIDI 60. */
export function noteToMidi(name) {
  const m = NOTE_NAME_RE.exec(String(name).trim());
  if (!m) return null;
  const [, letter, accidentals, octaveStr] = m;
  let semitone = NOTE_LETTER_SEMITONES[letter.toLowerCase()];
  for (const acc of accidentals) {
    if (acc === '#' || acc === 's' || acc === 'S') semitone += 1;
    else if (acc === 'b' || acc === 'f') semitone -= 1;
  }
  const octave = octaveStr !== undefined ? Number(octaveStr) : 5;
  return 60 + semitone + (octave - 5) * 12;
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

/**
 * Parses a scale name like "F minor", "F:minor", "c4 major", "d dorian" into
 * `{ rootMidi, intervals }`. A bare mode name with no root (e.g. "minor") defaults to root C.
 * Root octave defaults to 5 (so root MIDI matches this module's note-name convention).
 */
export function parseScaleName(scaleName) {
  const cleaned = String(scaleName).trim().replace(/:/g, ' ');
  const parts = cleaned.split(/\s+/).filter(Boolean);

  let rootPart = 'c';
  let modePart;
  if (parts.length >= 2) {
    [rootPart, modePart] = parts;
  } else {
    modePart = parts[0];
  }

  const modeKey = modePart.toLowerCase().replace(/[^a-z]/g, '');
  const resolvedMode = SCALE_ALIASES[modeKey] ?? modeKey;
  const intervals = SCALE_INTERVALS[resolvedMode];
  if (!intervals) {
    throw new Error(`[notes] unknown scale "${modePart}" (in "${scaleName}")`);
  }

  const rootMidi = noteToMidi(/\d/.test(rootPart) ? rootPart : `${rootPart}5`);
  if (rootMidi == null) {
    throw new Error(`[notes] unrecognized scale root "${rootPart}" (in "${scaleName}")`);
  }

  return { rootMidi, intervals };
}

/** The octave a scale name with no octave of its own sits in (this module's c5 = 60 convention). */
export const DEFAULT_SCALE_OCTAVE = 5;

/**
 * Splits a scale name into `{ root, octave, mode }` exactly the way parseScaleName reads it: the
 * root's letter + accidentals, the octave it named (null if it didn't), and the mode word. Lets a
 * caller rebuild the same scale somewhere else on the keyboard - see scaleAtOctave / Sig#sc.
 */
export function scaleParts(scaleName) {
  const parts = String(scaleName).trim().replace(/:/g, ' ').split(/\s+/).filter(Boolean);
  const [rootPart, modePart] = parts.length >= 2 ? parts : ['c', parts[0] ?? ''];
  const m = NOTE_NAME_RE.exec(rootPart);
  return {
    root: m ? `${m[1]}${m[2]}` : rootPart,
    octave: m && m[3] !== undefined ? Number(m[3]) : null,
    mode: modePart,
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
  parseScaleName(scaleName); // throws on an unknown mode/root
  currentScale = String(scaleName).trim();
  return currentScale;
}

/** The global scale name, or null if setscale() has never run in this process. */
export function globalScale() {
  return currentScale;
}

/** The scale's allowed pitch classes (0-11, sorted) - what live-note quantization snaps to. */
export function scalePitchClasses(scaleName) {
  const { rootMidi, intervals } = parseScaleName(scaleName);
  return [...new Set(intervals.map((iv) => (((rootMidi + iv) % 12) + 12) % 12))].sort((a, b) => a - b);
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
  const pcs = scalePitchClasses(scaleName);
  if (!pcs.length) return midi;
  const note = Math.round(midi);
  for (let d = 0; d <= 11; d++) {
    if (pcs.includes((((note - d) % 12) + 12) % 12)) return note - d;
    if (pcs.includes((((note + d) % 12) + 12) % 12)) return note + d;
  }
  return note;
}

/** Converts a scale-degree number (can be negative, or beyond the scale length) to a MIDI note. */
export function degreeToMidi(degree, scaleName) {
  const { rootMidi, intervals } = parseScaleName(scaleName);
  const len = intervals.length;
  const octaveOffset = Math.floor(degree / len);
  const indexInScale = ((degree % len) + len) % len;
  return rootMidi + intervals[indexInScale] + 12 * octaveOffset;
}
