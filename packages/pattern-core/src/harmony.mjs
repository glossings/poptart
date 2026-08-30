// Chord tables, diatonic-chord building, chord analysis/naming, and voicing transforms - the
// music-theory foundation for the pianoroll's harmony tools (chord menu, voicing menu, analyzed
// chord name, next-chord suggestions). Like notes.mjs it is dependency-free beyond notes.mjs
// itself and served verbatim to the browser, so the editor and any server-side caller share one
// set of tables. Everything here is pure: functions take MIDI-number arrays (this package's
// c3 = 60 convention) and return NEW sorted arrays or plain analysis objects - the roll editor
// owns clamping to 0..127 and writing notes back.

import { degreeToMidi, midiToDegree, parseScaleName, scaleParts } from './notes.mjs';

// ---------------------------------------------------------------------------------------------
// Chord quality dictionary. Order matters: it is the analyzer's preference among interpretations
// that score equally otherwise (earlier = more common = more likely the intended name). Interval
// sets are pitch classes relative to the root; every set is unique, so within one candidate root
// a chord matches at most one quality.
// ---------------------------------------------------------------------------------------------
export const CHORD_QUALITIES = Object.freeze([
  { symbol: '', quality: 'major', intervals: [0, 4, 7] },
  { symbol: 'm', quality: 'minor', intervals: [0, 3, 7] },
  { symbol: '7', quality: 'dominant 7th', intervals: [0, 4, 7, 10] },
  { symbol: 'maj7', quality: 'major 7th', intervals: [0, 4, 7, 11] },
  { symbol: 'm7', quality: 'minor 7th', intervals: [0, 3, 7, 10] },
  { symbol: 'dim', quality: 'diminished', intervals: [0, 3, 6] },
  { symbol: 'aug', quality: 'augmented', intervals: [0, 4, 8] },
  { symbol: 'sus4', quality: 'suspended 4th', intervals: [0, 5, 7] },
  { symbol: 'sus2', quality: 'suspended 2nd', intervals: [0, 2, 7] },
  { symbol: '6', quality: 'major 6th', intervals: [0, 4, 7, 9] },
  { symbol: 'm6', quality: 'minor 6th', intervals: [0, 3, 7, 9] },
  { symbol: 'm7b5', quality: 'half-diminished 7th', intervals: [0, 3, 6, 10] },
  { symbol: 'dim7', quality: 'diminished 7th', intervals: [0, 3, 6, 9] },
  { symbol: 'mMaj7', quality: 'minor-major 7th', intervals: [0, 3, 7, 11] },
  { symbol: '7sus4', quality: 'dominant 7th sus4', intervals: [0, 5, 7, 10] },
  { symbol: 'add9', quality: 'added 9th', intervals: [0, 2, 4, 7] },
  { symbol: 'madd9', quality: 'minor added 9th', intervals: [0, 2, 3, 7] },
  { symbol: '9', quality: 'dominant 9th', intervals: [0, 2, 4, 7, 10] },
  { symbol: 'maj9', quality: 'major 9th', intervals: [0, 2, 4, 7, 11] },
  { symbol: 'm9', quality: 'minor 9th', intervals: [0, 2, 3, 7, 10] },
  { symbol: '5', quality: 'power chord', intervals: [0, 7] },
]);

const pc = (midi) => ((Math.round(midi) % 12) + 12) % 12;

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Pitch class 0..11 -> a display name; `flats` picks the flat spelling ("Eb" over "D#"). */
export function pcName(pitchClass, flats = false) {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[pc(pitchClass)];
}

const MAJOR_SET = [0, 2, 4, 5, 7, 9, 11];
const FLAT_MAJOR_PCS = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb - the flat-side keys

// How far above the mode's root its relative major sits: the rotation of the scale's interval
// set that lands exactly on the major scale (D dorian -> 10 up -> C major). Found from the
// intervals themselves so scale aliases need no second table here; a scale that is no rotation
// of major (harmonic minor, pentatonics) falls back on its third - minor-family scales borrow
// aeolian's answer (+3), major-family ones ionian's (0).
function relativeMajorUp(intervals) {
  const set = new Set(intervals.map(pc));
  if (set.size === 7) {
    for (let up = 0; up < 12; up++) {
      if (MAJOR_SET.every((iv) => set.has(pc(iv + up)))) return up;
    }
  }
  return set.has(3) ? 3 : 0;
}

/**
 * Whether names in `scaleName` should be spelled with flats: a root written with a flat wins
 * outright ("bb minor"), a root written with a sharp likewise, and otherwise the key signature
 * decides (relative major on the flat side of the circle of fifths -> flats). Heuristic, not
 * full letter-spelling - good enough to print "Ab" in F minor and "G#" in E major.
 */
export function preferFlats(scaleName) {
  if (scaleName == null) return false;
  const { root } = scaleParts(scaleName);
  const accidentals = String(root).slice(1).toLowerCase();
  if (accidentals.includes('b') || accidentals.includes('f')) return true;
  if (accidentals.includes('#') || accidentals.includes('s')) return false;
  const { rootMidi, intervals } = parseScaleName(scaleName);
  return FLAT_MAJOR_PCS.has(pc(rootMidi + relativeMajorUp(intervals)));
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// The roman numeral's tail for each quality symbol. The numeral's case already says major/minor
// third, so the minor 'm' drops out of the tail; dim/half-dim/aug get their markers.
const ROMAN_TAIL = {
  '': '', m: '', dim: '°', aug: '+', dim7: '°7', m7b5: 'ø7', mMaj7: 'maj7',
  m7: '7', m6: '6', m9: '9', madd9: 'add9',
};

/**
 * The roman numeral for a chord root + quality in `scaleName`: "V7", "ii7", "vii°", "IVmaj7".
 * Only 7-note scales get numerals (they're what the notation means); other lengths, and roots
 * that aren't scale tones, return null - a menu just shows nothing in that slot.
 */
export function romanNumeral(rootPc, qualityEntry, scaleName) {
  if (scaleName == null || !qualityEntry) return null;
  const { rootMidi, intervals } = parseScaleName(scaleName);
  if (intervals.length !== 7) return null;
  const degree = intervals.findIndex((iv) => pc(rootMidi + iv) === pc(rootPc));
  if (degree < 0) return null;
  const upper = qualityEntry.intervals.includes(4) || !qualityEntry.intervals.includes(3);
  const numeral = upper ? ROMAN[degree] : ROMAN[degree].toLowerCase();
  return numeral + (ROMAN_TAIL[qualityEntry.symbol] ?? qualityEntry.symbol);
}

const uniqSorted = (midis) => [...new Set(midis.map((m) => Math.round(m)))].sort((a, b) => a - b);

/**
 * Names a set of MIDI notes: `[57,60,64,67]` -> "Am7", `[64,67,72]` -> "C/E". Tries every note
 * present as the root, matches the pitch-class set against CHORD_QUALITIES exactly, and prefers
 * (1) the interpretation whose root is in the bass, then (2) the commoner quality - which is how
 * A-C-E-G reads as Am7 over A but C6 over C, and how a symmetric dim7 gets the bass note's name.
 * Returns null when nothing matches (fewer than 2 pitch classes, or an unnamed cluster);
 * `scaleName` (optional) picks sharp/flat spelling and adds the roman numeral.
 *
 * Shape: { rootPc, rootName, symbol, quality, name, bassMidi, bassPc, inversion, roman }.
 * `inversion` counts chord tones below the root's octave-position: 0 = root position, 1 = first
 * inversion (the slash in "C/E"), etc.
 */
export function analyzeChord(midis, scaleName = null) {
  const notes = uniqSorted(midis ?? []);
  if (!notes.length) return null;
  const pcs = [...new Set(notes.map(pc))].sort((a, b) => a - b);
  if (pcs.length < 2) return null;
  const bassMidi = notes[0];
  const bassPc = pc(bassMidi);

  let best = null;
  for (const rootPc of pcs) {
    const rel = new Set(pcs.map((p) => ((p - rootPc) + 12) % 12));
    for (let q = 0; q < CHORD_QUALITIES.length; q++) {
      const entry = CHORD_QUALITIES[q];
      if (entry.intervals.length !== rel.size || !entry.intervals.every((iv) => rel.has(iv))) continue;
      const score = (rootPc === bassPc ? 0 : 100) + q;
      if (!best || score < best.score) best = { rootPc, entry, score };
    }
  }
  if (!best) return null;

  const { rootPc, entry } = best;
  const flats = preferFlats(scaleName);
  const rootName = pcName(rootPc, flats);
  const bassInterval = ((bassPc - rootPc) + 12) % 12;
  const sorted = [...entry.intervals].sort((a, b) => a - b);
  const inversion = Math.max(0, sorted.indexOf(bassInterval));
  const name = rootName + entry.symbol + (inversion ? `/${pcName(bassPc, flats)}` : '');
  return {
    rootPc, rootName, symbol: entry.symbol, quality: entry.quality, name,
    bassMidi, bassPc, inversion,
    roman: romanNumeral(rootPc, entry, scaleName),
  };
}

/**
 * The chords the key offers, one per scale degree, built by stacking scale thirds (every other
 * degree) from that degree's root - so any 7-note mode yields its own triads/sevenths, and a
 * pentatonic yields its (unnamed, analysis returns what it can) stacked shapes. Chords sit at the
 * scale's own octave (c3-register by default); callers wanting them near a note transpose.
 * Returns [{ degree, midis, name, roman, symbol, rootPc }].
 */
export function diatonicChords(scaleName, { sevenths = false } = {}) {
  const { intervals } = parseScaleName(scaleName);
  const stack = sevenths ? [0, 2, 4, 6] : [0, 2, 4];
  return intervals.map((_, degree) => {
    const midis = stack.map((s) => degreeToMidi(degree + s, scaleName));
    const a = analyzeChord(midis, scaleName);
    return {
      degree, midis,
      name: a?.name ?? null, roman: a?.roman ?? null, symbol: a?.symbol ?? null,
      rootPc: pc(midis[0]),
    };
  });
}

/**
 * The chord-menu list for one held note: every diatonic chord that CONTAINS the note, voiced so
 * the note itself is one of the returned MIDI numbers (the note you drew stays where you drew
 * it). `role` says what the note is in each chord - 'root' first, then '3rd', '5th' (and '7th'
 * with `sevenths`), which is the menu's natural grouping. A note outside the key is first taken
 * to its nearest degree (midiToDegree's quantization), same tie-break as everywhere else.
 * Returns [{ midis, role, degree, name, roman, symbol }] - `degree` is the CHORD ROOT's degree
 * class in the scale (0-based).
 */
export function chordsForNote(midi, scaleName, { sevenths = false } = {}) {
  const { intervals } = parseScaleName(scaleName);
  const len = intervals.length;
  const noteDegree = midiToDegree(midi, scaleName);
  const stack = sevenths ? [0, 2, 4, 6] : [0, 2, 4];
  const roles = ['root', '3rd', '5th', '7th'];
  return stack.map((offset, i) => {
    const rootDegree = noteDegree - offset;
    const midis = stack.map((s) => degreeToMidi(rootDegree + s, scaleName));
    const a = analyzeChord(midis, scaleName);
    return {
      midis, role: roles[i],
      degree: ((rootDegree % len) + len) % len,
      name: a?.name ?? null, roman: a?.roman ?? null, symbol: a?.symbol ?? null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Voicing transforms. All pure: sorted unique input copy in, NEW sorted array out - or null when
// the op doesn't apply to this chord (too few voices, no 7th to shell onto), which a menu reads
// as "don't offer it". Octave collisions dedupe (inverting an octave-doubled chord may shrink
// it), and results may run below 0 or above 127 - the caller clamps, since only it knows whether
// that means "skip" or "fold back in".
// ---------------------------------------------------------------------------------------------

/**
 * Musical inversion of a VOICING: `times` > 0 sends the bottom note up an octave, that many
 * times; `times` < 0 sends the top note down. invertChord(m, 1) of a close triad is its first
 * inversion; n-1 of them brings an n-note chord back to itself an octave up.
 */
export function invertChord(midis, times = 1) {
  let notes = uniqSorted(midis ?? []);
  if (notes.length < 2 || !times) return notes;
  for (let i = 0; i < Math.abs(times); i++) {
    notes = uniqSorted(times > 0
      ? [notes[0] + 12, ...notes.slice(1)]
      : [...notes.slice(0, -1), notes.at(-1) - 12]);
  }
  return notes;
}

/**
 * Close position: the bass stays put and every other pitch class folds into the octave just
 * above it. Octave doublings fold away (a pure-octave chord keeps one octave so a chord in
 * stays a chord out).
 */
export function closeVoicing(midis) {
  const notes = uniqSorted(midis ?? []);
  if (notes.length < 2) return notes;
  const bass = notes[0];
  const rest = [...new Set(notes.slice(1).map(pc))]
    .filter((p) => p !== pc(bass))
    .map((p) => bass + ((p - pc(bass)) + 12) % 12);
  return rest.length ? uniqSorted([bass, ...rest]) : [bass, bass + 12];
}

/** Drop-2: the second voice from the top drops an octave. Needs at least 3 voices. */
export function drop2(midis) {
  const notes = uniqSorted(midis ?? []);
  if (notes.length < 3) return null;
  notes[notes.length - 2] -= 12;
  return uniqSorted(notes);
}

/** Drop-3: the third voice from the top drops an octave. Needs at least 4 voices. */
export function drop3(midis) {
  const notes = uniqSorted(midis ?? []);
  if (notes.length < 4) return null;
  notes[notes.length - 3] -= 12;
  return uniqSorted(notes);
}

/** Spread: every second voice above the bass rises an octave, opening a close chord wide. */
export function spreadVoicing(midis) {
  const notes = uniqSorted(midis ?? []);
  if (notes.length < 3) return null;
  return uniqSorted(notes.map((m, i) => (i % 2 === 1 ? m + 12 : m)));
}

/**
 * Shell ("3 & 7") voicing: just the root, 3rd and 7th - the jazz comp skeleton. Null when the
 * chord has no analyzable root/3rd/7th (a plain triad has no 7th to shell onto; a voicing op
 * never invents notes the chord doesn't have).
 */
export function shellVoicing(midis) {
  const notes = uniqSorted(midis ?? []);
  const a = analyzeChord(notes);
  if (!a) return null;
  const iv = (m) => ((pc(m) - a.rootPc) + 12) % 12;
  const third = notes.find((m) => iv(m) === 3 || iv(m) === 4);
  const seventh = notes.find((m) => iv(m) === 10 || iv(m) === 11);
  if (third == null || seventh == null) return null;
  const root = notes.find((m) => iv(m) === 0);
  const above = (from, target) => { let m = from + 1; while (pc(m) !== pc(target)) m++; return m; };
  const t = above(root, third);
  return uniqSorted([root, t, above(t, seventh)]);
}

/** Doubles the bass an octave down. */
export function doubleBassOctave(midis) {
  const notes = uniqSorted(midis ?? []);
  if (!notes.length) return null;
  return uniqSorted([notes[0] - 12, ...notes]);
}

/**
 * The voicing menu for one chord: every transform above that applies, named, with the plain
 * inversions numbered. Entries that land exactly on the input voicing are skipped (offering
 * "close" on an already-close chord says nothing). Returns [{ name, midis }].
 */
export function chordVoicings(midis) {
  const notes = uniqSorted(midis ?? []);
  if (notes.length < 2) return [];
  const same = (a) => a && a.length === notes.length && a.every((m, i) => m === notes[i]);
  const out = [];
  const push = (name, voiced) => { if (voiced && !same(voiced)) out.push({ name, midis: voiced }); };
  push('close', closeVoicing(notes));
  for (let i = 1; i < notes.length; i++) push(`inversion ${i}`, invertChord(notes, i));
  push('drop 2', drop2(notes));
  push('drop 3', drop3(notes));
  push('spread', spreadVoicing(notes));
  push('shell (3 & 7)', shellVoicing(notes));
  push('bass octave', doubleBassOctave(notes));
  return out;
}
