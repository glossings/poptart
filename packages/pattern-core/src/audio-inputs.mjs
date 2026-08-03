// Hardware audio input channels for the input() head source / injector.
//
// scsynth opens exactly ONE audio device (poptart.scd pins inDevice == outDevice on purpose - a
// CoreAudio aggregate of two independent-clock devices is what killed the server the last time),
// so "which input" is always a CHANNEL on that one device. Two ways to name a channel:
//
//   input(3)                 absolute - hardware channel 3 of whatever device booted
//   input("Scarlett", 1)     device-relative - channel 1 of that device
//
// The device-relative form only means anything against a layout: when the booted device is a
// poptart-managed aggregate, its channels are the concatenation of its subdevices' channels, and
// the offset of any one subdevice depends on what else is in the aggregate. That layout is a
// runtime fact (it changes when the aggregate is rebuilt in settings), so it can NOT be baked into
// a pattern - the resolution happens per eval, here, against whatever the server last fed in.

// Input channel layout of the booted device, in channel order: [{ name, inChannels }]. One entry
// for a plain interface; one per subdevice for an aggregate. Empty until the server reports it
// (engine not started, or a platform where we can't enumerate devices) - absolute channels still
// work in that state, only name resolution needs the layout.
let layout = [];

/**
 * Feeds in the booted device's input layout. Called by the server after every engine start (an
 * engine restart is the only way the device can change), so a rebuilt aggregate re-resolves on
 * the next eval. Entries must be in channel order - the resolver sums `inChannels` to get offsets.
 */
export function setAudioInputLayout(devices = []) {
  layout = (Array.isArray(devices) ? devices : [])
    .map((d) => ({ name: String(d?.name ?? ''), inChannels: Math.max(0, Math.floor(Number(d?.inChannels) || 0)) }))
    .filter((d) => d.name || d.inChannels > 0);
}

/** The current layout (as fed in), for the editor's device autocomplete and for tests. */
export function audioInputLayout() {
  return layout.map((d) => ({ ...d }));
}

/** Total input channels the booted device exposes; 0 when the layout is unknown. */
export function audioInputChannelCount() {
  return layout.reduce((sum, d) => sum + d.inChannels, 0);
}

// Same matching rule as MIDI device names (midi.mjs, and sclang's midiSourceFor): case-insensitive
// substring, so input("Scarlett", 1) matches "Scarlett 6i6 USB" without pasting the exact string.
function findDevice(name) {
  const needle = String(name).toLowerCase();
  let offset = 0;
  for (const d of layout) {
    if (d.name.toLowerCase().includes(needle)) return { device: d, offset };
    offset += d.inChannels;
  }
  return null;
}

/**
 * Resolves an input() request to absolute, 0-indexed hardware channels for the engine.
 *
 * `req` is { device, chans } - `device` null for absolute channel numbers, and `chans` a 1-indexed
 * array of 1 (mono, duplicated to both sides engine-side) or 2 (a stereo pair, in that order; they
 * need not be adjacent) channels.
 *
 * Returns { chans: [a, b|-1], warning }. Never throws and never returns null: an unresolvable
 * request still yields playable channels (falling back to absolute numbering) plus a warning, per
 * the "warn, don't block sound" rule - a typo'd device name shouldn't take the whole set down.
 */
export function resolveInputChannels(req = {}) {
  const wanted = (Array.isArray(req.chans) && req.chans.length ? req.chans : [1, 2]).slice(0, 2);
  const total = audioInputChannelCount();
  let offset = 0;
  let warning = null;
  let scope = 'hardware';

  if (req.device) {
    const hit = findDevice(req.device);
    if (hit) {
      offset = hit.offset;
      scope = `"${hit.device.name}"`;
      const max = hit.device.inChannels;
      const over = wanted.filter((c) => c > max);
      if (over.length) {
        warning = `[signal] input("${req.device}", ${wanted.join(', ')}): ${hit.device.name} has `
          + `${max} input channel${max === 1 ? '' : 's'} - channel ${over.join('/')} doesn't exist on it.`;
      }
    } else if (layout.length) {
      warning = `[signal] input("${req.device}", ...): no audio input device matching "${req.device}" - `
        + `the booted device offers ${layout.map((d) => `"${d.name}" (${d.inChannels}ch)`).join(', ')}. `
        + 'Add it to the audio device in settings, or use absolute channel numbers.';
    } else {
      warning = `[signal] input("${req.device}", ...): no audio device layout yet (the engine may still `
        + 'be starting) - treating the channel numbers as absolute.';
    }
  }

  const abs = wanted.map((c) => offset + Math.round(c) - 1);
  if (abs.some((c) => c < 0)) {
    warning = warning ?? `[signal] input(): channels are numbered from 1 (as on the interface) - got ${wanted.join(', ')}.`;
  }
  if (!warning && total > 0 && abs.some((c) => c >= total)) {
    warning = `[signal] input(${wanted.join(', ')}): the ${scope} input has ${total} channel${total === 1 ? '' : 's'} - `
      + `channel ${wanted.join('/')} is past the end.`;
  }

  const chans = abs.map((c) => Math.max(0, c));
  return { chans: [chans[0], chans.length > 1 ? chans[1] : -1], warning };
}
