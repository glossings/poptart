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
    // The console/server log is where the long version belongs - it's a log, not a sidebar.
    return { device: plain.device, warning: problem.detail };
  }
  return { device: aggregate, warning: plain.warning };
}

/**
 * What's wrong with the aggregate as it currently stands, or null when nothing is. Returns both a
 * one-line `message` (the UI's - what is wrong and what to press) and the `detail` behind it (the
 * console's and the tooltip's). Two kinds:
 *
 *   no-output-member - the device we play through isn't in it any more. Playback has to leave the
 *     aggregate entirely (deviceToOpen does), so input() loses the extra devices' channels. Note
 *     this is about MEMBERSHIP, not inputs: the output device belongs to the aggregate as its clock
 *     master and its playback destination, whether or not it has a single input channel.
 *   missing-members - it's still a valid playback path, but configured members aren't plugged in,
 *     and their absence renumbers every input channel after them.
 *
 * Both are invisible from the audio itself, which is exactly why they get said out loud.
 */
function aggregateProblem({ layout, outDevice, absent = [] }) {
  const members = layout?.subDevices ?? [];
  // Selected but not plugged in, from whichever source knows: what the caller compared against
  // connected hardware, or - before a heal has run - what the aggregate itself still has
  // configured and cannot see.
  const missing = absent.length ? absent : (layout?.missing ?? []);
  if (outDevice?.uid && members.length && !members.some((m) => m.uid === outDevice.uid)) {
    // The detail says WHY, and says what the output device is doing in there at all: read cold,
    // under a heading called "extra inputs" and next to a sentence about input(), "the combined
    // device doesn't contain your speakers" sounds like a claim that your speakers ought to be an
    // input. They oughtn't; they're in there as the clock master and the thing playback comes out
    // of. But that's a paragraph, and the UI gets the one line that says what to do about it.
    const cause = missing.length
      ? 'it was built around hardware that is no longer connected'
      : 'it was built around a different output device';
    return {
      kind: 'no-output-member',
      message: 'the combined audio device is out of date - press apply to rebuild it',
      detail: `the combined audio device does not include "${outDevice.name}" - ${cause}. Playback `
        + `has fallen back to "${outDevice.name}" on its own, so input() cannot reach the extra `
        + 'devices. Press apply under "extra inputs" to rebuild it. (Your output device is always a '
        + 'member of the combined device - it is the clock master everything else drift-corrects '
        + 'against, not an input.)',
    };
  }
  if (missing.length) {
    const one = missing.length === 1;
    return {
      kind: 'missing-members',
      message: `${missing.length} selected ${one ? 'device is' : 'devices are'} not plugged in `
        + `- press apply to rebuild without ${one ? 'it' : 'them'}`,
      detail: `the combined audio device is missing ${missing.length} `
        + `${one ? 'device that is' : 'devices that are'} configured but not plugged in `
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

/**
 * Why the aggregate has to be rebuilt before the engine opens it, as a short reason, or null when
 * it is already exactly what it should be. Called on every engine start, which is what makes an
 * unplugged interface a non-event: you restart, the aggregate is rebuilt around the output device
 * from whatever is actually connected, and nobody has to find a settings tab.
 *
 * Order is compared, not just membership - the member order IS the channel numbering input()
 * resolves against, so a reordered aggregate is a wrong one.
 *
 * @param wantUids - the selected input devices that are currently CONNECTED (see splitConnected)
 */
function aggregateStaleReason({ layout, outUid, wantUids }) {
  if (!outUid) return null; // nothing to build around; deviceToOpen falls back on its own
  const have = (layout?.subDevices ?? []).map((d) => d.uid);
  if (!wantUids.length) {
    // Everything selected is unplugged: an aggregate of the output device alone buys nothing over
    // opening that device directly, so the right move is not to have one.
    return have.length ? 'nothing selected is plugged in' : null;
  }
  if (!layout) return 'it does not exist yet';
  if (!have.includes(outUid)) return 'it does not include the output device';
  const want = aggregateMembers(outUid, wantUids);
  if (have.length !== want.length || have.some((uid, i) => uid !== want[i])) {
    return 'its devices no longer match what is selected and connected';
  }
  return null;
}

/**
 * Split a requested input selection into what can be aggregated right now and what isn't plugged
 * in. Absent devices must not fail the request: the settings tab can only draw a checkbox for a
 * device that's connected, so a saved-but-unplugged one is unremovable from the UI - and if it also
 * rejects the request, every future apply fails on it and the aggregate can never be rebuilt. That
 * is a dead end you can only escape by editing settings.json by hand, which is not a UI.
 */
function splitConnected(uids, knownUids) {
  const known = new Set(knownUids);
  return {
    present: uids.filter((u) => known.has(u)),
    absent: uids.filter((u) => !known.has(u)),
  };
}

module.exports = {
  plainOutputDevice, deviceToOpen, aggregateProblem, aggregateMembers, splitConnected,
  aggregateStaleReason,
};
