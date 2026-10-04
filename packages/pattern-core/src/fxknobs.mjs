// The DJ FX unit's knobs - a small bank of host-fed 0..1 values, read by fxknob() signals (see
// signal.mjs) and bound into an FX chain's code as `fx1`. The macro-knob store's sibling
// (macros.mjs), kept apart from signal.mjs for the same reason: both stay dependency-free, and
// the browser imports the same signal code against an untouched store.
//
// The desk is the write side: the FX unit's knob POSTs /api/mix/fx, the server calls setFxKnob,
// and every fx1 in the loaded chain picks the value up on its next scheduler poll.
//
// ONE knob today. The bank exists so a second is a number change here rather than a new
// mechanism: the names follow the index (`fx1`, `fx2`, ...), as the macros' do.

export const FX_KNOB_COUNT = 1;

const values = new Array(FX_KNOB_COUNT).fill(0);

export function assertFxKnobIndex(index) {
  if (!Number.isInteger(index) || index < 1 || index > FX_KNOB_COUNT) {
    throw new Error(`[fx] knob index must be 1..${FX_KNOB_COUNT}, got ${index}`);
  }
}

/** Host-side feed: one knob move. Clamped to 0..1. */
export function setFxKnob(index, value01) {
  assertFxKnobIndex(index);
  const v = Number(value01);
  values[index - 1] = Math.min(1, Math.max(0, Number.isNaN(v) ? 0 : v));
}

/** Current 0..1 value of a knob. Knobs always have a position, so this never rests. */
export function fxKnobValue(index) {
  assertFxKnobIndex(index);
  return values[index - 1];
}
