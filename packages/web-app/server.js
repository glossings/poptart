'use strict';

// Plain Node HTTP server - serves the browser UI from public/ and exposes engine, transport,
// and file operations as JSON-over-HTTP endpoints (see `routes`). Everything is request/reply
// (no push updates needed), so plain HTTP is enough - no WebSocket dependency.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { MappedEngine, toRealWorld } = require('./param-mapping');
const { blockReason, isLoopbackHostname } = require('./request-guard');
const { preferVst3 } = require('./plugin-filter');
const { SNAPSHOT_DIR, putSnapshot, getSnapshot, pruneSnapshots } = require('./snapshots');
const blobs = require('./blobs');
const recordings = require('@poptart/osc-engine/recordings');
const analysis = require('@poptart/osc-engine/analysis');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
// Loopback-only by default: this server evals arbitrary JS (/api/evaluate), so binding
// 0.0.0.0 would hand code execution to anyone on the same network. POPTART_HOST exists for
// a deliberate LAN bind (e.g. a collaborative jam) - that opt-out also relaxes the
// browser-level guards below, which only make sense for a loopback-only server.
const HOST = process.env.POPTART_HOST || '127.0.0.1';
const LOOPBACK_ONLY = isLoopbackHostname(HOST);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// CodeMirror (v5: plain script files, no build step) is served under /vendor/codemirror/
// straight out of node_modules - see resolveStaticPath(). pattern-core's dependency-free ESM
// sources are served under /pattern-core/ so the browser can run the same mini-notation parser
// and label splitter the server uses (playback highlighting needs identical step math).
const CODEMIRROR_DIR = path.dirname(require.resolve('codemirror/package.json'));
const PATTERN_CORE_SRC_DIR = path.join(__dirname, '..', 'pattern-core', 'src');

const DEFAULT_CPS = 0.5; // 120 bpm at 4 beats/cycle - overridable from code via setbpm()

let patternCore = null; // loaded via dynamic import() since it's an ESM package
let engine = null; // raw OscEngine (introspection/record endpoints talk to this directly)
let mappedEngine = null; // alias + unit-conversion wrapper (see param-mapping.js) - what the scheduler drives
let engineError = null;
let transport = null; // shared tempo clock (pattern-core Transport) - all schedulers read it
const schedulers = new Map(); // pattern label -> Scheduler (one engine track per label)

// VST host-transport mirror: pushes the Transport's tempo + song position (in beats, 4 per
// cycle) into the engine, which forwards it to every open plugin as emulated DAW transport -
// what makes plugin-internal synced LFOs/delays/arpeggiators follow setbpm. Called on every
// tempo change (transport.onCpsChange), after every engine (re)start, and on a periodic timer:
// plugins advance their own transport on the audio clock between calls, so like the
// scheduler's LFO anchors, the periodic re-sync keeps ppm-level clock skew from accumulating
// into drift against the pattern grid (each correction is microseconds).
const VST_TRANSPORT_SYNC_MS = 4000;
const VST_TRANSPORT_LOOKAHEAD_SEC = 0.15; // applied engine-side at this target, like note events

function syncVstTransport() {
  if (!engine || !transport) return;
  const targetSec = engine.getTime() + VST_TRANSPORT_LOOKAHEAD_SEC;
  engine.setTempo(transport.cps * 240, transport.cycleAt(targetSec) * 4, targetSec);
}
setInterval(syncVstTransport, VST_TRANSPORT_SYNC_MS);

// ---------------------------------------------------------------------------------------------
// Settings - small persisted knobs (currently just the audio output device), plain JSON under
// ~/.poptart so they survive restarts and are hand-editable.
// ---------------------------------------------------------------------------------------------

const SETTINGS_FILE = process.env.POPTART_SETTINGS_FILE || path.join(os.homedir(), '.poptart', 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {}; // missing or corrupt - defaults
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

const settings = loadSettings();

// Apply the persisted sample-library folder to the engine's samples module (env var still wins
// - see samples.js). Chosen in the "settings" tab; null/absent means the default ~/.poptart/samples.
require('@poptart/osc-engine/samples').setSamplesRoot(settings.samplesDir ?? null);

// Audio devices with channel counts and UIDs, via the poptart-audio CoreAudio helper (with a
// system_profiler fallback - see audio-devices.js). Channel counts are why this isn't sclang's
// ServerOptions.outDevices: scsynth needs numOutputBusChannels at boot, and .o(n)'s
// stereo-pair wraparound has to match the hardware.
const audioDevices = require('@poptart/osc-engine/audio-devices');
const audioSelection = require('./audio-selection.js');

// Output-capable devices in the shape the settings tab and loadEngine expect. `channels` is the
// output count (what .o(n) wraps at); `inChannels` is the same device's input count, which is what
// numInputBusChannels gets sized from - scsynth opens this ONE device for both directions.
function audioOutputDevices() {
  return audioDevices.listOutputDevices().map((d) => ({
    uid: d.uid,
    name: d.name,
    channels: d.outChannels,
    inChannels: d.inChannels,
    isDefault: d.isDefaultOutput,
    isAggregate: d.isAggregate,
  }));
}

// The device-selection policy lives in audio-selection.js (pure, unit-tested); these two wire it
// to the settings and turn its warnings into log lines.
function plainOutputDevice(devices) {
  const { device, warning } = audioSelection.plainOutputDevice(
    devices, settings.audioOutputDevice ?? null, audioDevices.AGGREGATE_UID,
  );
  // eslint-disable-next-line no-console
  if (warning) console.warn(`[poptart] ${warning}`);
  return device;
}

// Which device scsynth should actually open - the plain output device, or poptart's aggregate when
// extra inputs have been combined in. Reading the aggregate's live membership is the point: an
// aggregate that has lost the device we play through is not a playback path, however happily it
// opens (see audio-selection.js).
function deviceToOpen(devices) {
  const inputUids = settings.audioInputDevices ?? [];
  const { device, warning } = audioSelection.deviceToOpen({
    devices,
    wanted: settings.audioOutputDevice ?? null,
    inputUids,
    aggregateUid: audioDevices.AGGREGATE_UID,
    // Only worth a helper round-trip when there IS an aggregate in play.
    layout: inputUids.length ? audioDevices.deviceLayout(audioDevices.AGGREGATE_UID) : null,
  });
  // eslint-disable-next-line no-console
  if (warning) console.warn(`[poptart] ${warning}`);
  return device;
}

// The output-channel picture for the settings tab and for loadEngine: how many channels the device
// that would be opened can actually be heard on, which of those .o(n) is allowed to use, and the
// counts the tab may offer. One function so the tab can never show a choice the engine would not
// honour.
function outputChannelState(devices = audioOutputDevices()) {
  const args = {
    devices,
    wanted: settings.audioOutputDevice ?? null,
    active: deviceToOpen(devices),
    aggregateUid: audioDevices.AGGREGATE_UID,
  };
  const audible = audioSelection.audibleChannels(args);
  return {
    audible,
    channels: audioSelection.playbackChannels({ ...args, cap: settings.audioOutputChannels ?? null }),
    choices: audioSelection.outputChannelChoices(audible),
  };
}

/**
 * Make poptart's aggregate match `uids` (the extra input devices), built around whatever the
 * output device currently is - it goes in first and is the clock master. An empty list tears the
 * aggregate down. Returns the members it built, or null.
 *
 * MUTATES the machine's audio configuration, so every caller is an explicit settings action.
 */
function syncAggregate(uids) {
  if (!uids.length) {
    audioDevices.destroyAggregate();
    return null;
  }
  const out = plainOutputDevice(audioOutputDevices());
  if (!out?.uid) throw new Error('could not determine the output device to build the aggregate around');
  const members = audioSelection.aggregateMembers(out.uid, uids);
  audioDevices.rebuildAggregate(members, out.uid);
  return members;
}

// Which of the selected input devices are plugged in right now, and which aren't.
function splitSelectedInputs() {
  const uids = settings.audioInputDevices ?? [];
  return audioSelection.splitConnected(uids, audioDevices.listDevices().map((d) => d.uid));
}

// A selected device's name, remembered when it was applied - so one that is unplugged later reads
// as "EarPods" rather than as the raw CoreAudio UID, which is unreadable and, when it turned up in
// a checkbox list, unidentifiable.
function inputDeviceName(uid) {
  return settings.audioInputNames?.[uid] ?? uid;
}

/**
 * Bring the combined device back in line with what is selected AND connected, before the engine
 * opens it. This is what makes an unplugged interface a non-event: restart and the aggregate is
 * rebuilt from whatever is actually there, rather than the engine opening a stale one - or falling
 * back and leaving input() dead until somebody finds the settings tab and presses a button.
 *
 * The SELECTION is deliberately left alone. Auto-unticking would be the destructive reading of the
 * same idea: USB devices can take a second or two to enumerate after a wake, "absent right now"
 * is not "gone", and the order of that list is what input()'s channel offsets are computed from.
 * So the aggregate follows the hardware and the selection keeps the intent.
 */
function healAggregate() {
  const uids = settings.audioInputDevices ?? [];
  if (!uids.length || !audioDevices.helperAvailable()) return;
  const { present } = splitSelectedInputs();
  const reason = audioSelection.aggregateStaleReason({
    layout: audioDevices.deviceLayout(audioDevices.AGGREGATE_UID),
    outUid: plainOutputDevice(audioOutputDevices())?.uid ?? null,
    wantUids: present,
  });
  if (!reason) return;
  try {
    syncAggregate(present);
    // eslint-disable-next-line no-console
    console.warn(`[poptart] rebuilt the combined audio device: ${reason}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] could not rebuild the combined audio device (${err.message})`);
  }
}

// What's wrong with the audio device setup right now, as { message, detail } - one line for the
// settings tab, the paragraph behind it for the console - or null. The whole reason this is
// surfaced at all: both failures are inaudible in the one way that matters, they leave the meters
// moving.
function audioDeviceWarning() {
  const uids = settings.audioInputDevices ?? [];
  if (!uids.length) return null;
  const problem = audioSelection.aggregateProblem({
    layout: audioDevices.deviceLayout(audioDevices.AGGREGATE_UID),
    outDevice: plainOutputDevice(audioOutputDevices()),
    absent: splitSelectedInputs().absent.map(inputDeviceName),
  });
  return problem ? { message: problem.message, detail: problem.detail } : null;
}

// The device scsynth actually opened, as reported by audioOutputDevices() - set by loadEngine on
// every start and read by wireEngine to tell pattern-core which input channels input() can address.
let activeAudioDevice = null;

async function loadEngine() {
  try {
    // Before anything decides which device to open: make the combined device match reality. The
    // old scsynth is already stopped and the device released by here (see restartEngine), so this
    // is the one moment a rebuild can't collide with playback.
    healAggregate();
    const { OscEngine } = require('@poptart/osc-engine');
    // Whichever device scsynth will actually open decides how many channels exist at all, and
    // whose input channels input() addresses (wireEngine feeds the layout to pattern-core).
    const devices = audioOutputDevices();
    const active = deviceToOpen(devices);
    activeAudioDevice = active ?? null;
    // Pass the device name only when it isn't the system default: naming it pins inDevice too
    // (see poptart.scd), which is exactly what we want for a chosen device or the aggregate.
    const pinned = active && !active.isDefault ? active.name : null;
    const e = new OscEngine({
      outDevice: pinned,
      outChannels: active?.channels ?? 2,
      // What .o(n) wraps at: the channels anyone can actually hear, capped by the user's own
      // "output channels" choice - stereo unless they went looking for more (audio-selection.js).
      playChannels: audioSelection.playbackChannels({
        devices, wanted: settings.audioOutputDevice ?? null, active, aggregateUid: audioDevices.AGGREGATE_UID,
        cap: settings.audioOutputChannels ?? null,
      }),
      inChannels: active?.inChannels ?? 0,
    });
    await e.start(48000, 256);
    engineError = null;
    return e;
  } catch (err) {
    engineError = err.message ?? String(err);
    // eslint-disable-next-line no-console
    console.error('[poptart] osc-engine failed to start:', err);
    return null;
  }
}

let engineRestarting = false;

// Tear the whole engine stack (sclang + scsynth) down and boot a fresh one - how an audio
// output device change is applied, since scsynth only picks its device at boot. Playing tracks
// are stopped rather than migrated (their synths and plugins lived in the old scsynth); the
// editor tells the user to re-evaluate.
async function restartEngine() {
  if (engineRestarting) throw new Error('an engine restart is already in progress');
  engineRestarting = true;
  try {
    for (const [label, sch] of schedulers) {
      sch.stop();
      mappedEngine?.removeChain(label);
    }
    schedulers.clear();
    // The replacement engine has no tracks and no held notes - drop the keyboard-routing state
    // so a stale held note isn't "released" against the new engine on the next eval.
    kbTracks.clear();
    kbHeld.clear();
    // Every plugin window went with the old scsynth, and so did whatever was being edited in one.
    // Left alone, these would hold slots still for windows that no longer exist and for captures
    // nothing can take any more (see the hand-editing section).
    handTaken.clear();
    uncaptured.clear();
    // The taps and any in-flight bounce died with the old scsynth. Dropping the state here is what
    // stops the editor from polling a recording that can never finish; the panel re-taps on its
    // next poll.
    if (trackRec?.timer) clearInterval(trackRec.timer);
    trackRec = null;
    // The MIDI recorder's tick reads engine.getTime() every 50ms and its window is measured in
    // cycles of a transport that is about to be frozen - neither survives the restart, so the
    // timer has to go with them. Leaving it running was a crash: it outlived the engine it was
    // ticking against and threw on a null one, in a bare interval callback with nothing to catch it.
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = null;
    recTapped.clear();
    recLevels.clear();
    transport?.stop(); // playback is over - freeze the clock at cycle 0 until the next eval
    // Drop the shared references BEFORE the teardown, not after it. Everything that reaches for
    // `engine` outside a request - the VST transport re-sync on its 4s timer, the recorder ticks -
    // tests it for null and does nothing when it is null, and that test has to be true for the
    // WHOLE window in which the engine is unusable. Nulling these afterwards left a real one open:
    // OscEngine#stop closes its OSC port partway through, so a timer firing in the seconds between
    // that and the assignment found a non-null engine whose every send throws "OscEngine not
    // started". Thrown from a timer, that is an uncaught exception, and an uncaught exception is
    // the whole app - the crash you get for changing your audio device while something is playing.
    const dying = engine;
    engine = null;
    mappedEngine = null;
    if (dying) {
      await dying.stop();
      // Let the OS actually release the OSC UDP port and the audio device before the
      // replacement sclang/scsynth try to grab them - both frees complete asynchronously.
      await new Promise((r) => setTimeout(r, 300));
    }
    engine = await loadEngine();
    if (engine) wireEngine();
  } finally {
    engineRestarting = false;
  }
}

// ALL post-start engine wiring, shared by init() and restartEngine(). Single function on
// purpose: when these were two hand-maintained copies, onParamAutomated existed only on the
// restart path - so conf capture silently dropped every gesture on a fresh boot until the
// first audio-device change. Any new engine callback goes here and nowhere else.
function wireEngine() {
  mappedEngine = new MappedEngine(engine);
  // Captured plugin programs live in the blob store, not in the code (see blobs.js), so what the
  // scheduler hands the engine is usually a "@id" handle. This is the one place it is turned back
  // into a program.
  engine.setStateResolver((id) => blobs.getBlob(id));
  // Born paused at cycle 0: the clock only advances while something is playing (first eval
  // starts it, /api/stop freezes it back at 0). Survives engine restarts, hence the guard.
  if (!transport) transport = new patternCore.Transport(() => engine.getTime(), { cps: DEFAULT_CPS, paused: true });
  transport.onCpsChange = syncVstTransport;
  syncVstTransport(); // a fresh sclang needs the surviving transport's tempo, not 120
  // Live CC events (forwarded from sclang once MIDI is enabled) feed pattern-core's
  // live-value store - what a Tier-1 midicc() signal samples.
  engine.onMidiIn = (device, channel, cc, value) => patternCore.feedMidiCC(device, channel, cc, value);
  // Live note edges from midikeys() routes - what an armed MIDI recording collects.
  engine.onMidiNoteIn = (trackId, note, vel, isOn) => handleMidiNoteIn(trackId, note, vel, isOn);
  // Plugin-GUI knob gestures - what conf capture writes into the code.
  engine.onParamAutomated = (trackId, slot, name, index, value) => handleParamAutomated(trackId, slot, name, index, value);
  // Any edit inside a plugin's own window - what auto-pin captures back into the code.
  engine.onPluginEdited = (trackId, slot) => handlePluginEdited(trackId, slot);
  // Peak level of a track tapped for recording - what the record panel's meter draws.
  engine.onRecLevel = (trackId, left, right) => handleRecLevel(trackId, left, right);
  // Which input channels input() can address, and what a device-relative input("name", n) resolves
  // against. Only the booted device has any, so this is re-fed on every start (a device change is
  // an engine restart) - a pattern written before the change picks up the new offsets on re-eval.
  patternCore.setAudioInputLayout(audioInputLayout());
}

// The booted device's input channels, split per subdevice when it's an aggregate - which is what
// makes input("Scarlett", 1) resolve to the right absolute channel across several interfaces. The
// order is read back from CoreAudio rather than assumed, and only ACTIVE subdevices are counted,
// since an unplugged one contributes no channels and renumbers everything after it.
function audioInputLayout() {
  if (!activeAudioDevice || !activeAudioDevice.inChannels) return [];
  const layout = audioDevices.deviceLayout(activeAudioDevice.uid);
  const subs = (layout?.subDevices ?? []).filter((d) => d.inChannels > 0);
  if (layout?.missing?.length) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] the audio device is missing ${layout.missing.length} configured `
      + 'sub-device(s) - input() channel numbers have shifted accordingly');
  }
  if (!subs.length) return [{ name: activeAudioDevice.name, inChannels: activeAudioDevice.inChannels }];
  return subs.map((d) => ({ name: d.name, inChannels: d.inChannels }));
}

async function init() {
  patternCore = await import('@poptart/pattern-core');
  extendStringPrototype(patternCore);
  // Sig#log() event lines go to the browser, not this terminal: the editor drains the queue on
  // its existing 500ms poll (see POST /api/pluginEdits) and prints each line in the in-app
  // console, which mirrors it to devtools. Livecoding happens in the browser, so that's where a
  // debug line is actually read - and the server's stdout stays a log of the server.
  patternCore.setEventLogger((line) => {
    eventLogQueue.push(line);
    if (eventLogQueue.length > EVENT_LOG_MAX) eventLogQueue.splice(0, eventLogQueue.length - EVENT_LOG_MAX);
  });
  // Userland warnings ride the same queue for the same reason: a pattern that asks for something
  // that no longer exists keeps playing (see pattern-core's "Warnings, not exceptions"), so the
  // only way the player learns about it is a line in the console they're already watching.
  patternCore.setPatternWarn((line) => {
    eventLogQueue.push(line);
    if (eventLogQueue.length > EVENT_LOG_MAX) eventLogQueue.splice(0, eventLogQueue.length - EVENT_LOG_MAX);
  });
  // First-run setup: SC detection, VSTPlugin auto-install, preflight warnings (see
  // PACKAGING.md Stage 1). Logs what it finds; never throws, never blocks the boot -
  // loadEngine()'s own diagnostics remain the backstop if something is still wrong.
  await require('@poptart/osc-engine/setup').runSetup();
  engine = await loadEngine();
  if (engine) wireEngine();
  runPrebake(); // once, after builders + transport exist and before the first eval
}

// Strudel-flavored ergonomics: let mini-notation strings be used directly as patterns in
// evaluated code - `"0 0.5 1 0.3".gte(0.5)`, `"0 3 5".add(12)`, `"200 800".range(...)`. Each
// method wraps the string in mini() and delegates. This deliberately shadows the dead Annex-B
// legacy String methods where names collide (.sub's "<sub>…</sub>" wrapper, nothing of value).
function extendStringPrototype(core) {
  const METHODS = [
    'add', 'sub', 'mul', 'div', 'mod', 'round', 'abs', 'floor', 'ceil', 'clamp',
    'gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'when', 'hold', 'seg', 'segment', 'scale', 'range', 'synth', 'fx', 'param',
    'gain', 'pan', 'o', 'vel', 'clip', 'as', 'sc',
  ];
  for (const m of METHODS) {
    Object.defineProperty(String.prototype, m, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(...args) {
        return core.mini(String(this))[m](...args);
      },
    });
  }
  builtinSigMethods = new Set(Object.getOwnPropertyNames(core.Sig.prototype));
}

// Names on Signal's prototype when the server booted - anything beyond these was added from
// userland (`Signal.prototype.co = ...`) and gets mirrored onto strings too, below.
let builtinSigMethods = null;

// Userland language extensions work on bare mini strings exactly like the built-in methods:
// after each evaluated block, any method newly added to Signal.prototype is mirrored onto
// String.prototype with the same mini()-wrapping shim - unless strings already have that name
// (never shadow a real String method like .slice()/.at()).
function syncUserStringMethods() {
  for (const m of Object.getOwnPropertyNames(patternCore.Sig.prototype)) {
    if (builtinSigMethods.has(m) || m in String.prototype) continue;
    if (typeof patternCore.Sig.prototype[m] !== 'function') continue;
    Object.defineProperty(String.prototype, m, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(...args) {
        return patternCore.mini(String(this))[m](...args);
      },
    });
  }
}

const BUILDER_NAMES = ['Signal', 'n', 'note', 'mini', 's', 'se', 'sr', 'synth', 'sine', 'saw', 'tri', 'square', 'ramp', 'rand', 'perlin', 'lfo', 'env', 'midicc', 'midikeys', 'macro', 'choose', 'cat', 'seq', 'irand', 'keyboard', 'tap', 'midi', 'audio', 'input', 'pianoroll',
  // Every control method also as a top-level control builder - speed("-1"), begin(0.5), clip(2) -
  // so a combinator can aim at one channel of a pattern it was handed: x.mul(speed("-1")).
  'i', 'begin', 'end', 'loop', 'loopwrap', 'loopdir', 'speed', 'flip', 'stretch', 'fit', 'slice', 'attack', 'decay', 'sustain', 'release', 'vel', 'clip',
  // Pure music-theory helpers (not signal builders, but handy when writing your own): note-name
  // -> MIDI, scale-degree -> MIDI, and the raw {rootMidi, intervals} of a scale name. Exposed by
  // name so a custom `Signal.prototype.chord = ...` can call them. Real in the browser prebake too
  // (see client.js), so they behave the same in patterns, setup blocks, and hotkey handlers.
  'noteToMidi', 'degreeToMidi', 'parseScaleName'];

// Builders the EDITOR writes and nobody types: the definition calls behind a drawn roll, an LFO
// shape or a captured plugin preset. Bound so the buffer they are written into evaluates, but
// deliberately kept out of
// BUILDER_NAMES - which is what drives autocomplete and the docs - so the plain names `roll` and
// `shape` stay free for whatever they should mean to a person later. See the underscore in
// pattern-core: these are the editor's own calls, not part of the language.
const INTERNAL_BUILDERS = ['_roll', '_shape', '_preset'];

// The Macros panel's knobs, pre-bound as ready-made signals: `macro1`..`macro8` in evaluated
// code are `macro(1)`..`macro(8)`, so a knob can be dropped straight into a control -
// param("Filter 1 Freq", macro1.range(200, 4000)). Built lazily: patternCore is a dynamic
// import and isn't loaded yet when this module's top level runs.
function macroSigNames() {
  return Array.from({ length: patternCore.MACRO_COUNT }, (_, i) => `macro${i + 1}`);
}

// What a `setbpm(...)` block evaluates to - lets /api/evaluate tell tempo-only blocks apart
// from actual patterns (blocks must otherwise evaluate to a Sig).
const TEMPO_BLOCK = Object.freeze({ poptartTempoBlock: true });

// setbpm is global (there's one transport), so it's a server-provided builder rather than a
// pattern-core export. Accepts a number or any signal - "120 140", sine(0.05).range(100, 160)...
function setbpm(value) {
  if (!transport) throw new Error(engineError ?? 'engine not loaded');
  transport.setBpm(typeof value === 'string' ? patternCore.mini(value) : value);
  return TEMPO_BLOCK;
}

// The setscale equivalent of TEMPO_BLOCK.
const SCALE_BLOCK = Object.freeze({ poptartScaleBlock: true });

// setscale sets the buffer's key, which every `.sc()` then reads (see pattern-core's notes.mjs).
// Global like setbpm - a patch is in one key at a time - and HOISTED by /api/evaluate below, so
// the LAST setscale in the buffer is the key the whole buffer plays in, patterns written above it
// included. That's the point: re-keying a patch mid-set is one edit wherever you make it, not an
// edit that only takes effect downwards. Like the tempo, it persists until something changes it.
function setscale(name) {
  patternCore.setGlobalScale(name);
  return SCALE_BLOCK;
}

// The builders the HOST provides (as opposed to pattern-core's), bound alongside BUILDER_NAMES in
// every evaluated block. Read out of this source by api-docs.test.js, so adding one here is what
// makes the editor's reference cover it.
const HOST_BUILDERS = { setbpm, setscale };

// One block of editor code (see labels.mjs) -> its value, evaluated with the builders in
// scope. Evaluated via direct eval rather than wrapping the code in `return (...)` so a block
// may contain *statements*, not just one expression. eval's completion value (the last
// statement's value) is the block's result, so plain single-expression blocks behave exactly
// as before.
//
// The `label: pattern` paradigm is only for code that emits audio - a block may instead just
// declare things (`const kb = midikeys("Twister")` on an unlabeled line) and its top-level
// bindings stay visible to every block below it in the buffer. That sharing needs two tricks,
// because const/let declared inside a direct eval are scoped to that eval alone: top-level
// declarations are rewritten to `var` (which hoists into the wrapper function, where the
// harvest object literal can read it), and the harvested values are re-injected as extra
// parameters into each later block's wrapper. The typeof guard covers names the line-anchored
// regex picks up inside nested callbacks, which stay scoped there and never reach the wrapper.
// The prebake file is shared with the browser, which runs it too for its hotkeys/UI side (see
// runUserPrebake in client.js). Those browser-only calls - hotkey(), editor/repl, alert/prompt -
// have no meaning here, so we hand the evaluator harmless stubs rather than let them throw as
// ReferenceErrors. The pure utils (bjorklund/rotate/clamp) are real, since they're safe anywhere.
const PREBAKE_BROWSER_SHIMS = {
  hotkey: () => {},
  alert: () => {},
  prompt: (_msg, def) => def,
  log: (msg) => console.log(`[poptart] prebake log: ${msg}`),
  editor: new Proxy(() => '', { get: () => () => '', apply: () => '' }),
  get repl() { return this.editor; },
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  rotate: (arr, n) => {
    const len = arr.length;
    if (!len) return arr.slice();
    const k = ((n % len) + len) % len;
    return arr.slice(k).concat(arr.slice(0, k));
  },
  bjorklund: (pulses, steps) => {
    pulses = Math.max(0, Math.min(Math.floor(pulses), Math.floor(steps)));
    steps = Math.max(0, Math.floor(steps));
    if (steps === 0) return [];
    if (pulses === 0) return new Array(steps).fill(false);
    let groups = Array.from({ length: pulses }, () => [true]);
    let rem = Array.from({ length: steps - pulses }, () => [false]);
    while (rem.length > 1) {
      const n = Math.min(groups.length, rem.length);
      const ng = [], nr = [];
      for (let i = 0; i < n; i++) ng.push(groups[i].concat(rem[i]));
      if (groups.length > n) for (let i = n; i < groups.length; i++) nr.push(groups[i]);
      else for (let i = n; i < rem.length; i++) nr.push(rem[i]);
      groups = ng; rem = nr;
    }
    return groups.concat(rem).flat();
  },
};

function makeBlockEvaluator(defs = new Map()) {
  // defs: name -> value, accumulated down the buffer. Seeded from the prebake file so its
  // top-level bindings are in scope for every user block too (see runPrebake).
  const evalBlock = function evalBlock(code, locBase) {
    const declNames = [
      ...new Set([...code.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])),
    ];
    // Playback-highlight source locations: when a document offset is given (a real editor block),
    // wrap pattern-position string literals in mini("…", ABS_OFFSET) so the emitted steps carry
    // document-absolute atom spans (see pattern-core/locations.mjs). Prebake/def blocks pass no
    // base and stay untagged. The wrapping only touches string literals inside expressions, so the
    // decl-name harvest above and the const/let->var rewrite below are unaffected.
    const located = typeof locBase === 'number' ? patternCore.injectLocations(code, locBase) : code;
    const body = located.replace(/^([ \t]*)(?:const|let)(\s+)/gm, '$1var$2');
    const macroNames = macroSigNames();
    const baseNames = [...BUILDER_NAMES, ...INTERNAL_BUILDERS, ...macroNames, ...Object.keys(HOST_BUILDERS)].filter((n) => !defs.has(n)); // defs may shadow builders
    const baseValues = baseNames.map((n) => {
      if (n in HOST_BUILDERS) return HOST_BUILDERS[n];
      if (macroNames.includes(n)) return patternCore.macro(Number(n.slice(5)));
      return patternCore[n];
    });
    // Browser-only userland API stubs, minus anything a builder or a user def already provides.
    const shimNames = Object.keys(PREBAKE_BROWSER_SHIMS).filter((n) => !defs.has(n) && !baseNames.includes(n));
    const shimValues = shimNames.map((n) => PREBAKE_BROWSER_SHIMS[n]);
    const harvest = declNames
      .map((n) => `${JSON.stringify(n)}: (typeof ${n} === 'undefined' ? undefined : ${n})`)
      .join(', ');
    // eslint-disable-next-line no-new-func
    const build = new Function(
      ...baseNames,
      ...shimNames,
      ...defs.keys(),
      '__blockCode',
      `var __value = eval(__blockCode); return { __value: __value, __defs: { ${harvest} } };`,
    );
    const { __value, __defs } = build(...baseValues, ...shimValues, ...defs.values(), body);
    for (const [n, v] of Object.entries(__defs)) if (v !== undefined) defs.set(n, v);
    syncUserStringMethods(); // the block may have extended Signal.prototype - strings follow
    return __value;
  };
  evalBlock.defs = defs;
  return evalBlock;
}

// ---------------------------------------------------------------------------------------------
// Prebake - a user-owned setup file (plus an optional prebake/ folder of files) evaluated once
// at load, before any pattern is played. It's for the setup you'd otherwise paste into every
// buffer: personal helpers, custom scales, Signal.prototype extensions. Plain .js under
// ~/.poptart so it's hand-editable like settings.json and the patterns folder.
//
// Blocks run as setup - their values are ignored (nothing auto-plays and the engine needn't even
// be up). What persists is the same two things a `$:` setup block leaves behind: Signal.prototype
// mutations (global) and top-level const/let/var bindings, which are harvested into prebakeDefs
// and seeded into every later /api/evaluate so `const kick = s("bd*4")` in prebake is usable by
// name in any pattern.
// ---------------------------------------------------------------------------------------------

const PREBAKE_FILE = process.env.POPTART_PREBAKE_FILE || path.join(os.homedir(), '.poptart', 'prebake.js');
const PREBAKE_DIR = process.env.POPTART_PREBAKE_DIR || path.join(os.homedir(), '.poptart', 'prebake');

let prebakeDefs = new Map(); // top-level bindings from the prebake sources, injected into every eval

// The prebake sources in run order: prebake.js first, then prebake/*.js by filename. Later files
// see earlier files' bindings (they share one evaluator), so numbered files impose an order.
function prebakeSources() {
  const sources = [];
  try {
    const code = fs.readFileSync(PREBAKE_FILE, 'utf8');
    if (code.trim()) sources.push({ name: 'prebake.js', code });
  } catch { /* no single-file prebake - fine */ }
  let names = [];
  try {
    names = fs.readdirSync(PREBAKE_DIR).filter((f) => f.endsWith('.js')).sort((a, b) => a.localeCompare(b));
  } catch { /* no prebake/ folder - fine */ }
  for (const f of names) {
    try {
      const code = fs.readFileSync(path.join(PREBAKE_DIR, f), 'utf8');
      if (code.trim()) sources.push({ name: `prebake/${f}`, code });
    } catch { /* unreadable entry - skip it */ }
  }
  return sources;
}

// Runs (or re-runs) all prebake sources into a fresh evaluator, replacing prebakeDefs with the
// result. Called once at startup and again whenever the browser saves the file, so an edit takes
// effect without a restart. Returns the list of per-block error messages (empty on success) for
// the save endpoint to hand back to the editor; a broken prebake never throws or blocks startup.
function runPrebake() {
  const sources = prebakeSources();
  const errors = [];
  const evalBlock = makeBlockEvaluator();
  // roll() definitions from prebake are a library shared by every patch, so they go to their own
  // layer: a buffer evaluation clears only its own rolls and leaves these standing. Re-running
  // prebake (the browser saved the file) replaces the layer wholesale, the same as prebakeDefs.
  patternCore.setRollLayer('prebake');
  patternCore.clearRolls('prebake');
  try {
    for (const src of sources) {
      for (const b of patternCore.splitLabeledBlocks(src.code)) {
        try {
          evalBlock(b.code); // value ignored - prebake is setup, not a track
        } catch (err) {
          const where = b.label && !b.label.startsWith('$') ? ` (${b.label})` : '';
          const msg = `${src.name}${where}: ${err.message ?? err}`;
          errors.push(msg);
          console.error(`[poptart] prebake ${msg}`);
        }
      }
    }
  } finally {
    patternCore.setRollLayer('buffer');
  }
  prebakeDefs = evalBlock.defs; // replaces the previous set - a cleared prebake clears its defs
  if (sources.length) {
    const defs = prebakeDefs.size ? `; defs: ${[...prebakeDefs.keys()].join(', ')}` : '';
    console.log(`[poptart] prebake ran ${sources.length} file(s)${defs}`);
  }
  return errors;
}

// The single ~/.poptart/prebake.js file, read for the browser's prebake editor ('' if missing).
// The optional prebake/ folder is a disk-only power feature, so only this file is edited in-app.
function readPrebakeFile() {
  try {
    return fs.readFileSync(PREBAKE_FILE, 'utf8');
  } catch {
    return '';
  }
}

// Patterns evaluate lazily, so a bad value ("badnote" where a note name should be, a throwing
// signal) can first surface mid-playback rather than at eval. Force the first few cycles (and
// one continuous sample) here so those errors come back as an eval error the editor shows,
// instead of hitting the scheduler's timer. A few cycles because alternations (`<a b c>`) only
// visit each branch every N cycles - this catches the common cases, and the scheduler's own
// try/catch stops just the offending track for anything pathological beyond that.
const DRY_RUN_CYCLES = 8;

// Every signal a track carries that can hold a mini-notation pattern: the note/value pattern
// itself, plus each param modulation (.param), channel-strip control (.gain/.pan/.o/.dry), the
// velocity signal (.vel), and each sampler config (.i/.speed/…). LFO/env/constant controls have
// no step grid and fall out where callers check `.stepsForCycle`. Shared by the eval-time dry run
// and the highlight grid so BOTH see the whole track, not just its note pattern.
function patternSigs(sig) {
  // Sampler config and note channels are NOT listed: a patterned one is cross-merged into the
  // main grid at build time (structure + locs union, see pattern-core crossMerge), so the main
  // sig already lights them - and for a per-position control (choose) the config sig's own grid
  // only knows the phase-0 pick, which would wrongly light one option for the whole cycle.
  // A patterned lfo("<a b>") lights up too: the modulator itself has no step grid, but the shape
  // NAMES do - that pattern is what says which shape is running, and it is the thing on screen.
  // A .preset("<a b>") is the same case one level up: the names are a step pattern of their own,
  // and lighting them is what lets the preset panel open on the one you can hear.
  //
  // A slot the editor is HOLDING (the preset panel, or a plugin window open on it) is not playing
  // those names - but that is NOT decided here. A grid is computed in windows of many cycles and
  // shipped ahead of the sound, while a hold is taken and released between two of them, so a grid
  // with the hold baked in is wrong the moment the hold changes: it went on lighting names after a
  // hold was taken, and left them dark after one was dropped, until the next evaluation rebuilt it.
  // The grid says what the pattern says; the editor is told what is held on the poll it already
  // runs and suppresses those spans live. See client.js's syncHeldPresets.
  const presets = Object.values(sig.presetPatterns ?? {});
  return [sig, ...Object.values(sig.paramSignals), ...Object.values(sig.channel), ...presets]
    .flatMap((s) => (s?.lfoIR?.shapePattern ? [s, s.lfoIR.shapePattern] : [s]));
}

function dryRunPattern(sig) {
  const cps = transport?.cps ?? DEFAULT_CPS;
  const sigs = patternSigs(sig);
  for (const s of sigs) {
    if (s.stepsForCycle) {
      for (let cycle = 0; cycle < DRY_RUN_CYCLES; cycle++) s.stepsForCycle(cycle);
    }
    s.sample(0, cps, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Playback-highlight grid. The browser highlights the atom currently sounding by reading the
// SAME step grid the scheduler plays - so any transform in the method chain (.fast/.slow/.when/
// degrade/…) is reflected exactly, instead of the browser re-guessing from the source text. The
// server (which holds the real evaluated Sig) computes, per active track, the sounding steps for
// a window of cycles, each step tagged with its document-absolute atom spans (`locs`), converted
// to block-relative offsets the client anchors at the track's start position. Deterministic per
// cycle, so a later window can be re-requested identically via /api/highlight.
// ---------------------------------------------------------------------------------------------

const HL_WINDOW = 32; // cycles of grid shipped per track (initial window and each top-up)

const hlTracks = new Map(); // label -> { sig, start, end } for the last eval's active tracks

// The sounding steps of a track for cycles [from, from+count), each as { start, end, cont?, locs }.
// Every pattern signal on the track contributes (see patternSigs), so a `.param("x","0 1")` /
// `.gain("1 0.5")` / `.speed("<1 2>")` modulation highlights just like the note pattern. `locs` are
// the step's source spans (see pattern-core stepLocs), kept only where they fall inside the block's
// own [start,end] document range - so a location that rode in from a prebake-defined pattern or a
// dynamic string (which the client can't place in this block) is dropped - then rebased to
// block-relative. Steps that end up with no in-range span are omitted (they light nothing).
function highlightGrid(sig, start, end, from, count) {
  const sigs = patternSigs(sig).filter((s) => s.stepsForCycle);
  const grid = [];
  const base = Math.max(0, from);
  for (let c = base; c < base + count; c++) {
    const out = [];
    for (const sub of sigs) {
      let steps;
      try {
        steps = sub.stepsForCycle(c);
      } catch {
        continue;
      }
      for (const s of steps) {
        if (s.value == null) continue;
        const locs = patternCore
          .stepLocs(s)
          .filter((l) => l[0] >= start && l[1] <= end)
          .map((l) => [l[0] - start, l[1] - start]);
        // A lit atom stays lit for as long as its note SOUNDS, so clip is applied here exactly as
        // the scheduler applies it when placing the noteOff (see pattern-core soundingEnd) - the
        // highlighter is just another emitter of the same event.
        if (locs.length) {
          const at = c + s.start;
          const soundsTo = patternCore.soundingEnd(s, sub.noteChannels, at, 1, at);
          out.push({ start: s.start, end: soundsTo, ...(s.cont ? { cont: true } : {}), locs });
        }
      }
    }
    grid.push({ cycle: c, steps: out });
  }
  return grid;
}

// The cycle the transport is on right now (0 while paused / just after a stop). The highlight
// window starts here so a running clock gets the cycles it's about to play, not cycle 0.
function currentGridCycle() {
  if (!transport) return 0;
  return Math.max(0, Math.floor(transport.cycleAt(transport.getTime())));
}

// Pattern files - named saves and work-in-progress sessions under ~/.poptart/patterns, plus the
// metadata (`@title`/`@by`/`@tags`) the files tab lists and searches on. All the filesystem work
// lives in pattern-files.js / public/pattern-meta.js; the routes below are the HTTP face of it.
const {
  PATTERNS_DIR,
  WIP_DIR,
  patternFilePath,
  wipFilePath,
  listSavedPatterns,
  listWipPatterns,
  wipOlderThan,
  pruneWipSessions,
} = require('./pattern-files');
const { matchesQuery } = require('./public/pattern-meta.js');

// ---------------------------------------------------------------------------------------------
// MIDI record - capture a midikeys() performance as mini-notation. sclang forwards every note
// edge of an active midikeys() route as /poptart/midiNoteIn (see poptart.scd's midiRoute
// handlers); arming a recording collects those between two cycle boundaries. Recording starts
// at the next 4-cycle phrase boundary - the wait until then is the count-in - and runs for
// `cycles` cycles. The editor polls /api/midiRecord/status and, on 'done', writes each track's
// pattern into the code in place of its kb()/midikeys() call (see client.js applyRecording).
// ---------------------------------------------------------------------------------------------

const PHRASE_CYCLES = 4;

let midiRec = null; // { phase: 'armed'|'recording'|'done', startCycle, endCycle, cycles, grid, held, events, results, timer }

function midiRecStatus() {
  if (!midiRec) return { phase: 'idle' };
  const { phase, startCycle, endCycle, cycles, grid, results } = midiRec;
  return { phase, startCycle, endCycle, cycles, grid, results, transport: transport.snapshot() };
}

function pushRecEvent(trackId, ev) {
  let list = midiRec.events.get(trackId);
  if (!list) midiRec.events.set(trackId, (list = []));
  list.push(ev);
}

// One live note edge. Held notes wait per track+note (a stack, so fast retriggers of the same
// key pair up correctly) until their note-off completes the event.
function handleMidiNoteIn(trackId, note, vel, isOn) {
  if (!midiRec || midiRec.phase === 'done') return;
  const rel = transport.cycleAt(engine.getTime()) - midiRec.startCycle;
  if (isOn && vel > 0) {
    // Slightly-early onsets (played into the count-in's last moment, meant for beat 1) snap to
    // the window start; anything earlier is count-in noodling and stays unrecorded.
    const preRoll = 0.5 / (midiRec.grid > 0 ? midiRec.grid : patternCore.UNQUANTIZED_GRID);
    if (rel < -preRoll || rel >= midiRec.cycles) return;
    let held = midiRec.held.get(trackId);
    if (!held) midiRec.held.set(trackId, (held = new Map()));
    let stack = held.get(note);
    if (!stack) held.set(note, (stack = []));
    stack.push({ note, vel, start: Math.max(0, rel) });
  } else {
    const ev = midiRec.held.get(trackId)?.get(note)?.pop();
    if (!ev) return; // off for a note that started before the window (or after it closed)
    pushRecEvent(trackId, { ...ev, end: Math.min(midiRec.cycles, Math.max(ev.start + 1e-3, rel)) });
  }
}

// ---------------------------------------------------------------------------------------------
// Live computer-keyboard routing (keyboard()/tap()). Unlike a midikeys() route, the note source
// is the browser, not the audio engine - so the flow is inverted: after each eval we tell the
// editor which tracks are keyboard targets (kbTracks), and the browser POSTs every key edge to
// /api/keyNote, which drives engine.noteOn/noteOff on that track (the same call the scheduler
// makes for pattern notes, so env()/lfo() gating is identical). We track held notes per track so
// a stop, re-eval, or dropped keyboard() can release anything still down instead of leaving a
// stuck note. Key edges also feed the MIDI recorder, so a typed performance records like a
// midikeys() one.
// ---------------------------------------------------------------------------------------------

const kbTracks = new Map(); // trackId -> { kind: 'keyboard'|'tap' } - tracks currently accepting key edges
const kbHeld = new Map(); // trackId -> Set<note> currently held via /api/keyNote

// Send note-offs for every key still held on a track and forget them (stop, re-eval, un-arm).
function releaseKbNotes(trackId) {
  const held = kbHeld.get(trackId);
  if (held && engine) {
    const now = engine.getTime();
    for (const note of held) {
      engine.noteOff(trackId, note, now);
      handleMidiNoteIn(trackId, note, 0, false); // close its recorded event too
    }
  }
  kbHeld.delete(trackId);
}

// The fixed MIDI pitch a route's key strikes, when .note()/.n() set one (a Sig on the route). A
// tap() with no .note() returns null and the browser falls back to its default pad note.
function kbRouteNote(route) {
  if (!route.note) return null;
  const v = route.note.sample(0, 1);
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

// Re-derive the armed keyboard tracks from the just-evaluated active patterns, releasing any
// track that is no longer a keyboard target. Returns the list the eval response hands the editor.
function syncKbTracks(active) {
  const next = new Map();
  for (const b of active) if (b.sig.keyboardRoute) next.set(b.label, b.sig.keyboardRoute);
  for (const id of kbTracks.keys()) if (!next.has(id)) releaseKbNotes(id);
  kbTracks.clear();
  for (const [id, route] of next) kbTracks.set(id, route);
  return [...kbTracks].map(([trackId, route]) => ({ trackId, kind: route.kind, note: kbRouteNote(route) }));
}

function midiRecTick() {
  if (!midiRec || midiRec.phase === 'done') return;
  const pos = transport.cycleAt(engine.getTime());
  if (midiRec.phase === 'armed' && pos >= midiRec.startCycle) midiRec.phase = 'recording';
  // Small overshoot so a note-off landing right on the end boundary completes its event first.
  if (pos >= midiRec.endCycle + 0.02) finalizeMidiRec();
}

function finalizeMidiRec() {
  clearInterval(midiRec.timer);
  midiRec.timer = null;
  // Keys still held when the window closes become events that ring to the end.
  for (const [trackId, held] of midiRec.held) {
    for (const stack of held.values()) {
      for (const ev of stack) pushRecEvent(trackId, { ...ev, end: midiRec.cycles });
    }
  }
  midiRec.held.clear();
  const results = [];
  for (const [label, events] of midiRec.events) {
    if (events.length === 0) continue;
    // A tap() track records note-less (velocity/clip only) - the client wraps it .as("vel:clip").
    const noteless = kbTracks.get(label)?.kind === 'tap';
    try {
      const { pattern, count } = patternCore.recordingToMini(events, {
        cycles: midiRec.cycles,
        grid: midiRec.grid,
        startCycle: midiRec.startCycle,
        noteless,
      });
      results.push({ label, pattern, count, noteless });
    } catch (err) {
      results.push({ label, error: err.message ?? String(err) });
    }
  }
  midiRec.results = results;
  midiRec.phase = 'done';
}

// ---------------------------------------------------------------------------------------------
// Track record - bounce one labeled block's audio to a file it can then play back with sr().
//
// Same shape as the MIDI recorder above (arm at the next phrase boundary, poll for status, write
// the result into the code), but the payload is audio and the window's edges are decided by the
// audio clock rather than by this timer: engine.recordTrack schedules them as timestamped bundles,
// so the file's length is sample-exact whatever the event loop is doing.
//
// What lands on disk is wider than the window - [pre-roll][window][post-roll] - because freeing a
// DiskOut synth drops whatever is still in its realtime buffer. The post-roll covers that buffer
// and carries the release tail; trimRecording (wav.js, run on the analysis worker because it
// rewrites the whole capture) cuts the exact window back out, and only then does the take get a
// name and a home under ~/.poptart/recordings.
// ---------------------------------------------------------------------------------------------

// Insurance either side of the window. The pre-roll absorbs any rounding between this clock and
// the audio one; the post-roll MUST exceed DiskOut's buffer (65536 frames, ~1.4s at 48k) or the
// window's own last moments are what gets dropped.
const REC_PRE_ROLL_SEC = 0.25;
const REC_POST_ROLL_SEC = 3;
// A recording has to be armed far enough ahead that its pre-roll still lies in the future; when
// the next phrase is closer than this, arm for the one after it instead.
const REC_MIN_LEAD_SEC = REC_PRE_ROLL_SEC + 0.3;

let trackRec = null; // { phase: 'armed'|'recording'|'done', label, cycles, startCycle, endCycle, name, wrapTail, capture, result, error, timer }
const recTapped = new Set(); // labels currently tapped (a record panel is open on them)
const recLevels = new Map(); // label -> { peak, at } - latest meter reading, for the panel

// The engine meters ~20x/sec but the panel polls at ~10 - so readings QUEUE rather than overwrite,
// and a poll drains the lot. Throwing away every other reading would halve the live waveform's
// resolution and lose whichever transients landed in the gaps. Capped so a panel left open with
// nothing polling it can't grow without bound.
const REC_LEVEL_QUEUE_MAX = 64;

function handleRecLevel(trackId, peak, rms) {
  let queue = recLevels.get(trackId);
  if (!queue) recLevels.set(trackId, (queue = []));
  queue.push({ peak, rms, at: Date.now() });
  while (queue.length > REC_LEVEL_QUEUE_MAX) queue.shift();
}

// Drain every meter reading for one track since the last poll, oldest first, and clear the queue.
// Empty means the engine has stopped reporting (tap dropped, engine restarted) - the panel draws
// silence rather than freezing at whatever it last said.
function recLevelsOf(label) {
  const queue = recLevels.get(label);
  if (!queue?.length) return [];
  const cutoff = Date.now() - 1000;
  const out = queue.filter((r) => r.at >= cutoff).map((r) => ({ peak: r.peak, rms: r.rms }));
  queue.length = 0;
  return out;
}

// `levels` covers every tapped track, not just a recording one: an open panel meters its block
// from the moment it opens, which is most of what makes the panel worth opening. Each entry is
// every reading since the last poll, oldest first. Recording state rides alongside and is simply
// absent when nothing is armed.
function trackRecStatus() {
  const levels = Object.fromEntries([...recTapped].map((label) => [label, recLevelsOf(label)]));
  if (!trackRec) {
    return { phase: 'idle', tapped: [...recTapped], levels, transport: transport?.snapshot() };
  }
  const { phase, label, cycles, startCycle, endCycle, name, result, error } = trackRec;
  return {
    phase,
    label,
    cycles,
    startCycle,
    endCycle,
    name,
    result,
    error,
    tapped: [...recTapped],
    // A recording keeps its own tap even with the panel closed, so its readings may not be in
    // `levels` yet - drain them too.
    levels: recTapped.has(label) ? levels : { ...levels, [label]: recLevelsOf(label) },
    transport: transport.snapshot(),
  };
}

/** Open or close a track's meter tap - what the record panel being open costs. */
function setRecTap(label, on) {
  if (!engine) throw new Error(engineError ?? 'engine not loaded');
  if (on) recTapped.add(label);
  else if (trackRec?.label !== label) recTapped.delete(label); // a running bounce keeps its own tap
  else return; // don't pull the tap out from under a recording
  engine.tapTrack(label, on);
  if (!on) recLevels.delete(label);
}

function trackRecTick() {
  if (!trackRec || trackRec.phase === 'done') return;
  const pos = transport.cycleAt(engine.getTime());
  if (trackRec.phase === 'armed' && pos >= trackRec.startCycle) trackRec.phase = 'recording';
}

// The engine has closed the capture file: cut the window out of it, file it under a name nothing
// else has used, and hand the editor what it needs to write the sr() call. `wrote` is the engine's
// own report of what reached the disk ({ frames }), which is what tells an empty capture apart
// from an unreadable one.
// The trim itself runs on the analysis worker (it reads and rewrites the whole capture, which is
// seconds of audio and well over the scheduler's lookahead), so this is async and the bounce stays
// in phase 'recording' until it lands - which is exactly what the editor's status poll expects.
async function finalizeTrackRec(wrote = {}) {
  const rec = trackRec;
  clearInterval(rec.timer);
  rec.timer = null;
  try {
    if (wrote.frames === 0) {
      throw new Error(
        `the engine recorded nothing from "${rec.label}" - the track's recorder tap never carried audio ` +
        '(is the block still playing, and not soloed away?)',
      );
    }
    const name = recordings.mintName(rec.name || rec.label);
    const dest = recordings.newRecordingFile(name);
    const info = await analysis.trimRecording(rec.capture, dest, {
      startSec: REC_PRE_ROLL_SEC,
      lengthSec: rec.endSec - rec.startSec,
      wrapTail: rec.wrapTail,
    });
    if (!info) throw new Error(`couldn't read the capture the engine wrote (${rec.capture})`);
    rec.result = { name, file: dest, cycles: rec.cycles, ...info };
  } catch (err) {
    rec.error = err.message ?? String(err);
    console.error(`[poptart] track record (${rec.label}): ${rec.error}`);
  }
  // A failed capture is LEFT on disk: it's the only evidence of what went wrong, and the path is
  // in the error message. A good one has been trimmed into the recordings folder and is just a
  // temp file at this point.
  if (!rec.error) {
    try {
      fs.unlinkSync(rec.capture);
    } catch {
      // already gone - nothing to clean up
    }
  }
  rec.phase = 'done';
}

// Drop a recording's engine-side tap unless a panel is still open on that track.
function releaseRecTap(label) {
  if (recTapped.has(label)) return;
  try {
    engine.tapTrack(label, false);
  } catch {
    // engine already down - the tap went with it
  }
  recLevels.delete(label);
}

// ---------------------------------------------------------------------------------------------
// "conf" (configure) capture - Ableton-style. While a track is in conf mode, sclang forwards
// every parameter a user moves in a plugin's own editor GUI as /poptart/paramAutomated; we
// coalesce the latest value per (slot, name) and hand them to the editor, which drops each into
// the code as .param(name, value). Values arrive normalized 0..1 (what VST params take); for a
// parameter with a units mapping (mappings/*.json) we convert back to real-world units so the
// written .param() call round-trips - and reads in Hz/dB/etc. like the rest of that plugin's code.
// ---------------------------------------------------------------------------------------------

let conf = null; // { trackId, touched: Map<`slot|name`, { slot, name, value }>, seen: Set<addr> } while a track configures

// Round to `sig` significant figures - real-world unit values (Hz, ms) span wide magnitudes, so a
// fixed decimal count would be either lossy or noisy. Normalized values use a plain 4 decimals.
function roundSig(x, sig = 4) {
  if (x === 0 || !Number.isFinite(x)) return x;
  const mag = 10 ** (sig - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * mag) / mag;
}

// The address a touched parameter is written as: its plain name, or "Name#index" when the
// plugin has more than one parameter sharing that name (Diva's three "Frequency", etc.), so the
// generated .param() call targets the exact one that was moved rather than the first match. Falls
// back to the plain name if the plugin's parameter list isn't cached yet (nothing to compare).
function paramAddr(plugin, name, index) {
  const list = paramsByPlugin.get(plugin);
  if (!list) return name;
  const sameName = list.reduce((n, p) => n + (p.name === name ? 1 : 0), 0);
  return sameName > 1 ? `${name}#${index}` : name;
}

function handleParamAutomated(trackId, slot, name, index, normValue) {
  if (!conf || conf.trackId !== trackId) {
    // sclang only forwards gestures for a conf-armed track, so landing here means the two ends
    // disagree about the session - log it, this is the diagnostic for every "conf writes
    // nothing" report.
    console.log(`[conf] gesture "${name}" from track "${trackId}" ignored - configuring: ${conf ? `"${conf.trackId}"` : 'none'}`);
    return;
  }
  const spec = mappedEngine?.specFor(trackId, slot, name);
  const value = spec ? roundSig(toRealWorld(normValue, spec)) : Math.round(normValue * 1e4) / 1e4;
  const addr = paramAddr(mappedEngine?.chains.get(trackId)?.[slot], name, index);
  // One line per param per session (not per gesture - dragging floods otherwise), so the server
  // console shows what conf is capturing.
  if (!conf.seen.has(addr)) {
    conf.seen.add(addr);
    console.log(`[conf] capturing "${addr}" (track "${trackId}" slot ${slot})`);
  }
  conf.touched.set(`${slot}|${addr}`, { slot, name: addr, value });
}

// ---------------------------------------------------------------------------------------------
// Auto-pin. `synth("Serum 2")` with no state argument means "however the plugin defaults" - but
// the moment you touch anything in the plugin's own window, that's no longer true, so we capture
// the full state and hand it to the editor to write into the call as `{ state }`. No pin button:
// the code always describes what you're hearing.
//
// The state itself goes in, gzipped and base64'd, megabytes and all - not a reference to it. A
// patch is then the whole sound: what you save, paste or send needs nothing else to exist, and
// commenting one line out and another in swaps presets, because both are right there. It was
// briefly a short id into a side store instead; that made buffers small but made a patch a pointer,
// and pointers dangle. What made big buffers expensive was never the bytes - it was the label
// splitter re-lexing a block per line (fixed in labels.mjs: 2MB went 225ms -> 11ms). An 8.5MB
// buffer with three pinned Serums now costs ~55ms an eval, and that is worth paying for a patch
// that can't lose its own sound.
//
// WHEN we capture is an audio decision, not a bookkeeping one, and it has two settings. A capture
// is VSTPlugin's `writeProgram`, and its docs are explicit about the cost: with `async: true` (the
// default)
// "plugin processing is temporarily suspended" while the plugin serializes itself - a couple of
// megabytes of wavetables for a Serum program, and an audible interruption of that track.
// `async: false` is not an escape: it moves the same work onto the audio thread, where it stalls
// the whole server rather than one plugin. Our own share is off the event loop (the gzip runs on
// the threadpool - see osc-engine), so there is no faster capture to write - only a better moment
// to spend one:
//
// `immediate` (the default) spends one as soon as each gesture settles, whatever the clock is
// doing: one brief suspension per tweak, and a buffer that always matches what you hear.
// `deferred` (POPTART_AUTOPIN=deferred) spends it only where it costs least:
//
//   - clock frozen -> capture as soon as the gesture settles. Nothing is playing to interrupt.
//   - clock running -> hold the slot dirty, and capture at the next moment the code has to be
//     true about the sound: an eval, a stop, a save, an export, a share link (the callers of
//     flushPluginCaptures). Those are moments you are already changing or leaving the sound, and
//     all of them are far rarer than knob moves. It also keeps a megabyte-scale rewrite of the
//     buffer out of the middle of a performance.
//
// Deferring buys an uninterrupted jam, and pays for it in the gap between the plugin and the
// buffer: sound design that exists only inside the plugin is lost if the tab or the server goes
// away, and anything reading the buffer meanwhile (an autosave, a snapshot) is describing a sound
// that has moved on. flushPluginCaptures closes the gap wherever the code is about to be written
// out, but not everything is one of those moments - which is why it isn't the default.
//
// The signal actually worth waiting for would be the plugin's own window closing, and VSTPlugin
// doesn't offer it: its events are /vst_param, /vst_auto, /vst_program*, /vst_latency, /vst_midi,
// /vst_sysex, /vst_update and /vst_crash (see the UGen reference). Nothing reports a closed editor.
//
// Debounced either way: sclang reports every gesture, so an undebounced capture would run that
// round trip dozens of times a second during a knob drag. One capture per gesture is enough
// anyway - the state is a full snapshot, so intermediate ones are pure waste.
// ---------------------------------------------------------------------------------------------

const AUTOPIN_DEBOUNCE_MS = 400;
// A capture slower than this is worth a log line: it is time the plugin spent suspended, which is
// the only part of a capture anyone can hear.
const AUTOPIN_SLOW_MS = 50;

// See the section header for what these two cost each other.
const AUTOPIN_MODE = process.env.POPTART_AUTOPIN === 'deferred' ? 'deferred' : 'immediate';

// "trackId|slot" -> { trackId, slot, plugin, preset } - edited, not yet captured. `plugin` is what
// sat in that slot when the gesture happened; a capture that finds something else there has been
// overtaken by a chain edit and is dropped rather than written to the wrong plugin. `preset` is the
// name a .preset(...) pattern had loaded there AT THE GESTURE - read now rather than at capture
// time because the capture is half a second later, by which point the pattern may well have moved
// on, and the knob you turned belongs to the sound you were hearing when you turned it.
const autoPinDirty = new Map();
// "trackId|slot" -> { preset, at } - the preset the editor's preset panel is holding that slot on
// (see the /api/presetHold route and Scheduler#holdPreset). Kept HERE rather than only on the
// Scheduler because setPattern rebuilds what a slot plays from on every evaluation - and a save
// re-evaluates - so a hold has to be re-asserted afterwards, or the panel would lose the sound it
// is editing on its own first keystroke.
//
// A hold is a LEASE, not a flag: the editor renews it on the poll it already runs, and it expires a
// few seconds after the editor stops asking. A held slot stops swapping, so one that outlived its
// panel - a closed tab, a reload, a browser that crashed - would leave a track quietly stuck on one
// preset with nothing on screen to explain why its pattern had stopped working.
const presetHolds = new Map();
const PRESET_HOLD_TTL_MS = 3000; // ~6 missed polls (see the editor's 500ms pluginEdits loop)

/**
 * Takes or releases one slot's hold. Returns the reason the preset couldn't be loaded, or null.
 * `force` is the panel picking a preset by hand - see the route, which captures first.
 */
function setPresetHold(trackId, slot, preset, { force = false } = {}) {
  const key = `${trackId}|${slot}`;
  if (preset == null) {
    presetHolds.delete(key);
    schedulers.get(trackId)?.holdPreset(slot, null);
    return null;
  }
  const prev = presetHolds.get(key);
  // Renewing an unchanged lease is a HEARTBEAT and must do nothing else. holdPreset() LOADS the
  // preset, and between auto-pin capturing a program out of the plugin and the evaluation that
  // files it in the store, the store still holds the OLD program - so a renewal in that window
  // would push the old sound back into the plugin, and the eval a moment later would put the new
  // one in again. Which is precisely what "it jumps back to the previous preset and then returns"
  // was. Only a hold that is new, or has moved to a different preset, applies anything.
  const renewal = prev?.preset === preset && prev.loaded;
  // A hold taken while the slot is frozen by hand editing is a hold that hasn't LOADED anything -
  // the plugin is sounding what your knobs made, which is the sound the panel is editing anyway.
  // Recorded as such, so the poll that comes after the freeze lifts loads it rather than reading
  // as a heartbeat and doing nothing for the rest of the session.
  const loaded = renewal || force || !stateHeld(key);
  presetHolds.set(key, { preset, at: Date.now(), loaded });
  if (renewal || !loaded) return null;
  return schedulers.get(trackId)?.holdPreset(slot, preset, { force }) ?? null;
}

/** Drops leases the editor has stopped renewing, handing those slots back to their patterns. */
function expirePresetHolds() {
  const cutoff = Date.now() - PRESET_HOLD_TTL_MS;
  for (const [key, held] of presetHolds) {
    if (held.at >= cutoff) continue;
    presetHolds.delete(key);
    const at = key.lastIndexOf('|');
    schedulers.get(key.slice(0, at))?.holdPreset(Number(key.slice(at + 1)), null);
  }
}
// ---------------------------------------------------------------------------------------------
// Hand editing. While you are turning a plugin's own knobs, that plugin holds a sound nothing else
// has yet: not the preset store, not the buffer, not a `{ state }` argument. Anything that pushes a
// STORED program into the slot meanwhile overwrites what you just did - and auto-pin's capture
// lands a moment later and puts it back, so the slot audibly flips to the old sound for a cycle and
// then to the new one. That is what "the preset keeps switching back and forth" is.
//
// So a slot being edited by hand is frozen: whole-program pushes are held off, and nothing else is
// (see Scheduler#holdPluginState). Two things freeze one, and it stays frozen while either holds:
//
//   - the slot has been TAKEN BY HAND: you opened its plugin's own window (/api/showEditor), and
//     have not been back to the code since. Opening a plugin window is the gesture that means "I am
//     shaping this sound myself now", and clicking anywhere in the code (/api/releaseEditors) is
//     the one that hands it back - the two ends of a session at the plugin, both of them things a
//     person actually did rather than states we tried to infer.
//
//     Inference is what this replaced, and it is worth saying why. Nothing reports a plugin window
//     CLOSING - VSTPlugin's events are params, programs, latency, midi, sysex and crash, and
//     nothing else - so the first attempt guessed the end of a session from the browser regaining
//     focus, and guessed wrong constantly: a window that opens behind the browser never takes the
//     focus away, so holds ended a second or two after they started, in the middle of a knob turn.
//
//     Kept HERE rather than in the browser because it outlives a tab: reload the page and the
//     plugin window is still up, still holding, and the editor is told so on its first poll.
//   - a captured program hasn't reached the code yet. The round trip is capture -> poll -> write ->
//     eval, comfortably a cycle or two of a running clock, and the store is stale for every one of
//     them. The editor reports each capture it has filed BY SEQUENCE NUMBER, so a knob turned while
//     the last capture was in flight isn't released by the report of that one; a capture that never
//     lands (no chain call left to write into, a browser that went away) times out rather than
//     freezing the slot for the rest of the set.
// ---------------------------------------------------------------------------------------------

const handTaken = new Set(); // "trackId|slot" of every slot taken over by hand (see above)
const uncaptured = new Map(); // "trackId|slot" -> { seq, at } - edited, not yet filed into the code
const UNCAPTURED_TTL_MS = 20000; // covers a capture, a poll, a write and the eval that files it
let editSeq = 0;

/** Whether either reason to leave a slot's plugin alone is in force (see the section header). */
function stateHeld(key) {
  return handTaken.has(key) || uncaptured.has(key);
}

/** Tells the track's scheduler whether one of its slots is being edited by hand right now. */
function syncStateHold(key) {
  const at = key.lastIndexOf('|'); // a label may contain a pipe; the slot never does
  schedulers.get(key.slice(0, at))?.holdPluginState(Number(key.slice(at + 1)), stateHeld(key));
}

/** Every slot of one track frozen right now, for the eval that rebuilds its scheduler. */
function stateHeldSlotsFor(label) {
  const out = new Set();
  for (const key of [...handTaken, ...uncaptured.keys()]) {
    const at = key.lastIndexOf('|');
    if (key.slice(0, at) === label) out.add(Number(key.slice(at + 1)));
  }
  return out;
}

/**
 * Every chain slot that is NOT following its preset pattern right now, with the preset it is
 * actually sitting on. The editor draws these (see its holds section): a held slot is a place where
 * the code says one thing and the sound is another, and the only honest way to show that is on the
 * code itself. Both kinds are in here - the preset panel's hold and the hand-editing freeze -
 * because from the buffer's point of view they are one fact: this slot plays that preset for now.
 */
function currentHolds() {
  const out = [];
  const seen = new Set();
  const add = (key, why) => {
    if (seen.has(key)) return; // first reason wins, most deliberate first
    seen.add(key);
    const at = key.lastIndexOf('|');
    const trackId = key.slice(0, at);
    const slot = Number(key.slice(at + 1));
    out.push({ trackId, slot, why, preset: schedulers.get(trackId)?.livePreset(slot) ?? null });
  };
  for (const key of presetHolds.keys()) add(key, 'panel');
  for (const key of handTaken) add(key, 'hand');
  for (const key of uncaptured.keys()) add(key, 'capture');
  return out;
}

/** Opening a plugin's own window takes that slot by hand until the code is touched again. */
function takeSlotByHand(trackId, slot) {
  const key = `${trackId}|${slot}`;
  if (handTaken.has(key)) return;
  handTaken.add(key);
  syncStateHold(key);
}

/**
 * Hands every by-hand slot back to its pattern - one click in the code releases all of them, not
 * just the one you were looking at. There is no per-slot release because there is no per-slot
 * gesture: you are either working in the code or you are working in a plugin.
 */
function releaseSlotsHeldByHand() {
  const keys = [...handTaken];
  handTaken.clear();
  for (const key of keys) syncStateHold(key);
  return keys.length;
}

/** A gesture in a plugin's own window: its slot is frozen from here until the capture is filed. */
function noteHandEdit(key) {
  uncaptured.set(key, { seq: ++editSeq, at: Date.now() });
  syncStateHold(key);
  return editSeq;
}

/** The editor saying a captured program has reached the code, by the sequence number it came with. */
function commitCapture(at) {
  const key = `${String(at?.trackId ?? '')}|${Number(at?.slot ?? 0)}`;
  // A knob turned while the last capture was being written left a NEWER one uncaptured, and the
  // report of the old one must not release it - that edit is still only in the plugin.
  if (uncaptured.get(key)?.seq !== Number(at?.seq)) return;
  uncaptured.delete(key);
  syncStateHold(key);
}

/** Drops captures that never made it into the code. Windows are not in here: one is closed, never
 * expired - see the section header. */
function expireStateHolds() {
  const now = Date.now();
  for (const [key, held] of uncaptured) {
    // A slot still waiting to be captured is not late, however long it has waited: deferred mode
    // holds captures for the whole of a performance on purpose, and thawing there would hand the
    // pattern a plugin whose sound is still only in the plugin - the one thing this prevents.
    if (autoPinDirty.has(key)) continue;
    if (now - held.at < UNCAPTURED_TTL_MS) continue;
    uncaptured.delete(key);
    console.log(`[auto-pin] ${key.slice(0, key.lastIndexOf('|'))} slot ${key.slice(key.lastIndexOf('|') + 1)}: the capture never reached the code - the slot goes back to its pattern`);
    syncStateHold(key);
  }
}

const autoPinReady = new Map(); // same key -> { trackId, slot, plugin, preset, state, seq } - editor drains it
// Sig#log() lines waiting for the editor to drain them (see init's setEventLogger). Capped, so a
// .log() left running with no browser attached can't grow without bound: the oldest lines go,
// which is the right end to lose - the interesting one is what just played.
const EVENT_LOG_MAX = 500;
const eventLogQueue = [];
let autoPinTimer = null;
let autoPinRun = null; // the capture pass in flight, so a flush can wait for it instead of racing

function handlePluginEdited(trackId, slot) {
  const key = `${trackId}|${slot}`;
  autoPinDirty.set(key, {
    trackId,
    slot,
    plugin: pluginInSlot(trackId, slot),
    preset: schedulers.get(trackId)?.livePreset(slot) ?? null,
  });
  // Frozen from the GESTURE, not from the capture: the swap that would overwrite this edit can come
  // round long before the debounce below has even fired (see the hand-editing section).
  noteHandEdit(key);
  clearTimeout(autoPinTimer);
  // In deferred mode, capture on the gesture only while the clock is frozen - nothing to interrupt.
  // A running clock leaves the slot dirty until something flushes it.
  if (AUTOPIN_MODE === 'immediate' || (transport?.paused ?? true)) {
    autoPinTimer = setTimeout(flushPluginCaptures, AUTOPIN_DEBOUNCE_MS);
  }
}

function pluginInSlot(trackId, slot) {
  return mappedEngine?.chains.get(trackId)?.[slot] ?? null;
}

/**
 * Capture every slot edited since the last flush. Safe to call at any time and from anywhere:
 * concurrent callers share the one pass (captures are serialized - each is a disk write in sclang,
 * and two writeProgram calls must not race for the same slot's temp file), and a slot that can't
 * be captured is logged rather than thrown, so a flush never fails the request it rides on.
 */
function flushPluginCaptures() {
  if (!autoPinRun) {
    autoPinRun = captureDirtyPlugins().finally(() => {
      autoPinRun = null;
    });
  }
  return autoPinRun;
}

async function captureDirtyPlugins() {
  if (!engine) return;
  while (autoPinDirty.size) {
    const [key, { trackId, slot, plugin, preset }] = autoPinDirty.entries().next().value;
    autoPinDirty.delete(key);
    // Reordering a chain moves which plugin a slot holds. A pending capture for slot 2 would then
    // read - and the editor would write - the wrong plugin's program, so drop it instead. The
    // plugin still holds the edit; touching it again captures it where it now lives.
    const now = pluginInSlot(trackId, slot);
    if (plugin && now !== plugin) {
      console.log(`[auto-pin] skipped ${trackId} slot ${slot}: it held ${plugin} when it was edited and holds ${now ?? 'nothing'} now`);
      continue;
    }
    try {
      const t0 = performance.now();
      const state = await engine.getPluginState(trackId, slot);
      const ms = performance.now() - t0;
      // Nearly all of this is the plugin serializing itself with its processing suspended - the
      // gzip on our side is off the event loop (see osc-engine). Worth logging when it's slow:
      // it's the only part of a capture anyone can hear.
      if (ms > AUTOPIN_SLOW_MS) {
        console.log(`[auto-pin] ${trackId} slot ${slot}: plugin took ${Math.round(ms)}ms to hand over its program`);
      }
      // Into the store, and the editor is handed the handle: a program is megabytes, and the
      // buffer it would be written into is copied on every autosave, checkpoint and eval (see
      // blobs.js). Nothing downstream can tell the difference - the scheduler compares states as
      // opaque strings, and the engine resolves the handle when it loads one.
      const handle = await blobs.putBlob(state);
      // The time the editor has to file this starts HERE, not at the gesture: in deferred mode the
      // capture itself may have been held back for a whole performance.
      const held = uncaptured.get(key);
      if (held) held.at = Date.now();
      autoPinReady.set(key, { trackId, slot, plugin, preset, state: handle, seq: held?.seq ?? 0 });
      // The state came *from* the plugin, so the next eval must not push it straight back:
      // tell the track's scheduler it's already applied. Without this, every eval would have
      // the plugin re-chew a state it already has (a reload, and an audible one on some).
      // Marked under the handle, because that is what the code the next eval reads will say.
      schedulers.get(trackId)?.markStateApplied(slot, mappedEngine?.chains.get(trackId)?.[slot], handle);
    } catch (e) {
      // Slot emptied, engine restarted mid-gesture, writeProgram refused - all recoverable and
      // all self-correcting on the next edit. Log once per slot so it's diagnosable.
      console.log(`[auto-pin] could not capture ${trackId} slot ${slot}: ${e.message ?? e}`);
      // Nothing will ever file this one, so it must not go on freezing the slot: the plugin's
      // window being open is the only reason left to, and the next edit captures again.
      uncaptured.delete(key);
      syncStateHold(key);
    }
  }
}

// Pruning is housekeeping, not part of answering the request: it runs after a delay, coalesced,
// so a burst of evals prunes once and never between the notes of one.
let pruneTimer = null;
function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    // Oldest first, then the states they were holding alive: a knob held for a minute is a hundred
    // captures and a hundred stored programs, and the ones no session and no history entry mentions
    // any more are simply gone (see blobs.js). Ordered, not raced - a session or snapshot deleted
    // after the sweep read it would leave its states behind until the next round, which is harmless
    // but pointless.
    Promise.resolve(expireWipSessions())
      .then(() => pruneSnapshots())
      .then(() => blobs.sweepBlobs({ scanDirs: [WIP_DIR, SNAPSHOT_DIR], alsoKeep: [...liveStateIds] }))
      .then(({ deleted, freed }) => {
        if (deleted) console.log(`[poptart] released ${deleted} captured plugin state(s), ${(freed / 1048576).toFixed(1)}MB`);
      })
      .catch((e) => console.error(`[poptart] snapshot prune failed: ${e.message ?? e}`));
  }, 30000).unref();
}

// Handles the editor's live buffer mentions, held out of the sweep by name rather than by age.
// Refreshed from both places the server sees that buffer - the eval request and the autosave - so
// a state stays safe from the moment it is written into the code, whether or not it has reached a
// file yet.
let liveStateIds = new Set();

// The retention policy, if the settings tab has been asked for one: session files older than
// `wipRetentionMonths` go, which is also what lets the state store shrink (a session pins the
// states it names). Off unless set, and off is the default - a session file is the recovery net
// for work that was never named, and how long that is worth keeping isn't the app's call.
function expireWipSessions() {
  const months = Number(settings.wipRetentionMonths ?? 0);
  if (!(months > 0)) return;
  const { deleted, freed } = pruneWipSessions(months);
  if (deleted) {
    console.log(`[poptart] expired ${deleted} session(s) older than ${months} month(s), ${(freed / 1048576).toFixed(1)}MB`);
  }
}

// ---------------------------------------------------------------------------------------------
// API handlers, keyed "METHOD /path" and dispatched by the plumbing at the bottom of the file.
// ---------------------------------------------------------------------------------------------

const routes = {
  'GET /api/status': async () => ({
    status: 200,
    // `scale` is whatever setscale() last set (the prebake may have, before any eval), so a fresh
    // page load already knows the key its piano roll should be drawing.
    body: { loaded: !!engine, error: engineError, scale: patternCore ? patternCore.globalScale() : null },
  }),

  // Both plugin-list endpoints run through the prefer-VST3 filter (settings tab, default on):
  // a VST2 entry is hidden when a VST3 with the same name exists. The scan itself still probes
  // everything, and an exact `.synth("Name.vst")` id still loads - this only shapes the list
  // the browser and autocomplete see.
  'POST /api/scanPlugins': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const result = await engine.scanPlugins(body.extraPaths ?? []);
    if (settings.preferVst3 !== false) result.plugins = preferVst3(result.plugins);
    return { status: 200, body: result };
  },

  'GET /api/knownPlugins': async () => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const plugins = await engine.getKnownPlugins();
    return { status: 200, body: settings.preferVst3 !== false ? preferVst3(plugins) : plugins };
  },

  'GET /api/midiDevices': async () => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getMidiDevices() };
  },

  // Sample packs on disk - one folder per pack under the samples root (see osc-engine's
  // samples.js). Files come back in the same filename-sorted order the sampler indexes them
  // in, so a file's position in the list is its `s("pack:idx")` index. Reads the filesystem
  // directly rather than going through the engine, so it works even before the engine is up.
  'GET /api/samples': async () => {
    const { samplesRoot, listPackFiles } = require('@poptart/osc-engine/samples');
    const root = samplesRoot();
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      // missing root = no packs, not an error
    }
    const packs = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => ({ name: e.name, files: (listPackFiles(e.name) ?? []).map((f) => path.basename(f)) }))
      .filter((p) => p.files.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, body: { root, packs } };
  },

  // The sample-library folder shown/edited in the settings tab. `envOverride` is true when
  // POPTART_SAMPLES_DIR is set, in which case the saved folder is ignored until it's unset.
  'GET /api/samplesDir': async () => {
    const { samplesRoot } = require('@poptart/osc-engine/samples');
    return {
      status: 200,
      body: { dir: samplesRoot(), envOverride: !!process.env.POPTART_SAMPLES_DIR },
    };
  },

  // Filesystem folder browser for the settings-tab folder picker. Query `path` is the folder to
  // list (absolute, or ~-relative; defaults to home); returns its immediate subfolders plus its
  // parent so the client can navigate up. Hidden (dot) folders are included on purpose - the
  // default library lives in ~/.poptart. Only ever lists one directory (never recurses), so this
  // stays cheap. If the requested folder doesn't exist or can't be read (e.g. the default
  // ~/.poptart/samples on a fresh install), it walks up to the nearest readable ancestor and
  // lists that instead, so the picker always opens somewhere navigable rather than an error.
  'GET /api/browseDir': async (query) => {
    const raw = (query.path || '').trim();
    const expanded = raw.startsWith('~')
      ? path.join(os.homedir(), raw.slice(1))
      : (raw || os.homedir());
    const listDir = (d) => fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(d, e.name)).isDirectory(); } catch { return false; }
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    let dir = path.resolve(expanded);
    let dirs;
    for (;;) {
      try { dirs = listDir(dir); break; } catch {
        const up = path.dirname(dir);
        if (up === dir) break; // reached the filesystem root; give up
        dir = up;
      }
    }
    if (!dirs) throw new Error(`can't read ${path.resolve(expanded)}`);
    const parent = path.dirname(dir);
    return { status: 200, body: { path: dir, parent: parent === dir ? null : parent, dirs } };
  },

  // Prefer-VST3 toggle (settings tab). Default on; body: { enabled }. Applied on the next
  // plugin-list fetch - no rescan needed, the filter sits on the endpoints above.
  'GET /api/preferVst3': async () => ({
    status: 200,
    body: { enabled: settings.preferVst3 !== false },
  }),

  'POST /api/preferVst3': async (body) => {
    settings.preferVst3 = !!body.enabled;
    saveSettings();
    return { status: 200, body: { enabled: settings.preferVst3 } };
  },

  // Body: { dir } - a folder path, or null/"" to reset to the default (~/.poptart/samples).
  // Persisted and applied immediately; the next `s(...)` eval reads packs from the new root.
  'POST /api/samplesDir': async (body) => {
    const { setSamplesRoot, samplesRoot } = require('@poptart/osc-engine/samples');
    const dir = body.dir ? String(body.dir).trim() : null;
    settings.samplesDir = dir;
    setSamplesRoot(dir);
    saveSettings();
    return { status: 200, body: { dir: samplesRoot(), envOverride: !!process.env.POPTART_SAMPLES_DIR } };
  },

  // `code` is the whole editor buffer: one or more labeled blocks (see pattern-core's
  // labels.mjs - `$:` anonymous, `name:` named, `_name:` muted, `Sname:` soloed), each
  // evaluating to a Sig and playing on its own engine track named after the label. Unlabeled
  // code is treated as a single anonymous block, so the original one-expression usage still
  // works.
  'POST /api/evaluate': async (body) => {
    if (!engine || !mappedEngine) throw new Error(engineError ?? 'engine not loaded');

    // Whatever you last moved in a plugin's own window is captured here, before anything else:
    // this eval may reload the very plugin holding the only copy of that tweak, and it is the
    // moment the code has to describe the sound anyway (see the auto-pin section).
    await flushPluginCaptures();

    const blocks = patternCore.splitLabeledBlocks(body.code ?? '');
    if (blocks.length === 0) throw new Error('nothing to evaluate');
    liveStateIds = blobs.referencedIds(body.code ?? ''); // this buffer's states are in use

    // Rewind the random builders' seed counter before building anything, so choose()/irand()
    // seeds are a function of position in the buffer rather than of how many times this server
    // has evaluated. Without it every re-eval re-rolls the take, and since /api/stop rewinds the
    // clock to cycle 0, stop-then-play would come back as a different performance of the same
    // code. Blocks are built below in document order, which is what makes the seeds stable.
    patternCore.resetRandomSeeds();

    // Roll definitions are rebuilt from the buffer every time, for the reason the track teardown
    // below exists: a roll(...) call you just deleted has to stop being playable. Prebake's layer
    // is untouched - it is a library, not part of this buffer.
    patternCore.clearRolls();

    // Fresh copy of the prebake bindings each eval: they're the starting scope for the buffer,
    // and a redeclared name in the buffer overrides the copy without clobbering the original.
    const evalBlock = makeBlockEvaluator(new Map(prebakeDefs));

    // setscale is HOISTED: every block that is nothing but a `setscale(...)` call runs here, in
    // document order, before any pattern is built - so the LAST one in the buffer is the key the
    // whole buffer plays in, and a `.sc()` pattern written ABOVE it follows it too. A hoisted call
    // that can't run out of order (its argument comes from a `const` declared further up) is left
    // alone and simply runs in its own position, where it always did.
    const hoisted = new Map(); // block -> its value, so the in-order pass below doesn't run it twice
    for (const b of blocks) {
      if (!patternCore.isBareCallBlock(b.code, 'setscale')) continue;
      try {
        evalBlock(b.code, b.start);
        hoisted.set(b, SCALE_BLOCK);
      } catch {
        // not evaluable up here - it keeps its place in the pass below (and reports errors there)
      }
    }

    const evaluated = blocks.map((b) => {
      try {
        const value = hoisted.has(b) ? hoisted.get(b) : evalBlock(b.code, b.start);
        if (value instanceof patternCore.Sig) {
          dryRunPattern(value);
        } else if (value !== TEMPO_BLOCK && value !== SCALE_BLOCK && !b.label.startsWith('$')) {
          // Only an explicitly *named* block promises sound. Anything anonymous (bare code
          // outside labels, or `$:`) that doesn't produce a pattern is a setup block, Strudel-
          // style: declarations shared with the blocks below (const kb = midikeys("...")),
          // language extensions (Signal.prototype.co = ...), one-off side effects - whatever
          // it evaluated to is simply not played.
          throw new Error('must evaluate to a pattern (e.g. n("0 2 3").scale("F minor").synth("Serum 2"))');
        }
        return { ...b, sig: value };
      } catch (err) {
        throw new Error(`${b.label}: ${err.message ?? err}`);
      }
    });
    // Tempo-only and definitions-only blocks act at eval time and don't become tracks.
    // A block of roll(...) definitions evaluates to its last definition, which is a real Sig but
    // not a track - playing it would turn the definitions block into an extra voice (see
    // signal.mjs's isDef). Anything derived from one (`roll(0, "…").synth(…)`) has lost the mark
    // and plays as normal.
    const built = evaluated.filter((b) => b.sig instanceof patternCore.Sig && !b.sig.isDef);

    // Solo wins over everything except mute: if anything is soloed, only soloed patterns play.
    const anySolo = built.some((b) => b.soloed && !b.muted);
    const active = built.filter((b) => !b.muted && (!anySolo || b.soloed));

    // Stop tracks whose label disappeared (or that are now muted / un-soloed).
    for (const [label, sch] of schedulers) {
      if (!active.some((b) => b.label === label)) {
        sch.stop();
        schedulers.delete(label);
        mappedEngine.removeChain(label);
      }
    }

    // Playback (re)starts: un-freeze the clock. After a stop it sits at cycle 0, so every
    // pattern comes in from the top of the grid; mid-performance evals are a no-op here.
    // `start: false` (the editor's "Update" button) evaluates without touching the clock: a
    // stopped clock stays frozen (patterns load silently), a running one keeps running.
    if (active.length > 0 && body.start !== false) transport.start();

    for (const b of active) {
      // The wrapper needs to know which plugin sits in each slot to pick the right mapping file.
      mappedEngine.setChain(b.label, [b.sig.instrument, ...b.sig.fxChain]);
      let sch = schedulers.get(b.label);
      if (!sch) {
        sch = new patternCore.Scheduler(mappedEngine, { transport, trackId: b.label });
        schedulers.set(b.label, sch);
      }
      // Hand-edit freezes go on BEFORE the pattern does: setPattern pushes any pinned `{ state }`,
      // and a slot whose plugin is being edited must not have a stored program pushed into it (see
      // the hand-editing section). Re-asserted here because a Scheduler is rebuilt whenever its
      // label comes back, and unlike a preset hold this sends nothing - it only holds things off.
      for (const slot of stateHeldSlotsFor(b.label)) sch.holdPluginState(slot, true);
      sch.setPattern(b.sig);
      for (const [key, held] of presetHolds) {
        const at = key.lastIndexOf('|');
        if (key.slice(0, at) === b.label) sch.holdPreset(Number(key.slice(at + 1)), held.preset);
      }
      sch.start();
    }

    // Any midicc()/midikeys() seen at eval time needs MIDI input running engine-side. The
    // native paths (setParamCC/setMidiNotes) enable it themselves; this covers Tier-1-only
    // use (a cc signal inside arithmetic), whose JS-side sampling needs the /poptart/midiIn
    // feed. Idempotent, so re-sending every eval is fine.
    if (patternCore.midiInUse()) engine.enableMidi();

    // Re-arm conf capture engine-side: sclang keeps the flag on its track object, which an
    // engine restart discards - the eval that recreates the track re-sends it. Idempotent.
    if (conf && active.some((b) => b.label === conf.trackId)) engine.setConfMode(conf.trackId, true);

    // Which tracks the browser should route computer-keyboard input to (keyboard()/tap()).
    const keyboardTracks = syncKbTracks(active);

    // Refresh the highlight-grid source set to this eval's active tracks, and ship each active
    // track's first window inline so playback lights up immediately without a follow-up request.
    hlTracks.clear();
    for (const b of active) hlTracks.set(b.label, { sig: b.sig, start: b.start, end: b.end });
    const gridFrom = currentGridCycle();

    return {
      status: 200,
      body: {
        cps: transport.cps,
        transport: transport.snapshot(),
        scale: patternCore.globalScale(), // what setscale() left in force - the piano roll colours by it
        keyboardTracks,
        gridFrom,
        gridCount: HL_WINDOW,
        tracks: built.map((b) => ({
          label: b.label,
          muted: b.muted,
          soloed: b.soloed,
          active: active.includes(b),
          start: b.start,
          end: b.end,
          instrument: b.sig.instrument,
          fxChain: b.sig.fxChain,
          paramNames: Object.keys(b.sig.paramSignals),
          keyboard: b.sig.keyboardRoute?.kind ?? null,
          grid: active.includes(b) ? highlightGrid(b.sig, b.start, b.end, gridFrom, HL_WINDOW) : null,
        })),
      },
    };
  },

  // Playback-highlight top-up. Patterns that vary per cycle (`<…>`, r/i, degrade, choice) outrun
  // the window shipped with /api/evaluate; the browser requests the next window as its clock nears
  // the end of what it has. Query: { from, count? }. Returns the same per-track grid shape, for the
  // still-active tracks of the last eval - deterministic, so it matches what /api/evaluate sent.
  // What roll ids are playable right now. The buffer's own definitions the editor can read for
  // itself; this is how it learns about the prebake library, which is nowhere in the buffer.
  // Every handler returns { status, body } - this one didn't, so it 500'd on every call and the
  // picker's library list was quietly always empty.
  'GET /api/rolls': async () => ({
    status: 200,
    body: { rolls: patternCore.rollIds(), shapes: patternCore.shapeIds(), presets: patternCore.presetIds() },
  }),

  'GET /api/highlight': async (q) => {
    const from = Math.max(0, Math.floor(Number(q.from)) || 0);
    const count = Math.min(HL_WINDOW * 4, Math.max(1, Math.floor(Number(q.count)) || HL_WINDOW));
    const tracks = [...hlTracks.entries()].map(([label, t]) => ({
      label,
      grid: highlightGrid(t.sig, t.start, t.end, from, count),
    }));
    return { status: 200, body: { gridFrom: from, gridCount: count, tracks } };
  },

  'POST /api/stop': async () => {
    for (const sch of schedulers.values()) sch.stop();
    // Release any live-keyboard notes still held so nothing rings through the stop. The tracks
    // stay armed (kbTracks intact) - a live keyboard isn't sequenced, so it keeps playing after
    // stop until the pattern is removed or re-evaluated.
    for (const id of kbTracks.keys()) releaseKbNotes(id);
    // Reset the shared clock to cycle 0 and freeze it - the next eval starts from the top.
    transport?.stop();
    // Now that nothing is playing, any plugin edit held back during the performance is free to
    // capture (the suspension it costs has nothing left to interrupt).
    flushPluginCaptures();
    return { status: 200, body: { transport: transport?.snapshot() ?? null } };
  },

  // A live computer-keyboard note edge from the browser (keyboard()/tap() tracks). Body:
  // { trackId, note, vel, isOn }. Routed straight to the instrument like a scheduled note, so
  // env()/lfo() shapes gate the same way; also fed to the MIDI recorder so typed takes record.
  // Ignored for a track that isn't currently a keyboard target (a stale key-up after re-eval).
  'POST /api/keyNote': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = String(body.trackId ?? '');
    if (!kbTracks.has(trackId)) return { status: 200, body: { ok: false, reason: 'not a keyboard track' } };
    const note = Math.round(Number(body.note));
    if (!Number.isFinite(note)) throw new Error('keyNote: note must be a number');
    const isOn = !!body.isOn;
    const now = engine.getTime();
    let held = kbHeld.get(trackId);
    if (!held) kbHeld.set(trackId, (held = new Set()));
    if (isOn) {
      const vel = Math.max(0, Math.min(1, Number(body.vel ?? 1)));
      if (vel <= 0) return { status: 200, body: { ok: true } };
      // Retrigger a re-pressed key cleanly (some layouts fire keydown without an intervening
      // keyup); the browser suppresses auto-repeat, so a real double-down means a new hit.
      if (held.has(note)) engine.noteOff(trackId, note, now);
      engine.noteOn(trackId, note, vel, now);
      held.add(note);
      handleMidiNoteIn(trackId, note, vel, true);
    } else {
      if (!held.has(note)) return { status: 200, body: { ok: true } };
      engine.noteOff(trackId, note, now);
      held.delete(note);
      handleMidiNoteIn(trackId, note, 0, false);
    }
    return { status: 200, body: { ok: true } };
  },

  // A one-off audition note from the piano roll editor. Body: { trackId, note, vel, isOn }. Unlike
  // keyNote this isn't gated on a keyboard()/tap() route - it plays straight on whatever track the
  // pianoroll(...) block built, so the note previews through that track's own synth. If the track
  // hasn't been evaluated (no instrument loaded), the engine call simply makes no sound.
  'POST /api/previewNote': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = String(body.trackId ?? '');
    const note = Math.round(Number(body.note));
    if (!trackId || !Number.isFinite(note)) return { status: 200, body: { ok: false } };
    const now = engine.getTime();
    if (body.isOn) {
      const vel = Math.max(0, Math.min(1, Number(body.vel ?? 0.8)));
      if (vel > 0) engine.noteOn(trackId, note, vel, now);
    } else {
      engine.noteOff(trackId, note, now);
    }
    return { status: 200, body: { ok: true } };
  },

  // Introspection: real parameter names of the plugin in a track slot. Body: { trackId, slot }.
  'POST /api/params': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getParams(body.trackId ?? 'default', body.slot ?? 0) };
  },

  // Parameter lists for every plugin in the currently-evaluated chain, for the editor's
  // autocomplete and params panel. Loading a plugin is fire-and-forget (the eval response
  // doesn't wait for it), so a slot whose plugin is still opening is retried for a while
  // before giving up - the client calls this in the background right after an eval.
  'GET /api/chainParams': async () => {
    if (!engine || !mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    const slots = [];
    for (const [trackId, chain] of mappedEngine.chains) {
      for (let slot = 0; slot < chain.length; slot++) {
        const plugin = chain[slot];
        if (!plugin) continue;
        if (!paramsByPlugin.has(plugin)) {
          try {
            paramsByPlugin.set(plugin, await getParamsWhenLoaded(trackId, slot));
          } catch (err) {
            slots.push({ track: trackId, slot, plugin, params: [], error: err.message ?? String(err) });
            continue;
          }
        }
        slots.push({ track: trackId, slot, plugin, params: paramsByPlugin.get(plugin) });
      }
    }
    return { status: 200, body: { slots } };
  },

  // Auto-pin drain (see captureDirtyPlugins): the plugin states captured since the last poll, for
  // the editor to write into their synth/fx calls as `{ state }` - or, when the slot was on a
  // named preset at the time, into that preset's definition instead (see writePluginState).
  // Draining on read means a
  // slot the editor already wrote isn't written again; a slot edited since is still pending
  // capture and arrives on a later poll. `logs` rides along on the same drain - the .log() event
  // lines fired since the last poll, in order, for the in-app console.
  'POST /api/pluginEdits': async (body) => {
    // `flush: true` means the editor is about to write the buffer out somewhere it matters -
    // saving, exporting, copying a share link - so a plugin edit still held back gets captured
    // now rather than writing out a stale state. The 500ms poll never asks for this.
    if (body?.flush) await flushPluginCaptures();
    // The preset panel's lease rides along on this poll rather than on a timer of its own - one
    // request either way, and a browser that stops polling releases what it was holding.
    if (body?.hold) setPresetHold(String(body.hold.trackId ?? ''), Number(body.hold.slot ?? 0), String(body.hold.preset ?? ''));
    expirePresetHolds();
    // Hand editing, both halves, on the same poll and for the same reason (see that section):
    // `editing` renews the lease on every plugin window the editor has open, and `committed` says
    // which captures have reached the code - by sequence number, so the report of one capture can
    // never release a knob turned after it.
    for (const at of body?.committed ?? []) commitCapture(at);
    expireStateHolds();
    const logs = eventLogQueue.splice(0, eventLogQueue.length);
    const edits = [...autoPinReady.values()];
    autoPinReady.clear();
    // Slots deliberately left uncaptured (deferred mode, mid-performance), so the editor can say so
    // once rather than leave a plugin tweak looking like it went unnoticed. In immediate mode a
    // dirty slot is merely one whose debounce hasn't fired yet - nothing worth announcing.
    const holding = AUTOPIN_MODE === 'deferred' && !(transport?.paused ?? true) ? autoPinDirty.size : 0;
    // What is held right now, every poll, so the editor can draw it on the code and stop lighting
    // names that are not playing. Sent whole rather than as changes: it is a handful of entries,
    // and a poll that drops (or a tab that reloads) then costs nothing to recover from.
    return { status: 200, body: { edits, logs, pending: holding, holds: currentHolds() } };
  },

  // Hold one chain slot on a named preset while the editor's preset panel is open on it, so what
  // you hear is what you are editing (see Scheduler#holdPreset). Body: { trackId, slot, preset },
  // preset null to release. A preset is edited by turning the plugin's own knobs, so this is not a
  // convenience: without it a `.preset("<a b>")` swaps the sound out from under the edit.
  'POST /api/presetHold': async (body) => {
    const trackId = String(body?.trackId ?? '');
    const slot = Number(body?.slot ?? 0);
    const name = body?.preset == null ? null : String(body.preset);
    // Picking one in the panel is a deliberate "let me hear this", so it loads even over a plugin
    // you have been turning knobs in (see the hand-editing section) - but never before those knobs
    // have been captured, or the capture would read the preset you switched TO and file it under
    // the one you switched from. Only a real change pays for the capture; the poll's heartbeat
    // goes through the same function without this route.
    if (name != null && presetHolds.get(`${trackId}|${slot}`)?.preset !== name) await flushPluginCaptures();
    const why = setPresetHold(trackId, slot, name, { force: true });
    return { status: 200, body: { held: name, why } };
  },

  // Pop open the native editor window of the plugin in a chain slot (design your supersaw in
  // Serum's own UI, then livecode the modulation). Body: { trackId, slot }.
  'POST /api/showEditor': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = body.trackId ?? 'default';
    const slot = body.slot ?? 0;
    engine.showPluginEditor(trackId, slot);
    // The window is up, so the slot's program is yours to change from here: take it now rather than
    // on the editor's next poll, or a swap in between would change the preset out from under the
    // window you just opened - and a knob turned after that would land in the wrong preset.
    takeSlotByHand(trackId, slot);
    return { status: 200, body: {} };
  },

  // "I'm back in the code" - the editor sends this on a click in the buffer, and every slot being
  // held by hand goes back to its pattern (see the hand-editing section). No body: a click is not
  // about one slot, it is about which of the two places you are working in.
  'POST /api/releaseEditors': async () => ({ status: 200, body: { released: releaseSlotsHeldByHand() } }),

  // Turn "conf" (configure) capture on/off for a track (see handleParamAutomated). Only one
  // track configures at a time; turning it on for a track supersedes any previous one. Body:
  // { trackId, on }.
  'POST /api/confMode': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = body.trackId ?? 'default';
    if (conf && conf.trackId !== trackId) engine.setConfMode(conf.trackId, false); // release the previous track
    conf = body.on ? { trackId, touched: new Map(), seen: new Set() } : null;
    engine.setConfMode(trackId, !!body.on);
    return { status: 200, body: { on: !!body.on, trackId } };
  },

  // Drain the parameters touched since the last poll while conf mode is on: the editor polls this
  // and writes each into the code. Returns latest-value-per-param (coalesced), then clears, so a
  // knob swept between polls lands once at its final position. Body: { trackId }.
  'POST /api/confPending': async (body) => {
    const trackId = body.trackId ?? 'default';
    if (!conf || conf.trackId !== trackId) return { status: 200, body: { active: false, params: [] } };
    const params = [...conf.touched.values()];
    conf.touched.clear();
    return { status: 200, body: { active: true, params } };
  },

  // --- pattern files (the editor's "files" tab) ---

  // Query: { q } - free text matched against name, @title, @by, @tags and the code itself
  // (`tag:techno`, `by:aria` restrict a term to one field). Returns named saves and
  // work-in-progress sessions separately, newest first. Searching happens here rather than in
  // the browser because it reads file contents.
  'GET /api/patterns': async (query) => {
    const q = query?.q ?? '';
    const keep = (entries) => entries
      .filter((e) => matchesQuery(e, q))
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ code, ...rest }) => rest); // the buffer was only needed for searching
    return { status: 200, body: { patterns: keep(listSavedPatterns()), wip: keep(listWipPatterns()) } };
  },

  // Body: { name, code }. Overwrites silently - "save" in a livecoding tool means "keep this".
  //
  // Written HYDRATED: a saved pattern is a file someone can hand to someone else, or drop into
  // another machine's patterns folder, so it carries its captured plugin states in full rather
  // than handles into a store that machine hasn't got (see blobs.js).
  'POST /api/patterns/save': async (body) => {
    const file = patternFilePath(body.name);
    const { code, missing } = await blobs.hydrate(String(body.code ?? ''));
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.writeFileSync(file, code, 'utf8');
    // Saved anyway: the patch is worth more than the states it couldn't fill in, and the handles
    // are still in the file - if the store turns up, so do the sounds. But say so.
    return { status: 200, body: { missingStates: missing.length } };
  },

  // Body: { name } -> { code }. The file holds its states in full; the editor is given handles in
  // their place, so the buffer it copies on every keystroke stays kilobytes (see blobs.js). The
  // states themselves are put in the store on the way past, which is also how a patch from another
  // machine gets its programs in here.
  'POST /api/patterns/load': async (body) => {
    const file = patternFilePath(body.name);
    if (!fs.existsSync(file)) throw new Error(`no saved pattern named "${body.name}"`);
    const { code } = await blobs.dehydrate(fs.readFileSync(file, 'utf8'));
    return { status: 200, body: { code } };
  },

  // Body: { name }.
  'POST /api/patterns/delete': async (body) => {
    const file = patternFilePath(body.name);
    if (!fs.existsSync(file)) throw new Error(`no saved pattern named "${body.name}"`);
    fs.unlinkSync(file);
    return { status: 200, body: {} };
  },

  // Body: { from, to }.
  'POST /api/patterns/rename': async (body) => {
    const from = patternFilePath(body.from);
    const to = patternFilePath(body.to);
    if (!fs.existsSync(from)) throw new Error(`no saved pattern named "${body.from}"`);
    if (fs.existsSync(to)) throw new Error(`a pattern named "${body.to}" already exists`);
    fs.renameSync(from, to);
    return { status: 200, body: {} };
  },

  // --- work in progress (the editor autosaves the live buffer here; see wipFilePath) ---

  // Body: { id, code }. Called on a debounce while typing, so it must stay cheap and must never
  // be the thing that interrupts a jam - a blank buffer deletes the session file instead of
  // leaving an empty one behind, and that's the only way a WIP file is removed automatically.
  // Autosave fires every second or so while the user types, and this process also runs the
  // pattern scheduler - so the write is async. Synchronously writing a buffer carrying captured
  // plugin state is milliseconds the scheduler spends not sending notes, against a 150ms
  // lookahead, several times a minute.
  'POST /api/patterns/wip/save': async (body) => {
    const file = wipFilePath(body.id);
    // Machine-local scratch, so it keeps handles - and a buffer that somehow holds states in full
    // (a pasted patch) gives them up here rather than being written out at that size every second
    // or so. This is the write that left 519MB of autosaves on one month of playing.
    const { code } = await blobs.dehydrate(String(body.code ?? ''));
    // The freshest sighting of what the editor is holding, and a complete one - this is the whole
    // buffer - so it replaces rather than adds. It fires a second after a capture is written into
    // the code, where an eval can be an hour later, which is what makes it safe for the sweep's age
    // floor to be short.
    liveStateIds = blobs.referencedIds(code);
    if (!code.trim()) {
      await fs.promises.unlink(file).catch(() => {}); // already gone is the wanted state
      return { status: 200, body: { saved: false } };
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, code, 'utf8');
    return { status: 200, body: { saved: true } };
  },

  // Code snapshots - what the editor's URL points at (see snapshots.js). The buffer used to be
  // base64'd into the hash itself, which put a megabyte-URL pushState in front of every eval.
  // Body: { code } -> { id }.
  'POST /api/snapshot': async (body) => {
    // Handles, like the wip autosave and for the same reason: a snapshot is one checkpoint of a
    // buffer that is machine-local by definition (its id means nothing anywhere else).
    const { code } = await blobs.dehydrate(String(body.code ?? ''));
    const id = await putSnapshot(code);
    schedulePrune();
    return { status: 200, body: { id } };
  },

  // Query: { id } -> { code } - or { code: null } for a state pruned away or from another
  // machine, which the editor reports rather than treating as an empty buffer.
  'GET /api/snapshot': async (q) => {
    const code = await getSnapshot(q.id);
    // Snapshots written before the store existed hold their states in full - they are stored on the
    // way back out, so walking Back through old history entries lightens them as it goes.
    return { status: 200, body: { code: code == null ? null : (await blobs.dehydrate(code)).code } };
  },

  // Body: { id } -> { code }. Dehydrated like the saved-pattern load, for the sessions recorded
  // before the store existed.
  'POST /api/patterns/wip/load': async (body) => {
    const file = wipFilePath(body.id);
    if (!fs.existsSync(file)) throw new Error(`no work-in-progress session "${body.id}"`);
    const { code } = await blobs.dehydrate(fs.readFileSync(file, 'utf8'));
    return { status: 200, body: { code } };
  },

  // Body: { id }.
  'POST /api/patterns/wip/delete': async (body) => {
    const file = wipFilePath(body.id);
    if (!fs.existsSync(file)) throw new Error(`no work-in-progress session "${body.id}"`);
    fs.unlinkSync(file);
    return { status: 200, body: {} };
  },

  // The editor's own two crossings of the same line the routes above handle for it.
  //
  // Body: { code } -> { code, missing } - captured states filled back in, for the file the export
  // action hands to the browser. `missing` names handles this store hasn't got, which the editor
  // reports rather than passing off a patch with silent holes in it as the whole thing.
  'POST /api/blobs/hydrate': async (body) => {
    const { code, missing } = await blobs.hydrate(String(body?.code ?? ''));
    return { status: 200, body: { code, missing } };
  },

  // Body: { code } -> { code, stored } - the reverse, for a patch arriving from outside (an
  // imported file, a pasted buffer): its states go into the store and the editor gets handles.
  'POST /api/blobs/dehydrate': async (body) => {
    const { code, stored } = await blobs.dehydrate(String(body?.code ?? ''));
    return { status: 200, body: { code, stored } };
  },

  // Query: { id } -> { bytes } - what one stored state weighs, which the buffer can no longer say
  // now that it only holds the handle. `bytes: null` for one this store hasn't got.
  'GET /api/blobs/stat': async (q) => {
    const state = await blobs.getBlob(q?.id);
    return { status: 200, body: { bytes: state == null ? null : state.length } };
  },

  // --- prebake (the settings tab's "edit prebake" panel; see runPrebake) ---

  'GET /api/prebake': async () => ({ status: 200, body: { code: readPrebakeFile() } }),

  // Body: { code }. Overwrites prebake.js and re-runs all prebake sources immediately, so an edit
  // applies without a restart. Returns per-block errors (empty on success) for the editor to show.
  // (Removing a Signal.prototype extension still needs a restart - the prototype keeps it.)
  'POST /api/prebake': async (body) => {
    fs.mkdirSync(path.dirname(PREBAKE_FILE), { recursive: true });
    fs.writeFileSync(PREBAKE_FILE, String(body.code ?? ''), 'utf8');
    return { status: 200, body: { errors: runPrebake() } };
  },

  // --- MIDI record (see the "MIDI record" section above) ---

  // Arm a recording. Body: { cycles, grid } - grid is slots per cycle (16 = sixteenth notes at
  // 4 beats/cycle), 0 = unquantized. Starts at the next 4-cycle phrase boundary; the response
  // carries start/end cycles + a transport snapshot so the editor renders the count-in locally.
  'POST /api/midiRecord/start': async (body) => {
    if (!engine || !transport) throw new Error(engineError ?? 'engine not loaded');
    if (midiRec && midiRec.phase !== 'done') throw new Error('a MIDI recording is already armed or running - cancel it first');
    const cycles = Math.min(64, Math.max(1, Math.round(Number(body.cycles) || 4)));
    const grid = Math.max(0, Math.round(body.grid == null ? 16 : Number(body.grid) || 0));
    const startCycle = (Math.floor(transport.cycleAt(engine.getTime()) / PHRASE_CYCLES) + 1) * PHRASE_CYCLES;
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = {
      phase: 'armed',
      startCycle,
      endCycle: startCycle + cycles,
      cycles,
      grid,
      held: new Map(),
      events: new Map(),
      results: null,
      timer: setInterval(midiRecTick, 50),
    };
    return { status: 200, body: midiRecStatus() };
  },

  'GET /api/midiRecord/status': async () => ({ status: 200, body: midiRecStatus() }),

  // Abort an armed/running recording, or acknowledge a finished one (clears its results).
  'POST /api/midiRecord/cancel': async () => {
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = null;
    return { status: 200, body: {} };
  },

  // Bounce the master bus to a WAV. Body: { path, seconds }.
  'POST /api/record': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.record(body.path, body.seconds ?? 4) };
  },

  // --- track record (see the "Track record" section above) ---

  // Open/close a track's meter tap. Body: { label, on }. The editor calls this when a .record()
  // panel opens and closes; it's what makes the panel's meter live before anything is armed.
  'POST /api/trackRecord/tap': async (body) => {
    const label = String(body.label ?? '').trim();
    if (!label) throw new Error('trackRecord/tap needs a block label');
    setRecTap(label, body.on !== false);
    return { status: 200, body: trackRecStatus() };
  },

  // Arm a bounce of one labeled block. Body: { label, cycles, name, wrapTail }. Starts at the next
  // phrase boundary that leaves room for the pre-roll; the response carries the start/end cycles so
  // the editor can draw the count-in against its own copy of the transport.
  'POST /api/trackRecord/start': async (body) => {
    if (!engine || !transport) throw new Error(engineError ?? 'engine not loaded');
    if (trackRec && trackRec.phase !== 'done') throw new Error('a bounce is already armed or running - cancel it first');
    const label = String(body.label ?? '').trim();
    if (!label) throw new Error('trackRecord/start needs a block label');
    if (!schedulers.has(label)) throw new Error(`"${label}" isn't playing - only a live block can be bounced`);
    const cycles = Math.min(128, Math.max(1, Math.round(Number(body.cycles) || 4)));

    // Arm for the next phrase boundary far enough out that the pre-roll is still in the future -
    // otherwise the engine would clamp the start to "now" and the trim would cut in the wrong place.
    const now = engine.getTime();
    let startCycle = (Math.floor(transport.cycleAt(now) / PHRASE_CYCLES) + 1) * PHRASE_CYCLES;
    while (transport.secAt(startCycle) - now < REC_MIN_LEAD_SEC) startCycle += PHRASE_CYCLES;
    const startSec = transport.secAt(startCycle);
    const endSec = transport.secAt(startCycle + cycles);

    if (trackRec?.timer) clearInterval(trackRec.timer);
    trackRec = {
      phase: 'armed',
      label,
      cycles,
      startCycle,
      endCycle: startCycle + cycles,
      startSec,
      endSec,
      name: String(body.name ?? '').trim(),
      wrapTail: body.wrapTail === true,
      capture: recordings.captureFile(label),
      result: null,
      error: null,
      timer: setInterval(trackRecTick, 50),
    };

    // The capture path identifies THIS bounce: a reply that arrives after the user cancelled and
    // started another must not finalize (or clobber) the newer one.
    const capture = trackRec.capture;
    // The tap has to be up before the window opens; a panel may already have opened it.
    engine.tapTrack(label, true);
    engine
      .recordTrack(label, trackRec.capture, startSec - REC_PRE_ROLL_SEC, endSec + REC_POST_ROLL_SEC)
      .then((wrote) => {
        if (trackRec?.capture === capture) finalizeTrackRec(wrote);
      })
      .catch((err) => {
        if (trackRec?.capture !== capture) return; // superseded by a newer bounce
        clearInterval(trackRec.timer);
        trackRec.timer = null;
        trackRec.error = err.message ?? String(err);
        trackRec.phase = 'done';
      })
      .finally(() => releaseRecTap(label));
    return { status: 200, body: trackRecStatus() };
  },

  'GET /api/trackRecord/status': async () => ({ status: 200, body: trackRecStatus() }),

  // Abort an armed/running bounce, or acknowledge a finished one (clears its result). The engine
  // side stops with the tap; a cancelled capture is simply never trimmed.
  'POST /api/trackRecord/cancel': async () => {
    if (!trackRec) return { status: 200, body: {} };
    const { label, phase, capture, timer } = trackRec;
    if (timer) clearInterval(timer);
    trackRec = null;
    if (phase !== 'done' && engine) {
      engine.tapTrack(label, false); // frees the DiskOut synth and closes the file mid-flight
      recTapped.delete(label);
      try {
        fs.unlinkSync(capture);
      } catch {
        // the engine may not have created it yet
      }
    }
    return { status: 200, body: {} };
  },

  // Every bounce on disk, newest first - the sr() autocomplete's word list and the recordings
  // browser. Reads the filesystem directly, so it works with the engine down.
  'GET /api/recordings': async () => ({
    status: 200,
    body: { root: recordings.recordingsRoot(), items: recordings.listRecordings() },
  }),

  // One folder of the sample library, for se()'s autocomplete: subfolders first, then audio files.
  // Query `dir` is root-relative ("" = the root itself).
  'GET /api/sampleFiles': async (query) => {
    const { browseSamples, samplesRoot } = require('@poptart/osc-engine/samples');
    const listing = browseSamples(query.dir ?? '');
    if (!listing) throw new Error(`can't read ${path.join(samplesRoot(), query.dir ?? '')}`);
    return { status: 200, body: { root: samplesRoot(), ...listing } };
  },

  // --- macros (the editor's "macros" knob bank) ---

  // Knob values are live performance state (in-memory, reset on restart); names persist in
  // settings so a renamed knob keeps its name across sessions.
  'GET /api/macros': async () => ({
    status: 200,
    body: {
      macros: Array.from({ length: patternCore.MACRO_COUNT }, (_, i) => ({
        index: i + 1,
        value: patternCore.macroValue(i + 1),
        name: settings.macroNames?.[i] || `Macro ${i + 1}`,
      })),
    },
  }),

  // Body: { index, value } - value 0..1. Called on every knob move (throttled client-side),
  // so it deliberately touches nothing but the in-memory store.
  'POST /api/macros/set': async (body) => {
    patternCore.setMacro(Number(body.index), Number(body.value));
    return { status: 200, body: {} };
  },

  // Body: { index, name }. An empty name resets to the default "Macro N".
  'POST /api/macros/name': async (body) => {
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 1 || index > patternCore.MACRO_COUNT) {
      throw new Error(`macro index must be 1..${patternCore.MACRO_COUNT}`);
    }
    const name = String(body.name ?? '').trim().slice(0, 24);
    settings.macroNames = settings.macroNames ?? [];
    settings.macroNames[index - 1] = name;
    saveSettings();
    return { status: 200, body: { name: name || `Macro ${index}` } };
  },

  // --- settings (the editor's "settings" tab) ---

  // How long unnamed work-in-progress sessions are kept. Off by default (`months: 0` - keep them
  // forever), because a session file is the recovery net for work that was never named.
  //
  // GET reports the policy and what applying it would cost right now, so the editor can ask before
  // anything is deleted rather than after. `preview` months lets it price a policy that isn't in
  // force yet - the number in the confirmation dialog.
  'GET /api/patterns/wip/retention': async (q) => {
    const months = Number(settings.wipRetentionMonths ?? 0);
    const asked = q?.months == null ? months : Number(q.months);
    const { ids, bytes } = wipOlderThan(asked);
    return { status: 200, body: { months, preview: { months: asked, sessions: ids.length, bytes } } };
  },

  // Body: { months } - 0 to keep sessions forever. Applies the policy immediately, so what the
  // dialog said would go, goes now rather than at some later sweep.
  'POST /api/patterns/wip/retention': async (body) => {
    const months = Math.max(0, Math.min(120, Number(body?.months ?? 0) || 0));
    settings.wipRetentionMonths = months;
    saveSettings();
    const { deleted, freed } = months > 0 ? pruneWipSessions(months) : { deleted: 0, freed: 0 };
    // The states those sessions were holding alive can go with them, if nothing else names them.
    const swept = await blobs.sweepBlobs({ scanDirs: [WIP_DIR, SNAPSHOT_DIR], alsoKeep: [...liveStateIds] });
    return { status: 200, body: { months, deleted, freed: freed + swept.freed } };
  },

  // Output devices with channel counts, plus the saved selection (null = system default) and the
  // output-channel picture for the device that would be opened: `channels` is what .o(n) wraps at
  // right now, `choices` the counts the tab may offer, `audible` how wide the device really is.
  'GET /api/audioDevices': async () => {
    const devices = audioOutputDevices();
    const { channels, choices, audible } = outputChannelState(devices);
    return {
      status: 200,
      body: {
        devices,
        selected: settings.audioOutputDevice ?? null,
        outputChannels: channels,
        outputChannelChoices: choices,
        audibleChannels: audible,
      },
    };
  },

  // Body: { channels } - how many output channels .o(n) may address, as a count of whole stereo
  // pairs. Clamped to what the device can be heard on rather than refused, for the same reason
  // playbackChannels clamps: the saved number outlives the device it was chosen for. Restarts the
  // engine, because the pair count is compiled into every track SynthDef at boot.
  'POST /api/audioOutputChannels': async (body) => {
    // Whole stereo pairs only - a pair is the unit .o(n) addresses, and an odd count would leave
    // one channel no orbit could reach.
    const pairs = Math.max(1, Math.floor(Number(body?.channels) / 2) || 1);
    settings.audioOutputChannels = pairs * 2;
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    const { channels, choices, audible } = outputChannelState();
    return { status: 200, body: { outputChannels: channels, outputChannelChoices: choices, audibleChannels: audible } };
  },

  // Body: { device } - a device name, or null/"" for the system default. Persists the choice
  // and restarts the engine on the new device (scsynth can't switch devices while running),
  // so the response takes a few seconds and any playing tracks stop.
  'POST /api/audioDevice': async (body) => {
    const device = body.device ? String(body.device) : null;
    if (device && !audioOutputDevices().some((d) => d.name === device)) {
      throw new Error(`no audio output device named "${device}"`);
    }
    settings.audioOutputDevice = device;
    // The aggregate is built AROUND the output device - it's the clock master and its channels are
    // the ones playback lands on - so a new output device means a new aggregate. Without this the
    // choice is silently inert: deviceToOpen keeps opening an aggregate built around the device you
    // just stopped using, and picking your speakers changes nothing you can hear.
    let rebuildWarning = null;
    if ((settings.audioInputDevices ?? []).length) {
      try {
        syncAggregate(settings.audioInputDevices);
      } catch (err) {
        // Not fatal, and not a reason to refuse the device the user just asked for: deviceToOpen
        // sees an aggregate that no longer holds it and opens it directly instead. Say so, though -
        // input() loses the extra devices until the aggregate is rebuilt.
        rebuildWarning = {
          message: 'the combined audio device could not be rebuilt - press apply to retry',
          detail: `the combined audio device could not be rebuilt (${err.message}) - playing through `
            + `"${device ?? 'the system default'}" directly, so input() cannot reach the extra devices.`,
        };
        // eslint-disable-next-line no-console
        console.warn(`[poptart] ${rebuildWarning.detail}`);
      }
    }
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    return { status: 200, body: { device, warning: rebuildWarning ?? audioDeviceWarning() } };
  },

  // Input-capable devices, the saved extra-input selection, and the live channel layout input()
  // resolves against. `available: false` means no poptart-audio helper, so only the booted device's
  // own inputs can be used (absolute channel numbers still work).
  'GET /api/audioInputs': async () => ({
    status: 200,
    body: {
      available: audioDevices.helperAvailable(),
      // Never poptart's own aggregate: it's assembled FROM these, so offering it as one of them
      // is offering to make it a member of itself.
      devices: audioDevices.listInputDevices().filter((d) => d.uid !== audioDevices.AGGREGATE_UID),
      selected: settings.audioInputDevices ?? [],
      // uid -> the name it had when it was applied, so a device that has since been unplugged can
      // still be shown as itself.
      names: settings.audioInputNames ?? {},
      layout: audioInputLayout(),
      active: activeAudioDevice?.name ?? null,
      // Non-null when the combined device has degraded under us - the settings tab is the only
      // place this is visible, because the audio itself gives nothing away.
      warning: audioDeviceWarning(),
    },
  }),

  // Body: { uids } - the extra input devices to aggregate with the output device, in the order
  // their channels should appear. An empty list tears the aggregate down and goes back to opening
  // the output device directly.
  //
  // This MUTATES the machine's audio configuration (the aggregate shows up in Audio MIDI Setup)
  // and then restarts the engine, so any playing tracks stop - which is exactly why it's an
  // explicit settings action and never something an eval can trigger.
  'POST /api/audioInputs': async (body) => {
    const uids = Array.isArray(body.uids) ? body.uids.map(String) : [];
    if (uids.length && !audioDevices.helperAvailable()) {
      throw new Error('combining several input devices needs the poptart-audio helper, which is not available on this system');
    }
    // A device that isn't plugged in right now must NOT fail the whole request - see
    // splitConnected. Build from what's actually here; keep the rest saved, so plugging an
    // interface back in and pressing apply brings it straight back.
    const knownDevices = audioDevices.listDevices();
    const { present, absent } = audioSelection.splitConnected(uids, knownDevices.map((d) => d.uid));

    // The output device goes in as the clock master: it's the one whose timing playback is bound
    // to, and every other member gets drift compensation against it.
    syncAggregate(present);

    settings.audioInputDevices = uids;
    // Remember what each one is CALLED while it's here to ask. A UID is all that survives an
    // unplug, and on its own it's unreadable - the difference between "EarPods · not plugged in"
    // and "AppleUSBAudioEngine:Apple, Inc.:EarPods:DHK4XW9QTV:2 · not plugged in".
    const nameOf = new Map(knownDevices.map((d) => [d.uid, d.name]));
    settings.audioInputNames = Object.fromEntries(
      uids.map((uid) => [uid, nameOf.get(uid) ?? inputDeviceName(uid)]),
    );
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    const skipped = absent.length
      ? {
        message: `${absent.length} selected ${absent.length === 1 ? 'device was' : 'devices were'} `
          + 'not plugged in and got left out',
        detail: `${absent.length} selected ${absent.length === 1 ? 'device is' : 'devices are'} not `
          + `plugged in and were left out of the combined device (${absent.map(inputDeviceName).join(', ')}). `
          + 'They stay selected - plug them back in and the next engine start brings them in by '
          + 'itself, or untick them to forget them.',
      }
      : null;
    return {
      status: 200,
      body: { selected: uids, layout: audioInputLayout(), warning: skipped ?? audioDeviceWarning() },
    };
  },
};

// Full parameter lists keyed by plugin name - Serum 2's is 2,621 entries and round-trips
// through sclang via a temp file, so fetch it once per plugin, not once per eval.
const paramsByPlugin = new Map();

// Plugin loading is a fire-and-forget OSC send, so right after an eval getParams can race the
// plugin's own (potentially slow - Serum takes seconds) open. Poll until it answers.
async function getParamsWhenLoaded(trackId, slot, { tries = 30, delayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await engine.getParams(trackId, slot);
    } catch (err) {
      const stillOpening = /no plugin loaded/i.test(err.message ?? '');
      if (!stillOpening || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Plumbing: static file serving + JSON body parsing + route dispatch.
// ---------------------------------------------------------------------------------------------

const STATIC_ROOTS = [
  { prefix: '/vendor/codemirror/', root: CODEMIRROR_DIR },
  { prefix: '/pattern-core/', root: PATTERN_CORE_SRC_DIR },
];

function resolveStaticPath(urlPath) {
  const entry = STATIC_ROOTS.find((e) => urlPath.startsWith(e.prefix));
  const root = entry?.root ?? PUBLIC_DIR;
  const rel = entry ? urlPath.slice(entry.prefix.length) : urlPath;
  const filePath = path.join(root, rel);
  return filePath.startsWith(root) ? filePath : null;
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = resolveStaticPath(urlPath);

  if (!filePath) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(filePath);
    // no-cache (= revalidate, not "don't cache"): without it browsers heuristically cache
    // client.js etc., so after a server update a plain reload can keep running stale UI code.
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------------------------
// Live-reload: the browser holds one SSE stream open (GET /api/devReload) and reloads itself
// when told to. Two signals cover the two kinds of edit:
//   - a change under public/ broadcasts `reload` with the server still running - the engine and
//     the sound are untouched, only the page refreshes;
//   - an edit to server-side code (server.js, pattern-core, osc-engine) restarts the process
//     (npm run dev is `node --watch`), the stream drops, and the reconnecting client sees a new
//     boot id and reloads then. The changed ID - not the dropped connection - is the trigger, so
//     a transient hiccup reconnects without a spurious reload.
// pattern-core's src/ is served to the browser but not watched here on purpose: the server loads
// those same files, so --watch already answers with a restart, and the boot id covers it.
// ---------------------------------------------------------------------------------------------

const BOOT_ID = `${process.pid}:${Date.now()}`;
const reloadClients = new Set();

function serveDevReload(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: boot\ndata: ${BOOT_ID}\n\n`);
  reloadClients.add(res);
  res.on('close', () => reloadClients.delete(res));
}

// One save can land as several fs events (write + rename, an editor's temp-file dance); the
// browser needs one reload, so broadcasts settle for a beat first.
let reloadTimer = null;
function broadcastReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const res of reloadClients) res.write('event: reload\ndata: 1\n\n');
  }, 80);
}

try {
  fs.watch(PUBLIC_DIR, { recursive: true }, (_event, file) => {
    if (file && path.basename(file).startsWith('.')) return; // editor swap files, .DS_Store
    broadcastReload();
  });
} catch {
  // watching is a convenience - a platform without recursive fs.watch just loses auto-reload
}

// Streams a single sample file's raw bytes for the sounds-browser preview (the client decodes
// it with Web Audio). Addressed the same way `s("pack:i")` is - by the file's index in its
// pack's filename-sorted list - so what you preview is exactly what that pattern plays. Kept out
// of the JSON `routes` table because it returns binary audio, not JSON.
const AUDIO_MIME = {
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
};

function serveSampleAudio(query, res) {
  const pack = String(query.pack ?? '');
  const i = Number(query.i);
  // Pack is a single folder name under the samples root; reject anything that could escape it.
  if (!pack || pack.includes('/') || pack.includes('\\') || pack.includes('..') || !Number.isInteger(i) || i < 0) {
    res.writeHead(400).end('bad request');
    return;
  }
  const { listPackFiles } = require('@poptart/osc-engine/samples');
  const files = listPackFiles(pack);
  const filePath = files?.[i];
  if (!filePath) {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Chunks are concatenated as BYTES and decoded once. Decoding each chunk on arrival (`raw +=
// chunk`) splits any multi-byte character that happens to straddle a chunk boundary into two
// replacement characters - which, on a buffer big enough to arrive in several chunks, silently
// corrupts the code being evaluated wherever it holds an accent or an emoji.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (LOOPBACK_ONLY) {
    const refusal = blockReason({
      method: req.method,
      hostHeader: req.headers.host,
      originHeader: req.headers.origin,
    });
    if (refusal) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: refusal }));
      return;
    }
  }

  const url = new URL(req.url, 'http://localhost');

  // Binary sample preview - answered outside the JSON route table (see serveSampleAudio).
  if (req.method === 'GET' && url.pathname === '/api/sampleAudio') {
    return serveSampleAudio(Object.fromEntries(url.searchParams), res);
  }

  // Live-reload stream - long-lived SSE, so also outside the JSON route table.
  if (req.method === 'GET' && url.pathname === '/api/devReload') {
    return serveDevReload(res);
  }

  const handler = routes[`${req.method} ${url.pathname}`];

  if (!handler) {
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(404).end('not found');
    return;
  }

  try {
    // POST handlers receive the parsed JSON body; GET handlers receive the query params.
    const arg = req.method === 'POST'
      ? await readJsonBody(req)
      : Object.fromEntries(url.searchParams);
    const { status, body: responseBody } = await handler(arg);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message ?? String(err) }));
  }
});

init().then(() => {
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[poptart] listening on http://localhost:${PORT}`);
    if (!LOOPBACK_ONLY) {
      // eslint-disable-next-line no-console
      console.warn(
        `[poptart] WARNING: bound to ${HOST} (POPTART_HOST) - anyone who can reach this ` +
          'address can execute code on this machine via /api/evaluate. Only use on networks ' +
          'you trust.',
      );
    }
  });
});

process.on('SIGINT', () => {
  // stop() is async (it waits for sclang to quit scsynth cleanly) - give it a moment, but
  // never hang the Ctrl-C.
  setTimeout(() => process.exit(0), 4000).unref();
  Promise.resolve(engine?.stop()).finally(() => process.exit(0));
});

// Last line of defence: an error thrown where nobody can catch it - a timer callback, an OSC reply
// handler, a stray rejected promise - must not take the server down. Node's default for both of
// these is to print the stack and exit, and exiting is the worst thing that can happen here: the
// browser keeps its code but loses the engine, sclang and scsynth are orphaned holding the audio
// device, and whatever was playing stops mid-set. Staying up is recoverable; the engine can be
// restarted from the settings tab, and the pattern re-evaluated. So log it loudly - to the editor's
// own console as well as this terminal, since the terminal is not what a player is looking at - and
// keep going. This is a backstop, not a licence: the bug it caught first (a VST transport re-sync
// firing at an engine that was being torn down for an audio-device change) got fixed where it was.
for (const [event, label] of [['uncaughtException', 'uncaught error'], ['unhandledRejection', 'unhandled rejection']]) {
  process.on(event, (err) => {
    const detail = err?.stack ?? String(err);
    // eslint-disable-next-line no-console
    console.error(`[poptart] ${label} (the server is staying up):\n${detail}`);
    eventLogQueue.push(`${label}: ${err?.message ?? String(err)} - see the terminal for the full trace`);
    if (eventLogQueue.length > EVENT_LOG_MAX) eventLogQueue.splice(0, eventLogQueue.length - EVENT_LOG_MAX);
  });
}
