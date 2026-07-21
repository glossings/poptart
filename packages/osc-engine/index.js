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
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const osc = require('osc');

const SC_SCRIPT_PATH = path.join(__dirname, 'sc', 'poptart.scd');

const DEFAULT_NODE_PORT = 57140; // Node listens here for replies from sclang
const DEFAULT_SC_PORT = 57150; // sclang listens here for commands from Node

const READY_TIMEOUT_MS = 60000; // sclang class-library compile + scsynth boot
const REPLY_TIMEOUT_MS = 10000;
// A first-ever plugin scan probes every installed plugin (out-of-process, ~seconds each, with
// VSTPlugin's own per-plugin timeout skipping any that hang) - can legitimately take minutes.
const SCAN_TIMEOUT_MS = 600000;

// The osc package with `metadata: true` requires args as { type, value } objects - raw JS
// values would throw. Integers map to 'i', other numbers 'f', strings 's'.
function toOscArgs(values) {
  return values.map((v) => {
    if (typeof v === 'string') return { type: 's', value: v };
    if (Number.isInteger(v)) return { type: 'i', value: v };
    if (typeof v === 'number') return { type: 'f', value: v };
    throw new TypeError(`cannot encode OSC argument: ${v}`);
  });
}

class OscEngine {
  constructor({ nodePort = DEFAULT_NODE_PORT, scPort = DEFAULT_SC_PORT, sclangPath = 'sclang' } = {}) {
    this.nodePort = nodePort;
    this.scPort = scPort;
    this.sclangPath = sclangPath;
    this._sclangProcess = null;
    this._port = null;
    this._pending = new Map(); // requestId -> { resolve, reject, timer }
    this._nextRequestId = 1;
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

      this._port.on('error', (err) => reject(err));
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

  stop() {
    if (this._sclangProcess) {
      this._send('/poptart/quit', []);
      this._sclangProcess.kill();
      this._sclangProcess = null;
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
  // ir: { shape: 'sine'|'saw'|'tri'|'square'|'ramp'|'drift'|'sandy', rateHz, phaseCycles, min, max }
  // - see signal.mjs.
  // sclang maps a control bus to the VST parameter once and drives it with an internal UGen
  // (SinOsc.kr etc.) inside the track's SynthDef - the SC equivalent of the old native LFO.h,
  // zero further OSC traffic after this call.
  setParamLFO(trackId, slotIndex, paramName, ir) {
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
