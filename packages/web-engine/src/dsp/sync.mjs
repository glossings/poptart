// Tempo sync, for every effect with a rate or a time.
//
// The options are one list so a delay, a tremolo-shaped ducker and a chorus all spell their
// divisions the same way, triplets and dotted lengths included. `free` means the device's own
// time or rate control is read; anything else is a length in beats, and the tempo the engine
// tells the device turns it into seconds.
//
// `free` is also the MODE SWITCH. A device with a rate knob and a sync switch showing at once
// leaves somebody turning whichever of the two is not being read, so the knob declares itself
// `active: { param: 'sync', is: 'free' }` and the panel draws one or the other, never both.
//
// A saved state holds an enum by its INDEX, so a division inserted where it belongs musically
// moves every one after it: each device that takes the list bumps its version, and its `migrate`
// reads an older state through syncFromVersion1 (the desktop does the same in native-devices.js).

/** The choices on a sync switch, in panel order. The index is what a descriptor's enum stores. */
export const SYNC_OPTIONS = Object.freeze([
  'free', '1/32', '1/32T', '1/32.', '1/16', '1/16T', '1/16.', '1/8', '1/8T', '1/8.', '1/4', '1/4T', '1/4.',
  '1/2', '1/2T', '1/2.', '1 bar', '2 bars', '4 bars',
]);

/** The length of each option in beats (quarter notes), or null for free. */
const BEATS = Object.freeze([
  null, 1 / 8, 1 / 12, 3 / 16, 1 / 4, 1 / 6, 3 / 8, 1 / 2, 1 / 3, 3 / 4, 1, 2 / 3, 1.5,
  2, 4 / 3, 3, 4, 8, 16,
]);

/** The length of a sync setting in beats, or null when it is free. */
export function syncBeats(syncIndex) {
  return BEATS[Math.round(syncIndex)] ?? null;
}

/** Whether a sync setting is `free`. */
export function isFree(syncIndex) {
  return BEATS[Math.round(syncIndex)] == null;
}

/** The seconds a sync setting lasts at a tempo, or `fallbackSec` when it is free. */
export function syncedSeconds(syncIndex, bpm, fallbackSec) {
  const beats = BEATS[Math.round(syncIndex)];
  if (beats == null) return fallbackSec;
  return (beats * 60) / Math.max(1, bpm);
}

/** The rate in Hz a sync setting cycles at, or `fallbackHz` when it is free. */
export function syncedHz(syncIndex, bpm, fallbackHz) {
  const beats = BEATS[Math.round(syncIndex)];
  if (beats == null) return fallbackHz;
  return Math.max(1, bpm) / (beats * 60);
}

/**
 * A sync index saved before 1/32T and 1/32. were added (device version 1), as it is now: free and
 * 1/32 stay, everything after them moves two along.
 */
export function syncFromVersion1(index) {
  const i = Math.round(Number(index));
  return Number.isFinite(i) && i >= 2 ? i + 2 : index;
}

/** A device's `migrate` for the sync-list controls `ids`, from version 1. */
export function migrateSyncLists(ids) {
  return (params, from) => {
    if (from < 2) for (const id of ids) if (params[id] != null) params[id] = syncFromVersion1(params[id]);
    return params;
  };
}
