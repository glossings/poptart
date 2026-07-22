// Macro knob state - a fixed bank of host-fed 0..1 values, read by macro() signals (see
// signal.mjs). Like the MIDI CC store (midi.mjs) this lives apart from signal.mjs so both
// stay dependency-free: the browser imports the same signal code against an untouched store
// (all zeros), which is fine, since the browser only ever samples signals for display math.
//
// The web app's Macros panel is the write side: each knob POSTs /api/macros/set, the server
// calls setMacro, and any macroN signal in evaluated code picks the value up on its next
// scheduler poll.

export const MACRO_COUNT = 8;

const values = new Array(MACRO_COUNT).fill(0);

export function assertMacroIndex(index) {
  if (!Number.isInteger(index) || index < 1 || index > MACRO_COUNT) {
    throw new Error(`[macros] macro index must be 1..${MACRO_COUNT}, got ${index}`);
  }
}

/** Host-side feed: one knob move. Clamped to 0..1. */
export function setMacro(index, value01) {
  assertMacroIndex(index);
  const v = Number(value01);
  values[index - 1] = Math.min(1, Math.max(0, Number.isNaN(v) ? 0 : v));
}

/** Current 0..1 value of a knob. Knobs always have a position, so this never rests. */
export function macroValue(index) {
  assertMacroIndex(index);
  return values[index - 1];
}
