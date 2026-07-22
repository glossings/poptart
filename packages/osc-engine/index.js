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
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const osc = require('osc');
const { samplesRoot, listPackFiles, detectSlices } = require('./samples');

const SC_SCRIPT_PATH = path.join(__dirname, 'sc', 'poptart.scd');

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
  constructor({ nodePort = DEFAULT_NODE_PORT, scPort = DEFAULT_SC_PORT, sclangPath = 'sclang', outDevice = null, outChannels = 2, inChannels = 0 } = {}) {
    this.nodePort = nodePort;
    this.scPort = scPort;
    this.sclangPath = sclangPath;
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
    // Live CC feed callback, (device, channel 1-16, cc, value 0..1) - set by the host (web-app
    // points it at pattern-core's live-value store). Fired for every /poptart/midiIn message
    // once MIDI is enabled engine-side.
    this.onMidiIn = null;
    // Live note feed callback, (trackId, note, velocity 0..1, isOn) - fired for every
    // /poptart/midiNoteIn message, i.e. each note edge of an active midikeys() route (the note
    // as it sounds, post scale-quantization). What web-app's MIDI record collects.
    this.onMidiNoteIn = null;
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
    return new Promise((resolve, reject) => {
      this._port = new osc.UDPPort({
        localAddress: '127.0.0.1',
        localPort: this.nodePort,
        remoteAddress: '127.0.0.1',
        remotePort: this.scPort,
        metadata: true,
      });

      this._port.on('error', (err) => {
        reject(err); // no-op once start() has settled
        // Surface post-start transport errors (e.g. EMSGSIZE on an oversized datagram) instead
        // of letting them vanish into the already-settled promise.
        // eslint-disable-next-line no-console
        console.error(`[poptart] OSC port error: ${err.message}`);
      });
      this._port.on('message', (msg) => this._handleMessage(msg));

      const readyTimer = setTimeout(() => {
        reject(new Error(`sclang did not report /poptart/ready within ${READY_TIMEOUT_MS}ms - is SuperCollider installed and is 'sclang' on PATH?`));
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
        this._sclangProcess.stdout.on('data', (d) => process.stdout.write(`[sclang] ${d}`));
        this._sclangProcess.stderr.on('data', (d) => process.stderr.write(`[sclang] ${d}`));

        this._sclangProcess.on('error', (err) => {
          clearTimeout(readyTimer);
          reject(new Error(`failed to spawn '${this.sclangPath}': ${err.message}`));
        });
        this._sclangProcess.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            // eslint-disable-next-line no-console
            console.error(`[poptart] sclang exited with code ${code}`);
          }
        });

        const onReady = (msg) => {
          if (msg.address === '/poptart/ready') {
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
        const killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
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

  // --- plugin state (the synth("Serum 2", { state }) round-trip) ---
  // The state string is gzip+base64 of VSTPlugin's own program-file format, so it's compact
  // enough to live inside code / a URL hash and opaque by design. Both directions travel via
  // temp file - a Serum state is far beyond any UDP datagram.

  /** Captures the current full state of the plugin in a chain slot as an opaque string. */
  async getPluginState(trackId, slotIndex) {
    const reply = await this._request('/poptart/getPluginState', [trackId, slotIndex]);
    const data = fs.readFileSync(reply.path);
    fs.unlinkSync(reply.path);
    return zlib.gzipSync(data).toString('base64');
  }

  /**
   * Restores a state captured by getPluginState. Fire-and-forget like the other chain calls;
   * the .scd side waits for the slot's plugin to finish loading before applying.
   */
  setPluginState(trackId, slotIndex, state) {
    let data;
    try {
      data = zlib.gunzipSync(Buffer.from(String(state), 'base64'));
    } catch (e) {
      this._warnOnce(`state:${trackId}:${slotIndex}`, `[poptart] plugin state for ${trackId}/slot ${slotIndex} is not a valid captured state string (${e.message}) - ignoring`);
      return;
    }
    const stateFile = path.join(os.tmpdir(), `poptart-state-${trackId}-${slotIndex}-${Date.now()}.fxp`);
    fs.writeFileSync(stateFile, data);
    this._send('/poptart/setPluginState', [trackId, slotIndex, stateFile]);
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
   * the pattern's config signals plus `secPerCycle`: { index, begin, end, loop, speed, stretch,
   * fit ('auto' | measures), slice, note, vel, secPerCycle }. Resolves pack/index/slice/fit
   * down to the plain numbers the SC synth takes; `fit` becomes a speed multiplier so the
   * played region lasts exactly the target number of cycles, `note` a further multiplier that
   * repitches around MIDI 24 ("c2" = as recorded). `vel` scales volume linearly.
   */
  playSample(trackId, pack, cfg, onsetSec, offsetSec) {
    const entry = this._ensurePack(pack);
    if (entry.status !== 'ready' || entry.files.length === 0) return;

    const amp = cfg.vel ?? 1;
    if (amp <= 0) return;

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
    const stretch = cfg.stretch > 0 ? cfg.stretch : 1;
    const spanSec = file.duration * (end - begin);
    if (speed === 0 || spanSec <= 0) return;

    if (cfg.fit != null) {
      const measures = spanSec / cfg.secPerCycle;
      const target = cfg.fit === 'auto' ? 2 ** Math.round(Math.log2(measures)) : cfg.fit;
      if (target > 0) speed *= measures / target;
    }
    if (cfg.note != null) speed *= 2 ** ((cfg.note - 24) / 12); // repitch: MIDI 24 ("c2") = as recorded

    const loop = cfg.loop ? 1 : 0;
    // Natural playback length in seconds - what the one-shot synths' Line runs over.
    const durSec = (spanSec * stretch) / Math.abs(speed);
    // Sampler events are always gated to their event: a one-shot that would outlast its step
    // gets a gate-off at the step's end instead of ringing its natural length ("gate mode",
    // like Ableton Sampler's). The event length is whatever the pattern's step grid computed -
    // s() alone means whole steps (a bare s("long") cuts at each cycle); patterned config
    // (.vel()/.note()/.slice()/.i()...) subdivides it further. To let a sample ring longer, make its *event* longer
    // ("long/2", "long@2", "long _"). Loops already gate there; the small margin avoids
    // cutting a voice that ends naturally anyway.
    const cut = !loop && durSec > offsetSec - onsetSec + 0.005 ? 1 : 0;
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
    ]);
  }

  // --- events (targetTime is seconds, from OscEngine#getTime()'s clock) ---
  // Converted to a latency-from-now (seconds) right before sending, computed against the same
  // clock getTime() uses - sclang just feeds that straight to Server#sendBundle, no clock sync
  // between Node and sclang required. A negative latency (deadline already passed - e.g. a
  // slow tick) is clamped to 0 (fire immediately) rather than sent negative, since
  // Server:sendBundle treats negative latency as "now" inconsistently across versions.
  noteOn(trackId, note, velocity, targetTime) {
    this._send('/poptart/noteOn', [trackId, note, velocity, this._latency(targetTime)]);
  }
  noteOff(trackId, note, targetTime) {
    this._send('/poptart/noteOff', [trackId, note, this._latency(targetTime)]);
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

module.exports = { OscEngine };
