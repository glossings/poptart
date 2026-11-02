// Slice grids - `.slices(8)` and `.slices("1/4")` - laid over one file, shared by both builds.
//
// A grid is the one kind of slice set that can't be worked out where the pattern is: "a slice per
// quarter note" needs to know how many cycles THIS file lasts, and only the engine knows which file
// an event resolved to and how long it is. So the event carries the grid as it was asked for
// (`{ grid: { count: 8 } }` or `{ grid: { every: 0.25, label: '1/4' } }`, see pattern-core's
// slices.mjs sliceGridOf) and each engine lays it here, through the same functions, so the desktop
// (osc-engine's playSample) and the browser (web-engine's sample-plan.mjs) cut at the same places.
// The slice editor draws the same grid from this module too.
//
// The length a division is laid over is the FITTED one, computed by the very function both engines
// set the playback rate from (fittedLength) - so a grid and a speed can't disagree about how long a
// file is. A file with no fit has no musical length; it is laid over the length `.fit()` would give
// it (the power of two nearest its natural length), which is what lands a loop's slices on its own
// beats, and what keeps the chops where they are when a `.fit()` is added later. `assumed` says so.
//
// An ES module with no node or DOM in it: osc-engine require()s it, the browser imports it from
// /osc-engine/ (see web-app's server.js and build-web.mjs).

/**
 * How many cycles a file lasting `measures` cycles at its own speed is made to last by `fit`:
 * 'auto' is the power of two nearest its natural length, a number is that many cycles. Null for no
 * fit (or one that comes to nothing). The engines set the playback rate from this.
 */
export function fittedLength(fit, measures) {
  if (fit == null) return null;
  const target = fit === 'auto' ? 2 ** Math.round(Math.log2(measures)) : fit;
  return target > 0 ? target : null;
}

/** Is this per-event slice set a grid (rather than positions, or a map of them by file)? */
export function isSliceGrid(set) {
  const grid = set && typeof set === 'object' && !Array.isArray(set) ? set.grid : null;
  return !!grid && typeof grid === 'object' && !Array.isArray(grid) && (grid.count > 0 || grid.every > 0);
}

/**
 * Start positions for slices `every` cycles long over a file lasting `cycles` cycles: 0..1, the
 * last slice running to the end of the file. Counted up to wherever the end falls, less a
 * twentieth of a slice - so a loop a hair over one cycle still gets 4 quarter notes rather than a
 * click's worth of tail promoted to a fifth slice.
 */
export function divisionPositions(every, cycles) {
  if (!(every > 0) || !(cycles > 0)) return [0];
  const count = Math.max(1, Math.ceil(cycles / every - 0.05));
  const step = every / cycles;
  return Array.from({ length: count }, (_, k) => k * step);
}

/** Start positions for `count` equal slices of the file. */
export function evenPositions(count) {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n }, (_, k) => k / n);
}

/**
 * Where a grid cuts one file: `{ positions, cycles, assumed }`. `fit` is the fit in force for the
 * file - the chain's `.fit()`, else its slice set's - and `measures` its natural length in cycles.
 * `cycles` is the length a division was laid over (null for an even count, which needs none);
 * `assumed` is true where nothing gave a fit and the length was rounded as `.fit()` would.
 */
export function gridSlices(set, { fit = null, measures } = {}) {
  const grid = set.grid;
  if (grid.count > 0) return { positions: evenPositions(grid.count), cycles: null, assumed: false };
  // An audition carries the chain's fit on the grid itself (see Scheduler#sliceSetAt), since it
  // plays at the panel's rate and has no fit of its own on the event.
  const given = fittedLength(fit ?? grid.fit ?? null, measures);
  const cycles = given ?? fittedLength('auto', measures);
  return { positions: divisionPositions(grid.every, cycles), cycles, assumed: given == null };
}

/** The once-per-file console line for a division laid over a file with no fit. */
export function assumedFitNote(set, name, cycles) {
  const label = set.grid.label ?? `${set.grid.every}`;
  const n = Number(Number(cycles).toFixed(3));
  return `.slices("${label}"): ${name} has no fit, so its ${label}s are laid over ${n} cycle${n === 1 ? '' : 's'} - the length .fit() would give it`;
}
