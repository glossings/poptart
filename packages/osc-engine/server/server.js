'use strict';

// scsynth, driven straight from Node: boots it with poptart's options, talks to it over one UDP
// socket, and owns every node, bus and buffer id on it (alloc.js). The ported engine
// (../engine/) and the direct path (../direct.js) both send through this.

const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const osc = require('osc');
const { BlockAllocator, NodeIdAllocator } = require('./alloc');
const { timeTagFor, packBundles, encode, MAX_DATAGRAM } = require('../direct');

// What scsynth prints once it is listening.
const READY_LINE = /SuperCollider 3 server ready/;
// The class library's choices that poptart never changes (see ServerOptions.asOptionsString).
const FIXED_ARGS = ['-R', '0', '-C', '1', '-l', '1', '-s', '1.26'];
const NOW_LEAD_SEC = 0.001; // see bundleNow in the engine: less lead than this is sent unstamped

/**
 * scsynth's command line for a set of options. Mirrors ServerOptions.asOptionsString in the
 * class library, flag for flag, for the options poptart sets.
 */
function scsynthArgs(o) {
  const args = ['-u', String(o.port)];
  args.push('-a', String(o.numAudioBusChannels));
  args.push('-i', String(o.numInputBusChannels), '-o', String(o.numOutputBusChannels));
  args.push('-c', String(o.numControlBusChannels), '-b', String(o.numBuffers));
  args.push('-n', String(o.maxNodes), '-d', String(o.maxSynthDefs), '-z', String(o.blockSize));
  args.push('-m', String(o.memSize), '-w', String(o.numWireBufs));
  if (o.sampleRate != null) args.push('-S', String(o.sampleRate));
  if (o.outputStreamsEnabled != null) args.push('-O', String(o.outputStreamsEnabled));
  if (o.device) args.push('-H', o.device);
  args.push(...FIXED_ARGS.slice(0, 2));
  if (o.ugenPluginsPath?.length) args.push('-U', o.ugenPluginsPath.join(o.pathDelimiter ?? ':'));
  args.push(...FIXED_ARGS.slice(2));
  return args;
}

/** poptart's server options, the numbers poptart.scd set (see ARCHITECTURE.md on why each). */
function poptartOptions({
  port = 57110, sampleRate = 48000, blockSize = 256, outDevice = null, outChannels = 2, inChannels = 0,
  audioBuses = Number(process.env.POPTART_AUDIO_BUSES || 32768), ugenPluginsPath = null,
  // Tests run the engine with the device's output stream off: same channels, nothing audible.
  // Silent under test always: the test runner marks its processes (NODE_TEST_CONTEXT).
  silent = process.env.POPTART_SILENT === '1' || !!process.env.NODE_TEST_CONTEXT,
} = {}) {
  return {
    outputStreamsEnabled: silent ? '0' : null,
    port,
    sampleRate,
    blockSize,
    numInputBusChannels: inChannels,
    numOutputBusChannels: Math.max(2, outChannels),
    // Input and output pinned to one device, never an aggregate of the default input with it.
    device: outDevice || null,
    numBuffers: 16384,
    memSize: 262144,
    maxNodes: 32768,
    numWireBufs: 1024,
    numAudioBusChannels: audioBuses,
    numControlBusChannels: 65536,
    maxSynthDefs: 8192,
    ugenPluginsPath,
  };
}

const typed = (v) => {
  if (v && typeof v === 'object' && 'type' in v) return v;
  if (typeof v === 'string') return { type: 's', value: v };
  if (typeof v === 'boolean') return { type: 'i', value: v ? 1 : 0 };
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return { type: 'b', value: v };
  if (Array.isArray(v)) return { type: 'b', value: encode({ address: v[0], args: v.slice(1).map(typed) }) };
  if (Number.isInteger(v)) return { type: 'i', value: v };
  if (typeof v === 'number') return { type: 'f', value: Number.isFinite(v) ? v : 0 };
  if (v == null) return { type: 'i', value: 0 };
  return { type: 's', value: String(v) };
};

/** One OSC message as a packet: [address, ...args], args plain or typed. */
function message(m) {
  return { address: String(m[0]), args: m.slice(1).map(typed) };
}

class Server {
  /**
   * scsynthPath: the binary. options: see poptartOptions. env: extra environment for scsynth.
   * onOutput(text): everything scsynth prints. onExit(code, signal): it went away.
   */
  constructor({ scsynthPath, options, env = {}, onOutput = () => {}, onExit = () => {}, cwd } = {}) {
    this.scsynthPath = scsynthPath;
    this.options = options;
    this.env = env;
    this.cwd = cwd;
    this._onOutput = onOutput;
    this._onExit = onExit;
    this.addr = { host: '127.0.0.1', port: options.port };
    this.proc = null;
    this.pid = null;
    this.clientID = 0;
    this.sampleRate = options.sampleRate ?? null;
    this.running = false;
    this._sock = null;
    this._replies = new Map(); // address -> Set of fn(args, msg)
    this._syncId = 1000;
    this._bundle = null; // the messages a makeBundle is collecting
    this.nodes = new NodeIdAllocator(1000);
    const firstPrivate = options.numInputBusChannels + options.numOutputBusChannels;
    this.audioBuses = new BlockAllocator(firstPrivate, options.numAudioBusChannels);
    this.controlBuses = new BlockAllocator(0, options.numControlBusChannels);
    this.buffers = new BlockAllocator(0, options.numBuffers);
    this.defaultGroup = null; // set once booted (objects.js's Group of node 1)
    this.onOversize = null;
  }

  // --- process ---------------------------------------------------------------------------------

  /** Spawns scsynth and opens the socket. Resolves once the server answers /notify. */
  async boot({ timeoutMs = 60000 } = {}) {
    await this._openSocket();
    const args = scsynthArgs(this.options);
    this._onOutput(`poptart: scsynth ${args.join(' ')}\n`);
    await new Promise((resolve, reject) => {
      let settled = false;
      let seen = '';
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => done(Object.assign(
        new Error(`scsynth did not report ready within ${timeoutMs / 1000}s`), { code: 'BOOT_TIMEOUT' })), timeoutMs);
      let proc;
      try {
        proc = spawn(this.scsynthPath, args, {
          env: { ...process.env, ...this.env }, cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        done(err);
        return;
      }
      this.proc = proc;
      this.pid = proc.pid ?? null;
      const feed = (d) => {
        const text = String(d);
        this._onOutput(text);
        if (!settled) {
          seen = (seen + text).slice(-4000);
          const sr = seen.match(/SC_AudioDriver: sample rate = ([0-9.]+)/);
          if (sr) this.sampleRate = Number(sr[1]);
          if (READY_LINE.test(seen)) done();
        }
      };
      proc.stdout.on('data', feed);
      proc.stderr.on('data', feed);
      proc.on('error', (err) => done(err));
      proc.on('exit', (code, signal) => {
        const wasRunning = this.running;
        this.running = false;
        this.proc = null;
        if (!settled) {
          done(Object.assign(new Error(`scsynth exited (code ${code}${signal ? `, ${signal}` : ''}) before it was ready`),
            { code: 'BOOT_EXIT', output: seen }));
        }
        this._onExit(code, signal, wasRunning);
      });
    });
    this.running = true;
    await this._notify();
    return this;
  }

  // Registers for /n_go, /n_end and the rest, retried: a server that printed ready a moment ago
  // can still miss the first datagram.
  async _notify() {
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        const reply = await this.request(['/notify', 1, 0], '/done', (a) => a[0] === '/notify', 2500);
        this.clientID = Number(reply[1]) || 0;
        return;
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /** Quits scsynth, escalating to a kill. */
  async quit({ graceMs = 3000 } = {}) {
    const proc = this.proc;
    if (proc) {
      try { this.send(['/quit']); } catch { /* socket gone */ }
      await new Promise((resolve) => {
        if (proc.exitCode != null) return resolve();
        // After the SIGKILL, still wait for 'exit' (bounded by another grace): the signal is
        // sent at once, but the process holds the device and its port until it is gone.
        let t = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
          t = setTimeout(resolve, graceMs);
        }, graceMs);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    this.running = false;
    this.proc = null;
    if (this._sock) {
      try { this._sock.close(); } catch { /* closed */ }
      this._sock = null;
    }
  }

  /** Talks to a server that is already running (tests, NRT-free probes); no process of ours. */
  async attach() {
    await this._openSocket();
    this.running = true;
    await this._notify();
    return this;
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', (err) => {
        if (!this._sock) reject(err);
        else this._onOutput(`poptart: scsynth socket error: ${err.message}\n`);
      });
      sock.on('message', (buf) => this._receive(buf));
      sock.bind(0, '127.0.0.1', () => {
        this._sock = sock;
        resolve();
      });
    });
  }

  /** The local port replies arrive on. */
  get localPort() {
    return this._sock?.address().port ?? null;
  }

  // --- sending ---------------------------------------------------------------------------------

  sendRaw(bytes) {
    if (!this._sock) return;
    this._sock.send(bytes, this.addr.port, this.addr.host);
  }

  /** One message, [address, ...args]. Inside a makeBundle it joins the bundle instead. */
  send(m) {
    if (this._bundle) { this._bundle.push(m); return; }
    this.sendRaw(encode(message(m)));
  }

  sendMsg(...m) {
    this.send(m);
  }

  /**
   * Messages as one timed bundle `latency` seconds from now, split into datagram-sized bundles
   * under one timetag when big. A null latency (or less lead than NOW_LEAD_SEC) is applied on
   * arrival.
   */
  sendBundle(latency, msgs) {
    if (!msgs.length) return;
    const packets = msgs.map(message);
    const tag = latency == null || latency < NOW_LEAD_SEC ? { raw: [0, 1] } : timeTagFor(Date.now() / 1000 + latency);
    for (const b of packBundles(tag, packets, MAX_DATAGRAM, this.onOversize)) this.sendRaw(encode(b));
  }

  /** Runs fn with every message it sends collected into one bundle (the class library's makeBundle). */
  makeBundle(latency, fn) {
    const outer = this._bundle;
    const msgs = [];
    this._bundle = msgs;
    let result;
    try {
      result = fn();
    } finally {
      this._bundle = outer;
    }
    if (outer) outer.push(...msgs);
    else this.sendBundle(latency, msgs);
    return result;
  }

  /** Resolves once everything sent before it has been handled (/sync -> /synced). */
  sync(timeoutMs = 30000) {
    const id = this._syncId++;
    return this.request(['/sync', id], '/synced', (a) => a[0] === id, timeoutMs).then(() => true);
  }

  /** Sends m and resolves with the first `reply` whose args pass `match`. */
  request(m, reply, match = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${m[0]}: no ${reply} within ${timeoutMs}ms`)); }, timeoutMs);
      const off = this.on(reply, (args) => {
        if (!match(args)) return;
        clearTimeout(timer);
        off();
        resolve(args);
      });
      this.send(m);
    });
  }

  // --- receiving -------------------------------------------------------------------------------

  /** fn(args, msg) for every message at `address` from the server; returns its remover. */
  on(address, fn) {
    let set = this._replies.get(address);
    if (!set) { set = new Set(); this._replies.set(address, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  once(address, match, fn) {
    const off = this.on(address, (args, msg) => {
      if (!match(args)) return;
      off();
      fn(args, msg);
    });
    return off;
  }

  _receive(buf) {
    let packet;
    try {
      packet = osc.readPacket(buf, { metadata: false });
    } catch {
      return;
    }
    this._dispatch(packet);
  }

  _dispatch(packet) {
    if (packet.packets) { for (const p of packet.packets) this._dispatch(p); return; }
    const set = this._replies.get(packet.address);
    if (!set) return;
    const args = packet.args ?? [];
    for (const fn of [...set]) {
      try { fn(args, packet); } catch (err) { this._onOutput(`poptart: reply handler for ${packet.address}: ${err.stack || err}\n`); }
    }
  }

  // --- ids -------------------------------------------------------------------------------------

  nextNodeID() {
    return this.nodes.alloc();
  }
}

module.exports = { Server, scsynthArgs, poptartOptions, message, typed };
