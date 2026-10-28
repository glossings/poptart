'use strict';

// The MIDI worker: a thread of its own that owns the device helper, reads what it hears, plays the
// direct input paths (./midi-routes.js) straight to scsynth, and runs MIDI clock out's ticker
// (./midi-clock.js). The engine's loop can be busy for as long as it likes without a knob, a key
// or a clock tick waiting on it. Started by ./midi-io.js; see there for the messages.
//
// Backends: 'swift' (../native/bin/poptart-midi, CoreMIDI, packets stamped in host time),
// 'sclang' (../sc/midi-io.scd, for Windows), 'fake' (in memory, for tests).

const { parentPort, workerData } = require('node:worker_threads');
const dgram = require('node:dgram');
const path = require('node:path');
const { spawn } = require('node:child_process');
const osc = require('osc');
const { DirectRoutes } = require('./midi-routes');
const { ClockTicker, hrSec } = require('./midi-clock');

const post = (m) => parentPort.postMessage(m);
const log = (text) => post({ op: 'log', text });

const typed = (v) => {
  if (v && typeof v === 'object' && 'type' in v) return v;
  if (typeof v === 'string') return { type: 's', value: v };
  if (Number.isInteger(v)) return { type: 'i', value: v };
  return { type: 'f', value: Number(v) };
};

// --- the server, for the direct paths ---------------------------------------------------------

let scsynth = null;
function toServer(msgs) {
  if (!msgs.length || workerData.serverPort == null) return;
  if (!scsynth) { scsynth = dgram.createSocket('udp4'); scsynth.unref(); }
  for (const m of msgs) {
    const bytes = osc.writePacket({ address: m[0], args: m.slice(1).map(typed) }, { metadata: true });
    scsynth.send(bytes, workerData.serverPort, '127.0.0.1');
  }
}

// --- backends ---------------------------------------------------------------------------------

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** Resolves once `proc` has exited, killing it if it has not within `ms`. */
function reap(proc, ms = 1000) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, ms);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

/** CoreMIDI through the Swift helper. Times cross as host-time nanoseconds; see clock sync. */
class SwiftBackend {
  constructor(onIn) {
    this.onIn = onIn;
    this.proc = null;
    this.offsetNs = 0n; // helper ns minus hrtime ns
    this._waits = new Map();
    this._seq = 1;
    this._buf = '';
    this._sync = null;
  }

  async open() {
    const bin = workerData.helperPath || path.join(__dirname, '..', 'native', 'bin', 'poptart-midi');
    await new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) { reject(err); return; }
      this.proc = proc;
      this._wait('hello', resolve);
      proc.on('error', reject);
      proc.on('exit', (code) => {
        this.proc = null;
        reject(new Error(`the MIDI helper exited (code ${code})`));
        post({ op: 'gone', code });
      });
      proc.stderr.on('data', (d) => log(`[midi] ${String(d).trimEnd()}`));
      proc.stdout.on('data', (d) => this._data(d));
    });
    await this.syncClock();
    // The two clocks share a source on this platform; the re-sync is a guard, not a correction.
    this._sync = setInterval(() => { this.syncClock().catch(() => {}); }, 10000);
    this._sync.unref();
  }

  _write(line) {
    this.proc?.stdin.write(`${line}\n`);
  }

  // Several callers can wait on one reply (two device lists asked for at once): each key holds a
  // list, and the reply answers all of them.
  _wait(key, fn) {
    const list = this._waits.get(key);
    if (list) list.push(fn); else this._waits.set(key, [fn]);
  }

  _answer(key, value) {
    const list = this._waits.get(key);
    if (!list) return;
    this._waits.delete(key);
    for (const fn of list) fn(value);
  }

  _data(d) {
    this._buf += d;
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      this._line(line.split('\t'));
    }
  }

  _line(f) {
    switch (f[0]) {
      case 'in': {
        const b = Buffer.from(f[3] ?? '', 'hex');
        this.onIn(Number(f[1]), b[0], b[1] ?? 0, b[2] ?? 0);
        break;
      }
      case 'hello': this._answer('hello'); break;
      case 'devices': this._answer('devices', JSON.parse(f[1])); break;
      case 'now': this._answer(`now${f[1]}`, BigInt(f[2])); break;
      case 'sent': post({ op: 'sent', id: Number(f[1]), stamped: this.toSec(BigInt(f[2])) }); break;
      case 'vin': {
        post({ op: 'vin', stamped: this.toSec(BigInt(f[1])), arrived: this.toSec(BigInt(f[2])), bytes: [...Buffer.from(f[3], 'hex')] });
        break;
      }
      case 'err': log(`[midi] ${f.slice(1).join(' ')}`); break;
      default: break;
    }
  }

  _ask(key, line) {
    return new Promise((resolve, reject) => {
      const done = (v) => { clearTimeout(t); resolve(v); };
      const t = setTimeout(() => {
        const list = this._waits.get(key);
        const i = list ? list.indexOf(done) : -1;
        if (i >= 0) list.splice(i, 1);
        if (list && !list.length) this._waits.delete(key);
        reject(new Error(`MIDI helper: no answer to ${line.split('\t')[0]}`));
      }, 5000);
      this._wait(key, done);
      this._write(line);
    });
  }

  /** Measures helper time against hrtime: the sample with the shortest round trip wins. */
  async syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const id = this._seq++;
      const t0 = process.hrtime.bigint();
      const h = await this._ask(`now${id}`, `now\t${id}`);
      const t1 = process.hrtime.bigint();
      const rtt = t1 - t0;
      if (best == null || rtt < best.rtt) best = { rtt, offset: h - (t0 + rtt / 2n) };
    }
    this.offsetNs = best.offset;
    return { offsetNs: Number(best.offset), rttNs: Number(best.rtt) };
  }

  toNs(sec) { return BigInt(Math.round(sec * 1e9)) + this.offsetNs; }

  toSec(ns) { return Number(ns - this.offsetNs) / 1e9; }

  async list() { return this._ask('devices', 'list'); }

  connect(uid) { this._write(`connect\t${Math.trunc(uid)}`); }

  connectAll() { this._write('connectAll'); }

  /** bytes to destination `uid` at `at` (hrSec) or at once; `id` > 0 asks for the stamp back. */
  send(uid, bytes, at = null, id = 0) {
    const ns = at == null ? 0n : this.toNs(at);
    this._write(`send\t${id}\t${Math.trunc(uid)}\t${ns}\t${hex(bytes)}`);
  }

  async virtual(name) { return this._ask('devices', `virtual\t${name}`); }

  emit(bytes) { this._write(`emit\t${hex(bytes)}`); }

  close() {
    if (this._sync) clearInterval(this._sync);
    const p = this.proc;
    if (!p) return Promise.resolve();
    this._write('quit');
    return reap(p);
  }
}

/** Windows: the class library's MIDI through a tiny sclang helper over UDP (../sc/midi-io.scd). */
class SclangBackend {
  constructor(onIn) {
    this.onIn = onIn;
    this.proc = null;
    this.sock = null;
    this.port = null;
    this._waits = [];
    this._ping = null;
  }

  async open() {
    const sc = workerData.sclang;
    if (!sc?.sclangPath) throw new Error('MIDI on this platform needs SuperCollider (sclang)');
    await new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', reject);
      sock.on('message', (buf) => this._receive(buf));
      sock.bind(0, '127.0.0.1', () => { this.sock = sock; resolve(); });
    });
    const hello = new Promise((resolve, reject) => {
      this._waits.push({ address: '/midi/hello', resolve });
      const proc = spawn(sc.sclangPath, [...(sc.confArgs ?? []), '-u', String(workerData.sclangPort ?? 57150),
        path.join(__dirname, '..', 'sc', 'midi-io.scd')], {
        env: { ...process.env, POPTART_MIDI_NODE_PORT: String(this.sock.address().port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;
      const out = (d) => { for (const l of String(d).split('\n')) if (/ERROR|WARNING/.test(l)) log(`[midi] ${l}`); };
      proc.stdout.on('data', out);
      proc.stderr.on('data', out);
      proc.on('error', reject);
      proc.on('exit', (code) => { this.proc = null; reject(new Error(`the MIDI helper exited (code ${code})`)); post({ op: 'gone', code }); });
    });
    const a = await hello;
    this.port = Number(a[0]) || workerData.sclangPort || 57150;
    this._ping = setInterval(() => this._send('/midi/ping'), 4000);
    this._ping.unref();
  }

  _send(address, ...args) {
    if (!this.sock || this.port == null) return;
    this.sock.send(osc.writePacket({ address, args: args.map(typed) }, { metadata: true }), this.port, '127.0.0.1');
  }

  _receive(buf) {
    let p;
    try { p = osc.readPacket(buf, { metadata: false }); } catch { return; }
    for (const m of p.packets ?? [p]) {
      const args = m.args ?? [];
      if (m.address === '/midi/in') { const [s, st, a, b] = args.map(Number); this.onIn(s, st, a, b); continue; }
      const i = this._waits.findIndex((w) => w.address === m.address);
      if (i >= 0) this._waits.splice(i, 1)[0].resolve(args);
    }
  }

  async list() {
    const a = await new Promise((resolve) => { this._waits.push({ address: '/midi/devices', resolve }); this._send('/midi/list'); });
    let i = 0;
    const take = () => {
      const n = Number(a[i++]) || 0;
      const out = [];
      for (let k = 0; k < n; k++) { out.push({ uid: Number(a[i]), device: String(a[i + 1]), name: String(a[i + 2]) }); i += 3; }
      return out;
    };
    const sources = take();
    return { sources, destinations: take() };
  }

  connect(uid) { this._send('/midi/connect', Math.trunc(uid)); }

  connectAll() { this._send('/midi/connectAll'); }

  // The class library's MIDIOut takes a latency, not a moment: worked out as late as possible.
  send(uid, bytes, at = null) {
    const latency = at == null ? 0 : Math.max(0, at - hrSec());
    this._send('/midi/send', Math.trunc(uid), latency, bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0);
  }

  async close() {
    if (this._ping) clearInterval(this._ping);
    this._send('/midi/quit');
    await reap(this.proc);
    try { this.sock?.close(); } catch { /* closed */ }
  }
}

/** In memory, for tests: devices as given, sends reported back, input injected by the test. */
class FakeBackend {
  constructor(onIn) { this.onIn = onIn; this.devices = workerData.fakeDevices ?? { sources: [], destinations: [] }; }
  async open() {}
  async list() { return this.devices; }
  connect() {}
  connectAll() {}
  send(uid, bytes, at = null) { post({ op: 'fakeSent', uid, bytes: [...bytes], at, now: hrSec() }); }
  close() {}
}

// --- the worker -------------------------------------------------------------------------------

const routes = new DirectRoutes();
let backend = null;
let opened = null;

function onIn(src, status, d1, d2) {
  const { sends, results } = routes.handle(src, status, d1, d2);
  toServer(sends);
  post({ op: 'in', src, status, d1, d2, results });
}

const ticker = new ClockTicker({
  send: (bytes, at) => { if (clockDest != null) backend?.send(clockDest, bytes, at); },
});
let clockDest = null;

const BACKENDS = { swift: SwiftBackend, sclang: SclangBackend, fake: FakeBackend };

async function handle(m) {
  switch (m.op) {
    case 'open': {
      opened ??= (async () => {
        backend = new (BACKENDS[workerData.backend] ?? SwiftBackend)(onIn);
        await backend.open();
        return backend.list();
      })();
      try {
        post({ op: 'reply', id: m.id, devices: await opened });
      } catch (err) {
        opened = null;
        post({ op: 'reply', id: m.id, error: err.message });
      }
      break;
    }
    case 'list': {
      try { post({ op: 'reply', id: m.id, devices: await backend.list() }); } catch (err) { post({ op: 'reply', id: m.id, error: err.message }); }
      break;
    }
    case 'connect': backend?.connect(m.uid); break;
    case 'connectAll': backend?.connectAll(); break;
    case 'send': backend?.send(m.uid, m.bytes, m.at ?? null, m.trace ?? 0); break;
    case 'route': routes.set(m.key, m.entry); break;
    case 'routeUpdate': routes.update(m.key, m.fields); break;
    case 'routeRemove': routes.remove(m.key); break;
    case 'clockDest': clockDest = m.uid; if (m.uid == null) ticker.stop(); break;
    case 'clockState': ticker.setState(m.state); break;
    case 'clockStart': ticker.start({ locate: !!m.locate }); break;
    case 'clockStop': ticker.stop(); break;
    case 'syncClock': {
      const r = backend?.syncClock ? await backend.syncClock() : null;
      post({ op: 'reply', id: m.id, sync: r });
      break;
    }
    case 'virtual': post({ op: 'reply', id: m.id, devices: await backend.virtual(m.name) }); break;
    case 'emit': backend?.emit(m.bytes); break;
    case 'fakeIn': onIn(m.src, m.status, m.d1, m.d2); break;
    case 'close':
      ticker.stop();
      // A helper still opening is waited for, so it cannot outlive the worker.
      await opened?.catch(() => {});
      await backend?.close();
      try { scsynth?.close(); } catch { /* closed */ }
      post({ op: 'closed' });
      process.exit(0);
      break;
    default: break;
  }
}

parentPort.on('message', (m) => { handle(m).catch((err) => log(`[midi] ${m.op}: ${err.stack || err}`)); });
