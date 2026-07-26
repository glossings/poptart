// Drawn note grids for pianoroll() - the textual format, its parser/serializer, the mini-notation
// converter, and the small helpers the editor and the builder share. Like shape.mjs (the lfo()
// shapes) this is dependency-free and served verbatim to the browser, so the interactive editor
// draws exactly the notes the scheduler plays.
//
// Format: space-separated note events `midi,start,len[,vel[,prob]]`, e.g. "60,0,4 64,0,4,0.7 67,8,8".
//   midi  - MIDI note number, 0..127 (this package's c5 = 60 convention)
//   start - onset cell, integer 0..steps-1 (a cell is one column of the grid)
//   len   - length in cells, integer >= 1 (may run past the last cell: the note rings on, like a
//           mini-notation tie)
//   vel   - optional velocity, 0..1 (omitted when 1, the default)
//   prob  - optional probability the note plays, 0..1 (omitted when 1). Drives a per-cycle random
//           gate in the builder, and becomes a `?` degrade when converted to mini-notation. When
//           present, vel is written too (it holds the field's place), even if it is the default.
// The grid width (`steps`, how many cells span one cycle) lives in the pianoroll() call's options,
// not the string - the same split shape.mjs uses for lfo()'s rate/mode.

export const PIANOROLL_DEFAULT_STEPS = 16;

/** Clamp/validate a grid width into a positive integer number of cells per cycle. */
export function normalizePianoRollSteps(steps) {
  const n = Math.round(Number(steps ?? PIANOROLL_DEFAULT_STEPS));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`[pianoroll] steps must be a positive integer number of cells (got ${JSON.stringify(steps)})`);
  }
  return n;
}

export function parsePianoRoll(str) {
  const trimmed = String(str).trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).map((tok) => {
    const parts = tok.split(',');
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
    };
  });
}

export function serializePianoRoll(notes) {
  return [...notes]
    // Left-to-right, low-to-high: stable output so re-serializing an unchanged roll is a no-op.
    .sort((a, b) => a.start - b.start || a.midi - b.midi)
    .map((nt) => {
      let s = `${Math.round(nt.midi)},${Math.round(nt.start)},${Math.round(nt.len)}`;
      // vel holds prob's field slot, so a sub-unity prob forces vel to be written even when it's 1.
      if (nt.prob < 1) s += `,${fmt(nt.vel)},${fmt(nt.prob)}`;
      else if (nt.vel < 1) s += `,${fmt(nt.vel)}`;
      return s;
    })
    .join(' ');
}

/**
 * Convert a drawn roll to the equivalent mini-notation, in the same multi-line `<…>*grid` form the
 * MIDI recorder writes: `len` cells (one per grid column) between `<` and `>`, multiplied by `grid`,
 * so the whole thing loops every `len` grid-th notes. Each cell is a rest `~`, a note, or a chord
 * `[a,b]`. Note length is carried by the `clip` field (a `_` tie misbehaves inside `<…>`), velocity
 * by the `vel` field, and probability by a `?amount` degrade (amount = 1 - prob).
 *
 * With only bare notes it emits `note(\`<…>*grid\`)` (which reads each atom as a MIDI note). As soon
 * as any velocity or multi-cell length appears it switches to the bare-string `.as("note[:vel][:clip]")`
 * form - because note() would eagerly parse a `60:0.5:2` token as a pitch and choke; .as() is what
 * splits the fields apart. A template literal keeps it readable across lines.
 */
export function pianoRollToMini(notes, { grid, len, indent = '' } = {}) {
  const g = normalizePianoRollSteps(grid);
  const total = Math.max(1, Math.round(len ?? g));
  const onsets = Array.from({ length: total }, () => []);
  for (const nt of notes) if (nt.start < total) onsets[nt.start].push(nt);
  const anyVel = notes.some((nt) => nt.vel < 1);
  const anyClip = notes.some((nt) => nt.len > 1);
  const fields = ['note', ...(anyVel ? ['vel'] : []), ...(anyClip ? ['clip'] : [])];

  const fieldStr = (nt, f) => (f === 'note' ? String(Math.round(nt.midi)) : f === 'vel' ? fmt(nt.vel) : String(Math.round(nt.len)));
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
  return fields.length > 1 ? `${seq}.as("${fields.join(':')}")` : `note(${seq})`;
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
