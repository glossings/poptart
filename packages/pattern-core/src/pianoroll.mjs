// Drawn note grids for pianoroll() - the textual format, its parser/serializer, the mini-notation
// converter, and the small helpers the editor and the builder share. Like shape.mjs (the lfo()
// shapes) this is served verbatim to the browser - so the interactive editor draws exactly the
// notes the scheduler plays - and depends on nothing outside this package (notes.mjs, its one
// import, is served the same way and is itself dependency-free).
//
// Format: space-separated note events `[!]midi,start,len[,vel[,prob]]`, e.g. "60,0,4 64,0,4,0.7 67,8,8".
//   !     - optional MUTE marker: the note is deactivated (Live's `0` key). It stays in the roll -
//           drawn greyed out, still movable, still holding its lane against the overlap rule - but
//           it never sounds and it isn't converted to mini-notation. Unmuting it is one keypress,
//           which is the point of keeping it in the string rather than deleting it.
//   midi  - MIDI note number, 0..127 (this package's c5 = 60 convention)
//   start - onset cell, integer 0..steps-1 (a cell is one column of the grid)
//   len   - length in cells, integer >= 1 (may run past the last cell: the note rings on, like a
//           mini-notation tie)
//   vel   - optional velocity, 0..1 (omitted when 1, the default)
//   prob  - optional probability the note plays, 0..1 (omitted when 1). Drives a per-cycle random
//           gate in the builder, and becomes a `?` degrade when converted to mini-notation. When
//           present, vel is written too (it holds the field's place), even if it is the default.
// The grid width (`grid`, how many cells span one cycle) lives in the pianoroll() call's options,
// not the string - the same split shape.mjs uses for lfo()'s rate/mode - and so does the loop
// window it plays: `len` cells starting at cell `start`. Notes are written at their drawn cell
// either way, so sliding the window over them never rewrites a single note.

import { DEFAULT_SCALE_OCTAVE, midiToDegree, noteToMidi, scaleAtOctave, scaleParts } from './notes.mjs';

export const PIANOROLL_DEFAULT_STEPS = 16;
export const PIANOROLL_MAX_GRID = 512; // finest grid the retime buttons will push a roll to

/** Clamp/validate a grid width into a positive integer number of cells per cycle. */
export function normalizePianoRollSteps(steps) {
  const n = Math.round(Number(steps ?? PIANOROLL_DEFAULT_STEPS));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`[pianoroll] steps must be a positive integer number of cells (got ${JSON.stringify(steps)})`);
  }
  return n;
}

/**
 * Does this string hold DRAWN NOTES rather than a pattern of roll ids? A note token always reads
 * "midi,start,len[,vel[,prob]]" behind an optional mute `!`, so it begins with a number and
 * carries a comma - which nothing naming a roll can look like (`0`, `chorus`, `<0 1>`, and even a
 * `[0,chorus]` stack each fail one half of the test or the other). An empty string is neither.
 *
 * This is the one place the two forms of pianoroll(...) are told apart: the builder routes on it,
 * the location transpile decides whether to tag the literal for highlighting by it, and the editor
 * uses it to know whether a call's argument is data it may write notes back into.
 */
export function looksLikeNoteString(str) {
  const first = String(str).trim().split(/\s+/)[0] ?? '';
  return /^!?-?\d/.test(first) && first.includes(',');
}

export function parsePianoRoll(str) {
  const trimmed = String(str).trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).map((tok) => {
    const mute = tok.startsWith('!');
    const parts = (mute ? tok.slice(1) : tok).split(',');
    if (parts.length < 3 || parts.length > 5) {
      throw new Error(`[pianoroll] bad note "${tok}" (want "midi,start,len" .. "midi,start,len,vel,prob")`);
    }
    const [midi, start, len, vel = 1, prob = 1] = parts.map(Number);
    if (![midi, start, len, vel, prob].every(Number.isFinite)) {
      throw new Error(`[pianoroll] non-numeric field in note "${tok}"`);
    }
    return {
      midi: clampInt(midi, 0, 127),
      start: Math.max(0, Math.round(start)),
      len: Math.max(1, Math.round(len)),
      vel: clamp01(vel),
      prob: clamp01(prob),
      mute,
    };
  });
}

export function serializePianoRoll(notes) {
  return [...notes]
    // Left-to-right, low-to-high: stable output so re-serializing an unchanged roll is a no-op.
    .sort((a, b) => a.start - b.start || a.midi - b.midi)
    .map((nt) => {
      let s = `${nt.mute ? '!' : ''}${Math.round(nt.midi)},${Math.round(nt.start)},${Math.round(nt.len)}`;
      // vel holds prob's field slot, so a sub-unity prob forces vel to be written even when it's 1.
      if (nt.prob < 1) s += `,${fmt(nt.vel)},${fmt(nt.prob)}`;
      else if (nt.vel < 1) s += `,${fmt(nt.vel)}`;
      return s;
    })
    .join(' ');
}

/**
 * Ableton-style overlap resolution, one pitch lane at a time: two notes at the same pitch are
 * never left ringing together, so a long note with a short one dropped into its middle stops where
 * the short one starts instead of carrying on invisibly behind it.
 *
 * Priority is ARRAY ORDER - later notes win, which is also the order they are drawn in and the
 * order hit-testing scans, so "the note on top" means one thing everywhere. The winner keeps the
 * length it was drawn with, in full; the notes under it give way:
 *
 *   - a note whose own onset falls inside a winner's span is HIDDEN (`hidden: true`) - there is no
 *     room left to sound it, so it drops out of the roll and out of the code
 *   - a note that merely runs into a winner is clipped, ending exactly at the winner's onset
 *
 * Nothing is destroyed either way. The length the note was DRAWN with is kept on `full` and `len`
 * is only ever the clipped, playable length, so moving the note on top out of the way lets the one
 * underneath spring straight back - clipped notes to their old length, hidden notes back into
 * existence. (A note without `full` - one just parsed out of the string, which already holds
 * clipped lengths - adopts its current `len` as its authored length.)
 *
 * Notes are updated IN PLACE and the same array comes back, hidden ones included: a caller keeps
 * them so they can return, and filters `hidden` out when it draws, hit-tests or serializes.
 *
 * A MUTED note takes part exactly like any other: it is still drawn, so it still owns its cells and
 * still clips what runs into it. Muting is a switch on one note, not an edit to the notes around it
 * - unmuting has to put the roll back the way it was, and it can't do that if the lane rearranged
 * itself underneath while the note was off.
 */
export function clipOverlaps(notes) {
  for (const nt of notes) if (!Number.isFinite(nt.full)) nt.full = nt.len;

  const lanes = new Map();
  notes.forEach((nt, i) => {
    if (!lanes.has(nt.midi)) lanes.set(nt.midi, []);
    lanes.get(nt.midi).push({ nt, i });
  });

  for (const lane of lanes.values()) {
    lane.sort((a, b) => b.i - a.i); // highest priority (last in the array) resolves first
    const claimed = []; // [start, end) of every note already given its room in this lane
    for (const { nt } of lane) {
      nt.hidden = claimed.some(([s, e]) => nt.start >= s && nt.start < e);
      if (nt.hidden) continue; // buried - claims nothing, so it can't clip anyone either
      let end = nt.start + nt.full;
      for (const [s] of claimed) if (s > nt.start && s < end) end = s;
      nt.len = Math.max(1, end - nt.start);
      claimed.push([nt.start, nt.start + nt.len]);
    }
  }
  return notes;
}

/**
 * Convert a drawn roll to the equivalent mini-notation, in the same multi-line `<…>*grid` form the
 * MIDI recorder writes: `len` cells (one per grid column) between `<` and `>`, multiplied by `grid`,
 * so the whole thing loops every `len` grid-th notes. The cells are the loop WINDOW - `len` of them
 * from cell `start` - so a window that begins half way through the first bar writes the note it
 * begins on as the first cell, exactly as playback sounds it. Each cell is a rest `~`, a note, or a chord
 * `[a,b]`. Note length is carried by the `clip` field (a `_` tie misbehaves inside `<…>`), velocity
 * by the `vel` field, and probability by a `?amount` degrade (amount = 1 - prob).
 *
 * With only bare notes it emits `note(\`<…>*grid\`)` (which reads each atom as a MIDI note). As soon
 * as any velocity or multi-cell length appears it switches to the bare-string `.as("note[:vel][:clip]")`
 * form - because note() would eagerly parse a `60:0.5:2` token as a pitch and choke; .as() is what
 * splits the fields apart. A template literal keeps it readable across lines.
 *
 * Given a `scale` (a name like "F minor" - the roll passes the buffer's key when it's folded to
 * it), the pitches come out as SCALE DEGREES instead: the `n` field, with a `.sc(octave)` tacked on
 * the end. Same notes, but re-keying the patch by editing its `setscale(...)` line moves them,
 * where written-out MIDI numbers would sit where they were drawn. The octave is chosen to put the
 * scale's root at or below the lowest note drawn, so no degree comes out negative. Degrees can only
 * name notes in the key, so an out-of-key one is written as its nearest degree (see midiToDegree) -
 * the one lossy part of this conversion.
 *
 * Muted notes are left out entirely: this writes down what the roll PLAYS, and mini-notation has no
 * spelling for a note that's there but switched off.
 */
export function pianoRollToMini(allNotes, { grid, len, start = 0, indent = '', scale = null } = {}) {
  const g = normalizePianoRollSteps(grid);
  const total = Math.max(1, Math.round(len ?? g));
  const from = Math.max(0, Math.round(start));
  // Only what the window plays is written down - and at its offset within the window, so cell
  // `from` is the pattern's first beat.
  const notes = allNotes.filter((nt) => !nt.mute && nt.start >= from && nt.start < from + total);
  const onsets = Array.from({ length: total }, () => []);
  for (const nt of notes) onsets[nt.start - from].push(nt);
  const anyVel = notes.some((nt) => nt.vel < 1);
  const anyClip = notes.some((nt) => nt.len > 1);
  const octave = scale ? rollOctave(notes, scale) : null;
  // Degrees are read against the scale AS .sc(octave) will build it, so the two agree exactly.
  const keyed = scale ? scaleAtOctave(scale, octave) : null;
  const pitchField = scale ? 'n' : 'note';
  const fields = [pitchField, ...(anyVel ? ['vel'] : []), ...(anyClip ? ['clip'] : [])];

  const pitchStr = (nt) => String(keyed ? midiToDegree(nt.midi, keyed) : Math.round(nt.midi));
  const fieldStr = (nt, f) => (f === pitchField ? pitchStr(nt) : f === 'vel' ? fmt(nt.vel) : String(Math.round(nt.len)));
  const isDefault = (nt, f) => (f === 'vel' && nt.vel === 1) || (f === 'clip' && nt.len === 1);
  const tok = (nt) => {
    const parts = fields.map((f) => fieldStr(nt, f));
    while (parts.length > 1 && isDefault(nt, fields[parts.length - 1])) parts.pop(); // trim trailing defaults
    let t = parts.join(':');
    if (nt.prob < 1) t += `?${fmt(1 - nt.prob)}`;
    return t;
  };

  const cells = [];
  for (let c = 0; c < total; c++) {
    const os = onsets[c];
    if (os.length === 0) cells.push('~');
    else if (os.length === 1) cells.push(tok(os[0]));
    else cells.push(`[${os.map(tok).join(',')}]`);
  }

  // one line per beat when the grid is big enough to divide evenly, so columns line up visually
  const perLine = g % 4 === 0 && g >= 8 ? g / 4 : g;
  const lines = [];
  for (let i = 0; i < total; i += perLine) lines.push(cells.slice(i, i + perLine).join(' '));
  const body = lines.map((l) => `${indent}  ${l}`).join('\n');
  const seq = `\`<\n${body}\n${indent}>*${g}\``;
  const tail = scale ? `.sc(${octave})` : '';
  return `${fields.length > 1 ? `${seq}.as("${fields.join(':')}")` : `${pitchField}(${seq})`}${tail}`;
}

/**
 * Rescale every note in place by `ratio` cells per cell, about `anchor` (the cell that stays put) -
 * the retiming behind a grid change (a 1/4-grid quarter note becomes four cells on a 1/16 grid),
 * behind the ×2/÷2 buttons when the grid itself can't carry the change, and behind ×2/÷2 applied to
 * a SELECTION, which stretches about its own first onset so the phrase grows to the right from
 * where it already starts. Both the drawn length (`full`) and the clipped one (`len`) move, so a
 * later clipOverlaps resolves the rescaled roll exactly as the drawn one resolved. Coarsening
 * rounds, and can round two notes onto one cell - which is a real collision the caller's
 * clipOverlaps then settles, not a bug in the arithmetic.
 */
export function rescalePianoRoll(notes, ratio, anchor = 0) {
  for (const nt of notes) {
    const full = Number.isFinite(nt.full) ? nt.full : nt.len;
    nt.start = Math.max(0, Math.round(anchor + (nt.start - anchor) * ratio));
    nt.full = Math.max(1, Math.round(full * ratio));
    nt.len = Math.max(1, Math.round(nt.len * ratio));
  }
  return notes;
}

/**
 * Change a roll's GRANULARITY while it keeps playing the same music: the cells get finer or
 * coarser and every note (and the loop window) is rescaled to span the same time as before. Notes
 * are mutated in place; the new `{ grid, len, start }` comes back.
 */
export function regridPianoRoll(roll, grid) {
  const next = normalizePianoRollSteps(grid);
  const cur = normalizePianoRollSteps(roll.grid);
  const ratio = next / cur;
  if (ratio !== 1) rescalePianoRoll(roll.notes ?? [], ratio);
  return {
    grid: next,
    len: Math.max(1, Math.round(Math.max(1, Math.round(roll.len ?? cur)) * ratio)),
    start: Math.max(0, Math.round(Math.max(0, Math.round(roll.start ?? 0)) * ratio)),
  };
}

/**
 * Stretch a WHOLE roll in TIME by `factor` (2 = it takes twice as long, 0.5 = half) - what the
 * ×2/÷2 buttons do when nothing is selected (with a selection they rescale just those notes, about
 * the first of them; see rescalePianoRoll).
 * The cheap direction is the grid: keeping the cells exactly where they are and making each one
 * twice as long (or half) retimes every note and the loop at once, losslessly, which is why `len`
 * comes out unchanged. Only when the grid can't take it - halving an odd one, or a grid already at
 * PIANOROLL_MAX_GRID - do the notes themselves move, which rounds. Returns the new
 * `{ grid, len, start }`; notes are mutated in place on that second path only.
 */
export function retimePianoRoll(roll, factor) {
  const grid = normalizePianoRollSteps(roll.grid);
  const len = Math.max(1, Math.round(roll.len ?? grid));
  const start = Math.max(0, Math.round(roll.start ?? 0));
  const scaled = grid / factor;
  if (Number.isInteger(scaled) && scaled >= 1 && scaled <= PIANOROLL_MAX_GRID) return { grid: scaled, len, start };
  rescalePianoRoll(roll.notes ?? [], factor);
  return { grid, len: Math.max(1, Math.round(len * factor)), start: Math.max(0, Math.round(start * factor)) };
}

/**
 * Repeat the loop window once more after itself: the window doubles in length and everything in it
 * is copied one window-length to the right, so a one-bar arpeggio becomes the same arpeggio over
 * two bars. Returns the copies to add (fresh objects - the caller pushes them last, so the overlap
 * rule resolves in their favour) and the new `len`.
 */
export function duplicatePianoRollLoop({ notes = [], len, start = 0 }) {
  const from = Math.max(0, Math.round(start));
  const span = Math.max(1, Math.round(len));
  const copies = notes
    .filter((nt) => nt.start >= from && nt.start < from + span)
    .map((nt) => ({ ...nt, start: nt.start + span }));
  return { copies, len: span * 2 };
}

/**
 * The octave to hand `.sc()`: the one that puts the scale's root at or just below the lowest note
 * in the roll, so every degree written out is >= 0 and the numbers read as "steps up from the
 * bottom of what I drew". An empty roll keeps the scale where it already is.
 */
function rollOctave(notes, scale) {
  const { root, octave } = scaleParts(scale);
  if (!notes.length) return octave ?? DEFAULT_SCALE_OCTAVE;
  const rootPc = ((noteToMidi(`${root}0`) ?? 0) % 12 + 12) % 12;
  const lowest = Math.min(...notes.map((nt) => Math.round(nt.midi)));
  return Math.floor((lowest - rootPc) / 12);
}

function fmt(v) {
  return String(Math.round(v * 1000) / 1000);
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
