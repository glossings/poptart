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

/** The scale's allowed pitch classes (0-11, sorted) - what live-note quantization snaps to. */
export function scalePitchClasses(scaleName) {
  const { rootMidi, intervals } = parseScaleName(scaleName);
  return [...new Set(intervals.map((iv) => (((rootMidi + iv) % 12) + 12) % 12))].sort((a, b) => a - b);
}

/** Converts a scale-degree number (can be negative, or beyond the scale length) to a MIDI note. */
export function degreeToMidi(degree, scaleName) {
  const { rootMidi, intervals } = parseScaleName(scaleName);
  const len = intervals.length;
  const octaveOffset = Math.floor(degree / len);
  const indexInScale = ((degree % len) + len) % len;
  return rootMidi + intervals[indexInScale] + 12 * octaveOffset;
}
