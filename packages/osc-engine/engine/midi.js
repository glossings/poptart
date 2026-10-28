'use strict';

// Live MIDI input: the forwarding feed to Node, midicc() onto a parameter, midikeys()/midi()
// device routes onto a track's instrument, and device notes injected into an effect - poptart.scd's
// MIDI sections. The devices themselves are ../server/midi-io.js; MIDIdef is E.midiDef below.
//
// What a knob or a key does to the server - a control bus written, a note into the plugin - is
// done on the MIDI worker's thread the moment the message arrives (../server/midi-routes.js),
// so a busy engine loop cannot hold it back. The defs here keep the books: held counts, envelope
// gates, what Node is told. Each is handed what the worker did as its last argument.

const { Bus } = require('../server/objects');
const { MidiIO } = require('../server/midi-io');

const KIND_OF = { 0x90: 'noteOn', 0x80: 'noteOff', 0xB0: 'cc', 0xE0: 'bend', 0xD0: 'touch', 0xA0: 'polytouch', 0xC0: 'program' };

function install(E) {
  const S = E.S;
  // defKey -> { kind, fn, num, chan, srcID, free() }: MIDIdef.all.
  E.midiDefs = new Map();
  E.midiConnected = new Set();
  E._midiReady = null;
  E._midiIO = E.config.midiIO ?? null;
  Object.defineProperty(E, 'midiIO', {
    configurable: true,
    get() {
      E._midiIO ??= new MidiIO({
        serverPort: S.options.port, sclangPort: E.config.midiIoPort ?? 57150,
        ...(E.config.midiBackend ? { backend: E.config.midiBackend } : {}),
        output: (t) => E.post(String(t).trimEnd()),
      });
      return E._midiIO;
    },
    set(v) { E._midiIO = v; },
  });
  E.onStop(() => E._midiIO?.close());

  /**
   * MIDIdef(key, fn, ...): one handler per key, replacing any before it. Arguments reach fn in the
   * class library's order - noteOn/noteOff/cc (value, num, chan, src), bend/touch/program
   * (value, chan, src), polytouch (value, note, chan, src) - and then what the worker's direct
   * path did with the message: the result under `resultKey` (see ../server/midi-routes.js).
   * num/chan/srcID nil match anything. `direct` is a route entry the worker plays for this def,
   * under the def's key; freeing the def takes it away.
   */
  E.midiDef = (key, kind, fn, { num = null, chan = null, srcID = null, direct = null, resultKey = key } = {}) => {
    const prev = E.midiDefs.get(key);
    // A direct route re-set under its key keeps what it has sounding (see DirectRoutes#set).
    if (prev) { prev.keepRoute = direct != null; prev.free(); }
    const def = {
      kind, fn, num, chan, srcID, resultKey, keepRoute: false,
      free: () => {
        if (E.midiDefs.get(key) !== def) return;
        E.midiDefs.delete(key);
        if (direct && !def.keepRoute) E._midiIO?.routeRemove(key);
      },
    };
    E.midiDefs.set(key, def);
    if (direct) E.midiIO.route(key, direct);
    return def;
  };

  // What a slot's controller drives, for the worker's direct path: the UGen its MIDI goes to.
  E.midiTargetOf = (ctl) => {
    if (ctl == null || ctl.synth == null) return null;
    const kind = typeof ctl.sendMidi === 'function' ? 'vst' : 'device';
    return { kind, node: ctl.synth.nodeID, index: ctl.synthIndex };
  };

  // Calls fn(slot) whenever a track's slot gets or loses a controller, so a direct route keeps
  // playing into what is in the slot today (a reload, a plugin swapped for a device).
  E.watchSlots = (track, fn) => {
    const m = track.controllers;
    if (!m._watchers) {
      const watchers = new Set();
      const set = m.set.bind(m);
      const del = m.delete.bind(m);
      const clear = m.clear.bind(m);
      const tell = (k) => { for (const w of [...watchers]) w(k); };
      m.set = (k, v) => { const r = set(k, v); tell(k); return r; };
      m.delete = (k) => { const r = del(k); tell(k); return r; };
      m.clear = () => { const keys = [...m.keys()]; clear(); keys.forEach(tell); };
      m._watchers = watchers;
    }
    m._watchers.add(fn);
    return () => m._watchers.delete(fn);
  };

  // One incoming message, to every def that matches it, with what the worker did about it.
  E.midiDispatch = (src, status, d1, d2, results = {}) => {
    const kind = KIND_OF[status & 0xF0];
    if (!kind) return;
    const chan = status & 0x0F;
    for (const def of [...E.midiDefs.values()]) {
      if (def.kind !== kind) continue;
      if (def.chan != null && def.chan !== chan) continue;
      if (def.srcID != null && def.srcID !== src) continue;
      if (def.num != null && (kind === 'cc' || kind === 'noteOn' || kind === 'noteOff') && def.num !== d1) continue;
      const r = results?.[def.resultKey];
      try {
        switch (kind) {
          case 'noteOn': case 'noteOff': case 'cc': def.fn(d2, d1, chan, src, r); break;
          case 'bend': def.fn(d1 + d2 * 128, chan, src, r); break;
          case 'touch': case 'program': def.fn(d1, chan, src, r); break;
          case 'polytouch': def.fn(d2, d1, chan, src, r); break;
          default: break;
        }
      } catch (err) {
        E.error(`MIDIdef ${kind}`, err);
      }
    }
  };

  const fullName = (s) => `${s.device} ${s.name}`;

  // Lazy and idempotent: most sessions never touch MIDI, so the devices are only opened when a
  // pattern first asks (any MIDI-flavored command, or Node's explicit /poptart/midiInit). Once
  // on, every incoming CC and note is also forwarded to Node as /poptart/midiIn - the live-value
  // feed a cc signal demoted to Tier-1 samples JS-side, and the desk's learned buttons. Resolves
  // with whether MIDI is up; a machine where it cannot be says so once and carries on.
  E.midiEnable = async () => {
    if (!E.midiInitialized) {
      E.midiInitialized = true;
      E._midiReady = (async () => {
        const io = E.midiIO;
        try {
          await io.open();
        } catch (err) {
          E.warn(`poptart: MIDI is not available - ${err.message}`);
          return false;
        }
        io.onMessage((src, st, a, b, results) => E.midiDispatch(src, st, a, b, results));
        io.connectAll();
        E.midiConnected = new Set(io.sources().map((s) => s.uid));
        E.midiDef('poptart_cc_forward', 'cc', (val, num, chan, src) => {
          E.midiNameForUid(src, (name) => E.tell('/poptart/midiIn', name, chan + 1, num, val / 127.0, 'cc'));
        });
        // NOTES are forwarded too, and the trailing word is which kind of message this is - a cc
        // 7 and a note 7 are different controls and must never bind to each other. Both edges go
        // out, and a release is 0.0 whichever way it is spelled (a note-on of velocity 0 too).
        E.midiDef('poptart_note_forward', 'noteOn', (veloc, num, chan, src) => {
          E.midiNameForUid(src, (name) => E.tell('/poptart/midiIn', name, chan + 1, num, veloc / 127.0, 'note'));
        });
        E.midiDef('poptart_noteoff_forward', 'noteOff', (veloc, num, chan, src) => {
          E.midiNameForUid(src, (name) => E.tell('/poptart/midiIn', name, chan + 1, num, 0.0, 'note'));
        });
        E.post(`poptart: MIDI input enabled (${io.sources().length} source(s))`);
        return true;
      })();
      return E._midiReady;
    }
    // Already on: a second ask is also a rescan, so a controller plugged in mid-session is heard.
    // Connecting is per NEW source only, so asking twice cannot double anyone's events.
    const ok = await E._midiReady;
    if (ok) await E.midiRefreshSources();
    return ok;
  };

  // The source list is a snapshot taken when MIDI was enabled; re-reading it is cheap and safe.
  E.midiRefreshSources = async () => {
    const io = E.midiIO;
    await io.list();
    for (const s of io.sources()) {
      if (!E.midiConnected.has(s.uid)) {
        io.connect(s.uid);
        E.midiConnected.add(s.uid);
        E.post(`poptart: MIDI source connected: ${s.device} ${s.name}`);
      }
    }
  };

  // The "device name" of a source, to `then`: at once when it is known, after a rescan otherwise.
  E.midiNameForUid = (uid, then) => {
    const find = () => E.midiIO.sources().find((e) => e.uid === uid);
    const s = find();
    if (s) { then(fullName(s)); return; }
    E.midiRefreshSources().then(() => {
      const again = find();
      then(again ? fullName(again) : 'unknown');
    }, () => then('unknown'));
  };

  // Same matching rule as pattern-core's midi.mjs: case-insensitive substring of "device name".
  E.midiSourceFor = async (pattern) => {
    const p = String(pattern).toLowerCase();
    const find = () => E.midiIO.sources().find((s) => fullName(s).toLowerCase().includes(p));
    let src = find();
    if (!src) { await E.midiRefreshSources(); src = find(); }
    return src ?? null;
  };

  E.midiWarnMissing = (context, device) => {
    if (!E.midiWarned.has(String(device))) {
      E.midiWarned.add(String(device));
      E.warn(`poptart: ${context}: no MIDI source matching '${device}' - connected: `
        + `${E.midiIO.sources().map(fullName).join(', ')}. Plug it in and re-evaluate.`);
    }
  };

  // Node asks for MIDI explicitly when a pattern's only MIDI use is Tier-1.
  E.on('/poptart/midiInit', () => E.midiEnable());

  // Connected sources as "device name" strings, for the editor's device autocomplete. Enabling
  // an enabled client rescans, so this is what is plugged in NOW.
  E.on('/poptart/getMidiDevices', async (msg) => {
    const requestId = msg[1];
    await E.midiEnable();
    E.replyOk('/poptart/getMidiDevices', requestId, E.toJson(E.midiIO.sources().map(fullName)));
  });

  // midicc() -> parameter: one MIDIdef writes each incoming value (scaled into lo..hi) straight to
  // a control bus mapped onto the parameter - no Node round-trip, no polling. channel 0 = all
  // channels. A re-send with the same binding updates lo/hi in place (the knob's last position
  // rescaled onto the new range); a changed binding re-registers the def on the same bus. slot -1
  // = the track's own channel controls, as everywhere else.
  E.on('/poptart/setParamCC', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const paramName = String(msg[3]);
    const device = String(msg[4]);
    const cc = Math.trunc(msg[5]);
    const channel = Math.trunc(msg[6]);
    const lo = Number(msg[7]);
    const hi = Number(msg[8]);
    E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) { E.warn(`poptart: setParamCC: no track ${key}`); return; }
      await E.midiEnable();
      const target = await E.awaitTarget(track, slot, paramName, 'setParamCC');
      if (target == null) return;
      // Range warnings are for a plugin's 0..1 controls, not a channel or an expression input.
      const isChannel = target.kind !== 'control';
      const index = target.index;
      const src = await E.midiSourceFor(device);
      if (src == null) { E.midiWarnMissing('midicc', device); return; }
      const binding = `${device}|${cc}|${channel}`;
      const ccKey = `slot${slot}_${paramName}`;
      const defKey = `poptart_cc_${key}_${ccKey}`;
      const existing = track.ccs.get(ccKey);
      const registerDef = (e) => {
        // The worker writes the bus (see the top of this file); this keeps the knob's position.
        E.midiDef(defKey, 'cc', (val, num, chan, s, r) => {
          e.last = r?.last ?? val / 127;
        }, {
          num: cc, chan: channel > 0 ? channel - 1 : null, srcID: src.uid,
          direct: { kind: 'cc', num: cc, chan: channel > 0 ? channel - 1 : null, srcID: src.uid, bus: e.bus.index, lo: e.lo, hi: e.hi },
        });
        e.srcUid = src.uid;
        // The one line that says a knob IS wired.
        E.post(`poptart: cc ${cc} on ${device} -> ${key} slot ${slot} '${paramName}' (${lo}..${hi})`);
      };
      if (existing == null && !isChannel && (lo < 0 || hi > 1)) {
        E.warn(`poptart: CC range ${lo}..${hi} for '${paramName}' is outside the normalized 0..1 VST parameter range `
          + 'and will pin - use .range(0.2, 0.9)-style values until per-plugin calibration exists');
      }
      if (existing != null) {
        existing.lo = lo;
        existing.hi = hi;
        // The entry outlives the plugin it was mapped onto: map again on every send (onto the same
        // bus it is a no-op), so a re-eval leaves the knob connected to what is in the slot today.
        existing.index = index;
        target.map(existing.bus);
        // A binding that still matches but whose def is gone or re-sourced is registered afresh.
        if (existing.binding !== binding || existing.srcUid !== src.uid || !E.midiDefs.has(defKey)) {
          existing.binding = binding;
          registerDef(existing);
        } else {
          E.midiIO.routeUpdate(defKey, { lo, hi });
        }
        existing.bus.set(lo + (existing.last * (hi - lo)));
      } else {
        const bus = Bus.control(S, 1);
        const entry = { bus, index, lo, hi, last: 0, binding, defKey };
        bus.set(lo); // hardware position unknown until the knob moves - start at the floor
        registerDef(entry);
        E.dropRamp?.(key, track, ccKey);
        target.map(bus);
        track.ccs.set(ccKey, entry);
      }
    });
  });

  E.on('/poptart/clearParamCC', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const paramName = String(msg[3]);
    const track = E.tracks.get(key);
    const ccKey = `slot${slot}_${paramName}`;
    const existing = E.isTrack(track) ? track.ccs.get(ccKey) : null;
    if (existing != null) {
      E.midiDefs.get(existing.defKey)?.free();
      E.paramTarget(track, slot, paramName, existing.index)?.unmap();
      existing.bus.free();
      track.ccs.delete(ccKey);
    }
  });

  // midikeys(): route a device's live performance stream to the track's instrument, straight to
  // the slot-0 controller's MIDI input ("now", not the lookahead). Note edges keep the held count
  // and gate envs / retrigger lfos as pattern notes do; CCs, bend and both aftertouch kinds pass
  // through. channel 0 = all channels.
  E.on('/poptart/midiRoute', (msg) => {
    const key = String(msg[1]);
    const device = String(msg[2]);
    const channel = Math.trunc(msg[3]);
    const scaleStr = msg.length > 4 ? String(msg[4]) : '';
    // Folded pitch statics: a semitone shift applied before the scale quantize.
    const transpose = msg.length > 5 ? Math.trunc(msg[5]) : 0;
    // DEFER mode (a dynamic pitch-op chain): forward each raw note edge to Node and play nothing
    // here - Node answers with /poptart/noteOn|noteOff. Bend, touch and CC still pass straight through.
    const defer = msg.length > 6 ? Math.trunc(msg[6]) > 0 : false;
    E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      // .scale(): each note snapped to the nearest of the scale's pitch classes, ties downward (in the worker).
      const scalePcs = scaleStr.length === 0 ? null : scaleStr.split(',').map((x) => Math.trunc(Number(x)));
      if (track == null) { E.warn(`poptart: midiRoute: no track ${key}`); return; }
      await E.midiEnable();
      const src = await E.midiSourceFor(device);
      if (src == null) { E.midiWarnMissing('midikeys', device); return; }
      const uid = src.uid;
      const chanArg = channel > 0 ? channel - 1 : null;
      const kOn = `poptart_mk_on_${key}`;
      const kOff = `poptart_mk_off_${key}`;
      const kBend = `poptart_mk_bend_${key}`;
      const kTouch = `poptart_mk_touch_${key}`;
      const kPoly = `poptart_mk_poly_${key}`;
      const kCc = `poptart_mk_cc_${key}`;
      for (const k of [kOn, kOff, kBend, kTouch, kPoly, kCc]) E.midiDefs.get(k)?.free();
      // What the route has sounding: incoming (channel, key) -> the pitch its note-on played. A
      // note-off releases THAT pitch, and a teardown releases exactly these (see clearMidiRoute).
      // Kept across a re-registration. The worker plays the notes and keeps the same table; this
      // one is its mirror, filled from what the worker says it did.
      const sounding = track.midiRoute?.sounding ?? new Map();
      track.midiRoute?.unwatch?.();
      const kRoute = `poptart_mk_${key}`;
      const opts = { chan: chanArg, srcID: uid, resultKey: kRoute };
      const onEdge = (veloc, note, chan, r) => {
        if (r == null) return;
        if (r.defer) {
          // Raw edge to Node; its answer comes back as /poptart/noteOn and does the playing.
          E.tell('/poptart/midiNoteIn', key, note, veloc / 127.0, r.on ? 1 : 0);
          return;
        }
        // Every edge also goes to Node (the note as it sounds) for MIDI record - whether or not
        // the instrument is open yet.
        E.tell('/poptart/midiNoteIn', key, r.note, veloc / 127.0, r.on ? 1 : 0);
        if (!r.played) return;
        const rawKey = (chan * 128) + note;
        if (r.on) {
          E.heldBy(track, 1);
          sounding.set(rawKey, r.note);
          for (const e of track.envs.values()) e.synth.set('gate', 1, 't_retrig', 1);
          for (const e of track.lfos.values()) {
            if (e.mode === 'retrigger' || e.mode === 'envelope') e.synth.set('t_trig', 1);
          }
        } else {
          E.heldBy(track, -1);
          sounding.delete(rawKey);
          if (track.held === 0) for (const e of track.envs.values()) e.synth.set('gate', 0);
        }
      };
      E.midiDef(kRoute, 'none', () => {}, {
        direct: { kind: 'keys', chan: chanArg, srcID: uid, transpose, scalePcs, defer, target: E.midiTargetOf(track.controllers.get(0)) },
      });
      E.midiDef(kOn, 'noteOn', (veloc, note, chan, s, r) => onEdge(veloc, note, chan, r), opts);
      E.midiDef(kOff, 'noteOff', (veloc, note, chan, s, r) => onEdge(veloc, note, chan, r), opts);
      // Bend, touch, polytouch and CC go straight through to the instrument, in the worker.
      const unwatch = E.watchSlots(track, (slot) => {
        if (slot === 0) E.midiIO.routeUpdate(kRoute, { target: E.midiTargetOf(track.controllers.get(0)) });
      });
      track.midiRoute = { keys: [kRoute, kOn, kOff, kBend, kTouch, kPoly, kCc], sounding, unwatch };
      E.post(`poptart: track ${key} playing live from ${src.device} ${src.name}`
        + (channel > 0 ? ` (channel ${channel})` : ' (all channels)')
        + (defer ? ' (pitch ops in Node)' : ''));
    });
  });

  // Tearing a route down also silences anything still sounding: gates close, and every note the
  // route still has sounding is released by name. CC 123 (all notes off) follows on every channel
  // for a VST2 plugin only - VST3 has no such message, and VSTPlugin warns per channel for one.
  E.clearMidiRoute = (key) => {
    const track = E.tracks.get(key);
    if (E.isTrack(track) && track.midiRoute != null) {
      const { sounding } = track.midiRoute;
      track.midiRoute.unwatch?.();
      for (const k of track.midiRoute.keys) E.midiDefs.get(k)?.free();
      track.midiRoute = null;
      track.held = 0;
      for (const e of track.envs.values()) e.synth.set('gate', 0);
      const ctl = track.controllers.get(0);
      // A plugin has to be there to release anything (see slotLive).
      if (ctl != null && E.slotLive(track, 0)) {
        if (sounding) for (const [rawKey, note] of sounding) ctl.midi.noteOff(Math.floor(rawKey / 128), note, 0);
        if (ctl.info != null && !String(ctl.info.sdkVersion).includes('VST 3')) {
          for (let c = 0; c < 16; c++) ctl.midi.control(c, 123, 0);
        }
      }
    }
  };

  E.on('/poptart/clearMidiRoute', (msg) => E.clearMidiRoute(String(msg[1])));

  E.on('/poptart/injectMidiDevice', (msg) => {
    const targetKey = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const device = String(msg[3]);
    E.fork(async () => {
      const track = E.builtTrack(targetKey) ?? await E.awaitTrack(targetKey);
      if (track == null) return;
      await E.midiEnable();
      const src = await E.midiSourceFor(device);
      if (src == null) { E.midiWarnMissing('midi inject', device); return; }
      const kOn = `poptart_mi_on_${targetKey}_${slot}`;
      const kOff = `poptart_mi_off_${targetKey}_${slot}`;
      for (const k of [kOn, kOff]) E.midiDefs.get(k)?.free();
      // The notes go into the slot from the worker (see the top of this file); nothing to keep here.
      E.midiDef(kOn, 'none', () => {}, { direct: { kind: 'inject', srcID: src.uid, target: E.midiTargetOf(track.controllers.get(slot)) } });
      const unwatch = E.watchSlots(track, (k) => {
        if (k === slot) E.midiIO.routeUpdate(kOn, { target: E.midiTargetOf(track.controllers.get(slot)) });
      });
      E.midiDef(kOff, 'none', () => {});
      E.midiDefs.get(kOff).free = ((free) => () => { unwatch(); free(); })(E.midiDefs.get(kOff).free);
      track.midiInjectDefs ??= new Map();
      track.midiInjectDefs.set(slot, [kOn, kOff]);
      E.post(`poptart: midi inject: dev '${device}' -> ${targetKey} (slot ${slot})`);
    });
  });

  E.on('/poptart/clearMidiInject', (msg) => {
    const targetKey = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const track = E.tracks.get(targetKey);
    if (E.isTrack(track) && track.midiInjectDefs != null) {
      const keys = track.midiInjectDefs.get(slot);
      if (keys) {
        for (const k of keys) E.midiDefs.get(k)?.free();
        track.midiInjectDefs.delete(slot);
      }
    }
  });
}

module.exports = { install, KIND_OF };
