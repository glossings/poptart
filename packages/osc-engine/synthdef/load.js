'use strict';

// Getting defs to scsynth: /d_recv for what fits in a UDP datagram, a file and /d_load for what
// does not, and the defs.json-shaped description of each def the controllers need.

const fs = require('node:fs');
const path = require('node:path');
const { scgf } = require('./graph.js');

// macOS's default net.inet.udp.maxdgram: the largest datagram the loopback will carry.
const MAX_DATAGRAM = 9216;
// Room for the bundle a message may be sent in ('#bundle', time tag, element size).
const BUNDLE_OVERHEAD = 20;

const pad4 = (n) => (n + 3) & ~3;
// The size of ['/d_recv', blob] as an OSC message.
const dRecvSize = (blobLength) => 8 + 4 + 4 + pad4(blobLength);

/**
 * OSC messages that load `defs` (SynthDef objects): as few /d_recv messages as hold them under
 * `maxDatagram`, each one SCgf file of several defs, and a /d_load of a file written to `dir` for
 * any def too big to travel alone. Returns {messages, files}; delete `files` once scsynth has
 * answered /done for their /d_load.
 */
function loadMessages(defs, { dir, maxDatagram = MAX_DATAGRAM } = {}) {
  const budget = maxDatagram - BUNDLE_OVERHEAD;
  const messages = [];
  const files = [];
  let batch = [];
  let batchSize = 10; // 'SCgf', version, def count
  const flush = () => {
    if (batch.length) messages.push(['/d_recv', scgf(batch)]);
    batch = [];
    batchSize = 10;
  };
  for (const def of defs) {
    const one = def.asBytes();
    const size = one.length - 10;
    if (dRecvSize(one.length) > budget) {
      if (!dir) throw new Error(`SynthDef ${def.name} is ${one.length} bytes - loading it needs a directory for /d_load`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${def.name}.scsyndef`);
      fs.writeFileSync(file, one);
      files.push(file);
      messages.push(['/d_load', file]);
      continue;
    }
    if (dRecvSize(batchSize + size) > budget) flush();
    batch.push(def);
    batchSize += size;
  }
  flush();
  return { messages, files };
}

/**
 * What a def holds that its controllers address: the UGen index of each VSTPlugin and
 * PoptartDevice by id, and its control names - one defs.json entry.
 */
function defMeta(def) {
  const m = {};
  const plugins = Object.entries(def.slots.vstplugins);
  if (plugins.length) m.vstplugins = Object.fromEntries(plugins.map(([id, u]) => [id, u.synthIndex]));
  const devices = Object.entries(def.slots.poptartDevices);
  if (devices.length) m.poptartDevices = Object.fromEntries(devices.map(([id, u]) => [id, u.synthIndex]));
  m.controls = (def.allControlNames ?? []).map((cn) => cn.name);
  return m;
}

/** Writes <dir>/<name>.scsyndef per def and <dir>/defs.json. */
function writeDefsDir(dir, defs) {
  fs.mkdirSync(dir, { recursive: true });
  const meta = {};
  for (const def of defs) {
    fs.writeFileSync(path.join(dir, `${def.name}.scsyndef`), def.asBytes());
    meta[def.name] = defMeta(def);
  }
  fs.writeFileSync(path.join(dir, 'defs.json'), JSON.stringify(meta));
  return meta;
}

module.exports = { loadMessages, defMeta, writeDefsDir, MAX_DATAGRAM };
