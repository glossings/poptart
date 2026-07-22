// Turns a recorded live-MIDI performance (web-app's /api/midiRecord flow: sclang forwards
// routed midikeys() notes to Node, the server collects them between two cycle boundaries)
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
 * @returns {{ pattern: string, count: number }} - `pattern` is the multi-line `<...>*n` string,
 *   ready to wrap as a template literal with .as("note:vel:clip").
 */
export function recordingToMini(events, { cycles, grid = 16, startCycle = 0 }) {
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
