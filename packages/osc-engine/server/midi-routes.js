'use strict';

// The MIDI input paths that write to the server themselves, the moment a message arrives: a
// midicc() knob onto its control bus, a midikeys() route's performance onto the instrument, and a
// device's notes injected into an effect. They run beside the device reader (the MIDI worker),
// so a busy engine loop cannot hold a knob or a key back. Everything that is bookkeeping - held
// counts, envelope gates, what is told to Node - stays with the engine (../engine/midi.js), which
// is handed each message with what was done about it here.
//
// A target is the UGen a slot's controller drives: { kind: 'vst' | 'device', node, index } or
// null while nothing is loaded (the engine updates it as the slot's controller changes).

const KIND_OF = { 0x90: 'noteOn', 0x80: 'noteOff', 0xB0: 'cc', 0xE0: 'bend', 0xD0: 'touch', 0xA0: 'polytouch', 0xC0: 'program' };

const f32 = (v) => ({ type: 'f', value: Number(v) });
const i32 = (v) => ({ type: 'i', value: Math.trunc(v) | 0 });
const blob = (bytes) => ({ type: 'b', value: Uint8Array.from(bytes) });

/**
 * The /u_cmd for a MIDI message to a target, as the controllers' MIDI proxies send it: a plugin
 * takes the raw bytes (VSTPluginController's /midi_msg), a device takes notes only.
 */
function targetMsg(target, status, d1, d2) {
  if (target == null || target.node == null) return null;
  const head = ['/u_cmd', i32(target.node), i32(target.index)];
  if (target.kind === 'vst') return [...head, '/midi_msg', blob([status, d1, d2]), f32(0)];
  const hi = status & 0xF0;
  if (hi === 0x90) return [...head, '/noteOn', f32(d1), f32(d2 / 127)];
  if (hi === 0x80) return [...head, '/noteOff', f32(d1)];
  return null; // a device hears its bend as a signal; the rest are quiet, as its MIDI proxy is
}

const mod12 = (n) => ((n % 12) + 12) % 12;

/** A route's note through its folded transpose and scale (nearest pitch class, ties downward). */
function quantizer(transpose = 0, scalePcs = null) {
  return (note) => {
    let q = note + transpose;
    if (scalePcs != null) {
      const n = q;
      for (let d = 0; d <= 11; d++) {
        if (scalePcs.includes(mod12(n - d))) { q = n - d; break; }
        if (scalePcs.includes(mod12(n + d))) { q = n + d; break; }
      }
    }
    return Math.min(127, Math.max(0, q));
  };
}

class DirectRoutes {
  constructor() {
    this.entries = new Map(); // key -> entry
  }

  /**
   * set(key, entry): { kind: 'cc', num, chan, srcID, bus, lo, hi }
   *                | { kind: 'keys', chan, srcID, transpose, scalePcs, defer, target }
   *                | { kind: 'inject', srcID, target }
   * A keys route keeps what it has sounding across a re-set.
   */
  set(key, entry) {
    const prev = this.entries.get(key);
    const e = { ...entry };
    if (e.kind === 'keys') {
      e.sounding = prev?.kind === 'keys' ? prev.sounding : new Map();
      e.quantize = quantizer(e.transpose, e.scalePcs);
    }
    this.entries.set(key, e);
  }

  update(key, fields) {
    const e = this.entries.get(key);
    if (!e) return;
    Object.assign(e, fields);
    if (e.kind === 'keys' && ('transpose' in fields || 'scalePcs' in fields)) e.quantize = quantizer(e.transpose, e.scalePcs);
  }

  remove(key) {
    this.entries.delete(key);
  }

  /**
   * One incoming message. Returns { sends: [osc message arrays], results: { key: what was done } }
   * for every entry it matched.
   */
  handle(src, status, d1, d2) {
    const sends = [];
    const results = {};
    const kind = KIND_OF[status & 0xF0];
    if (!kind) return { sends, results };
    const chan = status & 0x0F;
    for (const [key, e] of this.entries) {
      if (e.srcID != null && e.srcID !== src) continue;
      if (e.chan != null && e.chan !== chan) continue;
      if (e.kind === 'cc') {
        if (kind !== 'cc' || (e.num != null && e.num !== d1)) continue;
        const last = d2 / 127;
        sends.push(['/c_set', i32(e.bus), f32(e.lo + (last * (e.hi - e.lo)))]);
        results[key] = { last };
      } else if (e.kind === 'keys') {
        const r = this._keys(e, kind, chan, d1, d2, sends);
        if (r) results[key] = r;
      } else if (e.kind === 'inject') {
        if (kind !== 'noteOn' && kind !== 'noteOff') continue;
        const m = targetMsg(e.target, (kind === 'noteOn' ? 0x90 : 0x80), d1, d2);
        if (m) sends.push(m);
        results[key] = { sent: m != null };
      }
    }
    return { sends, results };
  }

  _keys(e, kind, chan, d1, d2, sends) {
    const t = e.target;
    const send = (st, a, b) => { const m = targetMsg(t, st, a, b); if (m) sends.push(m); };
    switch (kind) {
      case 'noteOn': case 'noteOff': {
        const veloc = d2;
        if (e.defer) return { defer: true, note: d1, veloc, on: kind === 'noteOn' && veloc > 0 };
        const note = e.quantize(d1);
        const rawKey = (chan * 128) + d1;
        if (t == null || t.node == null) return { note, veloc, on: kind === 'noteOn' && veloc > 0, played: false };
        if (kind === 'noteOn' && veloc > 0) {
          e.sounding.set(rawKey, note);
          send(0x90 | chan, note, veloc);
          return { note, veloc, on: true, played: true };
        }
        // A note-off (or a running-status note-on of velocity 0) releases what its on played.
        const played = e.sounding.get(rawKey) ?? note;
        e.sounding.delete(rawKey);
        send(0x80 | chan, played, kind === 'noteOn' ? 0 : veloc);
        return { note, veloc, on: false, played: true, released: played };
      }
      case 'bend': send(0xE0 | chan, d1, d2); return { bend: true };
      case 'touch': send(0xD0 | chan, d1, 0); return { touch: true };
      case 'polytouch': send(0xA0 | chan, e.quantize(d1), d2); return { poly: true };
      case 'cc': send(0xB0 | chan, d1, d2); return { cc: true };
      default: return null;
    }
  }

  /** What a keys route has sounding: [[rawKey, note]]; emptied. */
  takeSounding(key) {
    const e = this.entries.get(key);
    if (!e || e.kind !== 'keys') return [];
    const out = [...e.sounding];
    e.sounding.clear();
    return out;
  }
}

module.exports = { DirectRoutes, targetMsg, quantizer, KIND_OF };
