'use strict';

// Audio routing: named buses, cross-track sidechains and chain inputs, audio patched onto a
// parameter, a track's chain ('/poptart/setRouting'), bus sends and the DJ FX send. Ported from
// poptart.scd (see core.js for the conventions).

const { Synth, Bus } = require('../server/objects');

function install(E) {
  const S = E.S;

  // Dict key for a sidechain route, identifying the aux input by (target track, fx slot).
  E.scKey = (targetKey, slot) => `${targetKey}#${slot}`;

  // Get-or-create a named audio bus, bumping its refcount; returns the Bus. Every writer (Sig#bus)
  // and reader (audio("name")) holds one ref, so the bus outlives whichever end is set up first.
  E.acquireBus = (name) => {
    const key = String(name);
    let entry = E.namedBuses.get(key);
    if (!entry) { entry = { bus: Bus.audio(S, 2), refs: 0 }; E.namedBuses.set(key, entry); }
    entry.refs += 1;
    return entry.bus;
  };
  // Drop one ref on a named bus; free it (and forget the name) once nothing references it.
  E.releaseBus = (name) => {
    const key = String(name);
    const entry = E.namedBuses.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) { entry.bus.free(); E.namedBuses.delete(key); }
  };

  // The bus a source track's output is offered on, so that any number of routes can read it. The
  // strip's sidechain tap writes here and each route runs its own poptart_busread reader off it,
  // so one source can feed a chain input and a sidechain, or two tracks' duckers, at once.
  // Refcounted like a named bus.
  E.acquireSourceFeed = (nameKey, source) => {
    let entry = E.sourceFeeds.get(nameKey);
    if (!entry) {
      entry = { bus: Bus.audio(S, 2), refs: 0 };
      E.sourceFeeds.set(nameKey, entry);
      // Unity at the source: each reader scales its own copy.
      E.stripTap(source, 'sidechain', entry.bus.index, 1, 0);
    }
    entry.refs += 1;
    return entry.bus;
  };
  E.releaseSourceFeed = (nameKey) => {
    const entry = E.sourceFeeds.get(nameKey);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      const s = E.tracks.get(nameKey);
      if (E.isTrack(s)) E.stripTap(s, 'sidechain', null);
      entry.bus.free();
      E.sourceFeeds.delete(nameKey);
    }
  };

  // "a key is (not) patched into this slot", for one of poptart's own devices in it. The aux bus
  // is there either way (it reads silentBus until a route is wired), so silence on it says nothing;
  // a plugin needs no telling. With no third argument it looks the answer up, which is what a
  // device opening into a slot that was already wired needs.
  E.tellKeyPatched = (target, slot, patched, targetKey) => {
    const ctl = E.isTrack(target) ? target.controllers?.get(slot) : null;
    if (ctl && typeof ctl.sidechain === 'function') {
      const on = patched ?? (targetKey != null && E.sidechainByTarget.get(E.scKey(targetKey, slot)) != null);
      ctl.sidechain(on);
    }
  };

  // Wire an audio route into a sink on `targetKey`: slot >= 1 is an fx aux (sidechain) input, slot
  // 0 is the chain input (a head audio() source). `rawName` is a source track ("label" or
  // "track:label"), a bus ("bus:name") or a hardware input ("dev:..."). A track source offers its
  // output on a shared feed bus that this route reads a copy of, and is ordered ahead of the target;
  // a device source runs a SoundIn feeder at the head writing the sink bus directly. Idempotent: an
  // existing route on the same sink is torn down first. `inA`/`inB` are the hardware channels a
  // device source reads, absolute and 0-indexed (inB -1 = mono).
  E.wireAudio = (targetKey, slot, rawName, gain, inA = 0, inB = 1) => E.fork(async () => {
    const target = await E.awaitTrack(targetKey);
    const str = String(rawName);
    const isDev = str.slice(0, 4) === 'dev:';
    const isBusPrefix = str.slice(0, 4) === 'bus:';
    let name = str;
    if (isDev || isBusPrefix) name = str.slice(4);
    else if (str.slice(0, 6) === 'track:') name = str.slice(6);
    const key = E.scKey(targetKey, slot);
    if (target == null) { E.warn(`poptart: audio route: no track ${targetKey}`); return; }
    if (slot < 0) { E.warn(`poptart: audio route: bad slot ${slot}`); return; }
    const nameKey = name;
    E.unwireAudio(targetKey, slot); // retire any existing route on this sink first
    let destBus;
    let ownsBus;
    if (slot >= 1) {
      destBus = Bus.audio(S, 2);
      ownsBus = true;
      E.setScBus(target, slot, destBus.index);
      E.tellKeyPatched(target, slot, true);
    } else {
      destBus = target.inBus; // chain input: the track already mixes inBus into slot 0
      ownsBus = false;
    }
    if (isDev) {
      const mono = inB < 0;
      const inChans = S.options.numInputBusChannels;
      const last = Math.max(0, inChans - 1);
      const wanted = mono ? [inA] : [inA, inB];
      // Clamped here rather than in the SynthDef: the feeder gets a bus index and no Clip UGen.
      const clip = (c) => Math.min(last, Math.max(0, c));
      const readA = clip(inA);
      const readB = clip(inB);
      if (inChans < 1) {
        E.warn('poptart: input(): the audio device exposes no input channels - nothing to read '
          + '(pick an input-capable device in settings)');
      }
      // Out-of-range reads the last real channel, so this warning is the only way the user learns
      // they asked for a channel the device hasn't got.
      if (inChans > 0 && wanted.some((c) => c >= inChans)) {
        E.warn(`poptart: input(): channel ${wanted.map((c) => c + 1).join('/')} is past the device's ${inChans} `
          + 'input channels - reading the last one');
      }
      const feeder = mono
        ? Synth.new(S, 'poptart_soundin_mono', ['out', destBus.index, 'inA', readA, 'gain', gain], S.defaultGroup, 'addToHead')
        : Synth.new(S, 'poptart_soundin', ['out', destBus.index, 'inA', readA, 'inB', readB, 'gain', gain], S.defaultGroup, 'addToHead');
      E.sidechainByTarget.set(key, { bus: destBus, target, targetKey, slot, source: null, feeder, busName: null, owns: ownsBus });
      E.post(`poptart: audio input: ch ${wanted.map((c) => c + 1).join('+')}${name === '' ? '' : ` of '${name}'`}`
        + ` -> ${targetKey} (slot ${slot})`);
      return;
    }
    // Resolve a bare / "track:" / "bus:" name. Both a source track and a bus writer may be created
    // in the same eval as this reader, so wait briefly for either to appear; otherwise track-first
    // with a bus of that name as fallback. A track reading its OWN name means the bus, not itself.
    // "bus:" forces a bus and waits for nothing.
    let tries = 0;
    const max = Math.trunc(5 / 0.05);
    while (!isBusPrefix
      && !((nameKey !== targetKey && E.isTrack(E.tracks.get(nameKey))) || E.namedBuses.get(nameKey) != null)
      && tries < max) {
      await E.wait(0.05);
      tries += 1;
    }
    const source = isBusPrefix || nameKey === targetKey ? null : E.tracks.get(nameKey);
    const useBus = isBusPrefix || (!E.isTrack(source) && E.namedBuses.get(nameKey) != null);
    if (E.isTrack(source)) {
      // The reader sits at the head of the sink's group and the sink's group is ordered after the
      // source's (reorderTracks), so the copy lands the same block.
      const feedBus = E.acquireSourceFeed(nameKey, source);
      const feeder = Synth.new(S, 'poptart_busread', ['out', destBus.index, 'in', feedBus.index, 'gain', gain],
        target.group, 'addToHead');
      E.sidechainByTarget.set(key, { bus: destBus, target, targetKey, slot, source: nameKey, feeder, busName: null, owns: ownsBus });
      E.sidechainBySource.set(nameKey, [...(E.sidechainBySource.get(nameKey) ?? []), { targetKey, slot }]);
      E.reorderTracks();
      E.post(`poptart: audio route: ${name} -> ${targetKey} (slot ${slot})`);
    } else if (useBus) {
      // A named bus: a reader feeder copies it into the sink's input, at the head of the sink's
      // group, and the sink's group is ordered after the bus's writers so it sees their sum this
      // block. The reader holds a bus ref while it's routed.
      const busObj = E.acquireBus(name);
      const feeder = Synth.new(S, 'poptart_busread', ['out', destBus.index, 'in', busObj.index, 'gain', gain],
        target.group, 'addToHead');
      E.sidechainByTarget.set(key, { bus: destBus, target, targetKey, slot, source: null, feeder, busName: name, owns: ownsBus });
      E.reorderTracks();
      E.post(`poptart: audio route: bus '${name}' -> ${targetKey} (slot ${slot})`);
    } else {
      E.warn(`poptart: audio route: '${name}' is neither a track nor a bus`);
    }
  });

  // Undo a route on (targetKey, slot): park an fx aux back to silence, drop a track source's
  // reader (or free a device feeder), and free the bus if we allocated it. No-op if not routed.
  E.unwireAudio = (targetKey, slot) => {
    const key = E.scKey(targetKey, slot);
    const entry = E.sidechainByTarget.get(key);
    if (!entry) return;
    const target = E.tracks.get(targetKey);
    if (slot >= 1 && E.isTrack(target)) {
      E.setScBus(target, slot, E.silentBus.index);
      E.tellKeyPatched(target, slot, false);
    }
    if (entry.source != null) {
      // One route off a source that may still feed others: drop this sink from its list and let
      // the refcount decide whether the source's tap goes.
      const src = entry.source;
      const left = (E.sidechainBySource.get(src) ?? []).filter((e) => !(e.targetKey === targetKey && e.slot === slot));
      if (left.length) E.sidechainBySource.set(src, left); else E.sidechainBySource.delete(src);
      E.releaseSourceFeed(src);
    }
    if (entry.busName != null) E.releaseBus(entry.busName); // a bus reader held a ref - drop it
    entry.feeder?.free();
    if (entry.owns) entry.bus.free();
    E.sidechainByTarget.delete(key);
    E.reorderTracks(); // the sink may sit shallower now
  };

  E.paramRouteKey = (targetKey, slot, name) => `${targetKey}#${slot}#${name}`;

  // Puts a route onto the device in its slot, if that device can take one. Called when the route
  // is wired and again whenever a device opens into the slot (loadDevice), because a device that
  // takes the slot starts with every control on its own default.
  E.applyParamRoute = (track, entry) => {
    const slot = entry.slot;
    const target = E.paramTarget(track, slot, entry.name);
    // A control of a slot whose plugin is not open yet: the open applies it.
    if (target == null) return;
    if (target.mapAudio == null) {
      if (entry.warned !== track.loaded.get(slot)) {
        entry.warned = track.loaded.get(slot);
        E.warn(`poptart: audio patched onto '${entry.name}' reaches poptart's own devices only - `
          + `${track.loaded.get(slot)} is a plugin, so nothing is connected`);
      }
      return;
    }
    // A polled value the route replaced leaves a ramp behind; it goes now.
    E.dropRamp?.(entry.targetKey, track, `slot${slot}_${entry.name}`);
    entry.index = target.index;
    target.mapAudio(entry.fbBus ?? entry.bus, entry.gain, entry.offset);
  };

  // After something else took a control off its audio bus (an audio-rate env() being cleared), the
  // route that is still wanted there goes back on.
  E.reassertParamRoute = (key, track, slot, name) => {
    const entry = E.paramRoutes.get(E.paramRouteKey(key, slot, name));
    if (entry) E.applyParamRoute(track, entry);
  };

  // Wire a track's output or a named bus onto a parameter. `rawName` resolves as a sidechain's does
  // (see wireAudio). Gain and offset ride on the route and are applied by the UGen. Idempotent: a
  // route already on the parameter is retired first.
  E.wireParamRoute = (targetKey, slot, name, rawName, gain, offset) => {
    const k = E.paramRouteKey(targetKey, slot, name);
    const token = {};
    E.unwireParamRoute(targetKey, slot, name);
    E.paramRoutes.set(k, { pending: token, targetKey, slot, name });
    return E.fork(async () => {
      const target = await E.awaitTrack(targetKey);
      const str = String(rawName);
      const isBusPrefix = str.slice(0, 4) === 'bus:';
      let srcName = str;
      if (isBusPrefix) srcName = str.slice(4);
      else if (str.slice(0, 6) === 'track:') srcName = str.slice(6);
      const nameKey = srcName;
      // Still the route this wiring was started for, and not one wired or dropped since.
      const current = () => E.paramRoutes.get(k)?.pending === token;
      if (target == null) {
        E.warn(`poptart: audio source: no track ${targetKey}`);
        if (current()) E.paramRoutes.delete(k);
        return;
      }
      if (str.slice(0, 4) === 'dev:') {
        E.warn('poptart: audio source: a hardware input cannot be patched onto a parameter - route it '
          + 'to a track first');
        if (current()) E.paramRoutes.delete(k);
        return;
      }
      let tries = 0;
      const max = Math.trunc(5 / 0.05);
      while (!isBusPrefix
        && !((nameKey !== targetKey && E.isTrack(E.tracks.get(nameKey))) || E.namedBuses.get(nameKey) != null)
        && tries < max) {
        await E.wait(0.05);
        tries += 1;
      }
      // Superseded or dropped while it waited for its source.
      if (!current()) return;
      const source = isBusPrefix || nameKey === targetKey ? null : E.tracks.get(nameKey);
      const useBus = isBusPrefix || (!E.isTrack(source) && E.namedBuses.get(nameKey) != null);
      let entry = { targetKey, slot, name, gain, offset, source: null, busName: null };
      if (E.isTrack(source)) {
        entry.bus = E.acquireSourceFeed(nameKey, source);
        entry.source = nameKey;
      } else if (useBus) {
        entry.bus = E.acquireBus(srcName);
        entry.busName = srcName;
      } else {
        entry = null;
      }
      if (entry == null) {
        E.paramRoutes.delete(k);
        E.warn(`poptart: audio source: '${srcName}' is neither a track nor a bus`);
      } else {
        E.paramRoutes.set(k, entry);
        E.reorderTracks();
        E.applyParamRoute(target, entry);
        E.post(`poptart: patched ${srcName} onto '${name}' of ${targetKey} (slot ${slot})`);
      }
    });
  };

  // Undo one: the control goes back to the last value set on it (or to a native env() mapped while
  // it was patched), and the source's feed or the bus is released. No-op when nothing is patched.
  E.unwireParamRoute = (targetKey, slot, name) => {
    const k = E.paramRouteKey(targetKey, slot, name);
    const entry = E.paramRoutes.get(k);
    E.paramRoutes.delete(k);
    const track = E.tracks.get(targetKey);
    if (entry && entry.pending == null) {
      if (E.isTrack(track) && entry.index != null) {
        const target = E.paramTarget(track, slot, name, entry.index);
        target?.unmapAudio?.();
      }
      if (entry.source != null) E.releaseSourceFeed(entry.source);
      if (entry.busName != null) E.releaseBus(entry.busName);
      // A closing edge's copy of the block before (see reorderTracks).
      entry.fbFeeder?.free();
      entry.fbBus?.free();
      E.reorderTracks();
    }
  };

  // --- a track's chain ('/poptart/setRouting') ---------------------------------------------------
  //
  // The chain as route-desktop.js lays it out: `steps`, in the order the audio runs - an effect's
  // node, a .bands() crossover or a term - each with the buses it reads and writes; `out`, the bus
  // the strip reads; and `buses`, every private bus they name ("chain" is the one the head writes).
  //
  // Nothing that holds a device is rebuilt here. An effect's node is made the first time a chain
  // names its slot (see ensureFxNode) and from then on only moves and is pointed at other buses; a
  // crossover's likewise, by its id. Terms hold nothing, so they are made afresh. It all lands in
  // one bundle, and the old buses go back a moment later, once nothing reads them.
  E.routeApply = (key, track, spec) => {
    const made = { buses: [], index: new Map() };
    const old = track.route;
    const steps = spec?.steps ?? [];
    const busOf = (v) => {
      if (v === 'chain') return track.chainIn.index;
      if (v == null || v === 'none') return E.routeNowhere;
      return made.index.get(v) ?? E.routeNowhere;
    };
    const flat = spec?.crossover ?? [];
    const params = [];
    for (let i = 0; i < flat.length; i += 3) {
      params.push({ id: String(flat[i]), name: String(flat[i + 1]), default: flat[i + 2] != null ? Number(flat[i + 2]) : null });
    }
    const order = [];
    const terms = [];
    const wired = new Set();
    const crossovers = new Set();
    const opening = [];
    const sendIns = new Map();
    for (const [id, channels] of Object.entries(spec?.buses ?? {})) {
      let b = null;
      try { b = Bus.audio(S, Math.trunc(Number(channels))); } catch { b = null; }
      if (b == null) {
        E.warn(`poptart: the server has no private audio bus left for track ${key}'s chain - part of it `
          + `is silent. Raise POPTART_AUDIO_BUSES (now ${S.options.numAudioBusChannels})`);
      } else {
        made.buses.push(b);
        made.index.set(id, b.index);
      }
    }
    S.makeBundle(null, () => {
      for (const st of steps) {
        const kind = st.k;
        if (kind === 'fx') {
          const slot = Math.trunc(Number(st.slot));
          const node = E.ensureFxNode(key, track, slot);
          wired.add(slot);
          // A looped Delay's repeats go out on `loop`; its return is pointed by the ret step.
          node.set('in', busOf(st.in), 'out', busOf(st.out), 'loop', busOf(st.loop ?? 'none'), 'ret', E.silentBus.index);
          order.push(node);
        } else if (kind === 'xover') {
          const id = String(st.id);
          let x = track.xovers.get(id);
          if (!x) {
            const node = Synth.new(S, E.trackDef.xover.name, [], track.synth, 'addBefore');
            x = { node, k: Math.trunc(Number(st.xo)) };
            track.xovers.set(id, x);
            opening.push(x);
          }
          crossovers.add(id);
          x.node.set('in', busOf(st.in), 'key', busOf(st.key), 'out', busOf(st.out),
            'rest', busOf(st.rest), 'ap', busOf(st.ap));
          order.push(x.node);
        } else if (kind === 'term') {
          const g = Math.trunc(Number(st.g));
          const gain = g === 0 ? -1 : E.routeKrNode(track, 'gain', g).bus.index;
          const node = Synth.new(S, 'poptart_term', ['in', busOf(st.in), 'out', busOf(st.out), 'gain', gain],
            track.synth, 'addBefore');
          terms.push(node);
          order.push(node);
        } else if (kind === 'send') {
          sendIns.set(Math.trunc(Number(st.i)), busOf(st.in));
        } else if (kind === 'ret') {
          // Read the block before (InFeedback in the effect def): it closes the loop.
          track.nodes.get(Math.trunc(Number(st.slot)))?.set('ret', busOf(st.in));
        }
      }
      // The sends written inside the chain read the bus this layout gives them; the rest, and any
      // that was tapping a bus of the layout going, the strip's output. Set here so the taps
      // follow in the same bundle as the buses they read.
      track.sendIns = sendIns;
      E.repointSends(track);
      // In the order the audio runs, each just before the strip (or the bass mono before it).
      for (const node of order) node.moveBefore(track.bassmono ?? track.synth);
      track.chainOut = busOf(spec?.out ?? 'chain');
      (track.bassmono ?? track.synth).set('in', track.chainOut);
      for (const [slot, node] of track.nodes) {
        if (!wired.has(slot)) node.set('in', E.routeNowhere, 'out', E.routeNowhere, 'loop', E.routeNowhere, 'ret', E.silentBus.index);
      }
      for (const id of [...track.xovers.keys()]) {
        if (!crossovers.has(id)) {
          const x = track.xovers.get(id);
          track.xovers.delete(id);
          x.node.free();
        }
      }
      track.terms.forEach((n) => n.free());
    });
    track.terms = terms;
    track.wired = wired;
    track.route = made;
    // The crossovers new to this wiring: the engine's own Crossover device, its one control on the
    // track's xo<k> - so whatever drives that control drives the split.
    for (const x of opening) {
      const ctl = E.deviceController(x.node, 'nslot', E.trackDef.xover.name);
      x.ctl = ctl;
      ctl.open('Crossover', params, (self, ok) => {
        if (ok) {
          // On an audio-rate driver of xo<k> when there is one (see setChanAr).
          const driven = track.chanAr?.get(`xo${x.k}`);
          x.open = true;
          if (driven != null) self.mapAudio(0, driven, 1, 0); else self.map(0, E.routeKrNode(track, 'xo', x.k).bus);
        } else E.warn(`poptart: track ${key}: the Crossover device would not open, so its bands are silent`);
      });
    }
    if (old) E.sched(0.2, () => { E.routeFree(old); return null; });
  };
  E.routeFree = (made) => {
    made.buses.forEach((b) => b.free());
  };

  // Where send `i` (its index among the pattern's sends) reads: the bus the chain layout gives it
  // when it is written inside the chain, otherwise null for the strip's output.
  E.sendInput = (track, i) => track.sendIns?.get(i) ?? null;

  // Every routed send's tap pointed at what the current layout says it reads.
  E.repointSends = (track) => {
    (track.busSendIdx ?? []).forEach((i, k) => {
      const tap = track.taps.get(`bus${k}`);
      if (tap) tap.set('in', E.sendInput(track, i) ?? E.stripPost(track).index);
    });
  };

  // How late the chain in a looped device's feedback loop is, from its devices (the UGen adds its
  // block), or below zero for none: kept per slot, and told to the device now and whenever one
  // opens into the slot (see loadDevice).
  E.tellLoop = (track, slot) => {
    const ctl = track.controllers?.get(slot);
    if (ctl && typeof ctl.loopLatency === 'function') ctl.loopLatency(track.loopSec?.get(slot) ?? -1);
  };

  // msg = [trackId, layout JSON], or [trackId, 'loop', slot, seconds] for a loop's latency (one
  // address for both, as poptart.scd has them).
  E.on('/poptart/setRouting', (msg) => {
    const key = String(msg[1]);
    const json = String(msg[2]);
    const loop = json === 'loop';
    const spec = json === 'null' || loop ? null : JSON.parse(json);
    return E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (!E.isTrack(track)) return;
      if (!loop) { E.routeApply(key, track, spec); return; }
      const slot = Math.trunc(Number(msg[3]));
      const sec = Number(msg[4]);
      if (!track.loopSec) track.loopSec = new Map();
      if (sec >= 0) track.loopSec.set(slot, sec); else track.loopSec.delete(slot);
      E.tellLoop(track, slot);
    });
  });

  // --- audio routing (the audio() source builder and injector) -----------------------------------

  // Audio into an fx aux (Sig#audio injector): wireAudio handles both a track source and a device source.
  E.on('/poptart/injectAudio', (msg) => {
    E.wireAudio(String(msg[1]), Math.trunc(msg[2]), String(msg[3]), Number(msg[4]),
      Math.trunc(msg[5] ?? 0), Math.trunc(msg[6] ?? 1));
  });

  E.on('/poptart/clearAudioInject', (msg) => {
    E.unwireAudio(String(msg[1]), Math.trunc(msg[2]));
  });

  E.on('/poptart/setAudioInput', (msg) => {
    E.wireAudio(String(msg[1]), 0, String(msg[2]), 1.0, Math.trunc(msg[3] ?? 0), Math.trunc(msg[4] ?? 1));
  });

  E.on('/poptart/clearAudioInput', (msg) => {
    E.unwireAudio(String(msg[1]), 0);
  });

  // Output-to-bus sends (Sig#bus). msg = [trackId, name1, amount1, i1, name2, amount2, i2, ...]:
  // replace the track's whole set of bus sends. Acquire-before-release, so a bus kept across the
  // change never briefly hits zero refs. Each send is a tap of its own (see stripTap), reading the
  // strip's output - or, for a send the chain layout places inside the chain (`i`, the send's
  // index among the pattern's; see routeApply), the bus it taps there. Still after the fader and
  // the monitor either way, so a deck's crossfade applies to what a track feeds.
  E.on('/poptart/setBusSends', (msg) => {
    const key = String(msg[1]);
    const triples = msg.slice(2);
    return E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (!track) return;
      const requested = Math.floor(triples.length / 3);
      const newNames = [];
      const newIdx = [];
      for (let k = 0; k < requested; k++) {
        const name = String(triples[k * 3]);
        const amt = Number(triples[k * 3 + 1]);
        const i = Math.trunc(Number(triples[k * 3 + 2]));
        E.stripTap(track, `bus${k}`, E.acquireBus(name).index, amt, 1, E.sendInput(track, i));
        newNames.push(name);
        newIdx.push(i);
      }
      const prevCount = (track.busSends ?? []).length;
      for (let k = 0; k < prevCount; k++) if (k >= requested) E.stripTap(track, `bus${k}`, null);
      if (track.busSends) track.busSends.forEach((bn) => E.releaseBus(bn));
      track.busSends = newNames;
      track.busSendIdx = newIdx;
      E.reorderTracks();
    });
  });

  // One routed send's level moving (a signal-valued .bus() amount). msg = [trackId, index, amount,
  // latency]. Just the level: the routing is setBusSends' business. An index past the set routed is
  // ignored - the send it named has gone.
  E.on('/poptart/setBusSendAmount', (msg) => {
    const key = String(msg[1]);
    const i = Math.trunc(msg[2]);
    const amt = Number(msg[3]);
    const latency = Number(msg[4]);
    const track = E.tracks.get(key);
    if (E.isTrack(track) && i >= 0 && i < (track.busSends ?? []).length) {
      E.bundleNow(latency, () => { track.taps.get(`bus${i}`)?.set('amp', amt); });
    }
  });

  E.on('/poptart/clearBusSends', (msg) => {
    const key = String(msg[1]);
    const track = E.tracks.get(key);
    if (E.isTrack(track)) {
      const n = (track.busSends ?? []).length;
      for (let i = 0; i < n; i++) E.stripTap(track, `bus${i}`, null);
      if (track.busSends) { track.busSends.forEach((bn) => E.releaseBus(bn)); track.busSends = null; }
      track.busSendIdx = null;
      E.reorderTracks(); // whatever read those buses may sit shallower now
    }
  });

  // The DJ FX send (the desk's performance-FX unit). msg = [trackId, busName, amount]. Routes the
  // track's dedicated FX send to the named bus at `amount`; an empty name parks it. Its OWN send
  // rather than one of the .bus() slots: the desk's routing must survive an eval it had no part in.
  E.on('/poptart/setFxSend', (msg) => {
    const key = String(msg[1]);
    const name = String(msg[2]);
    const amt = Number(msg[3] ?? 0);
    return E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (!track) return;
      if (name === '') {
        track.dj?.set('fxOut', E.routeNowhere, 'fxSend', 0);
        if (track.fxBus != null) { E.releaseBus(track.fxBus); track.fxBus = null; }
      } else if (track.fxBus !== name) {
        E.djNode(track).set('fxOut', E.acquireBus(name).index, 'fxSend', amt);
        if (track.fxBus != null) E.releaseBus(track.fxBus);
        track.fxBus = name;
        E.reorderTracks();
      } else {
        E.djNode(track).set('fxSend', amt); // same bus: only the level moved
      }
    });
  });
}

module.exports = { install };
