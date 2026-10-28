'use strict';

// A track: its build and teardown, its optional stages (the DJ stage, taps, bass mono, the effect
// nodes and the route-control publishers), where each channel control lives, and the node order
// between tracks. Ported from poptart.scd's track sections (see core.js for the conventions).
//
// A track is not one synth but a row of them, in a group of its own, joined by private buses:
//
//   head    the instrument (a plugin or one of poptart's own devices) and the track's sample
//           voices, at the input gain - plus the bend and grain controls
//   fx      one per effect the code writes, made when a chain first names its slot and kept for
//           as long as it does
//   xover   one per .bands() crossover, the engine's own and never the user's (see routeApply)
//   term    a level, a pan or both on the way into a sum, made only where a .split()/.bands()
//           needs one
//   strip   the channel strip and everything after it
//
// Each reads the bus of what comes before it and writes its own, in order inside the track's
// chain group, so the whole track is one pass through a block with no delay anywhere.

const { Synth, Group, Bus } = require('../server/objects');

const HEAD_NAMES = ['gain', 'bend', 'bendrange', 'grainpos', 'grainsize', 'grainrate', 'grainpan'];
const DJ_NAMES = ['trim', 'eqlo', 'eqmid', 'eqhi', 'djf', 'djres', 'cue', 'mdeck'];

// Frees what an OSCFunc-like holder is: a remover function or an object with free().
const freeFunc = (f) => {
  if (!f) return;
  if (typeof f === 'function') f();
  else if (typeof f.free === 'function') f.free();
};

const busIdx = (bus) => (bus && typeof bus === 'object' ? bus.index : bus);

function install(E) {
  const S = E.S;
  E.deadNodes ??= new Set();

  // Every track runs the same defs - nothing in them depends on the key - so they are loaded once,
  // at boot, with the rest (see server/defs.js), and this only names them.
  E.trackDefName = (key) => `poptart_track_${key}`;
  E.trackDef = {
    head: { name: 'poptart_head' },
    fx: { name: 'poptart_fx' },
    xover: { name: 'poptart_xover' },
    strip: { name: E.trackDefName('shared') },
    dj: { name: 'poptart_dj' },
    tap: { name: 'poptart_tap' },
    bassmono: { name: 'poptart_bassmono' },
  };
  E.trackDefState = 'ready';
  E.sharedTrackDef = () => E.trackDef;

  // Neutral value a channel control (pseudo-slot -1) snaps back to when its modulator is cleared:
  // unity gain in and out, center pan, first output pair - and for the DJ stage, unity
  // trim/bands/fader/deck (djf's neutral is 0, djres's is 0).
  // bendrange's neutral is 2 (DEFAULT_BEND_RANGE in signal.mjs); wetN is unity; grainsize and
  // grainrate are the granular voice's defaults (CHANNEL_DEFAULTS in signal.mjs). A branch level is
  // unity, and a crossover rests at 1 kHz as a position on its control (route.mjs).
  E.channelDefault = (name) => {
    const n = String(name);
    if (n === 'bendrange') return 2;
    if (n === 'grainsize') return 0.08;
    if (n === 'grainrate') return 20;
    if (/^rl[0-9]+$/.test(n)) return 1;
    if (/^xo[0-9]+$/.test(n)) return (1000 - 20) / (20000 - 20);
    if (['gain', 'postgain', 'out', 'dry', 'width', 'trim', 'fader', 'deck', 'eqlo', 'eqmid', 'eqhi'].includes(n)
      || n.startsWith('wet')) return 1;
    return 0;
  };

  // Nothing is parked on the strip any more: its taps and sends are nodes made when wanted.
  E.scArgsFor = () => [];

  // --- a track's optional stages -------------------------------------------------------------
  //
  // Nothing after the strip runs until the code asks for it: the DJ stage, each tap and each send
  // is a node of its own, made the first time it is wanted.

  // How many output pairs are in use (see the strip's `pairs`).
  E.trackPairs = () => Math.max(1, Math.floor(Math.min(E.playChannels, S.options.numOutputBusChannels) / 2));

  // The bus the strip writes for what listens after it, made the first time anything does.
  E.stripPost = (track) => {
    if (track.post) return track.post;
    const bus = Bus.audio(S, 2);
    track.post = bus;
    track.synth.set('post', bus.index);
    return bus;
  };

  // The DJ stage, made the first time one of its controls is touched (or the track is monitored,
  // whose cue it plays). From then on it plays the track's direct output and the strip does not -
  // switched in one bundle, so no block plays both or neither.
  E.djNode = (track) => {
    if (track.dj) return track.dj;
    const post = E.stripPost(track);
    let node;
    S.makeBundle(null, () => {
      node = Synth.new(S, E.trackDef.dj.name, ['in', post.index, 'ctl', track.ctlBus.index,
        'cueBus', E.cueOffset ?? E.routeNowhere, 'meterBus', E.deckMeterBus.index, 'fxOut', E.routeNowhere],
      track.postGroup, 'addToHead');
      track.synth.set('direct', 0);
    });
    E.nodeOwns?.(node.nodeID, "a track's DJ stage");
    track.dj = node;
    return node;
  };

  // A copy of the strip's output to `out` at `amp` (post: after the fader and the monitor), as tap
  // `name` - made, moved or (with a null `out`) freed.
  E.stripTap = (track, name, out, amp = 1, post = 0) => {
    const taps = track.taps;
    const held = taps.get(name);
    if (out == null) {
      if (held) {
        held.free();
        taps.delete(name);
        E.tellTap(track, name, null);
      }
    } else if (!held) {
      const node = Synth.new(S, E.trackDef.tap.name, ['in', E.stripPost(track).index, 'out', out, 'ctl', track.ctlBus.index,
        'amp', amp, 'post', post], track.postGroup, 'addToTail');
      E.nodeOwns?.(node.nodeID, `a track's ${name} tap`);
      taps.set(name, node);
      E.tellTap(track, name, node);
    } else {
      held.set('out', out, 'amp', amp, 'post', post);
    }
  };

  // Bass mono, made the first time it is asked for: between the chain and the strip.
  E.bassMonoNode = (track) => {
    if (track.bassmono) return track.bassmono;
    const bus = Bus.audio(S, 2);
    let node;
    S.makeBundle(null, () => {
      node = Synth.new(S, E.trackDef.bassmono.name, ['in', track.chainOut ?? track.chainIn.index, 'out', bus.index],
        track.synth, 'addBefore');
      track.synth.set('in', bus.index);
    });
    E.nodeOwns?.(node.nodeID, "a track's bass mono");
    track.bassmono = node;
    track.bassmonoBus = bus;
    return node;
  };

  // The node a track's slot is: the head for the instrument (0), an effect's own node for 1..n, or null.
  E.slotNode = (track, slot) => (slot === 0 ? track.head : track.nodes.get(slot) ?? null);

  // The node for effect slot `slot`, made if the track has none yet - parked (reading and writing
  // nowhere) just before the strip, until routeApply wires it. It is kept from then on, whatever
  // the chain's structure does, so its plugin is never reloaded for a change of wiring.
  E.ensureFxNode = (key, track, slot) => {
    const have = track.nodes.get(slot);
    if (have) return have;
    const wet = track.wet.get(slot);
    const node = Synth.new(S, E.trackDef.fx.name, ['in', E.routeNowhere, 'out', E.routeNowhere,
      'scBus', track.scBus.get(slot) ?? E.silentBus.index, ...(wet != null ? ['wet', wet] : [])],
    track.synth, 'addBefore');
    E.nodeOwns?.(node.nodeID, `${key}'s effect ${slot}`);
    track.nodes.set(slot, node);
    return node;
  };

  // A slot's sidechain bus, kept for a node made later as well as set on the one there is.
  E.setScBus = (track, slot, index) => {
    track.scBus.set(slot, index);
    track.nodes.get(slot)?.set('scBus', index);
  };

  // The control-rate publisher of one route control: a branch level and pan pair (rl<k>/rp<k>) or a
  // crossover frequency (xo<k>), made when first wanted and kept for the track's life, in the
  // chain group's head so everything after it reads this block's value. `kind` is 'gain' or 'xo'.
  E.routeKrNode = (track, kind, k) => {
    const all = kind === 'gain' ? track.gains : track.xos;
    const have = all.get(k);
    if (have) return have;
    const bus = Bus.control(S, kind === 'gain' ? 2 : 1);
    let node;
    if (kind === 'gain') {
      bus.setn([1, 0]);
      node = Synth.new(S, 'poptart_gainkr', ['out', bus.index], track.krGroup, 'addToTail');
    } else {
      bus.set(E.channelDefault('xo1'));
      node = Synth.new(S, 'poptart_xokr', ['out', bus.index, 'value', E.channelDefault('xo1')], track.krGroup, 'addToTail');
    }
    const entry = { node, bus };
    all.set(k, entry);
    return entry;
  };

  // Where a channel control (slot -1) of a track lives, as [node, control]. Most are the strip's;
  // the input gain, the bend and the grain controls are the head's; wetN is effect N's own mix; and
  // a route control is its publisher's (see routeKrNode). null for a wetN with no effect N yet -
  // its value is kept for the node that will be made.
  E.channelTarget = (track, name) => {
    const str = String(name);
    const m = str.match(/^(rl|rp|xo|wet)([0-9]+)$/);
    if (m) {
      const which = m[1];
      const k = Number(m[2]);
      if (which === 'wet') {
        const n = track.nodes.get(k);
        return n ? [n, 'wet'] : null;
      }
      if (which === 'xo') return [E.routeKrNode(track, 'xo', k).node, 'value'];
      return [E.routeKrNode(track, 'gain', k).node, which === 'rl' ? 'level' : 'pan'];
    }
    if (HEAD_NAMES.includes(str)) return [track.head, str];
    if (DJ_NAMES.includes(str)) return [E.djNode(track), str];
    if (str === 'bassmono') return [E.bassMonoNode(track), str];
    // A monitored track plays to the cue pair, which the DJ stage does.
    if (str === 'mon' && E.cueOffset != null) E.djNode(track);
    return [track.synth, str];
  };

  // --- node order between tracks ---------------------------------------------------------------

  // How deep each track sits (key -> depth): 0 for one that reads no other track, else one past the
  // deepest thing routed into it - a source track, or the writers of a bus it reads. A feedback
  // loop has no order that works; the edge that closes it is dropped and that read is a block
  // late. A track still being built ('pending') is skipped and placed by its own routes.
  E.trackLevels = () => {
    const writers = new Map(); // bus name -> the keys sending to it
    const upstream = new Map(); // key -> the keys it must run after
    const levels = new Map();
    const add = (m, k, v) => { m.set(k, [...(m.get(k) ?? []), ...v]); };
    for (const [k, t] of E.tracks) {
      if (!E.isTrack(t)) continue;
      if (t.busSends) for (const n of t.busSends) add(writers, String(n), [k]);
      // The DJ FX unit's send counts as a write too (see setFxSend): the unit's return track READS
      // that bus, so without this the return sits at the same depth as the decks feeding it.
      if (t.fxBus != null) add(writers, String(t.fxBus), [k]);
    }
    // A sidechain and a parameter patch order the same way: whatever they read runs first.
    for (const routes of [E.sidechainByTarget, E.paramRoutes]) {
      for (const e of routes.values()) {
        let deps = [];
        if (e.source != null) deps = [e.source];
        else if (e.busName != null) deps = writers.get(String(e.busName)) ?? [];
        add(upstream, e.targetKey, deps);
      }
    }
    // A loop has no order that runs every reader after its writer, so one edge of it reads the
    // block before: the one that closes the loop, walking upstream from each track in the order
    // the tracks were made (the browser engine walks them the same way). Recorded as
    // "reader|writer" in loopEdges.
    E.loopEdges = new Set();
    const levelOf = (k, stack) => {
      if (levels.has(k)) return levels.get(k);
      const deps = (upstream.get(k) ?? []).filter((d) => E.isTrack(E.tracks.get(d)));
      const open = deps.filter((d) => {
        const closes = d === k || stack.includes(d);
        if (closes) E.loopEdges.add(`${k}|${d}`);
        return !closes;
      });
      const lvl = open.length === 0 ? 0 : Math.max(...open.map((d) => levelOf(d, [...stack, k]))) + 1;
      levels.set(k, lvl);
      return lvl;
    };
    [...E.tracks.keys()].filter((k) => E.isTrack(E.tracks.get(k)))
      .sort((a, b) => (E.tracks.get(a).born ?? 0) - (E.tracks.get(b).born ?? 0))
      .forEach((k) => levelOf(k, []));
    return levels;
  };

  // Whether a route into `targetKey` closes a loop (see trackLevels).
  E.routeCloses = (targetKey, e) => {
    let deps = [];
    if (e.source != null) deps = [e.source];
    else if (e.busName != null) deps = E.busWriters(String(e.busName));
    return deps.some((d) => E.loopEdges.has(`${targetKey}|${d}`));
  };

  // The tracks writing a named bus, by their sends and the DJ FX unit's.
  E.busWriters = (name) => {
    const out = [];
    for (const [k, t] of E.tracks) {
      if (E.isTrack(t) && ((t.busSends ?? []).some((n) => String(n) === name) || (t.fxBus != null && String(t.fxBus) === name))) {
        out.push(k);
      }
    }
    return out;
  };

  // Put every track's group in the Group for its depth - one per depth, made as needed, each before
  // recGroup (whose taps must still read what the tracks wrote this block).
  E.reorderTracks = () => {
    const levels = E.trackLevels();
    const deepest = levels.size ? Math.max(...levels.values()) : 0;
    while (E.levelGroups.length <= deepest) E.levelGroups.push(Group.before(E.recGroup));
    for (const [k, lvl] of levels) E.tracks.get(k).group.moveToHead(E.levelGroups[lvl]);
    // The edge that closes a loop reads the block before (InFeedback); every other one, this block.
    for (const e of E.sidechainByTarget.values()) {
      e.feeder?.set('fb', E.routeCloses(e.targetKey, e) ? 1 : 0);
    }
    for (const e of E.paramRoutes.values()) {
      if (e.pending == null && e.bus != null) {
        const closes = E.routeCloses(e.targetKey, e);
        const target = E.tracks.get(e.targetKey);
        if (closes && e.fbBus == null && E.isTrack(target)) {
          // A device reads its patch in the block itself, so a closing edge into one goes
          // through a copy of the block before.
          e.fbBus = Bus.audio(S, 2);
          e.fbFeeder = Synth.new(S, 'poptart_busread', ['out', e.fbBus.index, 'in', busIdx(e.bus), 'fb', 1],
            target.group, 'addToHead');
          E.applyParamRoute(target, e);
        } else if (!closes && e.fbBus != null) {
          e.fbFeeder.free();
          e.fbBus.free();
          e.fbFeeder = null;
          e.fbBus = null;
          if (E.isTrack(target)) E.applyParamRoute(target, e);
        }
      }
    }
  };

  // The track for a key once it is built, else null. A routine takes a built track with this
  // instead of awaiting awaitTrack, which always yields: sclang's awaitTrack does not wait for a
  // built track, and the routine asking for it ran before the next message was handled. Here a
  // yield lets every later message of the same burst go first - a setPattern sends its chain's
  // wiring and then its channel controls in one go, and a bass mono born ahead of the wiring was
  // left reading a bus the wiring had just retired: the track went silent until its next eval.
  E.builtTrack = (key) => {
    const t = E.tracks.get(key);
    return E.isTrack(t) ? t : null;
  };

  // createTrack reserves the key with 'pending' before its async setup, so this tells "being
  // built, wait" from "never created".
  E.awaitTrack = async (key, timeoutSec = 5) => {
    let tries = 0;
    const max = Math.trunc(timeoutSec / 0.05);
    let t = E.tracks.get(key);
    while (!E.isTrack(t) && tries < max) {
      await E.wait(0.05);
      tries += 1;
      t = E.tracks.get(key);
    }
    // Waited the whole build out and the key is STILL reserved: that build is not coming back
    // (see reclaimStuckTrack).
    if (E.isTrack(t)) return t;
    E.reclaimStuckTrack(key);
    return null;
  };

  // Gives up on a build that never committed, so the key can be built again. Bumping the
  // generation is what makes this safe against a build that is merely slow: a reclaimed build
  // finds its generation stale when it wakes and frees what it made instead of committing.
  E.reclaimStuckTrack = (key) => {
    if (E.tracks.get(key) === 'pending') {
      E.trackGen.set(key, (E.trackGen.get(key) ?? 0) + 1);
      E.tracks.delete(key);
      E.warn(`poptart: track ${key} never finished being built - cleared it, and the next `
        + 'evaluation will build it again');
    }
  };

  // --- track / chain management ----------------------------------------------------------------

  // Builds the track for a key nobody holds: reserves it with 'pending', and commits the real track
  // at the end of the async build. `birth` is the flat list of channel-control name/value pairs the
  // track is born with (see createTrack).
  E.buildTrack = (key, birth) => {
    // This build's claim on the key; a reclaim bumps it (see reclaimStuckTrack).
    const gen = (E.trackGen.get(key) ?? 0) + 1;
    E.trackGen.set(key, gen);
    E.tracks.set(key, 'pending');
    return E.fork(async () => {
      const group = Group.new(S, E.levelGroups[0], 'addToHead'); // depth 0 until a route says otherwise
      // Sample voices spawn into a group of their own at the head of the track's, so one gate-off
      // releases every one of them at once (see hushTrack).
      const voices = Group.new(S, group, 'addToHead');
      const inBus = Bus.audio(S, 2); // sample synths write here, the track synth mixes it in
      // The track's pitch-bend value, republished by the head for its sample voices to map and for
      // the MIDI sender to read.
      const bendBus = Bus.control(S, 1);
      // ...and the four grain controls, likewise (pos, size, rate, pan).
      const grainBus = Bus.control(S, 4);
      // What the head writes and the first effect (or the strip) reads.
      const chainIn = Bus.audio(S, 2);
      // What the strip publishes for its DJ stage and taps.
      const ctlBus = Bus.control(S, 6);
      const def = E.sharedTrackDef();
      // The channel values the track is born with, split between the two nodes that own them.
      const birthPairs = [];
      for (let i = 0; i + 1 < birth.length; i += 2) birthPairs.push([birth[i], birth[i + 1]]);
      const headBirth = birthPairs.filter((p) => HEAD_NAMES.includes(p[0])).flat();
      const stripBirth = birthPairs.filter((p) => !HEAD_NAMES.includes(p[0])).flat();
      // Control buses keep whatever the last owner left in them, so a recycled index could hand a
      // new track somebody else's bend. Zeroed explicitly, ahead of the sync.
      bendBus.set(0);
      grainBus.setn([0, 0.08, 20, 0]);
      await S.sync(); // load-bearing: orders the buses ahead of the synths
      // The chain: its route-control publishers first, then the head, the effects as routeApply
      // places them, and the strip last - in signal order, so one block runs it all.
      const chain = Group.new(S, group, 'addToTail');
      const krGroup = Group.new(S, chain, 'addToHead');
      const head = Synth.new(S, def.head.name, ['inBus', inBus.index, 'out', chainIn.index, 'bendOut', bendBus.index,
        'grainOut', grainBus.index, ...headBirth], chain, 'addToTail');
      const synth = Synth.new(S, def.strip.name, ['in', chainIn.index, 'post', E.routeNowhere, 'ctl', ctlBus.index,
        'pairs', E.trackPairs(), ...stripBirth], chain, 'addToTail');
      // The DJ stage, the taps and the sends, when there are any: after the strip.
      const postGroup = Group.new(S, chain, 'addAfter');
      // Somebody gave up on this build while it was in flight and the key has been built again
      // since (see reclaimStuckTrack): this one is taken back down instead of committing.
      if (E.trackGen.get(key) !== gen) {
        group.free();
        inBus.free();
        bendBus.free();
        grainBus.free();
        chainIn.free();
        ctlBus.free();
        E.warn(`poptart: track ${key} finished building after it was given up on - `
          + 'discarded it and kept the track that replaced it');
        return;
      }
      // SendReply names its sender by node id only, so bend messages need a way home.
      E.bendTracks.set(head.nodeID, key);
      // Who these belong to, for the failure reports (see nodeOwns).
      E.nodeOwns?.(group.nodeID, `${key}'s group`);
      E.nodeOwns?.(head.nodeID, `${key}'s instrument`);
      E.nodeOwns?.(synth.nodeID, `${key}'s channel strip`);
      E.trackSerial += 1;
      const track = {
        group,
        voices,
        inBus,
        bendBus,
        grainBus,
        synth, // the strip
        born: E.trackSerial, // the order tracks were made in (see trackLevels)
        head, // the instrument, slot 0
        chain, // the group the chain runs in, in signal order
        krGroup, // the route controls' publishers, at its head
        chainIn, // what the head writes
        ctlBus, // what the strip publishes
        postGroup, // the DJ stage, taps and sends
        taps: new Map(), // name -> tap node (see stripTap)
        nodes: new Map(), // slot -> its effect node (see ensureFxNode)
        xovers: new Map(), // crossover id -> { node, ctl } (see routeApply)
        terms: [], // the level/sum nodes of the current wiring
        gains: new Map(), // k -> { node, bus } for rl<k>/rp<k>
        xos: new Map(), // k -> { node, bus } for xo<k>
        scBus: new Map(), // slot -> its sidechain bus (see setScBus)
        wet: new Map(), // slot -> a wetN set before its node was made
        controllers: new Map(),
        loaded: new Map(), // slot -> pluginId once open() succeeds
        wanted: new Map(), // slot -> pluginId an in-flight open() should commit
        lfos: new Map(), // 'slotN_param' -> { synth, bus, shape, index }
        envs: new Map(), // 'slotN_param' -> { synth, bus, index }
        ccs: new Map(), // 'slotN_param' -> { bus, index, lo, hi, last, binding, defKey }
        oscs: new Map(), // 'slotN_param' -> same shape as ccs, bound to an OSC address
        ramps: new Map(), // 'slotN_param' -> { synth, bus, index, slot } - polled controls (see rampTo)
        resting: new Map(), // 'slotN_param' -> what the parameter was before the pattern took it
        editWatch: new Map(), // slot -> [listeners] watching for plugin edits
        key, // what Node calls it (see tellTrack)
        held: 0, // active-note count, drives env gates
        sounding: new Map(), // slot -> (note -> when its off lands), see markSounding
      };
      E.tracks.set(key, track);
      E.tellTrack(track);
      // A track born while the mixer is open joins its meters right away.
      if (E.mixOn) E.mixReconcile?.();
      // ...and a display of it already on screen starts drawing it.
      if (E.viewTap?.on) E.viewTap.reconcile();
      // A DJ stage born touched (a desk's trim or EQ carried over) is made now.
      const dj = birthPairs.filter((p) => DJ_NAMES.includes(p[0]));
      if (dj.length) E.djNode(track).set(...dj.flat());
    });
  };

  E.on('/poptart/createTrack', (msg) => {
    const key = String(msg[1]);
    // Optional birth values (name/value pairs after the key): channel controls baked into the
    // synths' own args, so a track created into a live mix comes up already wearing the desk's
    // state. They have to ride the creation itself: a setParam sent while the track is still
    // 'pending' is dropped.
    const birth = [];
    for (let i = 2; i + 1 < msg.length; i += 2) birth.push(String(msg[i]), Number(msg[i + 1]));
    const t = E.tracks.get(key);
    if (t == null) {
      E.buildTrack(key, birth);
    } else if (t === 'pending') {
      // Asked to build a key still being built. Nearly always the same evaluation asking twice; but
      // this is the ONLY message a plain track ever sends about its key, so if that build was lost
      // (see reclaimStuckTrack) this is where it is found out.
      E.fork(async () => {
        if ((await E.awaitTrack(key)) == null && E.tracks.get(key) == null) E.buildTrack(key, birth);
      });
    }
  });

  // Destroy a track outright - the performance mixer's complete-mix drops the outgoing song's
  // tracks. Everything the track owns goes: its mix tap, edit watchers, every modulator synth and
  // bus, sidechain routes in AND out, bus-send refs, the group and the input bus. Freeing the
  // synth is what closes the plugin instances (and any open editor windows).
  E.destroyTrack = (key) => E.fork(async () => {
    const track = E.builtTrack(key) ?? await E.awaitTrack(key); // 'pending': let the birth finish, then take it down
    if (!track) return;
    E.stopMixTap?.(key);
    const slots = new Set([0, ...track.nodes.keys(), ...track.scBus.keys()]);
    for (const slot of slots) {
      E.unwireAudio(key, slot); // routes INTO this track
      const funcs = track.editWatch.get(slot);
      if (funcs) { funcs.forEach(freeFunc); track.editWatch.delete(slot); }
    }
    // ...and every route OUT of it - one source may feed several sinks. Over a copy.
    const out = E.sidechainBySource.get(key);
    if (out) for (const e of [...out]) E.unwireAudio(e.targetKey, e.slot);
    // Parameter patches the same way, into this track and out of it.
    [...E.paramRoutes.values()].filter((e) => e.targetKey === key || e.source === key)
      .forEach((e) => E.unwireParamRoute(e.targetKey, e.slot, e.name));
    for (const dict of [track.lfos, track.envs, track.ramps]) {
      for (const e of dict.values()) {
        e.synth?.free();
        e.bus?.free();
        if (e.bufs) e.bufs.forEach((b) => b.free());
      }
    }
    for (const e of track.ccs.values()) {
      freeFunc(E.midiDefs?.get(e.defKey));
      E.midiDefs?.delete(e.defKey);
      e.bus?.free();
    }
    // Expression synths go with the group; their output buses are ours to hand back.
    if (E.exprsOf) {
      for (const e of E.exprsOf(track).values()) {
        e.out?.free();
        E.exprDefDone?.(e.def);
      }
    }
    for (const e of track.oscs.values()) {
      freeFunc(E.oscDefs?.get(e.defKey));
      E.oscDefs?.delete(e.defKey);
      e.bus?.free();
    }
    if (track.busSends) track.busSends.forEach((bn) => E.releaseBus(bn));
    if (track.fxBus != null) E.releaseBus(track.fxBus); // the DJ FX send's ref (see setFxSend)
    // A song deck's buffer (the whole file, real RAM) must not outlive the track.
    const song = E.songs.get(key);
    if (song) {
      freeFunc(song.posFunc);
      song.buf?.free();
      E.songs.delete(key);
    }
    E.bendTracks.delete(track.head.nodeID);
    E.viewTap?.stop(key); // a display's tap of it, buffers and all (a rebuilt track is tapped anew)
    track.group.free();
    track.inBus.free();
    track.bendBus?.free();
    track.grainBus?.free();
    // The chain's buses are ours to hand back (its nodes went with the group).
    [track.chainIn, track.ctlBus, track.post, track.bassmonoBus].forEach((b) => b?.free());
    for (const all of [track.gains, track.xos]) for (const e of all.values()) e.bus.free();
    if (track.route) track.route.buses.forEach((b) => b.free());
    E.tracks.delete(key);
    E.tell('/poptart/ids/trackGone', key);
    E.reorderTracks(); // whatever read this track sits shallower now
    E.post(`poptart: destroyed track ${key}`);
  });

  E.on('/poptart/destroyTrack', (msg) => {
    E.destroyTrack(String(msg[1]));
  });
}

module.exports = { install, freeFunc };
