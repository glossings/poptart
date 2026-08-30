// rollops.mjs - geometry on a piano roll's notes: strum, retrograde, pitch inversion, spread/
// contract, rhythmize, conform-to-key, humanize, legato, and the seeded ones - degrade, augment,
// variation - and the generators, arpeggiate and melodize. Every function here is
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

import { degreeToMidi, midiToDegree, quantizeToScale, scalePitchClasses } from './notes.mjs';

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

// ---------------------------------------------------------------------------------------------
// Accents. A weight curve over the BAR (accents are metric - where a note sits in the bar decides
// its weight, not where it sits in the selection), sampled at each note's own moment and applied
// to velocity - and, at the caller's option, to timing (weak notes laid back, the accented ones
// dead on: most of what a groove template is) and length (weak notes clipped shorter). The
// 'waves' shape superposes independent cosine cycles at the half, quarter, eighth and
// dotted-eighth of the bar - the dotted one is what pushes 3+3+2.

export const ACCENT_SHAPES = Object.freeze(['waves', 'downbeats', 'offbeats', '3+3+2', 'clave', 'ramp up', 'ramp down', 'random']);

const nearInt = (x) => Math.abs(x - Math.round(x)) < 0.02;

/** The accent weight at `t` (fraction of the bar, 0..1): 1 = strongest, -1 = weakest. */
export function accentWeight(t, shape, { waves = null, rand = null } = {}) {
  switch (shape) {
    case 'waves': {
      const { half = 0, quarter = 0, eighth = 0, dotted = 0 } = waves ?? {};
      const total = half + quarter + eighth + dotted;
      if (!total) return 0;
      const tau = 2 * Math.PI;
      return (half * Math.cos(tau * 2 * t) + quarter * Math.cos(tau * 4 * t)
        + eighth * Math.cos(tau * 8 * t) + dotted * Math.cos(tau * t * 16 / 3)) / total;
    }
    case 'downbeats':
    case 'offbeats': {
      // The metric hierarchy by binary subdivision, so it reads the same on a triplet grid: the
      // bar's start, then halves, quarters, eighth-offs, sixteenth-offs, then everything between.
      const w = nearInt(t) ? 1 : nearInt(t * 2) ? 0.7 : nearInt(t * 4) ? 0.4 : nearInt(t * 8) ? 0 : nearInt(t * 16) ? -0.6 : -0.8;
      return shape === 'offbeats' ? -w : w;
    }
    case '3+3+2': return nearInt(t * 8) && [0, 3, 6].includes(((Math.round(t * 8) % 8) + 8) % 8) ? 1 : -0.5;
    case 'clave': return nearInt(t * 16) && [0, 3, 6, 10, 12].includes(((Math.round(t * 16) % 16) + 16) % 16) ? 1 : -0.5;
    case 'ramp up': return 2 * t - 1;
    case 'ramp down': return 1 - 2 * t;
    case 'random': return 2 * (rand?.(Math.round(t * 32)) ?? 0.5) - 1;
    default: return 0;
  }
}

/**
 * Accentuate: reshape the selection's dynamics by where each note sits in the bar. `vel` is the
 * depth (bipolar - negative accents the weak pulses instead), scaling each velocity by up to
 * ±75% at full depth so existing dynamics shape through rather than being replaced. `time` lays
 * weak notes back by up to that many cells (negative rushes them); `length` clips weak notes up
 * to half their cells. `grid` is the bar (the roll's cells per cycle); 'random' rolls one seeded
 * weight per bar position, so a chord stays a chord.
 */
export function accentuate(notes, { grid = 16, shape = 'downbeats', waves = null, vel = 0.6, time = 0, length = 0, seed = 1 } = {}) {
  const g = Math.max(1, Math.round(grid));
  const rand = (i) => seededRandom(((seed * 131071) ^ (i * 7919)) >>> 0)();
  return notes.map((nt) => {
    const pos = nt.start + noteNudge(nt);
    const t = (((pos % g) + g) % g) / g;
    const w = accentWeight(t, shape, { waves, rand });
    const weak = (1 - w) / 2; // 0 on the strongest pulse, 1 on the weakest
    const out = { ...nt };
    if (vel) out.vel = clampVel(noteVel(nt) * (1 + 0.75 * vel * w));
    if (time) out.nudge = clampNudge(noteNudge(nt) + time * weak);
    if (length && nt.len > 1) {
      const l = Math.max(1, Math.round(nt.len * (1 - 0.5 * length * weak)));
      out.len = l;
      out.full = l;
    }
    return out;
  });
}

/** A figure turned `rotation` steps later (negative = earlier), accents riding along. */
export function rotateFigure(figure, rotation = 0) {
  const { steps, hits, accents = [] } = figure;
  const r = ((Math.round(rotation) % steps) + steps) % steps;
  const pairs = hits.map((h, i) => [(h + r) % steps, accents[i] ?? 1]).sort((a, b) => a[0] - b[0]);
  return { steps, hits: pairs.map((p) => p[0]), accents: pairs.map((p) => p[1]) };
}

// ---------------------------------------------------------------------------------------------
// Generators. Destructive in the roll's spirit: a chord becomes the run of notes an arpeggiator
// would have played, a rhythm keeps its every cell and takes a freshly walked melody. Seeded like
// the chance ops - one seed per popover, reroll throws new dice.

/**
 * Arpeggiate: each chord (notes sharing an onset) becomes a run of single notes over the chord's
 * own span, one every `rate` cells, cycling through the chord in `direction` order - 'up',
 * 'down', 'up-down' (no repeated turnaround), 'converge' (outside in), 'as drawn' (the order the
 * notes were added), or 'random' (seeded, never the same note twice in a row). Each hit keeps its
 * source note's velocity, fractional rates land in nudges, and a hit that would double a pitch in
 * a cell - or run past the chord's end - is dropped (a lane holds one note per cell). Lone notes
 * pass through untouched.
 */
export function arpeggiate(notes, { rate = 1, direction = 'up', seed = 1 } = {}) {
  const r = Math.max(0.25, rate);
  const rand = seededRandom(seed);
  const groups = new Map();
  for (const nt of notes) {
    if (!groups.has(nt.start)) groups.set(nt.start, []);
    groups.get(nt.start).push(nt);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) { out.push({ ...group[0] }); continue; }
    const start = group[0].start + Math.min(...group.map(noteNudge)); // an offbeat chord arps from where it sat
    const span = Math.max(...group.map((nt) => nt.len));
    const asc = [...group].sort((a, b) => a.midi - b.midi);
    const cycle = direction === 'down' ? [...asc].reverse()
      : direction === 'up-down' ? [...asc, ...asc.slice(1, -1).reverse()]
      : direction === 'converge' ? asc.map((_, i) => (i % 2 ? asc[asc.length - 1 - (i >> 1)] : asc[i >> 1]))
      : direction === 'as drawn' ? [...group]
      : asc; // 'up'; 'random' re-picks per hit below
    const seen = new Set();
    let prevPick = -1;
    for (let i = 0; i * r < span - 1e-9; i++) {
      let src = cycle[i % cycle.length];
      if (direction === 'random') {
        let idx = Math.floor(rand() * asc.length);
        if (idx === prevPick) idx = (idx + 1) % asc.length;
        prevPick = idx;
        src = asc[idx];
      }
      const hit = placeAt(src, start + i * r);
      const key = `${hit.start}:${hit.midi}`;
      if (hit.start >= group[0].start + span || seen.has(key)) continue;
      seen.add(key);
      out.push(withLen(hit, Math.min(r, span - i * r)));
    }
  }
  return out;
}

/**
 * Melodize: same rhythm, new pitches - every cell, length, velocity and nudge stays put, the
 * pitches are a seeded walk in `scale`. Four dials; the last two both read as "adherence to the
 * original", 0 ignoring it and 1 preserving it:
 *
 *   range   the walk's window in scale steps, centred on the selection's own midpoint. Unset, it
 *           is the selection's span, widened to an octave when narrower - so one repeated pitch
 *           still yields a melody. A window wider than an octave also walks bolder - the leaps
 *           scale with it - so widening the range audibly spreads the line, not just its limits.
 *   offset  moves the whole window up or down in scale steps.
 *   shape   each re-pitched note's chance of tracing the original's shape: pulled to its own
 *           position mapped into the window (so range magnifies the drawn contour), wiggled a
 *           step for fresh notes, and held to the original's direction sign for sign (a repeat
 *           staying a repeat); otherwise the walk chooses freely - steps over leaps, leaning
 *           back toward the middle of the window. 1 is "same shape, new notes".
 *   keep    each note's chance of not being re-pitched at all, kept notes anchoring the walk -
 *           0 is a whole new melody, ~0.65 mutates a familiar one.
 *
 * Free-walking notes on the strong beats of the bar (`grid` cells, its quarters the beats) land
 * on tonic-triad tones - the chord-tone bias that keeps a random line sounding intentional; a
 * shape-following note is exempt (the shape is the constraint there). Notes sharing an onset
 * always come out on distinct pitches, since a duplicate would collapse into one note. Each
 * note's dice are drawn up front, so dragging any one dial never rescrambles the others' work.
 */
export function melodize(notes, { scale, seed = 1, keep = 0, shape = 0, range = null, offset = 0, grid = 16 } = {}) {
  if (!notes.length) return [];
  const rand = seededRandom(seed);
  const size = scalePitchClasses(scale).length || 7;
  const triad = size >= 6 ? [0, 2, 4] : null; // in a pentatonic everything is a chord tone already
  const ordered = notes.map((nt, i) => [nt, i]).sort((a, b) => byTime(a[0], b[0]));
  const dice = ordered.map(() => [rand(), rand(), rand(), rand(), rand()]);
  const degs = ordered.map(([nt]) => midiToDegree(nt.midi, scale));
  let lo = Math.min(...degs), hi = Math.max(...degs);
  const origLo = lo, origSpan = hi - lo; // the drawn shape's own span, for contour mapping
  if (range != null) {
    const width = Math.max(1, Math.round(range));
    const mid = Math.round((lo + hi) / 2);
    lo = mid - (width >> 1);
    hi = lo + width;
  } else if (hi - lo < size) { // a narrow selection - one repeated pitch included - gets an octave
    const mid = Math.round((lo + hi) / 2);
    lo = mid - (size >> 1);
    hi = lo + size;
  }
  lo += Math.round(offset);
  hi += Math.round(offset);
  const center = (lo + hi) / 2;
  const stretch = Math.max(1, (hi - lo) / size); // a wide window walks bolder, so range is heard
  const clampDeg = (d) => Math.min(hi, Math.max(lo, d));
  const beat = grid >= 4 && Number.isInteger(grid / 4) ? grid / 4 : null;
  const snapTriad = (d, dir) => {
    if (!triad) return d;
    for (let k = 0; k <= size; k++) {
      for (const cand of (dir < 0 ? [d - k, d + k] : [d + k, d - k])) {
        if (cand >= lo && cand <= hi && triad.includes(((cand % size) + size) % size)) return cand;
      }
    }
    return d;
  };
  const result = new Array(notes.length);
  let prev = clampDeg(degs[0] + Math.round(offset));
  let onsetKey = null;
  let atOnset = new Set();
  ordered.forEach(([nt, idx], i) => {
    const pos = nt.start + noteNudge(nt);
    if (pos !== onsetKey) { onsetKey = pos; atOnset = new Set(); }
    const [keepRoll, dirRoll, magRoll, magRoll2, shapeRoll] = dice[i];
    if (keepRoll < keep) {
      atOnset.add(degs[i]);
      prev = degs[i];
      result[idx] = { ...nt };
      return;
    }
    const follow = shapeRoll < shape;
    let d;
    if (follow) {
      // Trace the original: its position mapped into the window (range magnifies the shape),
      // wiggled a step for new notes, then held to the original's direction sign for sign.
      const t = origSpan ? (degs[i] - origLo) / origSpan : 0.5;
      d = Math.round(lo + t * (hi - lo)) + (magRoll < 0.4 ? 0 : magRoll < 0.7 ? 1 : -1);
      const sign = i === 0 ? null : Math.sign(degs[i] - degs[i - 1]);
      if (sign === 0) d = prev;
      else if (sign > 0 && d <= prev) d = prev + 1;
      else if (sign < 0 && d >= prev) d = prev - 1;
      d = clampDeg(d);
    } else {
      const up = dirRoll < (prev < center ? 0.65 : prev > center ? 0.35 : 0.5) ? 1 : -1;
      const mag = magRoll < 0.15 ? 0 : magRoll < 0.65 ? 1
        : magRoll < 0.9 ? Math.round(2 * stretch) : Math.round((3 + Math.floor(magRoll2 * 2)) * stretch);
      d = clampDeg(prev + up * mag);
      const barPos = ((pos % grid) + grid) % grid;
      if (beat && Math.abs(barPos / beat - Math.round(barPos / beat)) < 0.02) {
        d = snapTriad(d, Math.sign(up * mag) || -1);
      }
    }
    let guard = 0;
    while (atOnset.has(d) && guard++ < 12) d += 1;
    atOnset.add(d);
    prev = d;
    result[idx] = { ...nt, midi: clampMidi(degreeToMidi(d, scale)) };
  });
  return result;
}
