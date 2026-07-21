// Live MIDI input state, fed by the host process (web-app receives /poptart/midiIn OSC events
// from sclang and calls feedMidiCC) and read by midicc() signals (see signal.mjs). Kept apart
// from signal.mjs so both stay dependency-free: the browser imports the same signal code and
// simply has an empty store here - midicc signals sample as rests there, which is fine, since
// the browser only ever samples signals for display math, never for audio.
//
// Device names: a midicc("Twister") pattern is matched against the real device names the
// engine reports (CoreMIDI's "<device> <port>" strings) by case-insensitive substring, so code
// can use whatever readable fragment is unambiguous. sc/poptart.scd applies the same matching
// rule (midiSourceFor) for the native CC/note paths, so both tiers agree on which controller
// a name means.

// actual device name -> Map("cc|channel" -> latest 0..1 value). The "cc|*" key aggregates all
// channels (last event on any channel wins) - what a channel-less cc(12) reads.
const deviceStates = new Map();

// Device-name patterns any midicc()/midikeys() call has asked for this session. The host
// checks this after each eval to know whether to enable MIDI input engine-side at all (the
// engine boots with MIDI off - most sessions never touch it). Monotonic on purpose: once MIDI
// is on, deleting the code from the buffer costs nothing.
const requestedDevices = new Set();

export function registerMidiDevice(devicePattern) {
  requestedDevices.add(String(devicePattern));
}

export function midiInUse() {
  return requestedDevices.size > 0;
}

/** Host-side feed: one incoming CC event. channel is 1-16, value already normalized to 0..1. */
export function feedMidiCC(device, channel, cc, value01) {
  let state = deviceStates.get(device);
  if (!state) {
    state = new Map();
    deviceStates.set(device, state);
  }
  state.set(`${cc}|${channel}`, value01);
  state.set(`${cc}|*`, value01);
}

/**
 * Latest 0..1 value for a device/cc (channel null = aggregate over all channels), or null if
 * nothing has arrived yet - a midicc() signal rests until its knob first moves, so a parameter
 * holds its current value instead of jumping to a guess.
 */
export function latestCC(devicePattern, cc, channel) {
  const p = String(devicePattern).toLowerCase();
  const key = `${cc}|${channel ?? '*'}`;
  for (const [device, state] of deviceStates) {
    if (!device.toLowerCase().includes(p)) continue;
    const v = state.get(key);
    if (v != null) return v;
  }
  return null;
}
