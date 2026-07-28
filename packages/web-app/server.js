'use strict';

// Plain Node HTTP server - serves the browser UI from public/ and exposes engine, transport,
// and file operations as JSON-over-HTTP endpoints (see `routes`). Everything is request/reply
// (no push updates needed), so plain HTTP is enough - no WebSocket dependency.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { MappedEngine, toRealWorld } = require('./param-mapping');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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

// CoreAudio output devices with channel counts, via system_profiler (macOS - the platform the
// audio/MIDI plumbing already assumes). Channel counts are why this isn't sclang's
// ServerOptions.outDevices: scsynth needs numOutputBusChannels at boot, and .o(n)'s
// stereo-pair wraparound has to match the hardware.
function audioOutputDevices() {
  try {
    const raw = execFileSync('system_profiler', ['SPAudioDataType', '-json'], { encoding: 'utf8', timeout: 15000 });
    const groups = JSON.parse(raw).SPAudioDataType ?? [];
    return groups
      .flatMap((g) => g._items ?? [])
      .filter((d) => Number(d.coreaudio_device_output) > 0)
      .map((d) => ({
        name: d._name,
        channels: Number(d.coreaudio_device_output),
        // The device's input channel count (0 for output-only devices). scsynth opens this one
        // device for both in and out (see poptart.scd), so it must not be asked for more input
        // channels than the device has - this is what numInputBusChannels gets sized from.
        inChannels: Number(d.coreaudio_device_input) || 0,
        isDefault: d.coreaudio_default_audio_output_device === 'spaudio_yes',
      }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] could not list audio output devices: ${err.message}`);
    return [];
  }
}

async function loadEngine() {
  try {
    const { OscEngine } = require('@poptart/osc-engine');
    const devices = audioOutputDevices();
    const wanted = settings.audioOutputDevice;
    const chosen = wanted ? devices.find((d) => d.name === wanted) : null;
    if (wanted && !chosen) {
      // eslint-disable-next-line no-console
      console.warn(`[poptart] saved audio output device "${wanted}" is not connected - using the system default`);
    }
    // Whichever device scsynth will actually open decides the channel count .o(n) wraps at.
    const active = chosen ?? devices.find((d) => d.isDefault);
    const e = new OscEngine({ outDevice: chosen?.name ?? null, outChannels: active?.channels ?? 2, inChannels: active?.inChannels ?? 0 });
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
    transport?.stop(); // playback is over - freeze the clock at cycle 0 until the next eval
    if (engine) {
      await engine.stop();
      // Let the OS actually release the OSC UDP port and the audio device before the
      // replacement sclang/scsynth try to grab them - both frees complete asynchronously.
      await new Promise((r) => setTimeout(r, 300));
    }
    engine = null;
    mappedEngine = null;
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
}

async function init() {
  patternCore = await import('@poptart/pattern-core');
  extendStringPrototype(patternCore);
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
    'gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'when', 'hold', 'scale', 'range', 'synth', 'fx', 'param',
    'gain', 'pan', 'o', 'vel', 'clip', 'as',
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

const BUILDER_NAMES = ['Signal', 'n', 'note', 'mini', 's', 'synth', 'sine', 'saw', 'tri', 'square', 'ramp', 'rand', 'perlin', 'lfo', 'env', 'midicc', 'midikeys', 'macro', 'choose', 'keyboard', 'tap', 'midi', 'audio', 'pianoroll',
  // Pure music-theory helpers (not signal builders, but handy when writing your own): note-name
  // -> MIDI, scale-degree -> MIDI, and the raw {rootMidi, intervals} of a scale name. Exposed by
  // name so a custom `Signal.prototype.chord = ...` can call them. Real in the browser prebake too
  // (see client.js), so they behave the same in patterns, setup blocks, and hotkey handlers.
  'noteToMidi', 'degreeToMidi', 'parseScaleName'];

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
    const baseNames = [...BUILDER_NAMES, ...macroNames, 'setbpm'].filter((n) => !defs.has(n)); // defs may shadow builders
    const baseValues = baseNames.map((n) => {
      if (n === 'setbpm') return setbpm;
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
  return [
    sig,
    ...Object.values(sig.paramSignals),
    ...Object.values(sig.channel),
    ...(sig.velSig ? [sig.velSig] : []),
    ...Object.values(sig.sampler ?? {}).filter((v) => v instanceof patternCore.Sig),
  ];
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
        if (locs.length) out.push({ start: s.start, end: s.end, ...(s.cont ? { cont: true } : {}), locs });
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

// ---------------------------------------------------------------------------------------------
// Pattern files - the editor's "files" tab saves/loads whole editor buffers as plain .js files
// under ~/.poptart/patterns (overridable via POPTART_PATTERNS_DIR), so they're ordinary files
// the user can also back up / edit / version outside poptart.
// ---------------------------------------------------------------------------------------------

const PATTERNS_DIR = process.env.POPTART_PATTERNS_DIR || path.join(os.homedir(), '.poptart', 'patterns');

// Names are used as filenames directly, so keep them to a single path segment.
function patternFilePath(name) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 128 || clean.startsWith('.') || /[/\\]/.test(clean)) {
    throw new Error('pattern name must be a plain file name (no slashes, not starting with ".")');
  }
  return path.join(PATTERNS_DIR, `${clean}.js`);
}

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
// API handlers, keyed "METHOD /path" and dispatched by the plumbing at the bottom of the file.
// ---------------------------------------------------------------------------------------------

const routes = {
  'GET /api/status': async () => ({
    status: 200,
    body: { loaded: !!engine, error: engineError },
  }),

  'POST /api/scanPlugins': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.scanPlugins(body.extraPaths ?? []) };
  },

  'GET /api/knownPlugins': async () => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getKnownPlugins() };
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

    const blocks = patternCore.splitLabeledBlocks(body.code ?? '');
    if (blocks.length === 0) throw new Error('nothing to evaluate');

    // Fresh copy of the prebake bindings each eval: they're the starting scope for the buffer,
    // and a redeclared name in the buffer overrides the copy without clobbering the original.
    const evalBlock = makeBlockEvaluator(new Map(prebakeDefs));
    const evaluated = blocks.map((b) => {
      try {
        const value = evalBlock(b.code, b.start);
        if (value instanceof patternCore.Sig) {
          dryRunPattern(value);
        } else if (value !== TEMPO_BLOCK && !b.label.startsWith('$')) {
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
    const built = evaluated.filter((b) => b.sig instanceof patternCore.Sig);

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
      sch.setPattern(b.sig);
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

  // Capture the full state of the plugin in a chain slot as an opaque string, for the editor's
  // "pin" button to write into the code as synth/fx's `{ state }` argument. Body: { trackId, slot }.
  'POST /api/pluginState': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: { state: await engine.getPluginState(body.trackId ?? 'default', body.slot ?? 0) } };
  },

  // Pop open the native editor window of the plugin in a chain slot (design your supersaw in
  // Serum's own UI, then livecode the modulation). Body: { trackId, slot }.
  'POST /api/showEditor': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    engine.showPluginEditor(body.trackId ?? 'default', body.slot ?? 0);
    return { status: 200, body: {} };
  },

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

  'GET /api/patterns': async () => {
    let names = [];
    try {
      names = fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith('.js'));
    } catch {
      // directory doesn't exist yet - nothing saved
    }
    const patterns = names
      .map((f) => ({ name: f.slice(0, -3), mtime: fs.statSync(path.join(PATTERNS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return { status: 200, body: { patterns } };
  },

  // Body: { name, code }. Overwrites silently - "save" in a livecoding tool means "keep this".
  'POST /api/patterns/save': async (body) => {
    const file = patternFilePath(body.name);
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.writeFileSync(file, String(body.code ?? ''), 'utf8');
    return { status: 200, body: {} };
  },

  // Body: { name } -> { code }.
  'POST /api/patterns/load': async (body) => {
    const file = patternFilePath(body.name);
    if (!fs.existsSync(file)) throw new Error(`no saved pattern named "${body.name}"`);
    return { status: 200, body: { code: fs.readFileSync(file, 'utf8') } };
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

  // Output devices with channel counts, plus the saved selection (null = system default).
  'GET /api/audioDevices': async () => ({
    status: 200,
    body: { devices: audioOutputDevices(), selected: settings.audioOutputDevice ?? null },
  }),

  // Body: { device } - a device name, or null/"" for the system default. Persists the choice
  // and restarts the engine on the new device (scsynth can't switch devices while running),
  // so the response takes a few seconds and any playing tracks stop.
  'POST /api/audioDevice': async (body) => {
    const device = body.device ? String(body.device) : null;
    if (device && !audioOutputDevices().some((d) => d.name === device)) {
      throw new Error(`no audio output device named "${device}"`);
    }
    settings.audioOutputDevice = device;
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    return { status: 200, body: { device } };
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
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
  const url = new URL(req.url, 'http://localhost');

  // Binary sample preview - answered outside the JSON route table (see serveSampleAudio).
  if (req.method === 'GET' && url.pathname === '/api/sampleAudio') {
    return serveSampleAudio(Object.fromEntries(url.searchParams), res);
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
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[poptart] listening on http://localhost:${PORT}`);
  });
});

process.on('SIGINT', () => {
  // stop() is async (it waits for sclang to quit scsynth cleanly) - give it a moment, but
  // never hang the Ctrl-C.
  setTimeout(() => process.exit(0), 4000).unref();
  Promise.resolve(engine?.stop()).finally(() => process.exit(0));
});
