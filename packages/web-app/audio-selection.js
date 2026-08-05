'use strict';

// Which audio device the engine opens, and what poptart's aggregate is built out of - the policy,
// with no CoreAudio in the way (audio-devices.js does the talking; this decides). Pure functions,
// no server state - see audio-selection.test.js.
//
// The failure this module exists to prevent: scsynth opens ONE device, so playing through your
// speakers *and* reading input("Scarlett", 1) means an aggregate built around the output device.
// An aggregate is a list of members, and CoreAudio quietly drops a member that gets unplugged.
// Unplug the interface the aggregate was built around and what's left is an aggregate whose
// channels 1/2 belong to whatever else was in it - a loopback, say - which the engine will open
// and play into perfectly happily, meters moving, in total silence. So:
//
//   - the aggregate is only a playback path while it still CONTAINS the device we mean to play
//     through (deviceToOpen falls back to that device directly when it doesn't), and
//   - anything that changes which device that IS has to rebuild the aggregate, or the choice is
//     silently inert (see server.js's POST /api/audioDevice).

/**
 * The plain output device the user picked (or the system default) - never the aggregate. This is
 * what playback is bound to, and what becomes the aggregate's clock master when inputs are added.
 *
 * @param devices - audioOutputDevices() shape: { uid, name, channels, inChannels, isDefault }
 * @param wanted - the saved device NAME, or null for the system default
 * @returns {{ device: object|null, warning: string|null }}
 */
function plainOutputDevice(devices, wanted, aggregateUid) {
  const candidates = devices.filter((d) => d.uid !== aggregateUid);
  const chosen = wanted ? candidates.find((d) => d.name === wanted) : null;
  return {
    device: chosen ?? candidates.find((d) => d.isDefault) ?? null,
    warning: wanted && !chosen
      ? `saved audio output device "${wanted}" is not connected - using the system default`
      : null,
  };
}

/**
 * Which device scsynth should actually open. Normally the plain output device - but when extra
 * input devices have been aggregated in, it's poptart's aggregate, since that's the single device
 * carrying all of their channels. Unless the aggregate has stopped carrying the output device, in
 * which case opening it would put playback somewhere nobody is listening.
 *
 * `layout` is the aggregate's deviceLayout() ({ subDevices, missing }), or null when it can't be
 * read - without it there's nothing to check against, so the aggregate is trusted as before.
 *
 * @returns {{ device: object|null, warning: string|null }}
 */
function deviceToOpen({ devices, wanted = null, inputUids = [], aggregateUid, layout = null }) {
  const plain = plainOutputDevice(devices, wanted, aggregateUid);
  if (!inputUids.length) return plain;

  const aggregate = devices.find((d) => d.uid === aggregateUid) ?? null;
  if (!aggregate) {
    return {
      device: plain.device,
      warning: 'the poptart aggregate device is configured but missing - falling back to the plain output device',
    };
  }
  const problem = aggregateProblem({ layout, outDevice: plain.device });
  if (problem?.kind === 'no-output-member') {
    return { device: plain.device, warning: problem.message };
  }
  return { device: aggregate, warning: plain.warning };
}

/**
 * What's wrong with the aggregate as it currently stands, or null when nothing is. Two kinds:
 *
 *   no-output-member - the device we play through isn't in it any more. Playback has to leave the
 *     aggregate entirely (deviceToOpen does), so input() loses the extra devices' channels.
 *   missing-members - it's still a valid playback path, but configured members aren't plugged in,
 *     and their absence renumbers every input channel after them.
 *
 * Both are invisible from the audio itself, which is exactly why they get said out loud.
 */
function aggregateProblem({ layout, outDevice }) {
  if (!layout) return null;
  const members = layout.subDevices ?? [];
  const missing = layout.missing ?? [];
  if (outDevice?.uid && members.length && !members.some((m) => m.uid === outDevice.uid)) {
    return {
      kind: 'no-output-member',
      message: `the combined audio device no longer contains "${outDevice.name}" `
        + `- playing through "${outDevice.name}" directly instead, so input() cannot reach the extra `
        + 'devices. Press apply under "extra inputs" to rebuild it.',
    };
  }
  if (missing.length) {
    return {
      kind: 'missing-members',
      message: `the combined audio device is missing ${missing.length} configured device(s) `
        + `(${missing.join(', ')}) - input() channel numbers have shifted. Press apply under `
        + '"extra inputs" to rebuild it without them.',
    };
  }
  return null;
}

/**
 * The aggregate's members in channel order: the output device first, because it's the clock master
 * and its channels are the ones playback lands on. Any input device that IS the output device is
 * already there and must not be added twice.
 */
function aggregateMembers(outUid, inputUids) {
  return [outUid, ...inputUids.filter((u) => u !== outUid)];
}

module.exports = { plainOutputDevice, deviceToOpen, aggregateProblem, aggregateMembers };
