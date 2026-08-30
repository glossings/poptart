// rollops.mjs - geometry on a piano roll's notes: strum, retrograde, pitch inversion, spread/
// contract, rhythmize, conform-to-key, humanize, legato, and the seeded ones - degrade, augment,
// variation. Every function here is
// notes -> notes over the roll's own note objects ({ midi, start, len, vel, prob, nudge, mute }),
// never mutating its input: the roll editor swaps the result in for the selection, so undo,
// overlap clipping and serialization all come from the editor as they do for any other edit.
//
// The unit of time is the CELL (the roll's grid). Onsets are whole cells, so anything that wants
// to land between them - a strum, a swung ride - goes into `nudge`, bipolar and clamped to half a
// cell either way, exactly the channel the value lane draws. Lengths are whole cells >= 1 (the
// overlap rule rounds up anything shorter), and `full` shadows `len` for that rule, so a function
// that changes a length sets both.
//
// Scale-aware operations take a scale name (see notes.mjs) and read/write degrees through
// midiToDegree/degreeToMidi; a note that isn't in the key takes its nearest degree and comes out
// in key, which is the honest reading of "invert this melody in C major".

import { degreeToMidi, midiToDegree, quantizeToScale } from './notes.mjs';

const MAX_NUDGE = 0.5; // mirrors pianoroll.mjs's PIANOROLL_MAX_NUDGE
const clampNudge = (v) => Math.min(MAX_NUDGE, Math.max(-MAX_NUDGE, v));
const clampMidi = (m) => Math.min(127, Math.max(0, Math.round(m)));
const clampVel = (v) => Math.min(1, Math.max(0, v));
const noteNudge = (nt) => (Number.isFinite(nt.nudge) ? clampNudge(nt.nudge) : 0);
const noteVel = (nt) => (Number.isFinite(nt.vel) ? nt.vel : 1);
const withLen = (nt, len) => ({ ...nt, len: Math.max(1, Math.round(len)), full: Math.max(1, Math.round(len)) });
const byTime = (a, b) => (a.start + noteNudge(a)) - (b.start + noteNudge(b)) || a.midi - b.midi;

/**
 * Places a note at a fractional cell position: the whole part is the onset, the remainder the
 * nudge, rounded so the nudge stays within its half-cell either way (2.7 = cell 3 nudged -0.3,
 * 2.5 = cell 2 nudged +0.5).
 */
function placeAt(nt, pos) {
  let start = Math.floor(pos);
  let nudge = pos - start;
  if (nudge > 0.5) { start += 1; nudge -= 1; } // exactly half stays in its own cell, pushed late
  return { ...nt, start, nudge: clampNudge(nudge) };
}

/** A tiny seeded generator (mulberry32) so "humanize" is reproducible per seed. */
export function seededRandom(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Time

/**
 * Strum: notes that share an onset are spread across `spread` cells, lowest first ('up') or
 * highest first ('down') by `key` (midi, or index for a drum roll), the first staying put. Within half a cell the whole strum is nudge; a
 * wider one steps later notes onto later cells with nudges filling the gaps, so a strum as wide as
 * you like survives the half-cell clamp. `velRamp` (0..1) fades the later notes - a strum is
 * loudest where the pick lands first.
 */
export function strum(notes, { spread = 0.5, direction = 'up', velRamp = 0, key = 'midi' } = {}) {
  const groups = new Map();
  for (const nt of notes) {
    const key = nt.start;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(nt);
  }
  const placed = new Map();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => (direction === 'down' ? b[key] - a[key] : a[key] - b[key]));
    const n = ordered.length;
    ordered.forEach((nt, i) => {
      const frac = n > 1 ? i / (n - 1) : 0;
      const out = placeAt(nt, nt.start + noteNudge(nt) + frac * spread);
      if (velRamp) out.vel = clampVel(noteVel(nt) * (1 - velRamp * frac));
      placed.set(nt, out);
    });
  }
  return notes.map((nt) => placed.get(nt));
}

/**
 * Retrograde: the selection played backwards within its own span - the last note's END becomes
 * the first note's start, so the phrase keeps its footprint. A nudge flips with it (late becomes
 * early).
 */
export function retrograde(notes) {
  if (!notes.length) return [];
  const lo = Math.min(...notes.map((nt) => nt.start));
  const hi = Math.max(...notes.map((nt) => nt.start + nt.len));
  return notes.map((nt) => ({ ...nt, start: lo + hi - (nt.start + nt.len), nudge: -noteNudge(nt) || 0 }));
}

/**
 * Legato: every note lasts until the next onset in the selection (any pitch), the way Live's
 * legato works on a monophonic line; notes sharing an onset get the same reach; the last keeps
 * its length.
 */
export function legato(notes) {
  const onsets = [...new Set(notes.map((nt) => nt.start))].sort((a, b) => a - b);
  return notes.map((nt) => {
    const next = onsets.find((s) => s > nt.start);
    return withLen(nt, next == null ? nt.len : next - nt.start);
  });
}

/**
 * Humanize: a seeded jitter on velocity (± `vel`, absolute) and timing (± `time` cells, into the
 * nudge). The seed is the caller's - the editor bumps it per invoke so a second "humanize" is a
 * different roll of the dice, and a test can pin one.
 */
export function humanize(notes, { seed = 1, vel = 0.1, time = 0.08 } = {}) {
  const rand = seededRandom(seed);
  return notes.map((nt) => ({
    ...nt,
    vel: clampVel(noteVel(nt) + (rand() * 2 - 1) * vel),
    nudge: clampNudge(noteNudge(nt) + (rand() * 2 - 1) * time),
  }));
}

// ---------------------------------------------------------------------------------------------
// Pitch

/**
 * Pitch inversion - the melody upside down. Chromatic: mirrored about the midpoint of its pitch
 * range (an even-semitone range mirrors about a real note, an odd one between two, either way
 * the top and bottom swap exactly). In key (`scale` given): the same mirror in scale degrees, so
 * a line in C major comes back in C major and a third stays a third.
 */
export function invertPitch(notes, { scale = null } = {}) {
  if (!notes.length) return [];
  if (!scale) {
    const lo = Math.min(...notes.map((nt) => nt.midi));
    const hi = Math.max(...notes.map((nt) => nt.midi));
    return notes.map((nt) => ({ ...nt, midi: clampMidi(lo + hi - nt.midi) }));
  }
  const degs = notes.map((nt) => midiToDegree(nt.midi, scale));
  const lo = Math.min(...degs), hi = Math.max(...degs);
  return notes.map((nt, i) => ({ ...nt, midi: clampMidi(degreeToMidi(lo + hi - degs[i], scale)) }));
}

/**
 * Spread / contract: every note moves one step (a scale degree in key, a semitone otherwise)
 * away from the selection's centre (`steps` > 0) or toward it (< 0), notes AT the centre staying
 * put and contracting notes never crossing it. Widens or tightens a voicing - or a melody's
 * ambitus - without changing its shape.
 */
export function spreadPitch(notes, { scale = null, steps = 1 } = {}) {
  if (!notes.length) return [];
  const toStep = (m) => (scale ? midiToDegree(m, scale) : m);
  const fromStep = (d) => (scale ? degreeToMidi(d, scale) : d);
  const ds = notes.map((nt) => toStep(nt.midi));
  const center = (Math.min(...ds) + Math.max(...ds)) / 2;
  return notes.map((nt, i) => {
    const d = ds[i];
    if (d === center) return { ...nt };
    const dir = Math.sign(d - center);
    let moved = d + dir * steps;
    if ((moved - center) * dir < 0) moved = Number.isInteger(center) ? center : center + dir * 0.5; // stop AT the centre
    return { ...nt, midi: clampMidi(fromStep(moved)) };
  });
}

/** Conform to key: each pitch to the nearest in `scale` (ties downward, like quantizeToScale). */
export function conformToScale(notes, scale) {
  return notes.map((nt) => ({ ...nt, midi: clampMidi(quantizeToScale(nt.midi, scale)) }));
}

// ---------------------------------------------------------------------------------------------
// Rhythm

/** Bjorklund's algorithm: k onsets spread as evenly as possible over n steps, step 0 a hit. */
export function euclid(k, n) {
  if (n <= 0 || k <= 0) return [];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  let a = Array.from({ length: k }, () => [1]);
  let b = Array.from({ length: n - k }, () => [0]);
  while (b.length > 1) {
    const m = Math.min(a.length, b.length);
    const merged = a.slice(0, m).map((x, i) => x.concat(b[i]));
    b = a.length > m ? a.slice(m) : b.slice(m);
    a = merged;
  }
  return [...a, ...b].flat().flatMap((v, i) => (v ? [i] : []));
}

/**
 * The rhythms "rhythmize" offers: onsets as fractions of the note's span, each with an accent map
 * alongside (1 = as loud as the note was) so the figure has a shape, not just a count. The 16-
 * pulse set is Toussaint's six distinguished timelines (The Geometry of Musical Rhythm) - the
 * five-onset patterns that carry son, rumba, bossa nova, shiko, soukous and gahu; the 8-pulse
 * ones are their Cuban ancestors plus the Charleston figure; bembe is the 12/8 standard bell,
 * and the ride is the jazz cymbal beat on the same ternary grid. Swing is NOT a figure here -
 * swingFigure() below lays it onto any of these at their own subdivision.
 */
export const RHYTHM_FIGURES = Object.freeze({
  tresillo: { steps: 8, hits: [0, 3, 6], accents: [1, 0.85, 0.9] },
  cinquillo: { steps: 8, hits: [0, 2, 3, 5, 6], accents: [1, 0.7, 0.9, 0.7, 0.9] },
  habanera: { steps: 8, hits: [0, 3, 4, 6], accents: [1, 0.8, 0.9, 0.85] },
  charleston: { steps: 8, hits: [0, 3], accents: [1, 0.9] },
  'son clave': { steps: 16, hits: [0, 3, 6, 10, 12], accents: [1, 0.85, 0.9, 0.85, 0.9] },
  'rumba clave': { steps: 16, hits: [0, 3, 7, 10, 12], accents: [1, 0.85, 0.9, 0.85, 0.9] },
  'bossa nova': { steps: 16, hits: [0, 3, 6, 10, 13], accents: [1, 0.85, 0.9, 0.85, 0.9] },
  shiko: { steps: 16, hits: [0, 4, 6, 10, 12], accents: [1, 0.85, 0.9, 0.85, 0.9] },
  soukous: { steps: 16, hits: [0, 3, 6, 10, 11], accents: [1, 0.85, 0.9, 0.85, 0.7] },
  gahu: { steps: 16, hits: [0, 3, 6, 10, 14], accents: [1, 0.85, 0.9, 0.85, 0.9] },
  'bembe bell': { steps: 12, hits: [0, 2, 4, 5, 7, 9, 11], accents: [1, 0.8, 0.9, 0.8, 0.9, 0.8, 0.85] },
  'jazz ride': { steps: 12, hits: [0, 3, 5, 6, 9, 11], accents: [1, 0.9, 0.7, 0.95, 0.9, 0.7] },
  'four on the floor': { steps: 4, hits: [0, 1, 2, 3], accents: [1, 0.85, 0.9, 0.85] },
  'off beats': { steps: 4, hits: [1, 3], accents: [0.9, 0.9] },
});

/** The note split into `parts` even hits - 3 is a triplet - accented on the first. */
export function divideFigure(parts) {
  const n = Math.max(1, Math.round(parts));
  return { steps: n, hits: Array.from({ length: n }, (_, i) => i), accents: Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0.85)) };
}

/**
 * Swing at the figure's own subdivision: every odd step is delayed by `amount` steps - the MPC/
 * groove-pool model, where 0 is straight, ~0.33 lands the offbeat on the triplet (a 66% swing)
 * and 0.5 is fully dotted (75%). Fractional hits are fine downstream: rhythmize places hits as
 * fractions of the note's span and pushes the remainder into nudges. Apply AFTER rotateFigure -
 * swing belongs to the grid, not to the pattern's phase.
 */
export function swingFigure(figure, amount = 0) {
  if (!amount) return figure;
  const { steps, hits, accents } = figure;
  return { steps, hits: hits.map((h) => (h % 2 === 1 ? h + amount : h)), accents };
}

/** A euclidean figure as the table above spells them, accents on the hits' downbeat only. */
export function euclidFigure(k, n) {
  const hits = euclid(k, n);
  return { steps: n, hits, accents: hits.map((h) => (h === 0 ? 1 : 0.85)) };
}

/**
 * Rhythmize: one note becomes a figure played over its own span - the note's length is the bar
 * the figure fills, each hit lasting until the next (the last to the note's end). Fractional
 * landings go into nudges, so a 16-step figure over a 4-cell note still swings the way it is
 * written; hits that would land in the same cell collapse into one. Returns null when the note is
 * too short to hold more than one hit - nothing for the menu to offer.
 */
export function rhythmize(note, figure) {
  const { steps, hits, accents = [] } = figure;
  const span = Math.max(1, Math.round(note.len));
  const placed = [];
  const seen = new Set();
  hits.forEach((h, i) => {
    const pos = note.start + (h / steps) * span;
    const out = placeAt(note, pos);
    if (seen.has(out.start) || out.start >= note.start + span) return; // two hits in one cell: the first keeps it
    seen.add(out.start);
    out.vel = clampVel(noteVel(note) * (accents[i] ?? 1));
    placed.push(out);
  });
  if (placed.length < 2) return null;
  placed.sort(byTime);
  return placed.map((nt, i) => {
    const next = placed[i + 1];
    const end = next ? next.start : note.start + span;
    return withLen(nt, end - nt.start);
  });
}

/** Rhythmize every note of a selection (each over its own span); notes too short pass through. */
export function rhythmizeAll(notes, figure) {
  const out = [];
  let changed = false;
  for (const nt of notes) {
    const r = rhythmize(nt, figure);
    if (r) { changed = true; out.push(...r); } else out.push({ ...nt });
  }
  return changed ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Chance. Everything here is seeded: the editor keeps the seed for the life of a popover so a
// slider drag re-runs the SAME dice with a new amount, and "reroll" is the only thing that
// changes them. The note nearest in time is the model for anything added - a rhythm augmented
// keeps sounding like itself.

const nearestInTime = (notes, cell) => notes.reduce((a, b) => (Math.abs(b.start - cell) < Math.abs(a.start - cell) ? b : a));

/** A pitch a scale step (or a semitone, with no scale) away from `midi`, `dir` = -1 / 0 / +1. */
function stepPitch(midi, dir, scale) {
  if (!dir) return clampMidi(midi);
  return clampMidi(scale ? degreeToMidi(midiToDegree(midi, scale) + dir, scale) : midi + dir);
}

/** Degrade: each note dropped with probability `amount`; at least one always survives. */
export function degrade(notes, { amount = 0.3, seed = 1 } = {}) {
  const rand = seededRandom(seed);
  const kept = notes.filter(() => rand() >= amount).map((nt) => ({ ...nt }));
  return kept.length || !notes.length ? kept : [{ ...notes[Math.floor(rand() * notes.length)] }];
}

/**
 * Augment: new notes in a share (`amount`) of the empty cells of the selection's span, each a
 * cell long, modelled on its nearest neighbour - the same pitch half the time, a scale step
 * either way otherwise (`repitch: false` for a drum roll, where a row is a sound) - and a little
 * quieter, so additions read as ghost notes until raised. Originals come first, additions after.
 */
export function augment(notes, { amount = 0.3, seed = 1, scale = null, span = null, repitch = true } = {}) {
  if (!notes.length) return [];
  const rand = seededRandom(seed);
  const [from, to] = span ?? [Math.min(...notes.map((nt) => nt.start)), Math.max(...notes.map((nt) => nt.start + nt.len))];
  const taken = new Set(notes.map((nt) => nt.start));
  const empty = [];
  for (let c = from; c < to; c++) if (!taken.has(c)) empty.push(c);
  const shuffled = empty.map((c) => [rand(), c]).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  const added = shuffled.slice(0, Math.round(amount * empty.length)).sort((a, b) => a - b).map((c) => {
    const model = nearestInTime(notes, c);
    const dir = !repitch || rand() < 0.5 ? 0 : (rand() < 0.5 ? -1 : 1);
    return { ...model, start: c, len: 1, full: 1, nudge: 0, midi: stepPitch(model.midi, dir, scale), vel: clampVel(noteVel(model) * 0.8) };
  });
  return [...notes.map((nt) => ({ ...nt })), ...added];
}

/**
 * Variation: the loop doubled, the second half a variation of the first. `temperature` (0..1) is
 * how much of the copy is up for change: each copied note in the region has that chance of being
 * dropped, moved a cell, taken a scale step, or softened, and empty cells in the region fill at a
 * third of that rate. `from`..`to` (fractions of the copy) confine the changes - `from: 0.75` is
 * the classic fill at the end of the second bar; the copy outside the region is verbatim.
 * `repitch: false` (a drum roll) keeps every row - only timing, presence and velocity vary.
 * Returns { notes, len }: the originals untouched, then the copy, and the doubled length.
 */
export function variation(notes, { len, start = 0, temperature = 0.35, seed = 1, scale = null, from = 0, to = 1, repitch = true } = {}) {
  const span = Math.max(1, Math.round(len));
  const rand = seededRandom(seed);
  const lo = start + span + Math.round(from * span);
  const hi = start + span + Math.round(to * span);
  const inRegion = (c) => c >= lo && c < hi;
  const originals = notes.filter((nt) => nt.start >= start && nt.start < start + span);
  const copy = [];
  for (const src of originals) {
    const nt = { ...src, start: src.start + span };
    if (!inRegion(nt.start) || rand() >= temperature) { copy.push(nt); continue; }
    const op = rand();
    if (op < 0.3) continue; // dropped
    if (op < 0.6) { // moved a cell, staying in the region
      const moved = nt.start + (rand() < 0.5 ? -1 : 1);
      nt.start = inRegion(moved) ? moved : nt.start;
    } else if (op < 0.9 && repitch) {
      nt.midi = stepPitch(nt.midi, rand() < 0.5 ? -1 : 1, scale);
    } else {
      nt.vel = clampVel(noteVel(nt) * (0.6 + rand() * 0.3));
    }
    copy.push(nt);
  }
  const models = copy.length ? copy : originals.map((nt) => ({ ...nt, start: nt.start + span }));
  const taken = new Set(copy.map((nt) => nt.start));
  for (let c = lo; c < hi; c++) {
    if (taken.has(c) || !models.length || rand() >= temperature / 3) continue;
    const model = nearestInTime(models, c);
    const dir = !repitch || rand() < 0.5 ? 0 : (rand() < 0.5 ? -1 : 1);
    copy.push({ ...model, start: c, len: 1, full: 1, nudge: 0, midi: stepPitch(model.midi, dir, scale), vel: clampVel(noteVel(model) * 0.8) });
  }
  return { notes: [...notes.map((nt) => ({ ...nt })), ...copy], len: span * 2 };
}

/** A figure turned `rotation` steps later (negative = earlier), accents riding along. */
export function rotateFigure(figure, rotation = 0) {
  const { steps, hits, accents = [] } = figure;
  const r = ((Math.round(rotation) % steps) + steps) % steps;
  const pairs = hits.map((h, i) => [(h + r) % steps, accents[i] ?? 1]).sort((a, b) => a[0] - b[0]);
  return { steps, hits: pairs.map((p) => p[0]), accents: pairs.map((p) => p[1]) };
}
