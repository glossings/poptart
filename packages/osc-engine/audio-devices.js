// Audio device enumeration and aggregate-device management, on top of the poptart-audio CoreAudio
// helper (native/poptart-audio.swift, committed prebuilt so no toolchain is needed to install).
//
// Why a native helper at all: scsynth opens exactly ONE audio device (sc/poptart.scd pins
// inDevice == outDevice - a CoreAudio aggregate built implicitly out of two independent-clock
// devices is what silently killed the server before). So the only way input("Scarlett", 1) and
// input("Mic", 1) can both be live in one set is an explicit aggregate that poptart builds, with
// drift compensation on every non-master member and a subdevice order we can read back to compute
// channel offsets. `system_profiler` can do neither.
//
// EVERYTHING here degrades: if the helper is missing or won't run (a non-macOS host, a stripped
// checkout, a Gatekeeper block), listDevices() falls back to the system_profiler parsing poptart
// used before, and the aggregate features report unavailable. A single device with absolute
// channel numbers - the old behaviour - keeps working either way.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HELPER = path.join(__dirname, 'native', 'bin', 'poptart-audio');

// The one aggregate poptart manages. A fixed UID (rather than one per session) is what makes
// rebuilding idempotent - "make the aggregate be exactly these devices" instead of accumulating a
// new device in the user's Audio MIDI Setup every time they change the selection.
const AGGREGATE_UID = 'com.poptart.aggregate';
const AGGREGATE_NAME = 'poptart';

let helperWarned = false;

function helperAvailable() {
  try {
    return process.platform === 'darwin' && fs.statSync(HELPER).isFile();
  } catch {
    return false;
  }
}

function runHelper(args, { timeout = 10000 } = {}) {
  const raw = execFileSync(HELPER, args, { encoding: 'utf8', timeout });
  return JSON.parse(raw);
}

// The helper writes {"error": "..."} to stderr and exits 1; surface that text rather than the
// generic "Command failed" execFileSync produces.
function helperError(err) {
  const stderr = String(err.stderr ?? '').trim();
  try {
    const parsed = JSON.parse(stderr);
    if (parsed?.error) return new Error(parsed.error);
  } catch { /* not JSON - fall through */ }
  return new Error(stderr || err.message);
}

// --- fallback: the pre-helper system_profiler path -------------------------------------------

// Same shape as the helper's `list`, minus UIDs (which system_profiler doesn't report). Without
// UIDs there's no aggregate management, but device selection and absolute input channels work.
function listDevicesViaSystemProfiler() {
  try {
    const raw = execFileSync('system_profiler', ['SPAudioDataType', '-json'], { encoding: 'utf8', timeout: 15000 });
    const groups = JSON.parse(raw).SPAudioDataType ?? [];
    return groups.flatMap((g) => g._items ?? []).map((d) => ({
      uid: null,
      name: d._name,
      inChannels: Number(d.coreaudio_device_input) || 0,
      outChannels: Number(d.coreaudio_device_output) || 0,
      sampleRate: Number(d.coreaudio_device_srate) || 0,
      transport: String(d.coreaudio_device_transport ?? ''),
      isAggregate: false,
      isDefaultOutput: d.coreaudio_default_audio_output_device === 'spaudio_yes',
      isDefaultInput: d.coreaudio_default_audio_input_device === 'spaudio_yes',
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] could not list audio devices: ${err.message}`);
    return [];
  }
}

// --- public API -------------------------------------------------------------------------------

/** Every audio device, with input/output channel counts and (helper only) UIDs. */
function listDevices() {
  if (!helperAvailable()) {
    if (!helperWarned && process.platform === 'darwin') {
      helperWarned = true;
      // eslint-disable-next-line no-console
      console.warn('[poptart] the poptart-audio helper is missing - falling back to system_profiler; '
        + 'multi-interface aggregates are unavailable (rebuild it with packages/osc-engine/native/build.sh)');
    }
    return listDevicesViaSystemProfiler();
  }
  try {
    return runHelper(['list']);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] poptart-audio list failed (${helperError(err).message}) - falling back to system_profiler`);
    return listDevicesViaSystemProfiler();
  }
}

/** Output-capable devices only - what the settings tab offers as the device to play through. */
function listOutputDevices() {
  return listDevices().filter((d) => d.outChannels > 0);
}

/** Input-capable devices only - what the settings tab offers as aggregate members. */
function listInputDevices() {
  return listDevices().filter((d) => d.inChannels > 0);
}

/**
 * The input channel layout of one device, in channel order: what input("name", n) resolves against.
 * For an aggregate that's its active subdevices; for a plain interface, itself as a single entry.
 * `missing` names subdevices that are configured but not currently plugged in - their absence
 * renumbers every channel after them, so it's worth telling the user about.
 *
 * Returns null when there's no helper (the caller falls back to a one-entry layout it builds from
 * the device's own channel count).
 */
function deviceLayout(uid) {
  if (!helperAvailable() || !uid) return null;
  try {
    return runHelper(['layout', '--uid', uid]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] could not read the layout of ${uid}: ${helperError(err).message}`);
    return null;
  }
}

/**
 * Builds (or rebuilds) poptart's aggregate device from `uids`, in that order - channel offsets
 * follow it. `mainUid` is the clock master (defaults to the first); every other member gets drift
 * compensation. Idempotent: an existing poptart aggregate is replaced, not added to.
 *
 * This MUTATES the user's audio configuration (the device appears in Audio MIDI Setup), so it is
 * only ever called from an explicit settings action, never as a side effect of evaluating a pattern.
 */
function rebuildAggregate(uids, mainUid = null) {
  if (!helperAvailable()) throw new Error('multi-interface aggregates need the poptart-audio helper, which is not available on this system');
  if (!Array.isArray(uids) || uids.length === 0) throw new Error('an aggregate needs at least one device');
  const args = ['create', '--name', AGGREGATE_NAME, '--uid', AGGREGATE_UID, '--main', mainUid ?? uids[0]];
  for (const uid of uids) args.push('--sub', uid);
  try {
    return runHelper(args, { timeout: 20000 });
  } catch (err) {
    throw helperError(err);
  }
}

/** Removes poptart's aggregate device. No-op if it doesn't exist. */
function destroyAggregate() {
  if (!helperAvailable()) return { destroyed: false };
  try {
    return runHelper(['destroy', '--uid', AGGREGATE_UID]);
  } catch (err) {
    throw helperError(err);
  }
}

/** poptart's own aggregate, if it currently exists. */
function findAggregate() {
  return listDevices().find((d) => d.uid === AGGREGATE_UID) ?? null;
}

module.exports = {
  AGGREGATE_UID,
  AGGREGATE_NAME,
  helperAvailable,
  listDevices,
  listOutputDevices,
  listInputDevices,
  deviceLayout,
  rebuildAggregate,
  destroyAggregate,
  findAggregate,
};
