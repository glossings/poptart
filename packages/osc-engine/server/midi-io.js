'use strict';

// MIDI device I/O, for the engine: the device lists, hearing sources, sending to destinations, and
// MIDI clock out's ticker. This file is the only place that knows HOW - everything about what the
// messages mean is ../engine/midi.js and ../engine/clock.js. The devices are read and written on a
// worker thread of their own (./midi-worker.js), so a busy engine loop cannot delay a knob, a key
// or a clock tick; the input paths that write the server directly (./midi-routes.js) run there too.
//
// One switch picks how the devices are reached: macOS uses poptart's CoreMIDI helper
// (../native/bin/poptart-midi), everywhere else the class library's MIDI through a small sclang
// helper (../sc/midi-io.scd). POPTART_MIDI_BACKEND=swift|sclang overrides it.
//
// The interface:
//   open()                      resolves once the devices can be used (idempotent)
//   sources() / destinations()  the last-read lists: [{ uid, device, name }]
//   list()                      re-reads both lists (picks up gear plugged in since)
//   connect(uid) / connectAll() start hearing one source / every source
//   onMessage(fn)               fn(srcUid, status, d1, d2, results) per message; returns its remover
//   send(uid, bytes, at)        to a destination, at `at` on now()'s clock (null = at once)
//   now()                       that clock, in seconds (shared by every thread of this process)
//   route / routeUpdate / routeRemove   the direct input paths (see midi-routes.js)
//   clockDest / clockState / clockStart / clockStop   MIDI clock out (see midi-clock.js)
//   close()

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { hrSec } = require('./midi-clock');

const HELPER = path.join(__dirname, '..', 'native', 'bin', 'poptart-midi');

function defaultBackend(platform = process.platform, env = process.env) {
  if (env.POPTART_MIDI_BACKEND) return env.POPTART_MIDI_BACKEND;
  return platform === 'darwin' ? 'swift' : 'sclang';
}

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** The sclang that runs the Windows helper, and its class-library arguments; null when there is none. */
function helperSclang() {
  const { privateScInstalled, privateSclangPath, writeSclangConf, isPrivateSclang } = require('../private-sc');
  const p = process.env.POPTART_SCLANG || (privateScInstalled() ? privateSclangPath() : null)
    || ['/Applications/SuperCollider.app/Contents/MacOS/sclang', '/usr/local/bin/sclang', '/usr/bin/sclang',
      'C:\\Program Files\\SuperCollider\\sclang.exe'].find(executable);
  if (!p) return null;
  return { sclangPath: p, confArgs: isPrivateSclang(p) ? ['-l', writeSclangConf()] : [] };
}

class MidiIO {
  /**
   * serverPort: scsynth's port, for the direct input paths. output(text): log lines.
   * backend: 'swift' | 'sclang' | 'fake'. fakeDevices: the fake backend's { sources, destinations }.
   */
  constructor({ serverPort = null, output = () => {}, backend = defaultBackend(), helperPath = HELPER,
    sclangPort = 57150, fakeDevices = null } = {}) {
    this.backend = backend;
    this._output = output;
    this._sources = [];
    this._destinations = [];
    this._listeners = new Set();
    this._sentListeners = new Set();
    this._replies = new Map();
    this._seq = 1;
    this._opening = null;
    this._workerData = {
      backend, serverPort, helperPath, sclangPort, fakeDevices,
      sclang: backend === 'sclang' ? helperSclang() : null,
    };
    this._worker = null;
  }

  get isOpen() { return this._worker != null && this._opening != null; }

  sources() { return this._sources; }

  destinations() { return this._destinations; }

  now() { return hrSec(); }

  _spawn() {
    const w = new Worker(path.join(__dirname, 'midi-worker.js'), { workerData: this._workerData });
    w.unref();
    w.on('message', (m) => this._message(m));
    w.on('error', (err) => this._output(`[midi] worker: ${err.stack || err}`));
    w.on('exit', () => {
      if (this._worker === w) { this._worker = null; this._opening = null; }
      for (const r of this._replies.values()) r.reject(new Error('the MIDI worker stopped'));
      this._replies.clear();
    });
    this._worker = w;
  }

  _message(m) {
    switch (m.op) {
      case 'in':
        for (const fn of [...this._listeners]) {
          try { fn(m.src, m.status, m.d1, m.d2, m.results); } catch (err) { this._output(`[midi] ${err.stack || err}`); }
        }
        break;
      case 'reply': {
        const r = this._replies.get(m.id);
        if (!r) break;
        this._replies.delete(m.id);
        if (m.error) r.reject(new Error(m.error)); else r.resolve(m);
        break;
      }
      case 'log': this._output(m.text); break;
      case 'gone': this._output(`[midi] the MIDI helper exited (code ${m.code})`); break;
      case 'sent': case 'vin': case 'fakeSent':
        for (const fn of [...this._sentListeners]) fn(m);
        break;
      default: break;
    }
  }

  _ask(m, timeoutMs = 15000) {
    if (!this._worker) this._spawn();
    const id = this._seq++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._replies.delete(id); reject(new Error(`MIDI: no answer to ${m.op}`)); }, timeoutMs);
      this._replies.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._worker.postMessage({ ...m, id });
    });
  }

  _post(m) {
    this._worker?.postMessage(m);
  }

  _take(devices) {
    if (!devices) return;
    this._sources = devices.sources ?? [];
    this._destinations = devices.destinations ?? [];
  }

  open() {
    this._opening ??= this._ask({ op: 'open' }, 60000).then((r) => { this._take(r.devices); }, (err) => {
      this._opening = null;
      throw err;
    });
    return this._opening;
  }

  async list() {
    await this.open();
    const r = await this._ask({ op: 'list' });
    this._take(r.devices);
    return { sources: this._sources, destinations: this._destinations };
  }

  connect(uid) { this._post({ op: 'connect', uid }); }

  connectAll() { this._post({ op: 'connectAll' }); }

  onMessage(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** bytes to `uid` at `at` (now()'s clock) or at once. `trace` > 0 asks the helper for the stamp it used. */
  send(uid, bytes, at = null, trace = 0) {
    this._post({ op: 'send', uid, bytes: [...bytes], at, trace });
  }

  route(key, entry) { this._post({ op: 'route', key, entry }); }

  routeUpdate(key, fields) { this._post({ op: 'routeUpdate', key, fields }); }

  routeRemove(key) { this._post({ op: 'routeRemove', key }); }

  clockDest(uid) { this._post({ op: 'clockDest', uid }); }

  clockState(state) { this._post({ op: 'clockState', state }); }

  clockStart({ locate = false } = {}) { this._post({ op: 'clockStart', locate }); }

  clockStop() { this._post({ op: 'clockStop' }); }

  // --- for tests ---

  /** fn(m) for each stamp report ('sent'), virtual-destination arrival ('vin') or fake send ('fakeSent'). */
  onSent(fn) {
    this._sentListeners.add(fn);
    return () => this._sentListeners.delete(fn);
  }

  async virtual(name) {
    await this.open();
    const r = await this._ask({ op: 'virtual', name });
    this._take(r.devices);
    return r.devices;
  }

  emit(bytes) { this._post({ op: 'emit', bytes: [...bytes] }); }

  fakeIn(src, status, d1, d2) { this._post({ op: 'fakeIn', src, status, d1, d2 }); }

  async syncClock() { return (await this._ask({ op: 'syncClock' })).sync; }

  close() {
    const w = this._worker;
    if (!w) return Promise.resolve();
    this._worker = null;
    this._opening = null;
    return new Promise((resolve) => {
      const t = setTimeout(() => { w.terminate().finally(resolve); }, 3000);
      w.once('exit', () => { clearTimeout(t); resolve(); });
      w.postMessage({ op: 'close' });
    });
  }
}

module.exports = { MidiIO, defaultBackend, helperSclang, HELPER };
