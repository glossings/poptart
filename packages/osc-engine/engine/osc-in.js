'use strict';

// Live OSC input (osc()): the input port, its forwarding feed to Node, and osc() bound straight
// onto a parameter - poptart.scd's oscEnable and setParamOSC.

const dgram = require('node:dgram');
const osc = require('osc');
const { Bus } = require('../server/objects');

// The OSC types that are numbers to the store (as sclang's isNumber had them).
const NUMERIC = new Set(['i', 'f', 'd', 'h']);

function install(E) {
  const S = E.S;
  // defKey -> { address, fn, free() }: OSCdef.all for the input port.
  E.oscDefs = new Map();
  E.oscSocket = null;

  E.oscDef = (key, address, fn) => {
    E.oscDefs.get(key)?.free();
    const def = { address: String(address), fn, free: () => { if (E.oscDefs.get(key) === def) E.oscDefs.delete(key); } };
    E.oscDefs.set(key, def);
    return def;
  };

  // One message off the input port: forwarded to Node with its numbers, then to its bindings.
  E.oscReceive = (m) => {
    const args = (m.args ?? []).map((a) => {
      if (!NUMERIC.has(a.type)) return { num: false, value: a.value };
      const v = a.type === 'h' && typeof a.value === 'object' ? Number(a.value.high) * 4294967296 + (a.value.low >>> 0) : Number(a.value);
      return { num: true, value: v };
    });
    E.tell('/poptart/oscIn', m.address, ...args.filter((a) => a.num).map((a) => a.value));
    // What an OSCdef's function saw: [address, ...args], a non-number left as it came.
    const msg = [m.address, ...args.map((a) => (a.num ? a.value : a.value))];
    const isNum = [false, ...args.map((a) => a.num)];
    for (const def of [...E.oscDefs.values()]) {
      if (def.address !== m.address) continue;
      try { def.fn(msg, isNum); } catch (err) { E.error(`OSCdef ${def.address}`, err); }
    }
  };

  const walk = (p) => {
    if (p.packets) { for (const q of p.packets) walk(q); return; }
    if (p.address) E.oscReceive(p);
  };

  // Lazy and idempotent like midiEnable: the input port opens when a pattern first asks. It is a
  // SECOND port, apart from anything the engine is commanded on, so a controller's message can
  // never be read as an engine command. Resolves with whether it is open.
  E.oscEnable = () => {
    if (E.oscInitialized) return E._oscReady;
    E.oscInitialized = true;
    E._oscReady = new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', () => {
        try { sock.close(); } catch { /* not open */ }
        E.warn(`poptart: could not open OSC input port ${E.oscInPort} (in use? set POPTART_OSC_IN_PORT) - osc() signals will receive nothing`);
        resolve(false);
      });
      sock.on('message', (buf) => {
        let p;
        try { p = osc.readPacket(buf, { metadata: true }); } catch { return; }
        walk(p);
      });
      sock.bind(E.oscInPort, '0.0.0.0', () => {
        sock.removeAllListeners('error');
        sock.on('error', (err) => E.warn(`poptart: OSC input: ${err.message}`));
        E.oscSocket = sock;
        E.post(`poptart: OSC input open on port ${E.oscInPort}`);
        // Node announces the open port over Bonjour on this (see bonjour.js).
        E.tell('/poptart/oscOpen', E.oscInPort);
        resolve(true);
      });
    });
    return E._oscReady;
  };
  E.onStop(() => { try { E.oscSocket?.close(); } catch { /* closed */ } E.oscSocket = null; });

  // osc() -> parameter: setParamCC with an OSC address in place of a device/cc/channel binding.
  E.on('/poptart/setParamOSC', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const paramName = String(msg[3]);
    const address = String(msg[4]);
    const argIndex = Math.trunc(msg[5]);
    const lo = Number(msg[6]);
    const hi = Number(msg[7]);
    E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) { E.warn(`poptart: setParamOSC: no track ${key}`); return; }
      E.oscEnable();
      const target = await E.awaitTarget(track, slot, paramName, 'setParamOSC');
      if (target == null) return;
      const isChannel = target.kind !== 'control';
      const index = target.index;
      const binding = `${address}|${argIndex}`;
      const oscKey = `slot${slot}_${paramName}`;
      const defKey = `poptart_osc_${key}_${oscKey}`;
      const existing = track.oscs.get(oscKey);
      const registerDef = (e) => {
        E.oscDef(defKey, address, (m, isNum) => {
          if (isNum[argIndex + 1]) {
            e.last = Number(m[argIndex + 1]);
            e.bus.set(e.lo + (e.last * (e.hi - e.lo)));
          }
        });
        // The one line that says an address IS wired.
        E.post(`poptart: osc ${address}[${argIndex}] -> ${key} slot ${slot} '${paramName}' (${lo}..${hi})`);
      };
      if (existing == null && !isChannel && (lo < 0 || hi > 1)) {
        E.warn(`poptart: OSC range ${lo}..${hi} for '${paramName}' is outside the normalized 0..1 VST parameter range `
          + 'and will pin - use .range(0.2, 0.9)-style values until per-plugin calibration exists');
      }
      if (existing != null) {
        existing.lo = lo;
        existing.hi = hi;
        existing.index = index;
        target.map(existing.bus);
        if (existing.binding !== binding || !E.oscDefs.has(defKey)) {
          existing.binding = binding;
          registerDef(existing);
        }
        existing.bus.set(lo + (existing.last * (hi - lo)));
      } else {
        const bus = Bus.control(S, 1);
        const entry = { bus, index, lo, hi, last: 0, binding, defKey };
        bus.set(lo); // the fader's position is unknown until it moves - start at the floor
        registerDef(entry);
        E.dropRamp?.(key, track, oscKey);
        target.map(bus);
        track.oscs.set(oscKey, entry);
      }
    });
  });

  E.on('/poptart/clearParamOSC', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const paramName = String(msg[3]);
    const track = E.tracks.get(key);
    const oscKey = `slot${slot}_${paramName}`;
    const existing = E.isTrack(track) ? track.oscs.get(oscKey) : null;
    if (existing != null) {
      E.oscDefs.get(existing.defKey)?.free();
      E.paramTarget(track, slot, paramName, existing.index)?.unmap();
      existing.bus.free();
      track.oscs.delete(oscKey);
    }
  });

  E.on('/poptart/oscInit', () => E.oscEnable());
}

module.exports = { install };
