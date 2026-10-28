'use strict';

// The direct path: notes and parameter changes go from Node straight to scsynth as timestamped
// OSC bundles, so a busy sclang can no longer make them late.
//
// sclang still builds everything - tracks, devices, buses, buffers, modulators, ramps - and tells
// this side the ids it made as it makes them ('/poptart/ids/*', see sc/poptart.scd's tellIds
// section). Nothing here guesses an id. When the mirror lacks something an event needs, or the
// event needs sclang's own logic (a program load in flight, a pending lfo shape swap, a granular
// voice), the caller sends it the old way: every per-event method returns false for that.
//
// What sclang still keeps books on - held-note counts for modulators born later, what a hush must
// release, the sampler's voice ceiling - it is told about after the fact ('/poptart/direct/*').
// Those messages carry no timing, so a late one costs nothing audible.

const osc = require('osc');

const NTP_EPOCH_OFFSET = 2208988800; // seconds from 1900 (OSC's epoch) to 1970 (Date.now's)
const TWO_32 = 4294967296;
// macOS caps one UDP datagram at 9216 bytes (net.inet.udp.maxdgram); scsynth drops nothing
// smaller, so a bundle is packed up to this and split past it.
const MAX_DATAGRAM = 9216;
// Same rule as poptart.scd's bundleNow: under this much lead a bundle is sent unstamped (applied
// on arrival) rather than stamped for a moment already past by the time the audio thread looks.
const NOW_LEAD_SEC = 0.001;
const IMMEDIATE = { raw: [0, 1] };

// Kinds sclang tells modulators by (see tellMods in poptart.scd).
const MOD_ENV = 0;
const MOD_LFO = 1; // a basic lfo(): free running, its rate control is `freq`
const MOD_SHAPE_FREE = 2; // a drawn shape, free running, its rate control is `rate`
const MOD_SHAPE_RETRIG = 3;
const MOD_SHAPE_ENV = 4;

const i32 = (v) => ({ type: 'i', value: Math.trunc(v) | 0 });
const f32 = (v) => ({ type: 'f', value: Number(v) });
const str = (v) => ({ type: 's', value: String(v) });
const blob = (bytes) => ({ type: 'b', value: Uint8Array.from(bytes) });

/** OSC timetag for a moment in Date.now() seconds. */
function timeTagFor(sec) {
  const whole = Math.floor(sec);
  const frac = Math.min(TWO_32 - 1, Math.round((sec - whole) * TWO_32));
  return { raw: [whole + NTP_EPOCH_OFFSET, frac] };
}

/** The Date.now() seconds a timetag names (the inverse of timeTagFor, for tests). */
function secondsOf(tag) {
  return tag.raw[0] - NTP_EPOCH_OFFSET + tag.raw[1] / TWO_32;
}

function encodedSize(msg) {
  return osc.writeMessage(msg, { metadata: true }).length;
}

/**
 * Messages packed into as few bundles as fit one datagram each, all under the same timetag. scsynth
 * runs bundles that share a time in arrival order, so a split keeps the messages' order. A single
 * message bigger than a datagram still goes out, alone, and is reported through `onOversize`.
 */
function packBundles(timeTag, messages, maxBytes = MAX_DATAGRAM, onOversize = null) {
  const HEADER = 16; // "#bundle\0" + the timetag
  const out = [];
  let packets = [];
  let size = HEADER;
  for (const m of messages) {
    const n = 4 + encodedSize(m); // each element carries its own size
    if (packets.length && size + n > maxBytes) {
      out.push({ timeTag, packets });
      packets = [];
      size = HEADER;
    }
    if (HEADER + n > maxBytes && onOversize) onOversize(m, HEADER + n);
    packets.push(m);
    size += n;
  }
  if (packets.length) out.push({ timeTag, packets });
  return out;
}

const encode = (packet) => osc.writePacket(packet, { metadata: true });

const plain = (a) => (a && typeof a === 'object' && 'value' in a ? a.value : a);

class DirectPath {
  /**
   * sendRaw(bytes): one datagram to scsynth. tell(address, args): a bookkeeping message to sclang.
   * now(): seconds on the engine's clock (OscEngine#getTime). warn(key, text): a one-shot warning.
   */
  constructor({ sendRaw, tell, now, warn = () => {}, allocNode = null }) {
    this.allocNode = allocNode;
    this._sendRaw = sendRaw;
    this._tell = tell;
    this._now = now;
    this._warn = warn;
    this.server = null; // { port, nodeLo, nodeHi, sampleRate, rbDelay, loadFailsafe }
    this._nextNode = 0;
    this.tracks = new Map(); // trackId -> mirror (see _track)
    this.dead = new Set(); // node ids the server said it does not have
    this.loads = new Map(); // "track|slot" -> { seq, at, until }: a program load notes must wait for
    this.songs = new Map(); // trackId -> { bufnum, channels, sampleRate, frames, node, spawnUntil, viaLang }
    this._timers = new Set();
    this.counts = { direct: 0, fallback: 0 };
  }

  get ready() {
    return this.server != null;
  }

  stop() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    // The next sclang tells everything afresh.
    this.server = null;
    this.tracks.clear();
    this.dead.clear();
    this.loads.clear();
    this.songs.clear();
  }

  // --- what sclang tells us -------------------------------------------------------------------

  _track(id) {
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        known: false, group: 0, voices: 0, inBus: 0, bendBus: 0, head: 0,
        slots: new Map(), envs: new Map(), lfos: new Map(), staged: null,
        ramps: new Map(), taps: new Map(), held: 0,
        shapesSent: 0, shapesHandled: 0, swapPending: false,
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** Consumes one '/poptart/ids/*' message. Returns false for any other address. */
  handle(msg) {
    if (!msg.address.startsWith('/poptart/ids/')) return false;
    const a = (msg.args ?? []).map(plain);
    const what = msg.address.slice('/poptart/ids/'.length);
    const t = () => this._track(String(a[0]));
    switch (what) {
      case 'server':
        this.server = {
          port: Number(a[0]), nodeLo: Number(a[1]), nodeHi: Number(a[2]),
          sampleRate: Number(a[3]), rbDelay: Number(a[4]) || 0, loadFailsafe: Number(a[5]) || 0,
        };
        if (!(this._nextNode >= this.server.nodeLo && this._nextNode <= this.server.nodeHi)) this._nextNode = this.server.nodeLo;
        break;
      case 'rbDelay':
        if (this.server) this.server.rbDelay = Number(a[0]) || 0;
        break;
      case 'track': {
        const tr = t();
        Object.assign(tr, { known: true, group: a[1], voices: a[2], inBus: a[3], bendBus: a[4], head: a[5] });
        break;
      }
      case 'trackGone':
        this.tracks.delete(String(a[0]));
        this.songs.delete(String(a[0]));
        break;
      case 'slot':
        t().slots.set(Number(a[1]), {
          ctl: Number(a[2]) === 1, live: Number(a[3]) === 1, node: Number(a[4]), index: Number(a[5]), native: Number(a[6]) === 1,
        });
        break;
      case 'modsBegin':
        t().staged = { envs: new Map(), lfos: new Map() };
        break;
      case 'mod': {
        const tr = t();
        const into = tr.staged ?? { envs: tr.envs, lfos: tr.lfos };
        const kind = Number(a[3]);
        (kind === MOD_ENV ? into.envs : into.lfos).set(String(a[1]), { node: Number(a[2]), kind });
        break;
      }
      case 'modsEnd': {
        const tr = t();
        if (tr.staged) {
          tr.envs = tr.staged.envs;
          tr.lfos = tr.staged.lfos;
          tr.staged = null;
        }
        break;
      }
      case 'swap': {
        const tr = t();
        tr.shapesHandled = Number(a[1]);
        tr.swapPending = Number(a[2]) === 1;
        break;
      }
      case 'ramp': {
        const tr = t();
        const node = Number(a[2]);
        const direct = Number(a[4]) === 1;
        if (node > 0 && direct) tr.ramps.set(String(a[1]), { node, slot: Number(a[3]), rest: a[5] == null ? null : Number(a[5]) });
        else tr.ramps.delete(String(a[1]));
        break;
      }
      case 'tap': {
        const node = Number(a[2]);
        if (node > 0) t().taps.set(String(a[1]), node);
        else t().taps.delete(String(a[1]));
        break;
      }
      case 'held': {
        const tr = t();
        tr.held = Math.max(0, tr.held + Number(a[1]));
        break;
      }
      case 'dead':
        this.dead.add(Number(a[0]));
        if (this.dead.size > 4000) this.dead.clear();
        break;
      case 'loadDone': {
        const key = `${a[0]}|${Number(a[1])}`;
        const p = this.loads.get(key);
        if (p && p.seq <= Number(a[2])) this.loads.delete(key);
        break;
      }
      default:
        break;
    }
    return true;
  }

  // --- what the engine tells us it sent the old way -------------------------------------------

  /** A program load is announced for this slot, landing at `at` (engine seconds). */
  loadAnnounced(trackId, slot, seq, at) {
    const failsafe = this.server?.loadFailsafe || Infinity;
    this.loads.set(`${trackId}|${slot}`, { seq, at, until: Math.max(at, this._now()) + failsafe });
  }

  loadCancelled(trackId, slot) {
    this.loads.delete(`${trackId}|${slot}`);
  }

  /** A setParamShape went to sclang: until it says it has handled it, note-ons on the track wait. */
  shapeSent(trackId) {
    this._track(trackId).shapesSent += 1;
  }

  /** hush and clearMidiRoute zero sclang's held count; the mirror follows at once. */
  heldReset(trackId) {
    const tr = this.tracks.get(trackId);
    if (tr) tr.held = 0;
  }

  /** releaseParam takes the ramp down sclang-side; nothing more may be sent to it. */
  rampReleased(trackId, slot, name) {
    this.tracks.get(trackId)?.ramps.delete(`slot${slot}_${name}`);
  }

  songLoading(trackId) {
    this.songs.delete(trackId);
  }

  songLoaded(trackId, info) {
    if (!info || !Number.isInteger(info.bufnum)) return;
    this.songs.set(trackId, {
      bufnum: info.bufnum, channels: info.channels, sampleRate: info.sampleRate, frames: info.frames,
      node: 0, spawnUntil: 0, viaLang: false,
    });
  }

  /** A failed command reported by scsynth: forget whatever pointed at that node. */
  serverFailed(nodeID) {
    if (!Number.isInteger(nodeID)) return;
    for (const tr of this.tracks.values()) {
      for (const [k, r] of tr.ramps) if (r.node === nodeID) tr.ramps.delete(k);
    }
    this.dead.add(nodeID);
  }

  // --- sending --------------------------------------------------------------------------------

  _allocNode() {
    // The node engine hands out every id from one allocator (server/alloc.js).
    if (this.allocNode) return this.allocNode();
    const s = this.server;
    const id = this._nextNode;
    this._nextNode = id >= s.nodeHi ? s.nodeLo : id + 1;
    return id;
  }

  /** Builds the datagrams for messages due at `targetTime` (engine seconds). */
  bundlesAt(targetTime, messages) {
    const lead = targetTime - this._now();
    const tag = targetTime != null && lead > NOW_LEAD_SEC ? timeTagFor(targetTime) : IMMEDIATE;
    return packBundles(tag, messages, MAX_DATAGRAM, (m, n) =>
      this._warn(`direct-oversize:${m.address}`, `[poptart] a ${n}-byte ${m.address} is over one datagram (${MAX_DATAGRAM}); sent anyway`));
  }

  _sendAt(targetTime, messages) {
    if (!messages.length) return;
    for (const b of this.bundlesAt(targetTime, messages)) this._sendRaw(encode(b));
  }

  _sendNow(messages) {
    for (const m of messages) this._sendRaw(encode(m));
  }

  _later(atSec, fn) {
    const t = setTimeout(() => {
      this._timers.delete(t);
      fn();
    }, Math.max(0, (atSec - this._now()) * 1000));
    t.unref?.();
    this._timers.add(t);
  }

  _ok(handled) {
    if (handled) this.counts.direct += 1;
    else this.counts.fallback += 1;
    return handled;
  }

  // What has to wait for sclang's own handler: a program load reaching this note's time.
  _loadBlocks(trackId, slot, at) {
    const p = this.loads.get(`${trackId}|${slot}`);
    if (!p) return false;
    if (this._now() > p.until) {
      this.loads.delete(`${trackId}|${slot}`);
      return false;
    }
    return at >= p.at;
  }

  // A slot a note can go straight to: an open device on a node the server has.
  _liveSlot(tr, slot) {
    const s = tr.slots.get(slot);
    if (!s || !s.ctl || !s.live || !(s.node > 0) || !(s.index >= 0) || this.dead.has(s.node)) return null;
    return s;
  }

  // The messages that play a note on a device: MIDI for a plugin, the device's own for ours.
  // Mirrors noteKey + VSTPluginMIDIProxy / PoptartDeviceMIDIProxy in sc/.
  static noteMessage(s, note, vel127, isOn) {
    if (s.native) {
      return isOn
        ? { address: '/u_cmd', args: [i32(s.node), i32(s.index), str('/noteOn'), f32(note), f32(vel127 / 127)] }
        : { address: '/u_cmd', args: [i32(s.node), i32(s.index), str('/noteOff'), f32(note)] };
    }
    const key = Math.round(note);
    const status = isOn ? 0x90 : 0x80;
    return {
      address: '/u_cmd',
      args: [i32(s.node), i32(s.index), str('/midi_msg'), blob([status, key & 0xff, vel127 & 0xff]), f32(0)],
    };
  }

  // A note or sample onset retriggers the track's envelopes and its note-synced shapes.
  _onsetMods(tr) {
    const out = [];
    for (const e of tr.envs.values()) out.push({ address: '/n_set', args: [i32(e.node), str('gate'), i32(1), str('t_retrig'), i32(1)] });
    for (const l of tr.lfos.values()) {
      if (l.kind === MOD_SHAPE_RETRIG || l.kind === MOD_SHAPE_ENV) out.push({ address: '/n_set', args: [i32(l.node), str('t_trig'), i32(1)] });
    }
    return out;
  }

  _closeEnvs(tr) {
    return [...tr.envs.values()].map((e) => ({ address: '/n_set', args: [i32(e.node), str('gate'), i32(0)] }));
  }

  /**
   * A note on a track's device slot (0 = the instrument, see poptartNoteOn; >0 = noteOnSlot, which
   * leaves the held count and the modulators alone). False = send it the old way.
   */
  noteOn(trackId, slot, note, velocity, targetTime) {
    if (!this.ready) return this._ok(false);
    const tr = this.tracks.get(trackId);
    if (!tr?.known) return this._ok(false);
    const s = this._liveSlot(tr, slot);
    if (!s || this._loadBlocks(trackId, slot, targetTime)) return this._ok(false);
    if (slot === 0 && (tr.swapPending || tr.shapesSent > tr.shapesHandled || tr.staged)) return this._ok(false);
    let vel127 = Math.round(velocity * 127);
    if (slot !== 0) vel127 = Math.min(127, Math.max(1, vel127));
    const msgs = [DirectPath.noteMessage(s, note, vel127, true)];
    if (slot === 0) {
      msgs.push(...this._onsetMods(tr));
      tr.held += 1;
    }
    this._sendAt(targetTime, msgs);
    this._tell('/poptart/direct/note', [trackId, slot, note, -1]);
    return this._ok(true);
  }

  noteOff(trackId, slot, note, targetTime) {
    if (!this.ready) return this._ok(false);
    const tr = this.tracks.get(trackId);
    if (!tr?.known) return this._ok(false);
    const s = this._liveSlot(tr, slot);
    if (!s || this._loadBlocks(trackId, slot, targetTime)) return this._ok(false);
    const msgs = [DirectPath.noteMessage(s, note, 0, false)];
    if (slot === 0) {
      tr.held = Math.max(0, tr.held - 1);
      if (tr.held === 0) msgs.push(...this._closeEnvs(tr));
    }
    this._sendAt(targetTime, msgs);
    this._tell('/poptart/direct/note', [trackId, slot, note, Math.max(0, targetTime - this._now())]);
    return this._ok(true);
  }

  /**
   * One sampler voice (see poptartPlaySample), already resolved to the synth's numbers. `v` has
   * { bufnum, channels, begin, end, loop, rate, stretch, dur, onsetSec, offsetSec, amp, cut,
   * atk, dec, sus, rel, loopLo, loopHi, entry, pingpong }. Granular voices stay with sclang.
   */
  playSample(trackId, v) {
    if (!this.ready) return this._ok(false);
    const tr = this.tracks.get(trackId);
    if (!tr?.known || !(tr.voices > 0) || !Number.isInteger(v.bufnum)) return this._ok(false);
    const warp = Math.abs(v.stretch - 1) > 1e-4;
    const loop = v.loop === 1;
    const defName = `poptart_sample_${warp ? 'warp_' : ''}${loop ? 'loop_' : ''}${v.channels}`;
    const gated = loop || v.cut === 1;
    const node = this._allocNode();
    const args = [
      str('out'), i32(tr.inBus), str('buf'), i32(v.bufnum), str('begin'), f32(v.begin), str('end'), f32(v.end),
      str('rate'), f32(v.rate), str('dur'), f32(v.dur), str('gate'), i32(1), str('amp'), f32(v.amp),
      str('atk'), f32(v.atk), str('dec'), f32(v.dec), str('sus'), f32(v.sus), str('rel'), f32(v.rel),
      str('bend'), str(`c${tr.bendBus}`),
    ];
    if (loop) args.push(str('loopLo'), f32(v.loopLo), str('loopHi'), f32(v.loopHi), str('entry'), f32(v.entry), str('pingpong'), i32(v.pingpong));
    const spawn = { address: '/s_new', args: [str(defName), i32(node), i32(0), i32(tr.voices), ...args] };
    this._sendAt(v.onsetSec, [spawn, ...this._onsetMods(tr)]);
    if (gated) this._sendAt(v.offsetSec, [{ address: '/n_set', args: [i32(node), str('gate'), i32(0)] }]);
    tr.held += 1;
    const doneAt = gated ? v.offsetSec : v.onsetSec + v.dur;
    // The held count drops when the voice's own event ends, as sclang's SystemClock.sched did.
    this._later(doneAt, () => {
      tr.held = Math.max(0, tr.held - 1);
      if (tr.held === 0 && this.tracks.get(trackId) === tr) this._sendNow(this._closeEnvs(tr));
      this._tell('/poptart/direct/held', [trackId, -1]);
    });
    this._tell('/poptart/direct/voice', [trackId, node, defName, Math.max(0, doneAt - this._now())]);
    return this._ok(true);
  }

  /**
   * A polled value onto a ramp sclang has already built (see rampTo). Only the ramp's target
   * moves; the first value, a channel control coming back to rest, and the stepped selectors go
   * the old way, since those are where sclang builds, drops or sets outright.
   */
  setParam(trackId, slot, name, value, targetTime) {
    if (!this.ready) return this._ok(false);
    const tr = this.tracks.get(trackId);
    if (!tr?.known) return this._ok(false);
    const key = `slot${slot}_${name}`;
    const r = tr.ramps.get(key);
    if (!r || this.dead.has(r.node)) return this._ok(false);
    if (slot === -1 && r.rest != null && value === r.rest) {
      tr.ramps.delete(key); // sclang schedules the ramp's drop on this value: it must see what follows
      return this._ok(false);
    }
    const leaf = /^~\d+~/.test(name);
    const v = slot >= 0 && !leaf ? Math.min(1, Math.max(0, value)) : value;
    this._sendAt(targetTime, [{ address: '/n_set', args: [i32(r.node), str('target'), f32(v)] }]);
    return this._ok(true);
  }

  /** A stepped channel control on the instrument node (the grain controls), set outright. */
  setHeadControl(trackId, name, value, targetTime) {
    if (!this.ready) return this._ok(false);
    const tr = this.tracks.get(trackId);
    if (!tr?.known || !(tr.head > 0) || this.dead.has(tr.head)) return this._ok(false);
    this._sendAt(targetTime, [{ address: '/n_set', args: [i32(tr.head), str(name), f32(value)] }]);
    return this._ok(true);
  }

  /** A patterned lfo's phase anchor (see poptartAnchorParamLFO). A drawn shape's new rate stays with sclang, which keeps it for swaps. */
  anchorLfo(trackId, slot, name, phase, targetTime, rate) {
    if (!this.ready) return this._ok(false);
    const tr = this.tracks.get(trackId);
    const l = tr?.known && !tr.staged ? tr.lfos.get(`slot${slot}_${name}`) : null;
    if (!l || this.dead.has(l.node)) return this._ok(false);
    const custom = l.kind !== MOD_LFO;
    if (rate != null && custom) return this._ok(false);
    const args = [i32(l.node), str('t_trig'), i32(1), str('phase'), f32(phase)];
    if (rate != null) args.push(str('freq'), f32(rate));
    this._sendAt(targetTime, [{ address: '/n_set', args }]);
    return this._ok(true);
  }

  busSendAmount(trackId, index, amount, targetTime) {
    if (!this.ready) return this._ok(false);
    const node = this.tracks.get(trackId)?.taps.get(`bus${index}`);
    if (!(node > 0) || this.dead.has(node)) return this._ok(false);
    this._sendAt(targetTime, [{ address: '/n_set', args: [i32(node), str('amp'), f32(amount)] }]);
    return this._ok(true);
  }

  // --- song decks (see poptartSongStart and its neighbors) ------------------------------------

  // songLat: nothing reaches a player before just after its spawn.
  _songAt(song, targetTime) {
    return Math.max(targetTime, song.spawnUntil + 0.02);
  }

  songStart(trackId, posSec, rate, targetTime, warp) {
    if (!this.ready) return this._ok(false);
    const tr = this.tracks.get(trackId);
    const song = this.songs.get(trackId);
    if (!tr?.known || !(tr.group > 0) || !song) return this._ok(false);
    const now = this._now();
    const latency = Math.max(0, targetTime - now);
    const sr = this.server.sampleRate;
    const rbLat = warp ? this.server.rbDelay / sr : 0;
    const spawnAt = Math.max(0, latency - rbLat);
    const seekSec = posSec - (latency - spawnAt) * rate;
    const handover = Math.max(latency, spawnAt + rbLat);
    const frame = Math.min(Math.max(0, song.frames - 1), Math.max(0, seekSec * (song.sampleRate || sr)));
    const defName = `${warp ? 'poptart_songwarp_' : 'poptart_song_'}${song.channels}`;
    if (song.node > 0) this._sendAt(this._songAt(song, now + handover), [{ address: '/n_set', args: [i32(song.node), str('gate'), i32(0)] }]);
    const node = this._allocNode();
    song.node = node;
    song.viaLang = false;
    song.spawnUntil = now + spawnAt;
    this._sendAt(now + spawnAt, [{
      address: '/s_new',
      args: [str(defName), i32(node), i32(0), i32(tr.group),
        str('out'), i32(tr.inBus), str('buf'), i32(song.bufnum), str('rate'), f32(rate), str('run'), i32(1),
        str('t_seek'), i32(1), str('seekFrame'), f32(frame), str('delay'), f32(warp ? this.server.rbDelay : 0)],
    }]);
    this._tell('/poptart/direct/song', [trackId, node, defName, spawnAt]);
    return this._ok(true);
  }

  // A deck whose player sclang made (a start that went the old way) stays sclang's until the next start.
  _songOwn(trackId) {
    if (!this.ready) return null;
    const song = this.songs.get(trackId);
    if (!song || song.viaLang) return null;
    return song;
  }

  /** Marks a deck whose start went the old way. */
  songStartedByLang(trackId) {
    const song = this.songs.get(trackId);
    if (song) song.viaLang = true;
  }

  songSet(trackId, name, value, targetTime) {
    const song = this._songOwn(trackId);
    if (!song) return this._ok(false);
    if (song.node > 0) this._sendAt(this._songAt(song, targetTime), [{ address: '/n_set', args: [i32(song.node), str(name), f32(value)] }]);
    return this._ok(true);
  }

  songSeek(trackId, posSec, targetTime) {
    const song = this._songOwn(trackId);
    if (!song) return this._ok(false);
    const frame = Math.min(Math.max(0, song.frames - 1), Math.max(0, posSec * (song.sampleRate || this.server.sampleRate)));
    if (song.node > 0) {
      this._sendAt(this._songAt(song, targetTime), [{ address: '/n_set', args: [i32(song.node), str('seekFrame'), f32(frame), str('t_seek'), i32(1)] }]);
    }
    return this._ok(true);
  }

  songStop(trackId, targetTime) {
    const song = this._songOwn(trackId);
    if (!song) return this._ok(false);
    if (song.node > 0) {
      this._sendAt(this._songAt(song, targetTime), [{ address: '/n_set', args: [i32(song.node), str('gate'), i32(0)] }]);
      this._tell('/poptart/direct/songStop', [trackId, song.node]);
    }
    song.node = 0;
    return this._ok(true);
  }
}

module.exports = {
  DirectPath, timeTagFor, secondsOf, packBundles, encode, MAX_DATAGRAM, NTP_EPOCH_OFFSET,
  MOD_ENV, MOD_LFO, MOD_SHAPE_FREE, MOD_SHAPE_RETRIG, MOD_SHAPE_ENV,
};
