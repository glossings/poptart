'use strict';

// poptart's SynthDefs on a server: built in Node by ../synthdef at boot (no sclang, nothing cached
// on disk) and sent with /d_recv, or /d_load through a temp file for one too big for a datagram.
//
// The registry is what the controllers ask: the UGen index of each VSTPlugin and PoptartDevice a
// def holds (by id), which their /u_cmd is addressed to.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const synthdef = require('../synthdef');

/** Which of poptart's own extensions scsynth will find in `extensionsDir` (sclang's \Class.asClass check). */
function extensionFlags(extensionsDir) {
  const has = (f) => !!extensionsDir && fs.existsSync(path.join(extensionsDir, 'poptart', f));
  const devices = has('PoptartDevices.scx');
  return { nativeDevices: devices, spectrum: devices, pitchShift: has('PoptartPitchShift.scx') };
}

/** Every def an engine with these settings loads at boot: [{name, bytes, meta, def}]. */
function bootDefs({ numOutputBusChannels = 2, cueOffset = null, mixFreqs = [], flags = {} } = {}) {
  const options = { numOutputBusChannels, cueOffset, ...flags };
  return [...synthdef.defsFor(options), ...(mixFreqs.length ? synthdef.mixDefsFor(mixFreqs, options) : [])];
}

/** The registry the engine asks: which defs exist and where their controllers sit. */
class DefRegistry {
  constructor(meta = {}) {
    this.meta = { ...meta };
  }

  static of(entries) {
    return new DefRegistry(Object.fromEntries(entries.map((e) => [e.name, e.meta])));
  }

  has(name) {
    return Object.prototype.hasOwnProperty.call(this.meta, String(name));
  }

  /** The UGen index of the VSTPlugin with `id` in def `name`, or null. */
  vstIndex(name, id) {
    return this.meta[String(name)]?.vstplugins?.[String(id)] ?? null;
  }

  /** The UGen index of the PoptartDevice with `id` in def `name`, or null. */
  deviceIndex(name, id) {
    return this.meta[String(name)]?.poptartDevices?.[String(id)] ?? null;
  }

  add(name, meta) {
    this.meta[String(name)] = meta;
  }

  remove(name) {
    delete this.meta[String(name)];
  }
}

/**
 * Sends `entries` (from bootDefs, or one exprDef) to the server and resolves once it has every one
 * (one /done per message). Temp files for /d_load are removed afterwards.
 */
async function sendDefs(server, entries, { timeoutMs = 30000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-defs-'));
  try {
    const { messages } = synthdef.loadMessages(entries.map((e) => e.def), { dir });
    // Count the answers: every /d_recv's /done looks alike.
    const want = new Map();
    for (const m of messages) want.set(m[0], (want.get(m[0]) ?? 0) + 1);
    await new Promise((resolve, reject) => {
      let left = messages.length;
      const timer = setTimeout(() => { off(); reject(new Error(`SynthDefs: ${left} load(s) unanswered after ${timeoutMs}ms`)); }, timeoutMs);
      const off = server.on('/done', (a) => {
        const n = want.get(a[0]);
        if (!n) return;
        want.set(a[0], n - 1);
        if (--left === 0) { clearTimeout(timer); off(); resolve(); }
      });
      if (!left) { clearTimeout(timer); off(); resolve(); return; }
      for (const m of messages) server.send(m);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { bootDefs, sendDefs, extensionFlags, DefRegistry };
