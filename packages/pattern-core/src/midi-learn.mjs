// MIDI learn for code: `const cc = midicc("Knobs")`, then a bare `cc()` is filled in by the next
// knob turned on that device - the editor rewrites it to `cc(12, 1)` and evaluates.
//
// Each evaluation lists its bare calls in document order (widgets.mjs's learnCalls). A controller
// message from a device a waiting call names goes to the FIRST of them, so several are filled one
// at a time, top to bottom. Learning is explicit: a knob already bound to another cc() in the
// buffer still fills the waiting call, and nothing is taken from anyone - the message goes on to
// every binding it drives as before. A control the DJ desk owns never gets here (the hosts give
// the desk first refusal, and it keeps what it has learned), so a desk knob cannot be learned
// into code, nor a code knob into the desk while the desk is learning.
//
// The binding is the LAST control that moved once the hand has been still for the settle window -
// the desk learn's rule, so a modifier held on the way to the knob (a shift, a push) is passed
// over for the knob itself. And the fine half of a high-resolution pair (cc n + 32, sent just
// behind cc n) is never the control: it follows its coarse half on every move.

import { onSourceFed } from './sources.mjs';
import { midiDeviceMatches } from './midi.mjs';
import { learnCalls, learnFilled } from './widgets.mjs';

/** How long the hand has to be still before the last control it moved is learned (the desk's too). */
export const MIDI_LEARN_SETTLE_MS = 450;

// A fine half arrives this soon after its coarse half (the desk's window for the same pair).
const FINE_HALF_MS = 60;

const DECKS = ['a', 'b'];

let candidate = null; // { deck, at, device, channel, cc, timer } - the last control moved
const learned = []; // filled calls the editor has not written yet
const coarseSeen = new Map(); // "device|channel|cc" -> when cc (< 32) last arrived

/** The first waiting bare call a message from `device` fills, or null. */
function waitingFor(device) {
  for (const deck of DECKS) {
    const call = learnCalls(deck).find((l) => midiDeviceMatches(l.device, device));
    if (call) return { deck, at: call.at };
  }
  return null;
}

function fed(src) {
  if (src.kind !== 'cc') return;
  const now = Date.now();
  const key = (cc) => `${src.device}|${src.channel}|${cc}`;
  if (src.cc < 32) coarseSeen.set(key(src.cc), now);
  else if (src.cc < 64 && now - (coarseSeen.get(key(src.cc - 32)) ?? -Infinity) <= FINE_HALF_MS) return;
  const call = waitingFor(src.device);
  if (!call) return;
  clearTimeout(candidate?.timer);
  const c = { ...call, device: src.device, channel: src.channel, cc: src.cc };
  c.timer = setTimeout(() => {
    if (candidate !== c) return;
    candidate = null;
    // Still waiting? An evaluation in the meantime may have rewritten or removed the call.
    if (!learnCalls(c.deck).some((l) => l.at === c.at)) return;
    learnFilled(c.deck, c.at);
    learned.push({ deck: c.deck, at: c.at, device: c.device, channel: c.channel, cc: c.cc });
  }, MIDI_LEARN_SETTLE_MS);
  candidate = c;
}

onSourceFed(fed);

/**
 * The bare cc() calls given a knob since the last call, for the editor to write: `[{ deck, at,
 * device, channel, cc }]` - `at` is where the call was when its buffer was evaluated, `channel`
 * 1-16 as cc() takes it.
 */
export function takeMidiLearns() {
  return learned.splice(0);
}

/** The device the first bare cc() still waiting for a knob names, or null when none is waiting. */
export function midiLearnWaiting() {
  for (const deck of DECKS) {
    const call = learnCalls(deck)[0];
    if (call) return call.device;
  }
  return null;
}
