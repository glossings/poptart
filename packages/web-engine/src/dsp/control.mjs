// Reading a control inside a block.
//
// An AudioWorklet hands a parameter over as a Float32Array that is ONE sample long when nothing
// is moving it and a whole block long when something is; a unit test hands over a plain number.
// `at()` reads any of those at a sample index, so a device's loop is written once for all three,
// and `isMoving()` is how a device decides whether a per-sample read is buying anything this
// block. `dbToGain` is the one conversion every device with a level in decibels needs.

/** The value of a control at sample `i`: from a number, a one-sample array, or a whole block. */
export function at(value, i) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return value.length === 1 ? value[0] : value[i];
}

/** Whether a control has a value per sample this block, rather than one for the whole of it. */
export function isMoving(value) {
  return value != null && typeof value !== 'number' && value.length > 1;
}

export const dbToGain = (db) => Math.pow(10, db / 20);
