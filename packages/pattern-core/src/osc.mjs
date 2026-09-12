// Live OSC input state, the OSC sibling of midi.mjs: fed by the host process (web-app receives
// /poptart/oscIn events from sclang and calls feedOsc) and read by osc() signals (see
// signal.mjs). Kept apart from signal.mjs so both stay dependency-free: the browser imports the
// same signal code and simply has an empty store here - osc signals sample as rests there, which
// is fine, since the browser only ever samples signals for display math, never for audio.
//
// Addresses are matched exactly (case-sensitive, leading slash implied): OSC has no device to
// name, so "/1/fader3" IS the control. A message's arguments are kept as a list, and an osc()
// signal reads one of them by index - a TouchOSC fader sends one float, an XY pad two.

// address -> latest argument list (numbers only; strings and blobs are dropped on the way in).
const latest = new Map();

// Addresses any osc() call has asked for this session. The host checks this after each eval to
// know whether to open the OSC input port engine-side at all (the engine boots with it closed -
// most sessions never touch OSC). Monotonic on purpose, like midi.mjs's device set.
const requestedAddresses = new Set();

/** "/1/fader3" as the store spells it - one leading slash, whatever the code wrote. */
export function normalizeOscAddress(address) {
  const s = String(address).trim();
  return s.startsWith('/') ? s : `/${s}`;
}

export function registerOscAddress(address) {
  requestedAddresses.add(normalizeOscAddress(address));
}

export function oscInUse() {
  return requestedAddresses.size > 0;
}

/** Host-side feed: one incoming message, its arguments as sent (non-numbers are ignored). */
export function feedOsc(address, args) {
  const values = (Array.isArray(args) ? args : [args]).map(Number).filter((v) => Number.isFinite(v));
  latest.set(normalizeOscAddress(address), values);
}

/**
 * Latest value of argument `index` at an address, or null if nothing has arrived yet (or the
 * last message was shorter than that) - an osc() signal rests until its control first moves,
 * so a parameter holds its current value instead of jumping to a guess.
 */
export function latestOsc(address, index = 0) {
  const values = latest.get(normalizeOscAddress(address));
  if (!values) return null;
  return values[index] ?? null;
}
