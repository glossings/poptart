// Recording a live performance into a PIANO ROLL - recordingToRoll, captureWindow and
// recordStartCycle, what web-app's ● rec and the roll's capture button run on - and, before it, the
// older conversion into mini-notation (recordingToMini), which the MIDI-file importer still measures
// itself against.
//
// recordingToMini turns a recorded live-MIDI performance (web-app's /api/midiRecord flow: sclang
// forwards routed midikeys() notes to Node, the server collects them between two cycle boundaries)
// into mini-notation of the house style:
//
//   `<
//     36:1:4 ~ ~ ~ ~ ~ ~ ~
//     ~ 47:0.5:3 ~ ~ ~ ~ ~ ~
//   >*8`.as("note:vel:clip")
//
// One token per grid slot - a rest, a note:vel:clip combo (clip = duration in slots), or a
// stack [a:v:c,b:v:c] for simultaneous onsets - played back at `*grid`, so the whole
// alternation loops over exactly `cycles` cycles. vel/clip are omitted when they'd be 1.
// No `@` weight chains on purpose: the slot grid stays visible in the code.

import { parseMini } from './mini.mjs';
import { clipOverlaps, normalizePianoRollSteps, regridPianoRoll, PIANOROLL_DEFAULT_INDEX, PIANOROLL_MAX_GRID, PIANOROLL_MAX_NUDGE } from './pianoroll.mjs';

/** Slots per cycle used when recording with quantization off - fine enough to keep the feel. */
export const UNQUANTIZED_GRID = 96;

const TOKENS_PER_LINE = 8;

/**
 * @param {Array<{note: number, vel: number, start: number, end: number}>} events - start/end in
 *   cycles relative to the recording window's start (0..cycles).
 * @param {object} opts
 * @param {number} opts.cycles - length of the recording window, in cycles.
 * @param {number} [opts.grid] - slots per cycle to quantize to; 0/absent = unquantized.
 * @param {number} [opts.startCycle] - absolute cycle the window started on. `<...>*n` indexes by
 *   absolute cycle number, so the token list is rotated to replay on the same cycles it was
 *   recorded on (the window starts on a phrase boundary, which need not be a multiple of
 *   `cycles`).
 * @param {boolean} [opts.noteless] - drop pitch from every token (a note-less recording): each hit
 *   becomes `vel` or `vel:clip`, replayed with .as("vel:clip") on the default note. Simultaneous
 *   hits collapse to one (a fixed-pitch pad has no chords).
 * @returns {{ pattern: string, count: number }} - `pattern` is the multi-line `<...>*n` string,
 *   ready to wrap as a template literal with .as("note:vel:clip") (or .as("vel:clip") if noteless).
 */
export function recordingToMini(events, { cycles, grid = 16, startCycle = 0, noteless = false }) {
  const R = grid > 0 ? Math.round(grid) : UNQUANTIZED_GRID;
  const total = Math.round(cycles * R);
  const phaseSlots = ((Math.round(startCycle * R) % total) + total) % total;

  const slots = Array.from({ length: total }, () => []);
  for (const ev of events) {
    const s = Math.round(ev.start * R);
    if (s < 0 || s > total - 1) continue;
    const clip = Math.max(1, Math.round((ev.end - ev.start) * R));
    const cell = slots[(s + phaseSlots) % total];
    const existing = cell.find((x) => x.note === ev.note);
    if (existing) {
      // the same key retriggered fast enough to land in one slot - keep the stronger/longer hit
      existing.vel = Math.max(existing.vel, ev.vel);
      existing.clip = Math.max(existing.clip, clip);
    } else {
      cell.push({ note: Math.round(ev.note), vel: ev.vel, clip });
    }
  }

  const one = (x) => {
    const vel = Math.round(Math.min(1, Math.max(0.01, x.vel)) * 100) / 100;
    if (noteless) return x.clip === 1 ? String(vel) : `${vel}:${x.clip}`; // tap: vel[:clip], no pitch
    if (x.clip === 1) return vel === 1 ? String(x.note) : `${x.note}:${vel}`;
    return `${x.note}:${vel}:${x.clip}`;
  };
  let tokens = slots.map((cell) =>
    cell.length === 0 ? '~' : cell.length === 1 ? one(cell[0]) : `[${cell.map(one).join(',')}]`,
  );

  // Unquantized recordings are 96 slots/cycle - almost all rests. Collapse rest runs with
  // replicate (`~!12` = 12 rest slots) so the string stays readable; quantized grids keep one
  // token per slot, so the grid reads straight off the code.
  if (!(grid > 0)) {
    const out = [];
    for (let i = 0; i < tokens.length; ) {
      if (tokens[i] !== '~') {
        out.push(tokens[i++]);
        continue;
      }
      let k = i;
      while (k < tokens.length && tokens[k] === '~') k++;
      if (k - i >= 3) out.push(`~!${k - i}`);
      else for (let j = i; j < k; j++) out.push('~');
      i = k;
    }
    tokens = out;
  }

  const lines = [];
  for (let i = 0; i < tokens.length; i += TOKENS_PER_LINE) {
    lines.push('  ' + tokens.slice(i, i + TOKENS_PER_LINE).join(' '));
  }
  const pattern = `<\n${lines.join('\n')}\n>*${R}`;
  parseMini(pattern); // self-check: never hand the editor a string that won't parse
  return { pattern, count: events.length };
}

// ---------------------------------------------------------------------------------------------
// Recording into a piano roll.
//
// Events are { note, vel, start, end[, index] } with start/end in ABSOLUTE cycles - the transport's
// own count, the same number the roll's playhead sweeps by - so an event and the cell the roll was
// playing when it sounded are one subtraction apart. That is the whole idea: a roll plays cell
// `start + (m mod len)` at absolute cell m (see signal.mjs pianoroll()), so a note played while the
// roll was playing goes to the cell that was under the playhead, and a roll shorter than the
// recording takes the later passes on top of the earlier ones - an overdub, for free.
// ---------------------------------------------------------------------------------------------

/** Cycles per phrase - the count-in unit, and what a recording window is aligned to. */
export const PHRASE_CYCLES = 4;

/** Grid a NEW roll is drawn on when recording unquantized: fine enough to keep a hand-played
    sixteenth run on separate cells, with the nudge field carrying what's left. */
export const UNQUANTIZED_ROLL_GRID = 32;

/**
 * The cycle a recording of `cycles` cycles opens on, asked at cycle `now`: the next phrase boundary,
 * pushed on to the next multiple of `cycles` when that is a power of two up to 16 - so a fresh
 * 8-cycle roll recorded from cycle 8 (rather than 4) starts at its own cell 0, instead of coming
 * out rotated by half. Odd lengths (3, 5, 12 cycles…) would wait a phrase-multiple away that is no
 * use to anyone, so they take the next phrase and land where the clock says.
 */
export function recordStartCycle(now, cycles, phrase = PHRASE_CYCLES) {
  const n = Math.max(1, Math.round(cycles));
  const pow2 = (n & (n - 1)) === 0;
  const align = pow2 && n <= 16 ? Math.max(n, phrase) : phrase;
  return (Math.floor(now / align) + 1) * align;
}

/**
 * Which stretch of a performance a CAPTURE takes - the roll's capture button, pressed after the
 * fact: "that thing I just played, as if I'd had record on". `events` is everything logged for the
 * track, and the answer is a window { start, end } in absolute cycles (null when nothing was played).
 *
 * The trailing run is what's wanted: walking back from the last note, the run ends at the first
 * silence of `gap` cycles or more - a whole phrase by default, long enough that a sparse pad part
 * with a bar or two between chords still reads as one run. Then:
 *
 *   - for a roll that already loops (`loopCycles`, its len in cycles): the most recent full pass,
 *     ending at the first loop boundary at or after the last note's end. The notes land where they
 *     sounded against the roll, so this is "what I just played over it", one pass deep - earlier
 *     passes are left out rather than piled on top.
 *   - for an EMPTY roll (loopCycles null): the run's whole-cycle span, rounded up to a power of two
 *     and aligned to a multiple of itself - a three-bar phrase in bars 2-4 comes out as a four-bar
 *     loop with its first bar empty, which is where it was played. Past `maxCycles` the last aligned
 *     stretch is taken and what came before it dropped. `cycles` comes back alongside, for the roll's
 *     new len.
 *
 * Edge tolerance: a note let go a hair after the bar, or struck a hair before it, doesn't pull
 * another whole cycle into the window (CAPTURE_EDGE_TOL).
 */
export function captureWindow(events, { loopCycles = null, maxCycles = 16, gap = PHRASE_CYCLES } = {}) {
  const sorted = events
    .filter((ev) => Number.isFinite(ev.start) && Number.isFinite(ev.end))
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return null;
  // endBefore[i]: the latest end among the events before i - what the silence before i is measured from
  let i = sorted.length - 1;
  let endBefore = -Infinity;
  const ends = [];
  for (const ev of sorted) {
    ends.push(endBefore);
    endBefore = Math.max(endBefore, ev.end);
  }
  while (i > 0 && sorted[i].start - ends[i] < gap) i--;
  const run = sorted.slice(i);
  const first = run[0].start;
  const lastEnd = Math.max(...run.map((ev) => ev.end));
  if (loopCycles != null && loopCycles > 0) {
    const end = Math.ceil((lastEnd - CAPTURE_EDGE_TOL) / loopCycles) * loopCycles;
    return { start: end - loopCycles, end, cycles: loopCycles };
  }
  const from = Math.floor(first + CAPTURE_EDGE_TOL);
  const to = Math.max(from + 1, Math.ceil(lastEnd - CAPTURE_EDGE_TOL));
  let cycles = 1;
  while (cycles < to - from && cycles < maxCycles) cycles *= 2;
  let start = Math.floor(from / cycles) * cycles;
  while (start + cycles < to && cycles < maxCycles) {
    cycles *= 2;
    start = Math.floor(from / cycles) * cycles;
  }
  if (start + cycles < to) start = Math.floor((to - 1) / cycles) * cycles; // too long to hold: the last aligned stretch
  return { start, end: start + cycles, cycles };
}

const CAPTURE_EDGE_TOL = 1 / 32; // cycles

/**
 * Write recorded events INTO a roll. `roll` is { notes, grid, len, start } - the editor's own state,
 * or a fresh `{ notes: [], grid, len, start: 0 }` for a track that had no roll - and its notes array
 * is extended IN PLACE (the editor keeps its note objects, and the selection, across the write).
 * Returns { notes, grid, len, start, added, sources, regridded }: the roll's possibly-changed
 * options, the note objects this call added, and - in step with them - the events they came from.
 *
 *   window    - [startCycle, endCycle] of the recording proper. Events from `startCycle` on go where
 *               the roll was playing when they sounded - cell `start + (absoluteCell mod len)` - so
 *               a 4-cycle take into a 1-cycle roll lays each cycle over the last (an overdub), and a
 *               take into a fresh roll whose len is the window's length (recorded from an aligned
 *               start - see recordStartCycle) fills it from cell 0.
 *               Events BEFORE startCycle are the count-in: they go to negative offsets from the
 *               window's start cell, `start + (cell - startCell)`, i.e. before the loop and before 0
 *               in a fresh roll - drawn, never played, there to be pulled in if they were good.
 *   quantize  - slots per cycle to snap onsets to, 0 for none. Coarser than the roll's grid, onsets
 *               land on the matching cells; FINER, the roll is re-meshed to hold them (regridPianoRoll,
 *               lossless - the existing notes don't move), up to PIANOROLL_MAX_GRID. Unquantized,
 *               each note takes the nearest cell. EITHER WAY the note keeps what the snap took off
 *               it as its nudge - the distance from where it was played to the cell it sits on, as
 *               far as the half-cell a nudge can say - so a take is quantized on the GRID and plays
 *               with the feel it was played with; resetting the nudges (the lane's menu) is the hard
 *               quantize, one click later. Lengths are never quantized - Live's record quantization
 *               moves onsets and leaves durations alone.
 *
 * Velocity is kept as played; an event's `index` (a key struck on an index roll) goes to the note's
 * sample index. The new notes are pushed LAST, so the overlap rule (clipOverlaps) resolves in their
 * favour - the note you just played cuts the one it landed on, as it would have in Live.
 */
export function recordingToRoll(events, roll, { window, quantize = 0, countIn = true } = {}) {
  const [startCycle] = window;
  const g0 = normalizePianoRollSteps(roll.grid);
  const q = Math.max(0, Math.round(Number(quantize) || 0));
  // A finer quantize than the roll's grid needs cells the roll hasn't got: re-mesh it (keeping the
  // music where it is), to the common multiple so a triplet roll quantized to sixteenths still fits.
  let grid = g0;
  let len = Math.max(1, Math.round(roll.len ?? g0));
  let start = Math.round(roll.start ?? 0);
  let regridded = false;
  if (q > g0) {
    const want = lcm(g0, q);
    if (want <= PIANOROLL_MAX_GRID) {
      ({ grid, len, start } = regridPianoRoll({ notes: roll.notes, grid: g0, len, start }, want));
      regridded = true;
    }
  }
  const startCell = Math.round(startCycle * grid);
  const added = [];
  const sources = [];
  const sorted = [...events].sort((a, b) => a.start - b.start);
  for (const ev of sorted) {
    if (!Number.isFinite(ev.start) || !Number.isFinite(ev.end) || !Number.isFinite(ev.note)) continue;
    const onset = q > 0 ? Math.round(ev.start * q) / q : ev.start;
    const cell = Math.round(onset * grid);
    const nudge = Math.min(PIANOROLL_MAX_NUDGE, Math.max(-PIANOROLL_MAX_NUDGE, ev.start * grid - cell));
    const noteLen = Math.max(1, Math.round((ev.end - ev.start) * grid));
    const rel = cell - startCell;
    let drawn;
    if (rel < 0) {
      if (!countIn) continue;
      drawn = start + rel; // count-in: before the window, and before 0 in a fresh roll
    } else {
      drawn = start + (((cell % len) + len) % len); // where the roll was playing when it sounded
    }
    const nt = {
      midi: Math.min(127, Math.max(0, Math.round(ev.note))),
      index: Number.isFinite(ev.index) ? Math.max(0, Math.round(ev.index)) : PIANOROLL_DEFAULT_INDEX,
      start: drawn,
      len: noteLen,
      full: noteLen,
      vel: Math.min(1, Math.max(0.01, Math.round(ev.vel * 100) / 100)),
      prob: 1,
      nudge: Math.round(nudge * 100000) / 100000,
      mute: false,
    };
    roll.notes.push(nt);
    added.push(nt);
    sources.push(ev);
  }
  clipOverlaps(roll.notes);
  return { notes: roll.notes, grid, len, start, added, sources, regridded };
}

function lcm(a, b) {
  let x = a, y = b;
  while (y) [x, y] = [y, x % y];
  return (a / x) * b;
}
