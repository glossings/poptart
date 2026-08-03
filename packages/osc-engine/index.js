'use strict';

// Engine adapter matching the interface packages/pattern-core/src/scheduler.mjs's Scheduler
// expects (see that file's header comment) - implements it over OSC to a spawned `sclang`
// process instead of an in-process N-API addon. sclang owns the actual audio engine (scsynth)
// and plugin hosting (VSTPlugin~ / VSTPluginController) - see sc/poptart.scd.
//
// Call shape mirrors the old NativeEngine on purpose: noteOn/noteOff/setParam/setParamLFO/etc.
// are fire-and-forget (matches Scheduler's synchronous calling convention - it never awaits
// these), while calls that need real data back (scanPlugins/getKnownPlugins/getParams) return a
// Promise resolved when the matching `/poptart/*.reply` OSC message arrives.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');
const osc = require('osc');
const { samplesRoot, listPackFiles, detectSlices } = require('./samples');

// Plugin state compression, off the event loop. A Serum program is a couple of megabytes, and
// this process also runs the note scheduler against a 150ms lookahead - gzipSync of that is
// ~35ms the scheduler spends not sending notes. zlib's async form does it on the threadpool.
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const SC_SCRIPT_PATH = path.join(__dirname, 'sc', 'poptart.scd');

// Standard SuperCollider install locations to fall back on when `sclang` isn't on PATH - the
// macOS/Windows installers drop the binary inside the app bundle / Program Files but don't put
// it on PATH, which is the single most common "engine failed to start" cause. Keep macOS first
// since that's where the .app-bundle path is genuinely non-obvious to users.
function knownSclangLocations() {
  if (process.platform === 'darwin') {
    return ['/Applications/SuperCollider.app/Contents/MacOS/sclang'];
  }
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\SuperCollider\\sclang.exe',
      'C:\\Program Files (x86)\\SuperCollider\\sclang.exe',
    ];
  }
  return ['/usr/local/bin/sclang', '/usr/bin/sclang'];
}

// Is `name` an executable on the current PATH? Walks PATH ourselves (rather than spawning) so
// resolution stays synchronous - the constructor needs an answer before start(). On Windows a
// bare name also matches name.exe.
function onPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [name, `${name}.exe`] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      try {
        fs.accessSync(path.join(dir, n), fs.constants.X_OK);
        return true;
      } catch {
        // not here - keep looking
      }
    }
  }
  return false;
}

// Decide which sclang to spawn. Priority: explicit POPTART_SCLANG override (points straight at a
// binary, no PATH surgery needed), then a bare `sclang` when it's actually on PATH (let spawn
// resolve it normally), then the platform's standard install location. Falls back to 'sclang' so
// a genuine "not installed" still fails with the binary named in the error.
function resolveSclangPath() {
  if (process.env.POPTART_SCLANG) return process.env.POPTART_SCLANG;
  if (onPath('sclang')) return 'sclang';
  for (const loc of knownSclangLocations()) {
    try {
      fs.accessSync(loc, fs.constants.X_OK);
      return loc;
    } catch {
      // not here - try the next candidate
    }
  }
  return 'sclang';
}

// Where the VSTPlugin server extension lives when installed per the README. Used only for
// diagnostics - sclang_conf.yaml can include other dirs, so absence here is a strong hint, not
// proof. User dir first (the README's instruction), then the system-wide one.
function vstPluginExtensionDirs() {
  if (process.platform === 'darwin') {
    return [
      path.join(os.homedir(), 'Library/Application Support/SuperCollider/Extensions/VSTPlugin'),
      '/Library/Application Support/SuperCollider/Extensions/VSTPlugin',
    ];
  }
  if (process.platform === 'win32') {
    return [
      path.join(process.env.LOCALAPPDATA || '', 'SuperCollider', 'Extensions', 'VSTPlugin'),
      'C:\\ProgramData\\SuperCollider\\Extensions\\VSTPlugin',
    ];
  }
  return [
    path.join(os.homedir(), '.local/share/SuperCollider/Extensions/VSTPlugin'),
    '/usr/local/share/SuperCollider/Extensions/VSTPlugin',
    '/usr/share/SuperCollider/Extensions/VSTPlugin',
  ];
}

function vstPluginExtensionInstalled() {
  return vstPluginExtensionDirs().some((d) => fs.existsSync(d));
}

// Map sclang's boot log to a human diagnosis of why /poptart/ready never arrived. The log is
// the only place the real cause appears, and users hitting this are exactly the ones not reading
// it - so pattern-match the handful of failure modes we've actually seen and say what to do.
// Returns null when nothing matches (the raw log tail still gets shown). `vstInstalled` is
// injected (default: filesystem check) so tests can exercise both branches.
function diagnoseSclangOutput(output, vstInstalled = vstPluginExtensionInstalled()) {
  if (/Library has not been compiled successfully|duplicate Class found|There is a discrepancy/i.test(output)) {
    return (
      "sclang's class library failed to compile, so poptart's engine script never ran. " +
      'The usual cause is a broken class file or extension in your SuperCollider user directory ' +
      '(on macOS: ~/Library/Application Support/SuperCollider/ - check Extensions/ and startup.scd); ' +
      "the ERROR lines in sclang's log name the file. Also: if you ever symlinked sclang onto your " +
      'PATH by hand, delete the symlink - a symlinked sclang cannot find its class library, and ' +
      'poptart auto-detects the real install anyway.'
    );
  }
  if (/unable to bind udp|failed to bind udp|address (already )?in use|Exception in World_OpenUDP/i.test(output)) {
    return (
      "poptart's OSC/audio ports are already taken - usually an orphaned sclang or scsynth from an " +
      'earlier run, or another SuperCollider session. Quit the SuperCollider IDE if it is open and ' +
      'kill leftovers (`pkill -f sclang; pkill -f scsynth`), then retry.'
    );
  }
  if (/could not initialize audio|DriverStart failed|Requested devices could not be found|device .* not found/i.test(output)) {
    return (
      'scsynth (the audio server) could not open the audio device. Check that the selected output ' +
      'device is connected (or pick another in settings), and that no orphaned scsynth is holding it ' +
      '(`pkill -f scsynth`).'
    );
  }
  if (/Class not defined/i.test(output)) {
    if (!vstInstalled) {
      return (
        'the VSTPlugin SuperCollider extension is not installed (looked in ' +
        `${vstPluginExtensionDirs().join(' and ')}). Download the SC extension for your platform ` +
        'from https://git.iem.at/pd/vstplugin/-/releases and unzip its VSTPlugin folder there, ' +
        'then retry.'
      );
    }
    return (
      "a class poptart's engine script needs failed to load - the ERROR lines in sclang's log say " +
      'which. A stale or half-installed extension in your SuperCollider Extensions folder is the ' +
      'usual cause.'
    );
  }
  if (/server failed to start/i.test(output)) {
    return (
      'scsynth (the audio server) failed to boot - usually the audio device being unavailable, or ' +
      'an orphaned scsynth from an earlier run holding it (`pkill -f scsynth`).'
    );
  }
  // --- silent-stall signatures ---
  // Nothing above matched, so the log doesn't contain an explicit error: it just stops. Locate
  // WHERE it stopped via the boot-progress checkpoints sc/poptart.scd postln's (the two
  // "poptart: ..." strings - kept in sync by hand, see the comment there). Deepest checkpoint
  // reached wins. "Booting server"/"Number of Devices"/"SC_AudioDriver" are sclang's and
  // scsynth's own boot lines - their presence means scsynth actually started talking.
  if (/poptart: booting scsynth/.test(output)) {
    if (/Booting server|Number of Devices|SC_AudioDriver/i.test(output)) {
      return (
        'scsynth (the audio server) started opening the audio device but never finished. Usually ' +
        'the device itself is wedged or misreporting: pick a different output device in settings, ' +
        'kill leftovers (`pkill -f scsynth`), and retry. To see the actual complaint, replay the ' +
        "error's boot config in the SuperCollider IDE - see Troubleshooting in poptart's README."
      );
    }
    return (
      'sclang asked scsynth (the audio server) to boot, but scsynth never produced any output - ' +
      'macOS likely blocked it from starting. If SuperCollider was just installed, launch ' +
      'SuperCollider.app once by hand (right-click it in /Applications, choose Open) so Gatekeeper ' +
      'approves it, and check System Settings > Privacy & Security > Microphone for a pending ' +
      'prompt for your terminal. Then retry.'
    );
  }
  if (/Welcome to SuperCollider/i.test(output) && !/poptart: engine script running/.test(output)) {
    return (
      "sclang started but never ran poptart's engine script. sclang runs your personal startup " +
      'file first, so a hanging ~/Library/Application Support/SuperCollider/startup.scd (one that ' +
      'boots a server, waits on something, or opens a GUI) blocks poptart forever - move it aside ' +
      'and retry. If you have no startup.scd, please report this log.'
    );
  }
  return null;
}

// Overridable via env so a second poptart stack (or a test run) can coexist with a running
// one - see also POPTART_SCSYNTH_PORT in sc/poptart.scd for the third port involved.
const DEFAULT_NODE_PORT = Number(process.env.POPTART_OSC_NODE_PORT || 57140); // Node listens here for replies from sclang
const DEFAULT_SC_PORT = Number(process.env.POPTART_OSC_SC_PORT || 57150); // sclang listens here for commands from Node

const READY_TIMEOUT_MS = 60000; // sclang class-library compile + scsynth boot
const REPLY_TIMEOUT_MS = 10000;
// A first-ever plugin scan probes every installed plugin (out-of-process, ~seconds each, with
// VSTPlugin's own per-plugin timeout skipping any that hang) - can legitimately take minutes.
const SCAN_TIMEOUT_MS = 600000;
// Reading a whole pack into buffers is disk-bound - a gigabyte-scale folder of full-length
// WAVs can legitimately take a minute-plus. The .scd's own read-wait cap stays just under this.
const PACK_LOAD_TIMEOUT_MS = 120000;

// The osc package with `metadata: true` requires args as { type, value } objects - raw JS
// values would throw. Integers map to 'i', other numbers 'f', strings 's'.
const wrap = (i, n) => ((i % n) + n) % n;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function toOscArgs(values) {
  return values.map((v) => {
    if (typeof v === 'string') return { type: 's', value: v };
    if (Number.isInteger(v)) return { type: 'i', value: v };
    if (typeof v === 'number') return { type: 'f', value: v };
    throw new TypeError(`cannot encode OSC argument: ${v}`);
  });
}

class OscEngine {
  // outDevice: CoreAudio output device name (null = system default). outChannels: that
  // device's output channel count - sclang sizes numOutputBusChannels from it so the .o(n)
  // stereo-pair selector wraps at the hardware's real channel count. inChannels: that same
  // device's input channel count (0 for output-only devices) - scsynth opens one device for
  // both in and out, so numInputBusChannels must not exceed what the device offers.
  constructor({ nodePort = DEFAULT_NODE_PORT, scPort = DEFAULT_SC_PORT, sclangPath = null, outDevice = null, outChannels = 2, inChannels = 0 } = {}) {
    this.nodePort = nodePort;
    this.scPort = scPort;
    // An explicit path wins (programmatic intent, e.g. tests); otherwise auto-detect, which
    // honours POPTART_SCLANG and the standard install locations.
    this.sclangPath = sclangPath || resolveSclangPath();
    this.outDevice = outDevice;
    this.outChannels = outChannels;
    this.inChannels = inChannels;
    this._sclangProcess = null;
    this._port = null;
    this._pending = new Map(); // requestId -> { resolve, reject, timer }
    this._nextRequestId = 1;
    // pack name -> { status: 'loading'|'ready'|'error', files: [{ path, duration, channels, slices }] }
    this._packs = new Map();
    this._warned = new Set(); // one-shot warning keys, so per-event problems don't spam the log
    this._stateSeq = new Map(); // "trackId|slot" -> latest restore, so a slow inflate can't win
    // Live CC feed callback, (device, channel 1-16, cc, value 0..1) - set by the host (web-app
    // points it at pattern-core's live-value store). Fired for every /poptart/midiIn message
    // once MIDI is enabled engine-side.
    this.onMidiIn = null;
    // Live note feed callback, (trackId, note, velocity 0..1, isOn) - fired for every
    // /poptart/midiNoteIn message, i.e. each note edge of an active midikeys() route (the note
    // as it sounds, post scale-quantization). What web-app's MIDI record collects.
    this.onMidiNoteIn = null;
    // Plugin-GUI parameter-gesture feed, (trackId, slot, paramName, paramIndex, value 0..1) -
    // fired for every /poptart/paramAutomated message, i.e. each parameter a user moves in a
    // plugin's own editor window while that track is in "conf" (configure) capture mode. Drives
    // web-app's conf feature, which writes the touched parameter into the code as .param(name,
    // value); the index lets it disambiguate plugins that reuse a name (see server's conf code).
    this.onParamAutomated = null;
    // Plugin-edited feed, (trackId, slot) - fired whenever the plugin in a chain slot reports
    // that the user changed something in its own editor window: a knob, a program switch, or a
    // preset loaded from the plugin's internal browser (see watchPluginEdits in poptart.scd).
    // Means "this slot's live state no longer matches the code"; drives web-app's auto-pin,
    // which re-captures the state and writes it back into the synth/fx call. Fires per gesture,
    // so consumers must debounce - capturing a state is a disk write plus a gzip.
    this.onPluginEdited = null;
    // Track->track MIDI routes for the midi() source builder / .midi() injector when the source
    // is another track (not a device): each { name, targetTrackId, slot, note }. Resolved lazily
    // at note time (see _fanoutMidi) so it doesn't matter which track was evaluated first. slot 0
    // routes to the target's instrument (a midi("track") head source); slot >= 1 injects into
    // that fx (a .midi("track") injector). Device sources ("dev:...") don't use this - they go
    // straight to sclang (setMidiNotes / injectMidiDevice).
    this._midiRoutes = [];
  }

  // Does the routing name refer to `sourceTrackId`? Track-first: a bare name (or "track:name")
  // matches a track by exact id; a "dev:" name is a device, never a track.
  _nameIsTrack(name, sourceTrackId) {
    if (name.startsWith('dev:')) return false;
    const n = name.startsWith('track:') ? name.slice(6) : name;
    return n === sourceTrackId;
  }

  // Fan a track's note edge out to every MIDI route whose source resolves to it. Synth sources
  // carry pitch (an instrument route replays it; an injector too, for melodic effects); a fixed
  // note is only used for note-less sources (see playSample). Called after the source's own note.
  _fanoutMidi(sourceTrackId, note, velocity, targetTime, isOn) {
    if (this._midiRoutes.length === 0) return;
    const latency = this._latency(targetTime);
    for (const r of this._midiRoutes) {
      if (!this._nameIsTrack(r.name, sourceTrackId)) continue;
      if (r.slot === 0) {
        if (isOn) this._send('/poptart/noteOn', [r.targetTrackId, note, velocity, latency]);
        else this._send('/poptart/noteOff', [r.targetTrackId, note, latency]);
      } else if (isOn) {
        this._send('/poptart/noteOnSlot', [r.targetTrackId, r.slot, note, velocity, latency]);
      } else {
        this._send('/poptart/noteOffSlot', [r.targetTrackId, r.slot, note, latency]);
      }
    }
  }

  // Fan-out for a note-less (sampler) source: fire the route's fixed note on the sample's rhythm,
  // note-on at onset and note-off at offset (there's no separate off edge to hook like noteOff).
  _fanoutMidiSample(sourceTrackId, velocity, onsetSec, offsetSec) {
    if (this._midiRoutes.length === 0) return;
    for (const r of this._midiRoutes) {
      if (!this._nameIsTrack(r.name, sourceTrackId)) continue;
      const note = r.note ?? 60;
      const onL = this._latency(onsetSec);
      const offL = this._latency(offsetSec);
      if (r.slot === 0) {
        this._send('/poptart/noteOn', [r.targetTrackId, note, velocity, onL]);
        this._send('/poptart/noteOff', [r.targetTrackId, note, offL]);
      } else {
        this._send('/poptart/noteOnSlot', [r.targetTrackId, r.slot, note, velocity, onL]);
        this._send('/poptart/noteOffSlot', [r.targetTrackId, r.slot, note, offL]);
      }
    }
  }

  // Add/replace a track->track MIDI route for (targetTrackId, slot); removes any prior route to
  // the same sink first so a re-eval with a different source doesn't leave a stale one.
  _addMidiRoute(name, targetTrackId, slot, note) {
    this._removeMidiRoute(targetTrackId, slot);
    this._midiRoutes.push({ name, targetTrackId, slot, note });
  }
  _removeMidiRoute(targetTrackId, slot) {
    this._midiRoutes = this._midiRoutes.filter((r) => !(r.targetTrackId === targetTrackId && r.slot === slot));
  }

  version() {
    return '0.1.0-osc';
  }

  // --- device / transport ---

  // Spawns sclang, waits for it to boot the server, load VSTPlugin, and report /poptart/ready.
  // Returns a Promise (unlike the old synchronous NativeEngine#start) since none of this can
  // happen synchronously over a subprocess + OSC round-trip - callers (packages/web-app) must
  // await it before driving the engine.
  start(sampleRate = 48000, bufferSize = 256) {
    // Instant heads-up for the most common fresh-install gap, instead of a 60s timeout: the
    // engine script cannot compile without the VSTPlugin extension. Warn-only, since
    // sclang_conf.yaml can legitimately include it from a non-standard directory.
    if (!vstPluginExtensionInstalled()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[poptart] VSTPlugin extension not found in ${vstPluginExtensionDirs().join(' or ')} - ` +
          'the engine will likely fail to boot. Download it from https://git.iem.at/pd/vstplugin/-/releases ' +
          "and unzip its sc/VSTPlugin folder there (it's a binary extension, not a Quark).",
      );
    }
    return new Promise((resolve, reject) => {
      // Boot-phase failures reject AND tear the half-started stack down: a timed-out start that
      // leaves its sclang running would hold the OSC port and the audio device, making every
      // retry fail the same way - the "works once, then times out forever" trap.
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(err);
        this.stop().catch(() => {});
      };
      // sclang's boot log is where the real cause of a boot failure appears; keep a tail of it
      // to diagnose and embed in the error, since that error (not the terminal) is what the
      // user actually reads.
      let bootLog = '';
      const logBoot = (chunk) => {
        bootLog = (bootLog + chunk).slice(-8000);
      };
      const bootFailure = (headline) => {
        const diagnosis = diagnoseSclangOutput(bootLog);
        const tail = bootLog.trim().split('\n').slice(-12).join('\n');
        return new Error(
          `${headline}${diagnosis ? ` Likely cause: ${diagnosis}` : ''}` +
            (tail ? `\n--- last sclang output ---\n${tail}` : '\n(sclang produced no output)'),
        );
      };

      this._port = new osc.UDPPort({
        localAddress: '127.0.0.1',
        localPort: this.nodePort,
        remoteAddress: '127.0.0.1',
        remotePort: this.scPort,
        metadata: true,
      });

      this._port.on('error', (err) => {
        fail(err);
        // Surface post-start transport errors (e.g. EMSGSIZE on an oversized datagram) instead
        // of letting them vanish into the already-settled promise.
        // eslint-disable-next-line no-console
        console.error(`[poptart] OSC port error: ${err.message}`);
      });
      this._port.on('message', (msg) => this._handleMessage(msg));

      const readyTimer = setTimeout(() => {
        // sclang spawned but never finished booting - do NOT blame PATH here; discovery
        // demonstrably worked. The boot config rides along so a pasted report carries the
        // device/rate/channel picture even when the .scd's checkpoint line isn't in the tail -
        // it's also what the README's IDE-replay procedure tells the user to copy from.
        fail(bootFailure(
          `sclang started but the engine did not finish booting within ${READY_TIMEOUT_MS / 1000}s ` +
          `(boot config - device: ${this.outDevice ?? 'system default'}, sr: ${sampleRate}, ` +
          `block: ${bufferSize}, out: ${this.outChannels}ch, in: ${this.inChannels}ch).`,
        ));
      }, READY_TIMEOUT_MS);

      this._port.once('ready', () => {
        this._sclangProcess = spawn(
          this.sclangPath,
          // -u makes sclang listen for our commands on scPort (its default 57120 would clash
          // with a user's own running SC session anyway).
          ['-u', String(this.scPort), SC_SCRIPT_PATH],
          {
            env: {
              ...process.env,
              POPTART_NODE_PORT: String(this.nodePort),
              POPTART_SAMPLE_RATE: String(sampleRate),
              POPTART_BLOCK_SIZE: String(bufferSize),
              ...(this.outDevice ? { POPTART_OUT_DEVICE: String(this.outDevice) } : {}),
              POPTART_OUT_CHANNELS: String(this.outChannels),
              POPTART_IN_CHANNELS: String(this.inChannels),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );

        // Forward sclang's output (prefixed) rather than letting it accumulate: an unread pipe
        // fills its OS buffer and then blocks sclang mid-print - and scan/load logs are the
        // main debugging surface for plugin problems anyway.
        this._sclangProcess.stdout.on('data', (d) => {
          logBoot(d);
          process.stdout.write(`[sclang] ${d}`);
        });
        this._sclangProcess.stderr.on('data', (d) => {
          logBoot(d);
          process.stderr.write(`[sclang] ${d}`);
        });

        this._sclangProcess.on('error', (err) => {
          const hint =
            err.code === 'ENOENT'
              ? " - couldn't find sclang. Install SuperCollider, or set POPTART_SCLANG to the sclang binary's full path."
              : '';
          fail(new Error(`failed to spawn '${this.sclangPath}': ${err.message}${hint}`));
        });
        this._sclangProcess.on('exit', (code) => {
          // Dying before ready is a boot failure - reject now with the log's diagnosis instead
          // of leaving the user staring at a 60s timeout.
          if (!settled) {
            fail(bootFailure(`sclang exited (code ${code}) before the engine finished booting.`));
            return;
          }
          if (code !== 0 && code !== null) {
            // eslint-disable-next-line no-console
            console.error(`[poptart] sclang exited with code ${code}`);
          }
        });

        const onReady = (msg) => {
          if (msg.address === '/poptart/ready') {
            settled = true;
            clearTimeout(readyTimer);
            this._port.off('message', onReady);
            resolve();
          }
        };
        this._port.on('message', onReady);
      });

      this._port.open();
    });
  }

  // Asks sclang to shut down cleanly - which also quits scsynth (see the .scd's quit handler;
  // an orphaned scsynth would keep the audio device and its port wedged for the next start,
  // e.g. across an output-device change) - escalating to SIGKILL if it doesn't exit in time.
  // Await it before starting a replacement engine.
  async stop() {
    if (this._sclangProcess) {
      const proc = this._sclangProcess;
      this._sclangProcess = null;
      try {
        this._send('/poptart/quit', []);
      } catch {
        // port already gone - fall through to the kill path
      }
      await new Promise((resolve) => {
        if (proc.exitCode != null) return resolve();
        // Resolve at the SIGKILL too, not only on 'exit': a process that never spawned (ENOENT)
        // never emits 'exit', and this promise must not hang on it.
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    if (this._port) {
      this._port.close();
      this._port = null;
    }
  }

  // Node's own wall clock is the scheduling authority (Scheduler computes lookahead deadlines
  // against this); the .scd side converts an incoming absolute target time into a
  // latency-from-now value for Server#sendBundle. See ARCHITECTURE.md's system-overview section.
  getTime() {
    return Date.now() / 1000;
  }

  // Mirrors the host tempo into every open VST as emulated DAW transport (VSTPlugin's
  // setTempo/setTransportPos), applied engine-side in a timestamped bundle at targetTime -
  // this is what makes plugin-internal synced LFOs/delays/arps follow setbpm instead of
  // assuming their own default 120. beatsPos is the song position in beats (4 per cycle,
  // matching setbpm's bpm = cps * 240 convention). Sent on every tempo change and as a
  // periodic re-sync (see web-app server.js), so the plugins' self-advanced transport can't
  // drift against the pattern grid.
  setTempo(bpm, beatsPos, targetTime) {
    this._send('/poptart/setTempo', [bpm, beatsPos, this._latency(targetTime)]);
  }

  // --- plugin discovery ---
  // Returns { plugins, crashed } like the old NativeEngine, for UI compatibility - `crashed`
  // will typically be empty now since VSTPlugin~'s own scanner (VSTPlugin.search) owns
  // crash/hang isolation instead of us.
  scanPlugins(extraPaths = []) {
    return this._request('/poptart/scanPlugins', [JSON.stringify(extraPaths)], SCAN_TIMEOUT_MS);
  }

  getKnownPlugins() {
    return this._request('/poptart/getKnownPlugins', []);
  }

  // --- track / chain management ---
  createTrack(trackId) {
    this._send('/poptart/createTrack', [trackId]);
  }
  loadInstrument(trackId, pluginId) {
    this._send('/poptart/loadInstrument', [trackId, pluginId]);
  }
  loadEffect(trackId, pluginId, position = -1) {
    this._send('/poptart/loadEffect', [trackId, pluginId, position]);
  }
  // Empties an effect slot: re-bypasses it and closes the plugin (freeing its memory).
  // Engine-side no-op if the slot is already empty.
  unloadEffect(trackId, slot) {
    this._send('/poptart/unloadEffect', [trackId, slot]);
  }
  getParams(trackId, slotIndex) {
    return this._request('/poptart/getParams', [trackId, slotIndex]);
  }
  // Records the master bus to a WAV at `filePath` for `seconds`; resolves when done.
  record(filePath, seconds) {
    return this._request('/poptart/record', [filePath, seconds], (seconds + 5) * 1000);
  }
  showPluginEditor(trackId, slotIndex) {
    this._send('/poptart/showPluginEditor', [trackId, slotIndex]);
  }

  // "conf" (configure) capture: while on, the track's open plugins forward every parameter the
  // user moves in their own editor GUI as /poptart/paramAutomated (see onParamAutomated). Off by
  // default so idle plugin windows never chatter over OSC.
  setConfMode(trackId, on) {
    this._send('/poptart/setConfMode', [trackId, on ? 1 : 0]);
  }

  // --- plugin state (the synth("Serum 2", { state }) round-trip) ---
  // A state is VSTPlugin's own program-file format, and always travels between here and sclang as
  // a file - a Serum state is far beyond any UDP datagram.
  //
  // The string form is what the editor buffer carries (gzip+base64), so a patch describes its own
  // sound with nothing to resolve. The compression at both ends is asynchronous for the reason in
  // the gzip/gunzip comment at the top of this file: it shares an event loop with the scheduler.

  /** Restores a state from a file on disk. Fire-and-forget, like the other chain calls. */
  setPluginStateFile(trackId, slotIndex, stateFile) {
    this._send('/poptart/setPluginState', [trackId, slotIndex, stateFile]);
  }

  /** Captures the current full state of the plugin in a chain slot as an opaque string. */
  async getPluginState(trackId, slotIndex) {
    const reply = await this._request('/poptart/getPluginState', [trackId, slotIndex]);
    const data = await fsp.readFile(reply.path);
    await fsp.unlink(reply.path).catch(() => {}); // sclang's temp copy; already gone is fine
    return (await gzip(data)).toString('base64');
  }

  /**
   * Restores a state captured by getPluginState. Fire-and-forget like the other chain calls;
   * the .scd side waits for the slot's plugin to finish loading before applying.
   *
   * Decompressing off the loop makes this asynchronous, so two states landing on one slot in
   * quick succession (an eval while an earlier one is still inflating) could otherwise arrive
   * out of order and leave the plugin on the older program. `_stateSeq` drops any restore a newer
   * one has already superseded.
   */
  setPluginState(trackId, slotIndex, state) {
    const key = `${trackId}|${slotIndex}`;
    const seq = (this._stateSeq.get(key) ?? 0) + 1;
    this._stateSeq.set(key, seq);
    const superseded = () => this._stateSeq.get(key) !== seq;
    (async () => {
      let data;
      try {
        data = await gunzip(Buffer.from(String(state), 'base64'));
      } catch (e) {
        this._warnOnce(`state:${trackId}:${slotIndex}`, `[poptart] plugin state for ${trackId}/slot ${slotIndex} is not a valid captured state string (${e.message}) - ignoring`);
        return;
      }
      if (superseded()) return;
      const stateFile = path.join(os.tmpdir(), `poptart-state-${trackId}-${slotIndex}-${Date.now()}.fxp`);
      await fsp.writeFile(stateFile, data);
      if (superseded()) return;
      this._send('/poptart/setPluginState', [trackId, slotIndex, stateFile]);
    })().catch((e) => {
      this._warnOnce(`state-write:${trackId}:${slotIndex}`, `[poptart] could not restore plugin state for ${trackId}/slot ${slotIndex}: ${e.message ?? e}`);
    });
  }

  // --- sampler ---

  _warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    // eslint-disable-next-line no-console
    console.warn(message);
  }

  // Kicks off (once) the async load of a pack: enumerate its files, have sclang read them into
  // buffers, then analyze WAVs for transient slices. Events that arrive while the pack is still
  // loading are dropped - a beat of silence on first eval, then everything plays.
  _ensurePack(pack) {
    let entry = this._packs.get(pack);
    if (entry) return entry;
    entry = { status: 'loading', files: [] };
    this._packs.set(pack, entry);

    const paths = listPackFiles(pack);
    if (!paths || paths.length === 0) {
      entry.status = 'error';
      this._warnOnce(`pack:${pack}`, `[poptart] sample pack "${pack}" has no audio files (looked in ${samplesRoot()}/${pack})`);
      return entry;
    }

    // The paths JSON can be far bigger than one UDP datagram (macOS caps sends at ~9KB and a
    // 700-file pack is ~70KB), so mirror the .scd's replyOk temp-file scheme in this direction
    // too: send only a file path, sclang reads and deletes the file.
    const pathsFile = path.join(os.tmpdir(), `poptart-pack-${pack.replace(/[^\w-]/g, '_')}-${Date.now()}.json`);
    fs.writeFileSync(pathsFile, JSON.stringify(paths));
    this._request('/poptart/loadSamplePack', [pack, pathsFile], PACK_LOAD_TIMEOUT_MS)
      .then((metas) => {
        entry.files = metas.map((m, i) => ({
          path: paths[i],
          duration: m.sampleRate > 0 ? m.frames / m.sampleRate : 0,
          channels: m.channels,
          slices: detectSlices(paths[i]), // null for non-WAV - .slice() then warns instead of failing
        }));
        entry.status = 'ready';
        // eslint-disable-next-line no-console
        console.log(`[poptart] sample pack "${pack}": ${entry.files.length} file(s) loaded`);
      })
      .catch((err) => {
        entry.status = 'error';
        this._warnOnce(`pack:${pack}`, `[poptart] sample pack "${pack}" failed to load: ${err.message}`);
      });
    return entry;
  }

  /**
   * One sampler event (see Scheduler#_scheduleNoteEdges). `cfg` carries the per-onset values of
   * the pattern's config signals plus `secPerCycle`: { index, begin, end, loop, speed, flip,
   * stretch, fit ('auto' | measures), slice, note, vel, attack, decay, sustain, release,
   * loopWrap (0 file | 1 window), loopDir (0 forward | 1 pingpong), secPerCycle }.
   * Resolves pack/index/slice/fit
   * down to the plain numbers the SC synth takes; `fit` becomes a speed multiplier so the
   * whole sample lasts exactly the target number of cycles, `note` a further multiplier that
   * repitches around MIDI 24 ("c2" = as recorded), `flip` a sign flip plus a re-anchored onset.
   * `vel` scales volume linearly.
   *
   * Returns what it resolved (the loop modes as their names, for the log line) - { index, begin,
   * end, loop, loopWrap, loopDir, speed, stretch,
   * durSec, cut, amp, fileSec }, or { skipped } for an event that makes no sound. Nothing in playback reads it;
   * it exists so .log() can report the numbers the synth is really getting (the fit rate and
   * the window's length in particular are computed here and nowhere else).
   */
  playSample(trackId, pack, cfg, onsetSec, offsetSec) {
    // A sampler source has no pitch, so any MIDI route off this track fires its fixed note on the
    // sample's rhythm. Done first, so a ducker/arp keyed off a drum pattern triggers even before
    // the pack finishes loading (when the sample itself would still be silent).
    this._fanoutMidiSample(trackId, cfg.vel ?? 1, onsetSec, offsetSec);
    const entry = this._ensurePack(pack);
    if (entry.status !== 'ready' || entry.files.length === 0) return { skipped: `pack "${pack}" ${entry.status}` };

    const amp = cfg.vel ?? 1;
    if (amp <= 0) return { skipped: 'vel 0' };

    const idx = wrap(Math.round(cfg.index ?? 0), entry.files.length);
    const file = entry.files[idx];

    let begin = clamp01(cfg.begin ?? 0);
    let end = clamp01(cfg.end ?? 1);
    if (cfg.slice != null) {
      if (file.slices?.length) {
        const k = wrap(Math.round(cfg.slice), file.slices.length);
        begin = file.slices[k];
        end = file.slices[k + 1] ?? 1;
      } else {
        this._warnOnce(`slices:${file.path}`, `[poptart] .slice(): no transient analysis for ${file.path} (only WAV files are analyzed) - playing the whole sample`);
      }
    }
    if (end < begin) [begin, end] = [end, begin];

    let speed = cfg.speed ?? 1;
    // .flip() is a switch, not a rate: over 0.5 it negates whatever speed is in force (so it
    // toggles cleanly off any 0..1 signal - .flip(rand()), .flip("<1 0>")) and re-anchors the
    // voice to the step's end below. Sign is all it touches; fit/note keep scaling the magnitude.
    const flip = (cfg.flip ?? 0) > 0.5;
    if (flip) speed *= -1;
    const stretch = cfg.stretch > 0 ? cfg.stretch : 1;
    const spanSec = file.duration * (end - begin);
    if (speed === 0 || spanSec <= 0) return { skipped: speed === 0 ? 'speed 0' : 'empty begin..end window' };

    if (cfg.fit != null) {
      // Fit is a property of the whole sample, not the begin..end window: the rate is set so
      // the FULL file lasts the target number of cycles, and begin/end/slice then select a
      // window at that fixed rate. Basing it on the window instead would make a randomized
      // .begin() (s("breaks").fit().vel("1!16").begin(irand(16).div(16))) repitch every hit.
      const measures = file.duration / cfg.secPerCycle;
      const target = cfg.fit === 'auto' ? 2 ** Math.round(Math.log2(measures)) : cfg.fit;
      if (target > 0) speed *= measures / target;
    }
    if (cfg.note != null) speed *= 2 ** ((cfg.note - 24) / 12); // repitch: MIDI 24 ("c2") = as recorded

    // Speed is a continuous rate read off `begin`: the playhead leaves `begin` at `speed`, so
    // positive runs up to `end` and 0 holds still. Going the other way it walks BACKWARDS out of
    // `begin`, which only has anywhere to go if the window is a circle - so a negative speed
    // loops by default, wrapping `begin` round to `end`. That makes the rate continuous through
    // zero (begin and end are the same point on the circle) and means .speed(-1) on a plain
    // sample is the familiar "play it backwards from the end", repeating for the event. An
    // explicit .loop(0) opts out: one backwards pass from `end`, then silence. .flip() is a
    // single anchored pass by definition, so it never picks up the auto-loop.
    const loop = (cfg.loop ?? (speed < 0 && !flip ? 1 : 0)) ? 1 : 0;
    // Where a loop runs and where it enters it (the SC loop defs take the three as arguments, so
    // one def covers both wrap modes). "file" - mode 0, the default - makes the loop the whole
    // sample and `begin` only the entry point, so .begin(0.9).loop() runs out the end and carries
    // on from the top instead of repeating that last tenth; "window" (mode 1) keeps it inside
    // begin..end, which is what a .slice() loop wants. Backwards through a WINDOW enters at its far edge, as it always has;
    // wrapping through the file has somewhere to go from `begin` in either direction, so it starts
    // there and reaches the file's edge in its own time.
    // The two modes arrive as NUMBERS (.loopwrap()/.loopdir() are ordinary patternable channels):
    // 0 = file/forward, 1 = window/pingpong. Rounded and wrapped here as well as in the scheduler,
    // so a direct engine call - or any raw value that reached here unnormalised - still names a
    // real mode instead of silently reading as the default.
    const mode = (v, count) => {
      const idx = Math.round(Number(v));
      return Number.isFinite(idx) ? wrap(idx, count) : 0;
    };
    const windowed = mode(cfg.loopWrap ?? 0, 2) === 1;
    const pingpong = mode(cfg.loopDir ?? 0, 2);
    const loopLo = windowed ? begin : 0;
    const loopHi = windowed ? end : 1;
    const loopEntry = windowed && speed < 0 ? end : begin;
    // Natural playback length in seconds - what the one-shot synths' Line runs over. Also for a
    // loop: it's the begin..end window's own length, which is what the ADSR times scale by (a
    // loop's audio has no length of its own - it runs until the event's gate-off).
    let durSec = (spanSec * stretch) / Math.abs(speed);
    const eventSec = offsetSec - onsetSec;
    // .flip() reverses the window AND re-anchors it: playback runs from one step's worth of audio
    // past `begin` back down to `begin`, landing on `begin` exactly at the step's end, so a
    // flipped hit sweeps *into* the next one (s("sd").flip("<1 0>*2")).
    if (flip && speed < 0 && !loop) {
      if (durSec > eventSec + 0.005) {
        // Window longer than the step: the start position lands inside it, so trim to that head.
        end = begin + (eventSec * Math.abs(speed)) / stretch / file.duration;
        durSec = eventSec;
      } else {
        // Window shorter than the step: the start position is past `end`, i.e. silence. Rather
        // than read past the window, just delay the voice - unspawned is the same silence - so
        // the whole window still finishes on `begin` at the step's end. Only the audio moves:
        // the MIDI fanout above already fired on the pattern's grid.
        onsetSec = offsetSec - durSec;
      }
    }
    // Sampler events are always gated to their event: a one-shot that would outlast its step
    // gets a gate-off at the step's end instead of ringing its natural length ("gate mode",
    // like Ableton Sampler's). The event length is whatever the pattern's step grid computed -
    // s() alone means whole steps (a bare s("long") cuts at each cycle); patterned config
    // (.vel()/.note()/.slice()/.i()...) subdivides it further. To let a sample ring longer, make its *event* longer
    // ("long/2", "long@2", "long _"). Loops already gate there; the small margin avoids
    // cutting a voice that ends naturally anyway.
    const cut = !loop && durSec > eventSec + 0.005 ? 1 : 0;
    this._send('/poptart/playSample', [
      trackId,
      pack,
      idx,
      begin,
      end,
      loop,
      speed,
      stretch,
      durSec,
      this._latency(onsetSec),
      this._latency(offsetSec),
      amp,
      cut,
      // ADSR amplitude envelope: attack/decay/release multiply the played duration (SC scales
      // them by dur - .attack(2) ramps over 2*dur), sustain is a 0..1 level. Defaults of 0/0/1/0
      // floor down to the sampler's original tiny declick envelope, so unset ADSR is unchanged.
      cfg.attack ?? 0,
      cfg.decay ?? 0,
      cfg.sustain ?? 1,
      cfg.release ?? 0,
      loopLo,
      loopHi,
      loopEntry,
      pingpong,
    ]);
    return {
      index: idx, begin, end, loop, speed, stretch, durSec, cut, amp, fileSec: file.duration,
      loopWrap: windowed ? 'window' : 'file', loopDir: pingpong ? 'pingpong' : 'forward',
    };
  }

  // --- events (targetTime is seconds, from OscEngine#getTime()'s clock) ---
  // Converted to a latency-from-now (seconds) right before sending, computed against the same
  // clock getTime() uses - sclang just feeds that straight to Server#sendBundle, no clock sync
  // between Node and sclang required. A negative latency (deadline already passed - e.g. a
  // slow tick) is clamped to 0 (fire immediately) rather than sent negative, since
  // Server:sendBundle treats negative latency as "now" inconsistently across versions.
  noteOn(trackId, note, velocity, targetTime) {
    this._send('/poptart/noteOn', [trackId, note, velocity, this._latency(targetTime)]);
    this._fanoutMidi(trackId, note, velocity, targetTime, true);
  }
  noteOff(trackId, note, targetTime) {
    this._send('/poptart/noteOff', [trackId, note, this._latency(targetTime)]);
    this._fanoutMidi(trackId, note, 0, targetTime, false);
  }
  setParam(trackId, slotIndex, paramName, value, targetTime) {
    this._send('/poptart/setParam', [trackId, slotIndex, paramName, value, this._latency(targetTime)]);
  }
  // ir: { shape: 'sine'|'saw'|'tri'|'square'|'ramp'|'rand', rateHz, phaseCycles, min, max } for
  // the basic shapes, or { shape: 'custom', points, mode, ... } for lfo() drawn shapes - see
  // signal.mjs / shape.mjs.
  // sclang maps a control bus to the VST parameter once and drives it with an internal UGen
  // (SinOsc.kr etc.) inside the track's SynthDef - the SC equivalent of the old native LFO.h,
  // zero further OSC traffic after this call. Custom shapes go through a separate handler that
  // compiles a small SynthDef from the breakpoints (IEnvGen driven by a Sweep phase).
  setParamLFO(trackId, slotIndex, paramName, ir) {
    if (ir.shape === 'custom') {
      this._send('/poptart/setParamShapeLFO', [
        trackId,
        slotIndex,
        paramName,
        ir.mode ?? 'free',
        ir.rateHz,
        ir.phaseCycles ?? 0,
        ir.min,
        ir.max,
        JSON.stringify(ir.points),
      ]);
      return;
    }
    this._send('/poptart/setParamLFO', [
      trackId,
      slotIndex,
      paramName,
      ir.shape,
      ir.rateHz,
      ir.phaseCycles,
      ir.min,
      ir.max,
    ]);
  }
  clearParamLFO(trackId, slotIndex, paramName) {
    this._send('/poptart/clearParamLFO', [trackId, slotIndex, paramName]);
  }
  // Re-pins a free-running LFO's phase (0..1) to the scheduler's clock at targetTime - the
  // periodic drift correction described at scheduler.mjs's LFO_ANCHOR_INTERVAL_SEC. sclang
  // resets the modulator's phase in a timestamped bundle, same path as note events.
  anchorParamLFO(trackId, slotIndex, paramName, phase01, targetTime) {
    this._send('/poptart/anchorParamLFO', [trackId, slotIndex, paramName, phase01, this._latency(targetTime)]);
  }
  // ADSR envelope retriggered by the track's note on/offs - same set-once Tier-2 contract as
  // setParamLFO (see the poptart_env SynthDef + gate wiring in sc/poptart.scd).
  setParamEnv(trackId, slotIndex, paramName, ir) {
    this._send('/poptart/setParamEnv', [
      trackId,
      slotIndex,
      paramName,
      ir.attack,
      ir.decay,
      ir.sustain,
      ir.release,
      ir.curve ?? -4,
      ir.min,
      ir.max,
    ]);
  }
  clearParamEnv(trackId, slotIndex, paramName) {
    this._send('/poptart/clearParamEnv', [trackId, slotIndex, paramName]);
  }

  // --- MIDI input (see the "live MIDI input" section of sc/poptart.scd) ---

  // Idempotent: sclang initializes CoreMIDI and starts forwarding CC events back as
  // /poptart/midiIn (consumed via onMidiIn above). The native paths below enable MIDI on their
  // own; this exists for patterns whose only MIDI use is Tier-1 (a cc signal inside arithmetic),
  // which is sampled Node-side and would otherwise never get its live feed.
  enableMidi() {
    this._send('/poptart/midiInit', []);
  }

  // Connected CoreMIDI sources as the "device name" strings midicc()/midikeys() patterns are
  // matched against. Enables MIDI input as a side effect (see poptart.scd).
  getMidiDevices() {
    return this._request('/poptart/getMidiDevices', []);
  }

  // Route a device's live performance stream (notes/velocity/bend/aftertouch/raw CC) to the
  // track's instrument, entirely engine-side - live playing never goes through the lookahead
  // scheduler. channel 0 = all channels. Device names match by case-insensitive substring.
  // scalePcs (optional array of pitch classes 0-11, from .scale() on the midikeys chain)
  // quantizes incoming notes to the scale before they reach the instrument.
  setMidiNotes(trackId, device, channel = 0, scalePcs = null) {
    this._send('/poptart/midiRoute', [trackId, device, channel, (scalePcs ?? []).join(',')]);
  }
  clearMidiNotes(trackId) {
    this._send('/poptart/clearMidiRoute', [trackId]);
  }

  // ir: { device, cc, channel (null = all), min, max }. sclang registers a MIDIdef that writes
  // the scaled value to a control bus mapped onto the parameter - the CC sibling of
  // setParamLFO's mechanism, zero per-event traffic from Node and no poll latency.
  setParamCC(trackId, slotIndex, paramName, ir) {
    this._send('/poptart/setParamCC', [trackId, slotIndex, paramName, ir.device, ir.cc, ir.channel ?? 0, ir.min, ir.max]);
  }
  clearParamCC(trackId, slotIndex, paramName) {
    this._send('/poptart/clearParamCC', [trackId, slotIndex, paramName]);
  }

  // --- midi()/audio() source + injector routing ---
  //
  // A routing `name` is either another track (bare, or "track:label") or a hardware input
  // ("dev:substring"). Track-first resolution: bare names are treated as track names here (MIDI
  // fanned out in Node, audio bussed in sclang); only "dev:" names hit a device path.

  _isDevice(name) {
    return String(name).startsWith('dev:');
  }
  _deviceName(name) {
    return String(name).slice(4); // strip "dev:"
  }

  // Live head input from the midi()/audio() source builders. io 'midi': play the source's notes
  // on this track's instrument (slot 0) - a track source fans out in Node, a device reuses the
  // midikeys note-route. io 'audio': feed the source's audio into the chain input (sclang).
  //
  // `hwChans` is [left, right] absolute 0-indexed hardware channels for an input() source (right
  // -1 = mono, centred engine-side), already resolved against the device layout in pattern-core;
  // null for a track/bus source or a legacy audio("dev:...") string, which default to channels 0+1.
  setInputSource(trackId, io, name, channel = 0, scalePcs = null, hwChans = null) {
    if (io === 'midi') {
      if (this._isDevice(name)) this.setMidiNotes(trackId, this._deviceName(name), channel, scalePcs);
      else this._addMidiRoute(name, trackId, 0, null); // slot 0 = instrument, null note = pass source pitch
    } else if (io === 'audio') {
      const [chA, chB] = hwChans ?? [0, 1];
      this._send('/poptart/setAudioInput', [trackId, name, chA, chB]);
    }
  }
  clearInputSource(trackId) {
    this._removeMidiRoute(trackId, 0);
    this.clearMidiNotes(trackId); // no-op unless a device note-route was set for this track
    this._send('/poptart/clearAudioInput', [trackId]);
  }

  // Route a track's output to one or more named audio buses (Sig#bus). `sends` is an array of
  // { name, amount }; the whole set replaces the track's current sends. sclang allocates each bus
  // on first use (any number of tracks on the same name sum into it) and frees it when
  // unreferenced. The dry path is untouched (see the 'dry' channel param); read a bus's sum with
  // the audio("name") head source (setInputSource io 'audio').
  setBusSends(trackId, sends = []) {
    const pairs = sends.flatMap(({ name, amount }) => [String(name), amount ?? 1]);
    this._send('/poptart/setBusSends', [trackId, ...pairs]);
  }
  clearBusSends(trackId) {
    this._send('/poptart/clearBusSends', [trackId]);
  }

  // Inject audio into the plugin at `slot` as its aux/sidechain input (Sig#audio injector). A
  // track source: sclang allocates a cross-track bus, maps it into that slot's VSTPlugin aux bus,
  // adds a send from the source track's output, and orders the source ahead so the send lands the
  // same block. A "dev:" source: sclang feeds SoundIn into the aux bus. gain scales the send.
  // `hwChans` is as in setInputSource - the resolved channels of an .audio(input(n)) sidechain.
  injectAudio(trackId, slot, name, gain = 1, hwChans = null) {
    const [chA, chB] = hwChans ?? [0, 1];
    this._send('/poptart/injectAudio', [trackId, slot, name, gain, chA, chB]);
  }
  clearAudioInject(trackId, slot) {
    this._send('/poptart/clearAudioInject', [trackId, slot]);
  }

  // Inject MIDI into the plugin at `slot` from a named source (Sig#midi injector, named form). A
  // track source fans out in Node (its notes replay to the plugin); a "dev:" source routes the
  // hardware device's MIDI to the plugin in sclang. `note` is the fixed pitch for note-less
  // (sampler) sources; melodic sources pass their own pitch through.
  injectMidi(trackId, slot, name, note = 60) {
    if (this._isDevice(name)) this._send('/poptart/injectMidiDevice', [trackId, slot, this._deviceName(name), note]);
    else this._addMidiRoute(name, trackId, slot, note);
  }
  clearMidiInject(trackId, slot) {
    this._removeMidiRoute(trackId, slot);
    this._send('/poptart/clearMidiInject', [trackId, slot]); // frees any device MIDIdefs for this sink
  }

  // --- internals ---

  _latency(targetTime) {
    return Math.max(0, targetTime - this.getTime());
  }

  _send(address, args) {
    if (!this._port) throw new Error('OscEngine not started - call start() first');
    this._port.send({ address, args: toOscArgs(args) });
  }

  _request(address, args, timeoutMs = REPLY_TIMEOUT_MS) {
    if (!this._port) return Promise.reject(new Error('OscEngine not started - call start() first'));

    const requestId = this._nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error(`${address} timed out waiting for a reply after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pending.set(requestId, { resolve, reject, timer });
      this._port.send({ address, args: toOscArgs([requestId, ...args]) });
    });
  }

  _handleMessage(msg) {
    if (msg.address === '/poptart/midiIn') {
      // Live CC feed for Tier-1 signal sampling: [deviceName, channel (1-16), cc, value 0..1].
      const [device, channel, cc, value] = (msg.args ?? []).map((a) => a?.value ?? a);
      if (typeof this.onMidiIn === 'function') this.onMidiIn(String(device), Number(channel), Number(cc), Number(value));
      return;
    }
    if (msg.address === '/poptart/midiNoteIn') {
      // Live note feed from an active midikeys() route: [trackId, note, velocity 0..1, isOn].
      const [track, note, vel, on] = (msg.args ?? []).map((a) => a?.value ?? a);
      if (typeof this.onMidiNoteIn === 'function') this.onMidiNoteIn(String(track), Number(note), Number(vel), Number(on) !== 0);
      return;
    }
    if (msg.address === '/poptart/paramAutomated') {
      // A parameter moved in a plugin's own editor GUI: [trackId, slot, paramName, paramIndex, value 0..1].
      const [track, slot, name, index, value] = (msg.args ?? []).map((a) => a?.value ?? a);
      if (typeof this.onParamAutomated === 'function') this.onParamAutomated(String(track), Number(slot), String(name), Number(index), Number(value));
      return;
    }
    if (msg.address === '/poptart/pluginEdited') {
      // The user changed something in a plugin's own editor window: [trackId, slot].
      const [track, slot] = (msg.args ?? []).map((a) => a?.value ?? a);
      if (typeof this.onPluginEdited === 'function') this.onPluginEdited(String(track), Number(slot));
      return;
    }
    if (!msg.address.endsWith('.reply')) return;

    const args = msg.args ?? [];
    const requestId = args[0]?.value ?? args[0];
    const pending = this._pending.get(requestId);
    if (!pending) return; // not one of ours (or already timed out) - ignore

    clearTimeout(pending.timer);
    this._pending.delete(requestId);

    const payloadArg = args[1];
    const payload = payloadArg?.value ?? payloadArg;
    if (msg.address.endsWith('.error.reply')) {
      pending.reject(new Error(String(payload)));
      return;
    }
    // Success replies carry a temp-file path, not inline JSON - payloads routinely exceed the
    // ~64KB UDP datagram limit (see replyOk in sc/poptart.scd).
    try {
      const json = fs.readFileSync(payload, 'utf8');
      fs.unlinkSync(payload);
      pending.resolve(JSON.parse(json));
    } catch (e) {
      pending.reject(new Error(`malformed reply for ${msg.address}: ${e.message}`));
    }
  }
}

module.exports = {
  OscEngine,
  resolveSclangPath,
  knownSclangLocations,
  onPath,
  diagnoseSclangOutput,
  vstPluginExtensionDirs,
  vstPluginExtensionInstalled,
};
