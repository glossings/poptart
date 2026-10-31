// Who is told when a live source is fed: a MIDI CC (midi.mjs), an OSC message (osc.mjs) or a
// macro knob (macros.mjs). Kept apart from all three so none of them has to know who listens -
// motion.mjs does, keeping each source's recent movement for the header's capture.

let hook = null;

/** `fn(src)` on every feed: `{ kind: 'cc', device, channel, cc, value }`, `{ kind: 'osc', address, values }` or `{ kind: 'macro', index, value }`. */
export function onSourceFed(fn) {
  hook = fn;
}

export function notifySourceFed(src) {
  if (hook) hook(src);
}
