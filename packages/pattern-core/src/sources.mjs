// Who is told when a live source is fed: a MIDI CC (midi.mjs), an OSC message (osc.mjs) or a
// macro knob (macros.mjs). Kept apart from all three so none of them has to know who listens -
// motion.mjs does, keeping each source's recent movement for the header's capture, and
// midi-learn.mjs, filling in a bare cc() from the next knob turned.

const hooks = [];

/** `fn(src)` on every feed: `{ kind: 'cc', device, channel, cc, value }`, `{ kind: 'osc', address, values }` or `{ kind: 'macro', index, value }`. */
export function onSourceFed(fn) {
  hooks.push(fn);
}

export function notifySourceFed(src) {
  for (const fn of hooks) fn(src);
}
