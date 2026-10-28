'use strict';

// The engine: what sc/poptart.scd did under sclang, in Node. OscEngine (../index.js) hands it the
// same '/poptart/*' messages it used to send sclang, and it answers with the same messages sclang
// sent back, so the protocol between the two halves did not change - only that it no longer
// crosses a process. It drives scsynth through ../server/.
//
// Porting conventions (each section file under engine/ follows them, so it reads against the
// sclang it came from):
//  - Every top-level sclang variable is a property of the engine `E` (state below, functions in
//    the section files), under the same name. A section adds its functions in install(E).
//  - A handler gets `msg` as sclang's OSCdef did: msg[0] is the address, msg[1] the first argument.
//    Strings arrive as strings (sclang had Symbols); floats are float32-rounded as OSC carried them.
//  - Symbol-keyed dictionaries are Maps keyed by string. A track is a plain object; the 'pending'
//    marker a build reserves its key with is the string 'pending' (isTrack tells them apart).
//  - fork { } is E.fork(async () => { }); x.wait is await E.wait(x); server.sync is await S.sync().
//    A function that could wait in sclang is async here, and its callers await it. awaitTrack.(key)
//    is `E.builtTrack(key) ?? await E.awaitTrack(key)`, so a built track is taken without yielding
//    (see builtTrack: a yield lets the rest of the message burst overtake the routine).
//  - SystemClock.sched(t, f) is E.sched(t, f) (f returning a number reschedules, as there);
//    Main.elapsedTime and SystemClock.seconds are E.elapsed().
//  - "...".postln is E.post(text); "...".warn is E.warn(text) (printed with sclang's "WARNING: ").
//  - nodeAddr.sendMsg(address, ...) is E.tell(address, ...).
//  - Synth(...), Group.new, Bus.audio/control, Buffer.read... are the classes in ../server/objects.js,
//    with the server first: Synth.new(S, def, args, target, addAction).
//  - VSTPluginController and PoptartDeviceController are ../server/vst.js and ../server/device.js,
//    with the class library's method names and callback shapes.

const { Server } = require('../server/server');
const { Synth, Group, Bus, Buffer, Node: ScNode } = require('../server/objects');

const isTrack = (t) => t != null && typeof t === 'object';

class Engine {
  /**
   * server: a booted ../server Server. config: the boot settings (see boot.js's engineConfig).
   * tell(address, args): a message to OscEngine. output(text, isError): the engine's log line.
   * defs: the DefRegistry the SynthDefs were loaded from. vst: the VSTPlugin host (../server/vst.js).
   */
  constructor({ server, config, tell, output, defs, vst = null, devices = null }) {
    this.S = server;
    this.server = server;
    this.config = config;
    this.defs = defs;
    this.vst = vst; // the VSTPlugin host: plugin list, search, cache (../server/vst.js)
    this.devices = devices; // the device catalog (../server/device.js), for PoptartDeviceDesc
    this._tell = tell;
    this._output = output;
    this._handlers = new Map();
    this._timers = new Set();
    this._t0 = performance.now();
    this.stopped = false;
    this.classes = { Synth, Group, Bus, Buffer, Node: ScNode };
    this.isTrack = isTrack;
    this._initState();
  }

  // --- the state poptart.scd's top-level variables held -------------------------------------

  _initState() {
    const c = this.config;
    this.nodePort = c.nodePort;
    this.oscInPort = c.oscInPort ?? 57160;
    this.sampleRate = c.sampleRate ?? 48000;
    this.blockSize = c.blockSize ?? 256;
    this.outDevice = c.outDevice ?? null;
    this.outChannels = c.outChannels ?? 2;
    this.playChannels = c.playChannels ?? this.outChannels;
    this.inChannels = c.inChannels ?? 0;
    this.cueOffset = c.cueOffset ?? null;
    this.searchDirs = c.searchDirs ?? null;
    this.excludePaths = c.excludePaths ?? [];
    this.parallelScan = !!c.parallelScan;
    this.searchOptions = { timeout: 20, exclude: this.excludePaths, parallel: this.parallelScan };
    this.scanning = false;
    this.routeNowhere = 1000000;
    this.scsynthPort = this.S.options.port;

    this.tracks = new Map(); // trackId -> track object, or 'pending' while it is built
    this.trackGen = new Map();
    this.stateSeqs = new Map();
    this.statePending = new Map();
    this.noteQueues = new Map();
    this.stateWaitMax = 0.3;
    this.coldWaitMax = 20;
    this.openWaitMax = 60;
    this.selfLoads = new Map();
    this.selfLoadTail = 0.5;
    this.samplePacks = new Map(); // pack -> Array of Buffers, filename order
    this.songs = new Map(); // trackId -> { buf, synth, ... }
    this.confWant = new Map();
    this.currentTempo = 120;
    this.trackTempo = new Map();
    this.trackPlace = new Map();
    this.loopEdges = new Set();
    this.trackSerial = 0;
    this.trackDef = null; // the shared track defs by role (see sharedTrackDef)
    this.trackDefState = null;
    this.midiInitialized = false;
    this.midiWarned = new Set();
    this.oscInitialized = false;
    this.clockOut = null;
    this.clockOutName = null;
    this.clockOutLatency = 0.05;
    this.clockRunning = false;
    this.clockLocate = false;
    this.feedbackOut = null;
    this.feedbackOutName = null;
    this.exprDefUse = new Map();
    this.exprDefSerial = 0;
    this.mixOn = false;
    this.mixReconciling = false;
    this.mixDirty = false;
    this.headphoneLevel = 1;
    this.headphoneMix = 0;
    this.shapesHandled = new Map();
    this.modFreeDelay = 0.3;
    this.maxVoices = 1024;
    this.liveVoices = new Set();
    this.voiceCapSaidAt = 0;
    this.statusNodesHigh = false;
    this.steppedChannelControls = ['out', 'cue', 'mdeck', 'mon', 'grainpos', 'grainsize', 'grainrate', 'grainpan'];
    this.grainSides = new Map();
    this.grainWindows = new Map();
    this.grainWindowFrames = 1024;
    this.grainMaxOverlap = 128;
    this.bendPollHz = 100;
    this.bendTracks = new Map();
    this.rbDelay = 0;
    // Made at boot (see boot()): the shared buses and groups every track uses.
    this.unityGainBus = null;
    this.silentBus = null;
    this.trashBus = null;
    this.deckMeterBus = null;
    this.sidechainByTarget = new Map();
    this.sidechainBySource = new Map();
    this.sourceFeeds = new Map();
    this.namedBuses = new Map();
    this.exprQueue = new Map();
    this.exprDefs = new Map();
    this.paramRoutes = new Map();
    this.recTaps = new Map();
    this.mixTaps = new Map();
    this.mixWanted = new Set();
    this.recGroup = null;
    this.levelGroups = [];
    this.masterSynth = null;
    this.headphoneSynth = null;
    this.deckMeterSynths = null;
  }

  /** VSTPluginController(synth, id: id, synthDef: def): the VSTPlugin with `id` in the synth's def. */
  vstController(synth, id, defName = synth.defName) {
    const { VstController } = require('../server/vst');
    const index = this.defs.vstIndex(defName, id);
    if (index == null) throw new Error(`SynthDef '${defName}' doesn't contain a VSTPlugin with ID '${id}'!`);
    return new VstController(this.S, synth, index, this.vst);
  }

  /** PoptartDeviceController(synth, id, def): the PoptartDevice with `id` in the synth's def. */
  deviceController(synth, id, defName = synth.defName) {
    const { DeviceController } = require('../server/device');
    const index = this.defs.deviceIndex(defName, id);
    if (index == null) throw new Error(`SynthDef '${defName}' doesn't contain a PoptartDevice with ID '${id}'!`);
    return new DeviceController(this.S, synth, index, this.devices);
  }

  /** Whether poptart's own devices are on this server (\PoptartDevice.asClass.notNil). */
  get hasNativeDevices() {
    return this.defs.deviceIndex('poptart_head', 'nslot0') != null;
  }

  lfoDefName(shape, audio) {
    return `poptart_lfo_${shape}${audio ? '_ar' : ''}`;
  }

  // --- the sclang runtime, as far as poptart used it ----------------------------------------

  /** OSCdef: a handler for one '/poptart/*' address. */
  on(address, fn) {
    this._handlers.set(address, fn);
  }

  /** A message from OscEngine. Unknown addresses are said, as sclang said nothing. */
  dispatch(address, args) {
    const fn = this._handlers.get(address);
    if (!fn) return false;
    const msg = [address, ...args];
    try {
      const r = fn(msg);
      if (r && typeof r.catch === 'function') r.catch((err) => this.error(address, err));
    } catch (err) {
      this.error(address, err);
    }
    return true;
  }

  handles(address) {
    return this._handlers.has(address);
  }

  error(where, err) {
    this._output(`ERROR: ${where}: ${err?.stack || err}\n`, true);
  }

  /** nodeAddr.sendMsg */
  tell(address, ...args) {
    if (this.stopped) return;
    this._tell(address, args);
  }

  post(text) {
    this._output(`${text}\n`, false);
  }

  warn(text) {
    this._output(`WARNING: ${text}\n`, false);
  }

  /** fork { }: runs fn now, as its own routine; an error is printed and stops only it. */
  fork(fn) {
    const p = (async () => fn())();
    p.catch((err) => this.error('routine', err));
    return p;
  }

  wait(sec) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._timers.delete(t); resolve(); }, Math.max(0, sec * 1000));
      this._timers.add(t);
    });
  }

  /** SystemClock.sched: fn runs after `sec`; a number returned schedules it again that far on. */
  sched(sec, fn) {
    const handle = { cancelled: false, cancel() { this.cancelled = true; } };
    const run = (s) => {
      const t = setTimeout(() => {
        this._timers.delete(t);
        if (handle.cancelled || this.stopped) return;
        let again;
        try { again = fn(); } catch (err) { this.error('sched', err); }
        if (typeof again === 'number' && again >= 0) run(again);
      }, Math.max(0, s * 1000));
      this._timers.add(t);
    };
    run(sec);
    return handle;
  }

  /** Main.elapsedTime: monotonic seconds. */
  elapsed() {
    return (performance.now() - this._t0) / 1000;
  }

  /** makeBundle with a timestamp only when there is real lead (poptart.scd's bundleNow). */
  bundleNow(latency, fn) {
    return this.S.makeBundle(latency != null && latency > 0.001 ? latency : null, fn);
  }

  /** The tiny JSON writer poptart.scd carried; JSON.stringify where the value is plain. */
  toJson(obj) {
    return JSON.stringify(obj, (k, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      if (typeof v === 'number' && Number.isNaN(v)) return null;
      return v;
    });
  }

  // Reply payloads go through a temp file, as poptart.scd's did (see OscEngine's _handleMessage).
  replyOk(address, requestId, payloadJson) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const p = path.join(os.tmpdir(), `poptart-reply-${requestId}-${process.pid}.json`);
    fs.writeFileSync(p, payloadJson);
    this.tell(`${address}.reply`, requestId, p);
  }

  replyErr(address, requestId, message) {
    this.tell(`${address}.error.reply`, requestId, String(message));
  }

  /** Stops every timer and routine wait; the server is the caller's to quit. */
  stop() {
    this.stopped = true;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    for (const fn of this._stopHooks ?? []) {
      try { fn(); } catch { /* best effort */ }
    }
  }

  /** Something to run at stop (an OSC input port, a MIDI helper). */
  onStop(fn) {
    (this._stopHooks ??= []).push(fn);
  }
}

module.exports = { Engine, isTrack, Server };
