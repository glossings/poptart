// Extracting a groove from what somebody played - the numbers half of it (see groove.mjs for the
// format, and the engine side for where the onsets come from).
//
// The input is a list of hits: where each one landed, in CYCLES from the start of the loop (a cycle
// is a bar here, as everywhere in poptart), and how hard it was hit (0..1, the hardest hit in the
// file being 1). Hits found in a file come as positions along the file instead, which is a different
// unit and converted once, out loud, by grooveHitsInCycles. What comes back is a groove table:
// per slot of a grid, how far off the grid that slot's hits actually were, and how loud they were
// against the others. That is all a groove IS - the difference between what the grid says and what
// a player did - so extraction is a measurement, not an interpretation, and every decision it has
// to make is named here rather than buried in a detector.
//
// Nothing in this file reads audio. It takes the hits an onset detector found and is therefore
// testable by writing the hits down by hand, which is also how a feel can be extracted from
// anything that produces onsets - a MIDI file, a recorded take, a tapped-in rhythm.

const SLOT_EPS = 1e-9;

/** How far off its slot a hit can sit and still be counted as that slot's: half a slot, no more. */
const MAX_DEVIATION = 0.5;

/**
 * A groove table measured off `hits` - `[{ at, strength }]`, `at` in cycles from the loop's start.
 *
 * `grid` is how many slots the bar is divided into, which is the resolution the feel is read at: a
 * 16-slot grid over a break says what each sixteenth does. Hits past the first bar fold onto it - a
 * groove describes one bar (see groove.mjs) - so two bars of the same feel are two readings of each
 * slot rather than a longer table.
 *
 * Returns `{ steps, time, vel, slots }` - a table parseGroove would have produced, plus `slots`:
 * per slot, how many hits it was measured from, 0 where the loop never hit it. That is what the
 * editor needs to show a draft honestly, since a slot nothing landed on is not a slot that was
 * played dead on the grid - it is a slot nobody can speak for.
 */
export function extractGroove(hits, { grid = 16, minStrength = 0, velDeadzone = 0.05 } = {}) {
  const steps = Math.max(1, Math.round(Number(grid) || 16));
  const offsets = Array.from({ length: steps }, () => []);
  const levels = Array.from({ length: steps }, () => []);

  for (const hit of hits ?? []) {
    // Negative is allowed: a hit can sit just before the downbeat it was aiming at (see
    // grooveHitsFromFile), and that is a feel, not a hit outside the loop.
    const at = Number(hit?.at ?? hit);
    if (!Number.isFinite(at)) continue;
    const strength = Number(hit?.strength ?? 1);
    if (Number.isFinite(strength) && strength < minStrength) continue;
    // Where in ONE bar this hit falls, and which slot of that bar it belongs to. The nearest slot
    // rather than the one it is inside: a hit played early sits at the END of the previous slot and
    // belongs to the slot it was aiming at, which is the whole point of measuring a feel.
    const exact = inOneBar(at) * steps;
    const slot = Math.round(exact) % steps;
    const deviation = exact - Math.round(exact); // in slots, within +/-0.5 by construction
    offsets[slot].push(deviation);
    if (Number.isFinite(strength)) levels[slot].push(Math.max(0, strength));
  }

  // The mean of what landed on a slot, not the first or the last of them: a player's feel is where
  // they tend to put a note, and a two-bar break gives two votes per slot.
  const time = offsets.map((list) => (list.length ? clampDeviation(mean(list)) : 0));
  const played = levels.filter((list) => list.length);
  const loudest = played.length ? Math.max(...played.map((list) => Math.max(...list))) : 0;
  // Velocity is a MULTIPLIER on what the pattern already says (see groove.mjs), so the loudest hit
  // in the loop is 1 and everything else is quieter in proportion. A slot nothing landed on says
  // nothing: 1, rather than silence, which is what "this groove has no opinion here" means.
  // ...and a slot within `velDeadzone` of the loudest is not an accent, it is a hand: real playing
  // never repeats a level exactly, and without a dead zone every extracted groove arrives carrying
  // a velocity row of noise that has to be flattened by hand before it is usable.
  const vel = levels.map((list) => {
    if (!list.length || loudest <= 0) return 1;
    const ratio = Math.max(...list) / loudest;
    return 1 - ratio <= velDeadzone ? 1 : round(ratio);
  });

  return {
    steps,
    time: time.map(round),
    vel: vel.some((v) => Math.abs(v - 1) > 1e-6) ? vel : null,
    slots: offsets.map((list) => list.length),
  };
}

/**
 * The grid a set of hits was most likely played on, out of `candidates` - the one whose slots the
 * hits sit closest to. What makes "extract a groove" a single gesture instead of a guessing game
 * about the subdivision.
 *
 * Judged by mean absolute deviation in SLOTS rather than in time, so a finer grid is not rewarded
 * for the fact that its slots are closer together; a grid is only preferred when it explains the
 * hits better than the coarser ones, by `margin` (a fifth of a slot by default), which is what
 * keeps a straight sixteenth loop from reading as a 32-slot grid with everything dead on.
 */
export function fitGrooveGrid(hits, { candidates = [4, 8, 12, 16, 24, 32], margin = 0.2 } = {}) {
  const positions = (hits ?? [])
    .map((h) => Number(h?.at ?? h))
    .filter((at) => Number.isFinite(at))
    .map(inOneBar);
  if (!positions.length) return null;
  const sorted = [...candidates].map((n) => Math.max(1, Math.round(n))).sort((a, b) => a - b);
  let best = null;
  for (const steps of sorted) {
    const errs = positions.map((p) => Math.abs(p * steps - Math.round(p * steps)));
    const err = mean(errs);
    // The coarsest grid that fits wins ties and near-ties: a feel described by fewer slots is the
    // same feel, said in the terms the player was more likely counting in.
    if (!best || err < best.err - margin / steps) best = { steps, err };
  }
  return best ? best.steps : null;
}

/** Hits that land within `window` slots of their slot, which is what "played to this grid" means. */
export function grooveHitsOnGrid(hits, { grid = 16, window = 0.5 } = {}) {
  const steps = Math.max(1, Math.round(Number(grid) || 16));
  return (hits ?? []).filter((h) => {
    const at = Number(h?.at ?? h);
    if (!Number.isFinite(at)) return false;
    const exact = inOneBar(at) * steps;
    return Math.abs(exact - Math.round(exact)) <= window + SLOT_EPS;
  });
}

/**
 * Hits found in a FILE - positions along it, 0..1 - as hits in cycles, given how many bars the file
 * spans. The one place the two units meet: a detector knows where in a file a hit is and nothing
 * about bars, and a groove is about bars and knows nothing about files.
 */
export function grooveHitsInCycles(hits, cycles = 1) {
  const bars = Math.max(1e-6, Number(cycles) || 1);
  return (hits ?? []).map((h) => {
    const at = Number(h?.at ?? h) * bars;
    return typeof h === 'object' && h ? { ...h, at } : { at, strength: 1 };
  });
}

/**
 * The same conversion when the file's TEMPO is what is known rather than its length in bars: hits
 * at `at` along a file of `seconds`, read against `bpm` from the downbeat at `anchorSec`.
 *
 * Preferred over grooveHitsInCycles wherever a tempo was fitted, because it does not assume the
 * file is a whole number of bars or that it starts on one - a break lifted out of a track rarely
 * does either. A hit before the anchor belongs to the bar before it, which folding takes care of.
 */
export function grooveHitsFromFile(hits, { seconds, bpm, anchorSec = 0 } = {}) {
  const dur = Number(seconds);
  const tempo = Number(bpm);
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(tempo) || tempo <= 0) return [];
  const barSec = 240 / tempo; // a cycle is a bar of four beats (bpm is cps * 240)
  const anchor = Number(anchorSec) || 0;
  return (hits ?? []).map((h) => {
    const at = (Number(h?.at ?? h) * dur - anchor) / barSec;
    return typeof h === 'object' && h ? { ...h, at } : { at, strength: 1 };
  });
}

/** Where in one bar a position in cycles falls, with whole bars folded away. */
const inOneBar = (at) => ((at % 1) + 1) % 1;

const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
const round = (v) => Math.round(v * 1000) / 1000;
const clampDeviation = (v) => Math.max(-MAX_DEVIATION, Math.min(MAX_DEVIATION, v));
