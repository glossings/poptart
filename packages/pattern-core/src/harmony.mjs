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
  { symbol: '6/9', quality: 'six-nine', intervals: [0, 2, 4, 7, 9] },
  { symbol: '11', quality: 'dominant 11th', intervals: [0, 2, 4, 5, 7, 10] },
  { symbol: 'm11', quality: 'minor 11th', intervals: [0, 2, 3, 5, 7, 10] },
  { symbol: 'maj11', quality: 'major 11th', intervals: [0, 2, 4, 5, 7, 11] },
  // 13ths both ways: the full diatonic stack, and the way they're actually played - 11th
  // omitted. Same symbol either way; a 13 chord doesn't stop being one for dropping its 11.
  { symbol: '13', quality: 'dominant 13th', intervals: [0, 2, 4, 7, 9, 10] },
  { symbol: 'm13', quality: 'minor 13th', intervals: [0, 2, 3, 7, 9, 10] },
  { symbol: 'maj13', quality: 'major 13th', intervals: [0, 2, 4, 7, 9, 11] },
  { symbol: '13', quality: 'dominant 13th', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { symbol: 'm13', quality: 'minor 13th', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { symbol: 'maj13', quality: 'major 13th', intervals: [0, 2, 4, 5, 7, 9, 11] },
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
  m7: '7', m6: '6', m9: '9', madd9: 'add9', m11: '11', m13: '13',
};
// The bare numeral's markers: what survives when the quality tail is dropped - case already says
// major/minor, but °/ø/+ are identity, not extension, so "vii°" keeps its ring without its 7.
const ROMAN_MARKER = { dim: '°', dim7: '°', m7b5: 'ø', aug: '+' };

/**
 * The roman numeral for a chord root + quality in `scaleName`: "V7", "ii7", "vii°", "IVmaj7" -
 * or, with `bare`, just the cased numeral and its °/ø/+ marker ("V", "ii", "viiø"), for a slot
 * (the roll header's readout) where the chord name beside it already spells the quality out.
 * Only 7-note scales get numerals (they're what the notation means); other lengths, and roots
 * that aren't scale tones, return null - a menu just shows nothing in that slot.
 */
export function romanNumeral(rootPc, qualityEntry, scaleName, { bare = false } = {}) {
  if (scaleName == null || !qualityEntry) return null;
  const { rootMidi, intervals } = parseScaleName(scaleName);
  if (intervals.length !== 7) return null;
  const degree = intervals.findIndex((iv) => pc(rootMidi + iv) === pc(rootPc));
  if (degree < 0) return null;
  const upper = qualityEntry.intervals.includes(4) || !qualityEntry.intervals.includes(3);
  const numeral = upper ? ROMAN[degree] : ROMAN[degree].toLowerCase();
  if (bare) return numeral + (ROMAN_MARKER[qualityEntry.symbol] ?? '');
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
 * Shape: { rootPc, rootName, symbol, quality, name, bassMidi, bassPc, inversion, roman,
 * numeral } - `roman` is the full numeral ("viiø7"), `numeral` the bare one ("viiø").
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
    numeral: romanNumeral(rootPc, entry, scaleName, { bare: true }),
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

/**
 * Extended chords with the held note as ROOT: the diatonic 9th, 11th and 13th stacked up from
 * its degree - the menu's "go taller" section. Unlike chordsForNote this offers only the root
 * role: a note as the 11th of something is a spelling, not a suggestion. Stacks that don't
 * analyze to a name are dropped rather than offered as note-soup - in a major key that's the
 * b9 stacks on iii and vii, which is the tables agreeing with the ear. Returns
 * [{ kind, midis, name, roman, symbol, degree }], possibly empty.
 */
export function extendedChordsOnNote(midi, scaleName) {
  const { intervals } = parseScaleName(scaleName);
  const len = intervals.length;
  const noteDegree = midiToDegree(midi, scaleName);
  const out = [];
  for (const [kind, height] of [['9th', 5], ['11th', 6], ['13th', 7]]) {
    const midis = Array.from({ length: height }, (_, s) => degreeToMidi(noteDegree + 2 * s, scaleName));
    const a = analyzeChord(midis, scaleName);
    if (!a || a.rootPc !== pc(midis[0])) continue; // unnamed, or named as something else entirely
    out.push({
      kind, midis, name: a.name, roman: a.roman, symbol: a.symbol,
      degree: ((noteDegree % len) + len) % len,
    });
  }
  return out;
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

/**
 * The same voicing moved by whole octaves to sit as close as possible to `reference` - its mean
 * pitch lands nearest the reference's mean (ties resolve downward, like every tie here). This is
 * what keeps a cycled inversion IN PLACE: bare invertChord only ever climbs, so the menu centers
 * each inversion back around the chord it came from rather than walking it up the keyboard.
 */
export function centerVoicing(midis, reference) {
  const notes = uniqSorted(midis ?? []);
  const ref = uniqSorted(reference ?? []);
  if (!notes.length || !ref.length) return notes;
  const mean = (a) => a.reduce((s, m) => s + m, 0) / a.length;
  const target = mean(ref);
  let best = notes;
  let bestDist = Infinity;
  for (let oct = -2; oct <= 2; oct++) {
    const moved = notes.map((m) => m + 12 * oct);
    const dist = Math.abs(mean(moved) - target);
    if (dist < bestDist) { best = moved; bestDist = dist; } // strict: a tie keeps the lower octave
  }
  return best;
}

/** Doubles the bass an octave down. */
export function doubleBassOctave(midis) {
  const notes = uniqSorted(midis ?? []);
  if (!notes.length) return null;
  return uniqSorted([notes[0] - 12, ...notes]);
}

/**
 * The voicing menu for one chord: every transform above that applies, named, with the plain
 * inversions numbered - each inversion centered back around the original (see centerVoicing), so
 * cycling through them re-voices the chord in place instead of marching it up the keyboard.
 * Entries that land exactly on the input voicing are skipped (offering "close" on an
 * already-close chord says nothing), and so are duplicates of an entry already offered - two
 * roads to the same voicing (closing an open chord, and cycling it round then centering it back)
 * are one choice, under the first road's name. Returns [{ name, midis }].
 */
export function chordVoicings(midis) {
  const notes = uniqSorted(midis ?? []);
  if (notes.length < 2) return [];
  const seen = new Set([notes.join(',')]);
  const out = [];
  const push = (name, voiced) => {
    if (!voiced || seen.has(voiced.join(','))) return;
    seen.add(voiced.join(','));
    out.push({ name, midis: voiced });
  };
  push('close', closeVoicing(notes));
  for (let i = 1; i < notes.length; i++) push(`inversion ${i}`, centerVoicing(invertChord(notes, i), notes));
  push('drop 2', drop2(notes));
  push('drop 3', drop3(notes));
  push('spread', spreadVoicing(notes));
  push('shell (3 & 7)', shellVoicing(notes));
  push('bass octave', doubleBassOctave(notes));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Chord building and voice-wise voicing, for the pattern methods (.chord/.inv/.voicing/.spread/
// .lead). Unlike the menu transforms above these keep VOICES: out[i] is where input voice i went
// (null = that voice is dropped), so a drawn chord's per-note lengths and velocities stay with
// their notes. Voices are compared by pitch, so callers pass them low to high.
// ---------------------------------------------------------------------------------------------

// How a pattern writes each quality. A bare number in mini notation is a number - and a number
// means "stack the key's thirds this high" (chordExtension) - so the dictionary's numeric symbols
// take a word: "dom7", "maj6", "maj69", "power". Symbols mini can't parse (^7, -7, ø) are not
// offered. Every other dictionary symbol is its own spelling.
const QUALITY_SPELLINGS = {
  '': ['maj', 'M', 'major'],
  m: ['m', 'min', 'minor'],
  7: ['dom7'],
  9: ['dom9'],
  11: ['dom11'],
  13: ['dom13'],
  6: ['maj6', 'M6'],
  '6/9': ['maj69'],
  5: ['power'],
  maj7: ['maj7', 'M7'],
  maj9: ['maj9', 'M9'],
  maj11: ['maj11', 'M11'],
  maj13: ['maj13', 'M13'],
  m7: ['m7', 'min7'],
  mMaj7: ['mMaj7', 'mM7'],
};

// name -> intervals. The first dictionary entry for a symbol wins, which for the 13ths is the
// way they're played (11th omitted).
const QUALITY_BY_NAME = (() => {
  const byName = new Map();
  for (const entry of CHORD_QUALITIES) {
    for (const name of QUALITY_SPELLINGS[entry.symbol] ?? [entry.symbol]) {
      if (!byName.has(name)) byName.set(name, entry.intervals);
    }
  }
  return byName;
})();

/** Every quality name chordIntervals() accepts, in dictionary order. */
export const CHORD_NAMES = Object.freeze([...QUALITY_BY_NAME.keys()]);

/** A quality name ("m9", "maj7", "dom7", "sus4") -> its semitone intervals above the root, or null. */
export function chordIntervals(name) {
  const intervals = QUALITY_BY_NAME.get(String(name));
  return intervals ? [...intervals] : null;
}

/**
 * The scale steps above the root for a chord stacked in the key up to extension `n`: 5 is the
 * triad (0 2 4), 7 the seventh chord, 9/11/13 taller, 3 the root and third, 1 the root alone; 6
 * is the triad plus the sixth. Null for anything else (even numbers besides 6, zero, negatives).
 */
export function chordExtension(n) {
  const ext = Math.round(Number(n));
  if (ext === 6) return [0, 2, 4, 5];
  if (!Number.isFinite(ext) || ext < 1 || ext % 2 === 0) return null;
  return Array.from({ length: (ext + 1) / 2 }, (_, i) => 2 * i);
}

const meanOf = (a) => a.reduce((s, m) => s + m, 0) / a.length;

/**
 * Every voice moves to the next chord tone up (`steps` > 0) or down (`steps` < 0), that many
 * times. On a close chord that is the plain inversion (C E G -> E G C); on any other voicing it
 * is the same shape on the next inversion - a drop-2 stays a drop-2, a spread chord stays
 * spread - because each voice keeps its place in the stack. The chord tones are the voices' own
 * pitch classes.
 */
export function rotateVoices(midis, steps = 1) {
  const voices = (midis ?? []).map((m) => Math.round(m));
  const pcs = [...new Set(voices.map(pc))].sort((a, b) => a - b);
  const times = Math.round(steps);
  if (!pcs.length || !times) return voices;
  return voices.map((m) => {
    let out = m;
    for (let i = 0; i < Math.abs(times); i++) {
      const at = pcs.indexOf(pc(out));
      if (times > 0) out += ((pcs[(at + 1) % pcs.length] - pc(out)) + 12) % 12 || 12;
      else out -= ((pc(out) - pcs[(at - 1 + pcs.length) % pcs.length]) + 12) % 12 || 12;
    }
    return out;
  });
}

// Hands a re-voiced chord's pitches back to the notes they came from: each input note takes an
// output pitch of its own pitch class (doublings pair in order), so the C that moved up an octave
// is still the C - its length and velocity go with it. Pitches left over (a rotation can turn a
// doubled root into a doubled third) fill the remaining notes in order.
function byPitchClass(voices, pitches) {
  const free = [...pitches];
  const out = voices.map((m) => {
    const i = free.findIndex((p) => p != null && pc(p) === pc(m));
    if (i < 0) return null;
    const p = free[i];
    free[i] = null;
    return p;
  });
  const rest = free.filter((p) => p != null);
  return out.map((p) => (p == null ? rest.shift() : p));
}

/**
 * rotateVoices, then moved by whole octaves back around where the chord was (centerVoicing's
 * rule), so stepping through inversions re-voices the chord in place instead of climbing. Comes
 * back note by note by pitch class: the input's C is the output's C.
 */
export function invertVoices(midis, steps = 1) {
  const voices = (midis ?? []).map((m) => Math.round(m));
  if (voices.length < 2) return voices;
  const rotated = rotateVoices(voices, steps);
  const shift = centerVoicing(rotated, voices)[0] - Math.min(...rotated);
  return byPitchClass(voices, rotated.map((m) => m + shift));
}

/**
 * Widens a chord by octaves, from the middle out: the lowest and highest voices move `amount`
 * octaves away from the middle and the voices between move in proportion, rounded to whole
 * octaves (a half rounds toward the middle), so every voice keeps its pitch class. A negative
 * amount pulls the outer voices in.
 */
export function spreadVoices(midis, amount = 1) {
  const voices = (midis ?? []).map((m) => Math.round(m));
  const len = voices.length;
  const n = Number(amount);
  if (len < 2 || !Number.isFinite(n) || !n) return voices;
  const rank = voices.map((m, i) => i).sort((a, b) => voices[a] - voices[b] || a - b);
  const out = [...voices];
  rank.forEach((v, r) => {
    const x = (2 * r / (len - 1) - 1) * n;
    out[v] += 12 * Math.sign(x) * Math.ceil(Math.abs(x) - 0.5);
  });
  return out;
}

/** The voicing names voicingVoices() knows. */
export const VOICING_NAMES = Object.freeze(['close', 'open', 'drop2', 'drop3', 'shell']);

/**
 * A named voicing, voice by voice: 'close' folds every voice into the octave above the bass
 * (doublings drop out), 'open' raises every second voice above the bass an octave, 'drop2' and
 * 'drop3' drop the second and third voice from the top an octave, 'shell' keeps only the root,
 * 3rd and 7th. Same voices back when the voicing doesn't apply to this chord (too few voices, no
 * 7th to shell onto); undefined for a name it doesn't know.
 */
export function voicingVoices(midis, name) {
  const voices = (midis ?? []).map((m) => Math.round(m));
  const len = voices.length;
  // Voice indices low to high (ties keep input order).
  const order = voices.map((m, i) => i).sort((a, b) => voices[a] - voices[b] || a - b);
  const moved = (fn) => {
    const out = [...voices];
    order.forEach((v, r) => { out[v] = fn(voices[v], r); });
    return out;
  };
  switch (String(name)) {
    case 'close': {
      if (len < 2) return voices;
      const bass = voices[order[0]];
      const seen = new Set();
      const out = moved((m, r) => (r === 0 ? m : bass + ((pc(m) - pc(bass)) + 12) % 12));
      // A doubling folds onto a voice already there: keep the lower voice, drop the rest - but a
      // chord of one pitch class keeps its octave, so a chord in stays a chord out.
      if (new Set(voices.map(pc)).size === 1) return moved((m, r) => bass + 12 * Math.min(r, 1));
      return out.map((m, i) => {
        const key = i === order[0] ? bass : m === bass ? null : m;
        if (key == null || seen.has(key)) return null;
        seen.add(key);
        return m;
      });
    }
    case 'open':
      return len < 3 ? voices : moved((m, r) => (r % 2 === 1 ? m + 12 : m));
    case 'drop2':
      return len < 3 ? voices : moved((m, r) => (r === len - 2 ? m - 12 : m));
    case 'drop3':
      return len < 4 ? voices : moved((m, r) => (r === len - 3 ? m - 12 : m));
    case 'shell': {
      const a = analyzeChord(voices);
      if (!a) return voices;
      const iv = (m) => ((pc(m) - a.rootPc) + 12) % 12;
      const pick = (want) => order.find((v) => want.includes(iv(voices[v])));
      const root = pick([0]);
      const third = pick([3, 4]);
      const seventh = pick([10, 11]);
      if (root == null || third == null || seventh == null) return voices;
      const above = (from, target) => { let m = from + 1; while (pc(m) !== pc(target)) m++; return m; };
      const out = voices.map(() => null);
      out[root] = voices[root];
      out[third] = above(voices[root], voices[third]);
      out[seventh] = above(out[third], voices[seventh]);
      return out;
    }
    default:
      return undefined;
  }
}

// How far a led chord's middle may wander from home (in semitones) before it pays for it. Inside
// the window only movement counts; past it every semitone costs as much as moving every voice one.
const LEAD_WINDOW = 6;

// How far voices travel between two chords. Same size: voice to voice, low to high - on a line,
// pairing in order is the cheapest pairing there is. Different sizes: each note's distance to the
// nearest note of the other chord, summed both ways, so a held common tone still costs nothing.
function voiceMotion(a, b) {
  if (a.length === b.length) {
    const x = [...a].sort((p, q) => p - q);
    const y = [...b].sort((p, q) => p - q);
    return x.reduce((s, m, i) => s + Math.abs(m - y[i]), 0);
  }
  const near = (m, set) => Math.min(...set.map((v) => Math.abs(v - m)));
  return a.reduce((s, m) => s + near(m, b), 0) + b.reduce((s, m) => s + near(m, a), 0);
}

/**
 * Voice leading: the inversion (rotateVoices) and octave of this chord that moves least from
 * `prev`, kept near `home` (a MIDI note; the chord's own middle when omitted). With no previous
 * chord, the one whose middle is nearest home - the chord as written, when home is its own
 * middle. The chord's shape survives (only rotations and octaves are tried); single notes come
 * back untouched. Ties go to the fewer rotations, then the lower octave. Note by note by pitch
 * class, like invertVoices.
 */
export function leadVoices(midis, prev = null, home = null) {
  const voices = (midis ?? []).map((m) => Math.round(m));
  if (voices.length < 2) return voices;
  const center = Number.isFinite(home) ? home : meanOf(voices);
  const before = prev?.length ? prev : null;
  const pcCount = new Set(voices.map(pc)).size;
  let best = voices;
  let bestCost = Infinity;
  for (let k = 0; k < pcCount; k++) {
    const rotated = rotateVoices(voices, k);
    const near = Math.round((center - meanOf(rotated)) / 12);
    for (let oct = near - 2; oct <= near + 2; oct++) {
      const cand = rotated.map((m) => m + 12 * oct);
      const drift = Math.abs(meanOf(cand) - center);
      const cost = before
        ? voiceMotion(before, cand) + cand.length * Math.max(0, drift - LEAD_WINDOW)
        : drift;
      if (cost < bestCost - 1e-9) { best = cand; bestCost = cost; }
    }
  }
  return byPitchClass(voices, best);
}
