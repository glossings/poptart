// Drawn note grids for pianoroll() - the textual format, its parser/serializer, the mini-notation
// converter, and the small helpers the editor and the builder share. Like shape.mjs (the lfo()
// shapes) this is served verbatim to the browser - so the interactive editor draws exactly the
// notes the scheduler plays - and depends on nothing outside this package (notes.mjs, its one
// import, is served the same way and is itself dependency-free).
//
// Format: space-separated note events `[!]midi[:index],start,len[,vel[,prob[,nudge]]]`, e.g.
// "60,0,4 64,0,4,0.7 67,8,8" or "24:0,0,1 24:3,4,1".
//   !     - optional MUTE marker: the note is deactivated (Live's `0` key). It stays in the roll -
//           drawn greyed out, still movable, still holding its lane against the overlap rule - but
//           it never sounds and it isn't converted to mini-notation. Unmuting it is one keypress,
//           which is the point of keeping it in the string rather than deleting it.
//   midi  - MIDI note number, 0..127 (this package's c3 = 60 convention)
//   index - optional sample index, >= 0 (omitted when 0, the default): which file of the pack this
//           event plays, the `i` channel. EVERY event has both a pitch and an index - they are two
//           channels of one event, not two kinds of event - and the roll's mode only says which of
//           them the editor is drawing on (see below).
//   start - onset cell, an integer (a cell is one column of the grid). Normally 0 or more; the
//           MIDI recorder writes what was played during the count-in at NEGATIVE cells, before the
//           roll's own time starts (see record.mjs) - drawn to the left of cell 0, never played, there
//           to be dragged into the loop if it turns out you want it
//   len   - length in cells, integer >= 1 (may run past the last cell: the note rings on, like a
//           mini-notation tie)
//   vel   - optional velocity, 0..1 (omitted when 1, the default)
//   prob  - optional probability the note plays, 0..1 (omitted when 1). Drives a per-cycle random
//           gate in the builder, and becomes a `?` degrade when converted to mini-notation. When
//           present, vel is written too (it holds the field's place), even if it is the default.
//   nudge - optional time offset, in CELLS (omitted when 0, the default): how far off its drawn
//           cell the note actually plays, -0.5..+0.5, positive late. Cells are the unit because
//           cells are what the roll is drawn on - a sixteenth pushed a tenth of a cell is a tenth
//           of a sixteenth late whatever length the note happens to have. The `nudge` CHANNEL the
//           scheduler reads is a fraction of the event's own width instead (see signal.mjs's
//           timeShift), so the two conversions - into the builder's steps and into mini-notation -
//           both divide by the note's length in cells. Like prob, it holds the fields before it
//           open: a nudge writes vel and prob too, default or not.
// The grid width (`grid`, how many cells span one cycle) lives in the pianoroll() call's options,
// not the string - the same split shape.mjs uses for lfo()'s rate/mode - and so does the loop
// window it plays: `len` cells starting at cell `start` (which may itself be negative: the window
// can be slid back over a recorded count-in). Notes are written at their drawn cell either way, so
// sliding the window over them never rewrites a single note.
//
// The options also carry the roll's MODE - which of the two channels the EDITOR draws on:
//   note   (the default) - the vertical axis is a piano keyboard and a drawn row is a pitch; the
//          index of a note drawn there is 0
//   index  - the vertical axis is a plain 0, 1, 2, … count and a drawn row is a sample index; the
//          pitch of a note drawn there is PIANOROLL_DEFAULT_NOTE, c2, where a sample plays as
//          recorded
// It is EDITOR METADATA and nothing else: playback reads both channels off every event whichever
// mode the roll is in, so switching modes moves not one note and changes not one sound. It is in
// the call so that reopening the panel puts you back on the axis you were drawing on.

import { DEFAULT_SCALE_OCTAVE, midiToDegree, noteToMidi, scaleAtOctave, scaleParts } from './notes.mjs';

export const PIANOROLL_DEFAULT_STEPS = 16;
export const PIANOROLL_MAX_GRID = 512; // finest grid the retime buttons will push a roll to
export const PIANOROLL_MODES = ['note', 'index'];
// What the channel a roll ISN'T being drawn on is worth. A note drawn on the index axis plays at
// MIDI 60 - the pitch a sample sounds at unrepitched, and what a note-less pattern fires anyway
// (DEFAULT_SYNTH_NOTE in signal.mjs) - and a note drawn on the piano keyboard plays the pack's
// first file. Both are the value that channel has when nobody has set it, so an event drawn on
// one axis is silent about the other rather than asserting anything.
export const PIANOROLL_DEFAULT_NOTE = 60;
export const PIANOROLL_DEFAULT_INDEX = 0;
// How far off its cell one note may be drawn, either way. Half a cell is where a nudge stops being
// a feel and starts being a different rhythm - past it the note has swapped places with the cell
// next door, and the honest edit is to move it. (The nudge CHANNEL clamps at half the event's own
// width for the same reason; on a one-cell note the two limits are the same number.)
export const PIANOROLL_MAX_NUDGE = 0.5;

// Slot boundaries land on fractions binary floating point can't hold exactly - the same nudge
// signal.mjs's timeShift takes, and for the same reason: floor(2/16 * 8) must be 1, not 0.
const SLOT_EPS = 1e-9;

/**
 * The swing offset one cell of a roll gets, in CELLS - the roll-shaped view of what timeShift
 * computes in cycles, and the number the editor draws and the commit button folds into a nudge.
 *
 * `cell` is the cell's position WITHIN THE CYCLE (0..grid-1), which is what the builder gives a step
 * as `start`, so the two agree by construction. Offbeats of the `swingGrid` division are delayed by
 * `amount` of one of its slots; everything else stays where it was drawn.
 */
export function pianoRollSwingCells(cell, { grid, swing = 0, swinggrid = null } = {}) {
  const g = normalizePianoRollSteps(grid);
  const amount = Math.min(0.5, Math.max(-0.5, Number(swing) || 0));
  if (!amount) return 0;
  // A roll knows exactly what it is written on, so its own grid is the division to swing unless the
  // roll says otherwise - the drum-machine reading of the word, where the knob acts on whatever
  // resolution the sequencer is set to.
  const n = Math.max(1, Math.round(Number(swinggrid) || g));
  const slot = Math.floor((cell / g) * n + SLOT_EPS);
  if (((slot % 2) + 2) % 2 !== 1) return 0;
  return (amount / n) * g; // cycles -> cells
}

/**
 * The finest division this roll's notes actually sit on, or null when there is nothing to tell it
 * from (an empty roll, or one whose every note is on the downbeat). This is NOT the roll's grid: the
 * grid is the resolution it is DRAWN on, and quarter notes drawn on a sixteenth grid are quarter
 * notes. Their spacing is what a swing has to act on to move anything, so it is what gets suggested
 * when the roll's swing turns out to have nothing to move.
 *
 * The onsets' spacing is their greatest common divisor in cells, and the division is how many of
 * those fit in a cycle: hits every 4 cells of a 16-grid are on the 4-per-cycle division.
 */
export function pianoRollNoteGrid(notes, grid) {
  const g = normalizePianoRollSteps(grid);
  let spacing = 0; // gcd so far; 0 is the identity, which is also "no onset seen off the downbeat"
  for (const nt of notes) {
    if (nt.mute) continue;
    const cell = ((Math.round(nt.start) % g) + g) % g;
    spacing = gcd(spacing, cell);
    if (spacing === 1) break; // as fine as it can get
  }
  const together = gcd(spacing, g);
  return together > 0 && together < g ? g / together : null;
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Fold a roll's swing into its notes, so they play where they already sounded and the swing can go
 * back to zero - Ableton's "commit groove", and the reason nudge is a per-note field at all.
 *
 * Each note takes the offset its cell was getting (pianoRollSwingCells) ON TOP of whatever nudge it
 * already carried, which is what makes committing a half-nudged roll leave the hand-made offsets
 * alone. Notes are mutated in place and handed back with a report of what couldn't be said exactly:
 *
 *   clamped - notes whose combined offset ran past half a cell, which is as far as a nudge reaches.
 *             Only possible when swinging a division COARSER than the roll's own grid, where one
 *             slot is several cells wide; the note is committed as far as it goes.
 *   uneven  - the roll's loop doesn't line up with the cycle (`len` is not the grid), so a note
 *             lands on a different beat each time round and has no ONE offset to be committed to.
 *             What is written is the offset of its first pass.
 */
export function commitPianoRollSwing(notes, { grid, len = null, swing = 0, swinggrid = null } = {}) {
  const g = normalizePianoRollSteps(grid);
  const window = Math.max(1, Math.round(len ?? g));
  let clamped = 0;
  for (const nt of notes) {
    const at = ((Math.round(nt.start) % g) + g) % g;
    const swung = pianoRollSwingCells(at, { grid: g, swing, swinggrid });
    if (!swung) continue;
    const wanted = noteNudge(nt) + swung;
    const got = clampNudge(wanted);
    if (Math.abs(wanted - got) > 1e-9) clamped++;
    nt.nudge = got;
  }
  return { notes, clamped, uneven: window !== g };
}

/** Clamp/validate a grid width into a positive integer number of cells per cycle. */
export function normalizePianoRollSteps(steps) {
  const n = Math.round(Number(steps ?? PIANOROLL_DEFAULT_STEPS));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`[pianoroll] steps must be a positive integer number of cells (got ${JSON.stringify(steps)})`);
  }
  return n;
}

/**
 * Which axis the editor draws this roll on: 'index' or 'note' (the default, and what every roll
 * written before index mode existed says). Anything unrecognised comes back as 'note' - the caller
 * warns about it, since a roll that opens on the keyboard is a better answer to a typo than one
 * that refuses to open at all.
 */
export function normalizePianoRollMode(mode) {
  return String(mode ?? 'note').trim().toLowerCase() === 'index' ? 'index' : 'note';
}

/** The channel `mode` draws on, and the one it leaves at its default. */
export const PIANOROLL_ROW_FIELD = { note: 'midi', index: 'index' };

/**
 * A fresh event drawn at row `row` on `mode`'s axis: the drawn channel takes the row, the other one
 * takes its resting value. This is the whole of what the two modes disagree about.
 */
export function pianoRollEventAt(row, mode) {
  const index = normalizePianoRollMode(mode) === 'index';
  return {
    midi: index ? PIANOROLL_DEFAULT_NOTE : clampInt(row, 0, 127),
    index: index ? Math.max(0, Math.round(row)) : PIANOROLL_DEFAULT_INDEX,
  };
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
    if (parts.length < 3 || parts.length > 6) {
      throw new Error(`[pianoroll] bad note "${tok}" (want "midi[:index],start,len" .. "midi[:index],start,len,vel,prob,nudge")`);
    }
    // The pitch field carries the sample index behind a ":" when it isn't the default - the same
    // "one token, several channels" spelling .as("note:vel") uses - so a roll that only ever plays
    // pitches reads exactly as it always did.
    const [midiStr, indexStr = PIANOROLL_DEFAULT_INDEX] = parts[0].split(':');
    const [midi, index, start, len, vel = 1, prob = 1, nudge = 0] = [midiStr, indexStr, ...parts.slice(1)].map(Number);
    if (![midi, index, start, len, vel, prob, nudge].every(Number.isFinite)) {
      throw new Error(`[pianoroll] non-numeric field in note "${tok}"`);
    }
    return {
      midi: clampInt(midi, 0, 127),
      index: Math.max(0, Math.round(index)),
      start: Math.round(start), // may be negative - count-in material sits before cell 0
      len: Math.max(1, Math.round(len)),
      vel: clamp01(vel),
      prob: clamp01(prob),
      nudge: clampNudge(nudge),
      mute,
    };
  });
}

export function serializePianoRoll(notes) {
  return [...notes]
    // Left-to-right, low-to-high: stable output so re-serializing an unchanged roll is a no-op.
    .sort((a, b) => a.start - b.start || a.midi - b.midi || noteIndex(a) - noteIndex(b))
    .map((nt) => {
      const index = noteIndex(nt);
      const pitch = index === PIANOROLL_DEFAULT_INDEX ? `${Math.round(nt.midi)}` : `${Math.round(nt.midi)}:${index}`;
      let s = `${nt.mute ? '!' : ''}${pitch},${Math.round(nt.start)},${Math.round(nt.len)}`;
      // Positional fields, so each one holds open the slots before it: a nudge writes vel and prob
      // whatever they are, and a sub-unity prob writes vel even when it's 1.
      const nudge = noteNudge(nt);
      if (nudge !== 0) s += `,${fmt(nt.vel)},${fmt(nt.prob)},${fmtNudge(nudge)}`;
      else if (nt.prob < 1) s += `,${fmt(nt.vel)},${fmt(nt.prob)}`;
      else if (nt.vel < 1) s += `,${fmt(nt.vel)}`;
      return s;
    })
    .join(' ');
}

/** A note's sample index, defaulted - notes built before the channel existed simply haven't got one. */
export const noteIndex = (nt) => (Number.isFinite(nt.index) ? Math.round(nt.index) : PIANOROLL_DEFAULT_INDEX);

/** A note's time offset in CELLS, defaulted and clamped - 0 for every note drawn before it existed. */
export const noteNudge = (nt) => (Number.isFinite(nt.nudge) ? clampNudge(nt.nudge) : 0);

/**
 * One note's offset as the BUILDER's steps need it: a fraction of the event's own width, where the
 * roll holds a fraction of a CELL (see the format notes above). The builder gives a `len`-cell note
 * a step `len` cells wide, so the same distance is that many times smaller a share of it - which is
 * what keeps two notes of different lengths, nudged the same on screen, sounding equally late.
 *
 * Only the builder divides. pianoRollToMini writes cells straight out, because the pattern it emits
 * puts one step in each cell and carries length as a clip instead (see fieldStr there).
 */
export const noteNudgeChannel = (nt) => noteNudge(nt) / Math.max(1, Math.round(nt.len));

/**
 * Ableton-style overlap resolution, one lane at a time: two notes in the same lane are
 * never left ringing together, so a long note with a short one dropped into its middle stops where
 * the short one starts instead of carrying on invisibly behind it.
 *
 * A LANE is a pitch and an index together, not either one alone. Both are drawn on the same rows -
 * whichever axis the roll is on, the other channel is invisible - so keying the lane on the visible
 * axis would make the rule DESTRUCTIVE across a mode switch: a two-file stack drawn on the index
 * axis (one pitch, two indices, one onset) would collapse to a single note the moment the keyboard
 * came back, and switching away and back would have quietly deleted half the roll. Keyed on the
 * pair, an overlap only ever resolves between events that really are the same event twice, which is
 * the same rule as before for any roll that uses only one of the two channels - the usual case.
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
    const key = `${Math.round(nt.midi)}:${noteIndex(nt)}`;
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push({ nt, i });
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
 * The divisions a roll drawn on `grid` can be quantized to, coarsest first: the grid's own
 * divisors, and nothing else. A note's onset is a whole cell (see the format above), so a division
 * the grid doesn't contain has no cells to land on - quantizing a 16-grid to eighth TRIPLETS would
 * ask for a note at cell 1.33, which the roll cannot write down. Changing the grid is what reaches
 * those (regridPianoRoll re-meshes without moving the music); this list is what quantize can offer
 * honestly. `grid` itself is always in it - snapping to the grid you are drawn on moves nothing,
 * but it still straightens the nudges and settles the overlaps, which is a thing to want.
 */
export function pianoRollQuantizeDivs(grid) {
  const g = normalizePianoRollSteps(grid);
  const divs = [];
  for (let d = 1; d <= g; d++) if (g % d === 0) divs.push(d);
  return divs;
}

/**
 * The division a quantize starts on: one step COARSER than the roll's own grid - the largest
 * divisor that still fits twice, so a 1/16 roll offers 1/8 and a 1/8T roll offers 1/4T. Quantizing
 * to the grid you drew on is the identity on the onsets, so the useful default is the next notch
 * up. (A grid of 1 has nowhere coarser to go and offers itself.)
 */
export function pianoRollDefaultQuantizeDiv(grid) {
  const g = normalizePianoRollSteps(grid);
  return pianoRollQuantizeDivs(g).filter((d) => d <= g / 2).pop() ?? g;
}

/**
 * Snap notes onto `div` (a division of the cycle, one of pianoRollQuantizeDivs) and settle the
 * overlap rule for good - the editor's ctrl+Q. Three things happen, and they belong together
 * because they are all "make the roll say plainly what it plays":
 *
 *   - every onset moves to the nearest cell of the division, and every NUDGE goes back to 0. A
 *     nudge is a deliberate offset from the grid, so a quantize that left it in place would snap
 *     the note and then push it straight back off again; quantizing is how you undo a groove you
 *     drew (or recorded), including one that was committed from the swing knob.
 *   - notes the overlap rule buries are DELETED. Everywhere else a hidden note is kept, because the
 *     note on top may move away and give it back (see clipOverlaps) - but two notes rounded onto
 *     one cell of one lane are not a stack waiting to be recovered, they are a duplicate, and
 *     leaving them in the string would keep re-hiding one of them on every later edit.
 *   - a note that was merely CLIPPED keeps its clipped length as its authored one (`full` = `len`),
 *     so the tail that used to hide behind the note in front of it is gone rather than waiting to
 *     spring back. After this, nothing in the roll is hidden and no part of any note is either.
 *
 * `only` (a Set/array of notes, or null for the whole roll) is what MOVES - the selection, when
 * there is one. The tidy-up is always the whole roll: whether a note is buried is a fact about its
 * lane, not about what happened to be selected.
 *
 * Notes are mutated in place; the SURVIVORS come back as a new array (the caller replaces its own,
 * since the deleted ones are gone for good), with a count of what was dropped and what was cut.
 */
export function quantizePianoRoll(notes, { grid, div, only = null } = {}) {
  const g = normalizePianoRollSteps(grid);
  const step = Math.max(1, Math.round(g / normalizePianoRollSteps(div ?? g)));
  const moving = only ? new Set(only) : null;
  for (const nt of notes) {
    if (moving && !moving.has(nt)) continue;
    nt.start = Math.round(nt.start / step) * step;
    nt.nudge = 0;
  }
  clipOverlaps(notes);
  let dropped = 0;
  let snipped = 0;
  const kept = [];
  for (const nt of notes) {
    if (nt.hidden) { dropped++; continue; }
    if (nt.len < nt.full) snipped++;
    nt.full = nt.len; // the clip IS the note now - there is no tail left behind the one in front
    kept.push(nt);
  }
  return { notes: kept, dropped, snipped };
}

/**
 * Convert a drawn roll to the equivalent mini-notation, in the same multi-line `<…>*grid` form the
 * MIDI recorder writes: `len` cells (one per grid column) between `<` and `>`, multiplied by `grid`,
 * so the whole thing loops every `len` grid-th notes. The cells are the loop WINDOW - `len` of them
 * from cell `start` - so a window that begins half way through the first bar writes the note it
 * begins on as the first cell, exactly as playback sounds it. Each cell is a rest `~`, a note, or a chord
 * `[a,b]`. Note length is carried by the `clip` field (a `_` tie misbehaves inside `<…>`), velocity
 * by the `vel` field, probability by a `?amount` degrade (amount = 1 - prob), and a note drawn off
 * its cell by the `nudge` field - converted out of the roll's cells into the share of the event's
 * own width the channel reads (see noteNudgeChannel), so the printed pattern plays where the roll
 * played. That is what makes a groove committed to the roll survive being turned into text.
 *
 * With only bare notes it emits `note(\`<…>*grid\`)` (which reads each atom as a MIDI note). As soon
 * as any velocity or multi-cell length appears it switches to the bare-string `.as("note[:vel][:clip]")`
 * form - because note() would eagerly parse a `60:0.5:2` token as a pitch and choke; .as() is what
 * splits the fields apart. A template literal keeps it readable across lines.
 *
 * A field every note in the window AGREES on is not written per cell: repeating `:0.5` down a
 * column says nothing, so a constant field is lifted out of the tokens onto its own control call -
 * `\`<…>\`.as("vel:clip").n(4)`, `note(\`<…>\`).vel(0.5)`. That is the same music either way (a
 * control is one key on the pattern's bundle, and vel/clip survive a later pitch call as note
 * channels), and it puts the number that never changes where it can be edited once. The pattern
 * always keeps at least one field, since the cells are what carry the RHYTHM: when every field is
 * constant the pitch stays in the tokens and the rest ride on calls.
 *
 * Given a `scale` (a name like "F minor" - the roll passes the buffer's key when it's folded to
 * it), the pitches come out as SCALE DEGREES instead: the `n` field, with a `.sc(octave)` tacked on
 * the end. Same notes, but re-keying the patch by editing its `setscale(...)` line moves them,
 * where written-out MIDI numbers would sit where they were drawn. The octave is chosen to put the
 * scale's root at or below the lowest note drawn, so no degree comes out negative. Degrees can only
 * name notes in the key, so an out-of-key one is written as its nearest degree (see midiToDegree) -
 * the one lossy part of this conversion.
 *
 * The `i` channel is written the same way, as its own field, whenever any event carries a sample
 * index - `i(\`<0 ~ 3>*8\`)` on its own, `\`<…>\`.as("note:i:vel")` alongside the others - so a roll
 * that sets both channels converts with both. A channel NO event sets is left out entirely: a roll
 * of plain pitches writes no `i`, and one drawn purely on the index axis (every pitch at c2, the
 * default) writes no `note`, exactly as `.as("vel")` leaves the pitch out today. If that empties
 * the field list - nothing about the roll differs from the defaults - the axis it was drawn on goes
 * back into the cells, since something has to carry the rhythm.
 *
 * `i` is the one field that never lifts out of the cells onto a control call the way a constant
 * pitch does: `.i()` only exists once there is a sampler, and the call this replaces comes before
 * the `.s()`. There is no scale form of it either - an index is not a pitch.
 *
 * Muted notes are left out entirely: this writes down what the roll PLAYS, and mini-notation has no
 * spelling for a note that's there but switched off.
 */
export function pianoRollToMini(allNotes, { grid, len, start = 0, indent = '', scale = null, mode = 'note' } = {}) {
  const g = normalizePianoRollSteps(grid);
  const total = Math.max(1, Math.round(len ?? g));
  const from = Math.round(start); // may be negative: the window can open before cell 0
  // Only what the window plays is written down - and at its offset within the window, so cell
  // `from` is the pattern's first beat.
  const notes = allNotes.filter((nt) => !nt.mute && nt.start >= from && nt.start < from + total);
  const onsets = Array.from({ length: total }, () => []);
  for (const nt of notes) onsets[nt.start - from].push(nt);
  const anyVel = notes.some((nt) => nt.vel < 1);
  const anyClip = notes.some((nt) => nt.len > 1);
  const anyNote = notes.some((nt) => Math.round(nt.midi) !== PIANOROLL_DEFAULT_NOTE);
  const anyIndex = notes.some((nt) => noteIndex(nt) !== PIANOROLL_DEFAULT_INDEX);
  const anyNudge = notes.some((nt) => noteNudge(nt) !== 0);
  const drawnIndex = normalizePianoRollMode(mode) === 'index';
  // Degrees are read against the scale AS .sc(octave) will build it, so the two agree exactly.
  // With no pitch to write (every event at the default note) there is no key to write it in either.
  const octave = scale && anyNote ? rollOctave(notes, scale) : null;
  const keyed = octave === null ? null : scaleAtOctave(scale, octave);
  const pitchField = keyed ? 'n' : 'note';
  const present = [
    ...(anyNote ? [pitchField] : []),
    ...(anyIndex ? ['i'] : []),
    ...(anyVel ? ['vel'] : []),
    ...(anyClip ? ['clip'] : []),
    // Last, because it is the field most often at its default - and the trailing ones are what a
    // token gets to leave off (see tok).
    ...(anyNudge ? ['nudge'] : []),
  ];

  const pitchStr = (nt) => String(keyed ? midiToDegree(nt.midi, keyed) : Math.round(nt.midi));
  const fieldStr = (nt, f) => {
    if (f === pitchField) return pitchStr(nt);
    if (f === 'i') return String(noteIndex(nt));
    if (f === 'vel') return fmt(nt.vel);
    // Written in CELLS, unconverted - unlike the builder's conversion (noteNudgeChannel), and for
    // the reason that conversion exists at all. `nudge` is a share of the step's own width, and the
    // step here is one cell: this writes `<…>*grid`, one column per cell, and carries a note's
    // LENGTH as a clip rather than as a wider step. So a cell and a step are the same thing on this
    // side, and the roll's cells go out as they are. (The builder makes a multi-cell note one wide
    // step instead, which is why it has to divide.)
    if (f === 'nudge') return fmtNudge(noteNudge(nt));
    return String(Math.round(nt.len));
  };
  // The fields that vary stay in the cells; the ones that don't are lifted onto control calls. An
  // empty roll agrees on nothing (there is nothing to agree), so it keeps writing its pitch field.
  const constant = (f) => notes.length > 0 && notes.every((nt) => fieldStr(nt, f) === fieldStr(notes[0], f));
  // ...except `i`, which has nowhere to be lifted TO: `.i(4)` needs a sampler, and this expression
  // is written in the pianoroll() call's place, before the `.s()` that makes one.
  let pulled = present.filter((f) => constant(f) && f !== 'i');
  let fields = present.filter((f) => !pulled.includes(f));
  // The cells are the rhythm, so something has to stay in them: with every field constant (or no
  // field differing from its default at all) the axis the roll was DRAWN on goes back into the
  // tokens - `note(\`<60 ~ 60>*4\`).vel(0.5)` - rather than the whole pattern collapsing to a bare
  // `<x ~ x>` with no field to read it as.
  if (!fields.length) {
    fields = [drawnIndex ? 'i' : pitchField];
    pulled = pulled.filter((f) => f !== fields[0]);
  }
  const isDefault = (nt, f) =>
    (f === 'vel' && nt.vel === 1) || (f === 'clip' && nt.len === 1) || (f === 'i' && noteIndex(nt) === PIANOROLL_DEFAULT_INDEX)
    || (f === 'nudge' && noteNudge(nt) === 0);
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
  // The lifted fields in the order they would have had in the token, then the key: `.n(4).sc(3)`.
  const tail = `${pulled.map((f) => `.${f}(${fieldStr(notes[0], f)})`).join('')}${keyed ? `.sc(${octave})` : ''}`;
  // note(`…`) only reads a column of bare pitches, and i(`…`) a column of bare indices - anything
  // else (several fields, or one field that is neither) needs .as() to say which is which.
  const head = fields.length === 1 && (fields[0] === pitchField || fields[0] === 'i')
    ? `${fields[0]}(${seq})`
    : `${seq}.as("${fields.join(':')}")`;
  return `${head}${tail}`;
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
    nt.start = Math.round(anchor + (nt.start - anchor) * ratio);
    nt.full = Math.max(1, Math.round(full * ratio));
    nt.len = Math.max(1, Math.round(nt.len * ratio));
    // A nudge is measured in cells, and the cells just changed size: a note at 4.1 cells belongs at
    // 4.1 * ratio, which is the new start plus the old offset scaled the same way. Coarsening can
    // push it past half a cell, where it is clamped - the note has been rounded onto a grid too
    // coarse to hold the feel it was drawn with, and half a cell is as much as one can say.
    if (noteNudge(nt) !== 0) nt.nudge = clampNudge(nt.nudge * ratio);
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
    start: Math.round(Math.round(roll.start ?? 0) * ratio),
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
  const start = Math.round(roll.start ?? 0);
  const scaled = grid / factor;
  if (Number.isInteger(scaled) && scaled >= 1 && scaled <= PIANOROLL_MAX_GRID) return { grid: scaled, len, start };
  rescalePianoRoll(roll.notes ?? [], factor);
  return { grid, len: Math.max(1, Math.round(len * factor)), start: Math.round(start * factor) };
}

/**
 * Repeat the loop window once more after itself: the window doubles in length and everything in it
 * is copied one window-length to the right, so a one-bar arpeggio becomes the same arpeggio over
 * two bars. Returns the copies to add (fresh objects - the caller pushes them last, so the overlap
 * rule resolves in their favour) and the new `len`.
 */
export function duplicatePianoRollLoop({ notes = [], len, start = 0 }) {
  const from = Math.round(start);
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
  // Octave NUMBERS are not raw MIDI octaves - where they start depends on the naming convention
  // (c3 = 60, so octave 0 begins at MIDI 24). Ask notes.mjs where c0 is rather than hard-coding
  // the offset, so this keeps agreeing with scaleAtOctave if that convention ever moves again.
  const c0 = noteToMidi('c0') ?? 0;
  return Math.floor((lowest - rootPc - c0) / 12);
}

function fmt(v) {
  return String(Math.round(v * 1000) / 1000);
}

// Nudge keeps more places than the 0..1 fields do. A third of a cell is the commonest offset there
// is - it is what committing a triplet swing writes - and at three decimals the roll would come
// back a hair straighter than it sounded. Five is past anything a clock can hear and still short.
function fmtNudge(v) {
  return String(Math.round(v * 100000) / 100000);
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function clampNudge(v) {
  return Math.min(PIANOROLL_MAX_NUDGE, Math.max(-PIANOROLL_MAX_NUDGE, v));
}
