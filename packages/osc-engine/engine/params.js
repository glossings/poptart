'use strict';

// Parameters and the modulators that drive them: what a param call is aimed at (paramTarget), the
// ramp behind every polled control, the native LFOs, drawn shapes and envelopes, pitch bend out to
// a plugin, and the device-only controls (a file or a curve on a control, the live report).
// Ported from poptart.scd (see core.js for the conventions).

const fs = require('node:fs');
const { Synth, Bus, Buffer } = require('../server/objects');

const isInt = (v) => Math.trunc(Number(v));
const hasFn = (o, name) => o != null && typeof o[name] === 'function';

function install(E) {
  const S = E.S;
  E.nodeGoneSaid ??= new Set();

  // --- what a param call is aimed at -----------------------------------------------------------
  //
  // Every handler that drives a control through a bus (a ramp, an LFO, an envelope, a cc, an osc
  // address, an audio route, an expression's output) maps it through ONE object instead of deciding
  // for itself between the track synth, a plugin and a device. Three kinds:
  //   'channel'  slot -1: the track synth's own control (gain, pan, ...)
  //   'control'  a parameter of the plugin or device in the slot, by index
  //   'leaf'     input i of the expression on `name`, addressed as "~i~name" (see setParamExpr)
  // Each has map (a control bus), unmap, and - where the reader takes one per sample - mapAudio /
  // unmapAudio (an audio bus). null for a control that cannot be resolved (no plugin open yet, or
  // no such parameter). `index` short-circuits the lookup, for a teardown that only has what it stored.
  E.exprLeaf = (name) => {
    const m = String(name).match(/^~([0-9]+)~(.*)$/);
    return m ? [Number(m[1]), m[2]] : null;
  };
  E.busIndexOf = (bus) => (bus instanceof Bus ? bus.index : bus);
  E.paramTarget = (track, slot, paramName, index = null) => {
    const leaf = E.exprLeaf(paramName);
    if (leaf != null) {
      const [i, realName] = leaf;
      return {
        kind: 'leaf', index: String(paramName), audio: true,
        map: (bus) => E.exprFeed(track, slot, realName, i, 'kr', E.busIndexOf(bus)),
        unmap: () => E.exprFeed(track, slot, realName, i, 'kr', -1),
        mapAudio: (bus) => E.exprFeed(track, slot, realName, i, 'ar', E.busIndexOf(bus)),
        unmapAudio: () => E.exprFeed(track, slot, realName, i, 'ar', -1),
      };
    }
    if (slot === -1) {
      const at = E.channelTarget(track, paramName);
      const wetSlot = String(paramName).match(/^wet([0-9]+)$/);
      const perSample = E.chanAudio(paramName);
      return {
        kind: 'channel', index: String(paramName), audio: perSample,
        map: (bus) => { if (at) at[0].map(at[1], bus); },
        // Unmapping leaves a control at whatever the bus last wrote, so it goes back to neutral.
        unmap: () => { if (at) { at[0].map(at[1], -1); at[0].set(at[1], E.channelDefault(paramName)); } },
        // An audio-rate driver, read per sample where the browser's is (poptart.scd's chanIn).
        mapAudio: perSample ? (bus) => E.setChanAr(track, paramName, E.busIndexOf(bus)) : null,
        unmapAudio: perSample ? () => {
          E.setChanAr(track, paramName, -1);
          // Back to neutral, as unmap leaves it - and onto whichever audio-rate driver is still
          // wanted there (the caller has already dropped its own).
          if (at) at[0].set(at[1], E.channelDefault(paramName));
          E.reassertAudioDrivers(track, -1, paramName);
        } : null,
        // A plain value, kept for an effect node made later where it has none yet.
        set: (value) => {
          if (wetSlot) track.wet.set(Number(wetSlot[1]), value);
          if (at) at[0].set(at[1], value);
        },
      };
    }
    const ctl = track.controllers.get(slot);
    const at = index ?? (ctl != null && ctl.info != null ? E.resolveParamIndex(ctl.info, paramName) : null);
    if (ctl == null || at == null) return null;
    const native = hasFn(ctl, 'mapAudio');
    return {
      kind: 'control', index: at, audio: native,
      map: (bus) => ctl.map(at, bus),
      unmap: () => ctl.unmap(at),
      mapAudio: native ? (bus, gain = 1, offset = 0) => ctl.mapAudio(at, bus, gain, offset) : null,
      unmapAudio: native ? () => {
        ctl.unmapAudio(at);
        // Back on the value last set - and onto whichever audio-rate driver is still wanted there
        // (the caller has already dropped its own).
        ctl.get(at, (v) => ctl.set(at, v));
        E.reassertAudioDrivers(track, slot, paramName);
      } : null,
    };
  };

  // After an audio driver comes off a device's control, the one still meant to be there goes back
  // on: an audio-rate env(), or an expression's output.
  E.reassertAudioDrivers = (track, slot, paramName) => {
    const k = `slot${slot}_${paramName}`;
    const ctl = track.controllers.get(slot);
    const index = ctl?.info != null ? E.resolveParamIndex(ctl.info, paramName) : null;
    // A channel control's, likewise (see setChanAr).
    if (slot === -1) {
      const env = track.envs.get(k);
      const lfo = track.lfos.get(k);
      const expr = track.exprs?.get(k);
      if (env != null && env.audio === true) E.setChanAr(track, paramName, env.bus.index);
      else if (lfo != null && lfo.audio === true) E.setChanAr(track, paramName, lfo.bus.index);
      else if (expr != null && expr.outKind === 'channelAr') E.setChanAr(track, paramName, expr.out.index);
    }
    if (index != null && hasFn(ctl, 'mapAudio')) {
      const env = track.envs.get(k);
      const expr = track.exprs?.get(k);
      if (env != null && env.audio === true) ctl.mapAudio(index, env.bus, 1, 0);
      else if (expr != null && expr.outKind === 'device') ctl.mapAudio(index, expr.out, 1, 0);
    }
  };

  // Waits for what a modulator is to be mapped onto, saying why when there is nothing: a channel
  // control and an expression input never wait for a plugin, a parameter does.
  E.awaitTarget = async (track, slot, paramName, who) => {
    if (E.exprLeaf(paramName) == null && slot !== -1 && !(await E.awaitLoaded(track, slot))) {
      E.warn(`poptart: ${who}: no plugin loaded in slot ${slot}`);
      return null;
    }
    const target = E.paramTarget(track, slot, paramName);
    if (target == null) {
      E.warn(`poptart: ${who}: plugin has no parameter named '${paramName}' (see getParams / the params panel for real names)`);
    }
    return target;
  };

  // --- the ramp behind every polled control ------------------------------------------------------
  //
  // A polled control writes through a ramp synth on a control bus of its own, mapped onto the
  // parameter (or the track synth's control input, or an expression's input) as a native
  // modulator's bus is. The first value creates the ramp, born AT that value so nothing glides in
  // from zero; every later one just moves its target. `target` is a paramTarget.
  // How long a polled value takes to reach an expression's input: the ramp's usual 30 ms, or none
  // for an input the tree marks `step` (read only under a .smooth(), whose time is then the only
  // glide). null for a control that is not an expression's input.
  E.LEAF_RAMP_SEC = 0.03;
  E.leafRampTime = (track, slot, paramName) => {
    const leaf = E.exprLeaf(paramName);
    if (leaf == null) return null;
    const e = E.exprsOf?.(track)?.get(E.exprKey(slot, leaf[1]));
    return e?.stepped?.has(leaf[0]) ? 0 : E.LEAF_RAMP_SEC;
  };

  E.rampTo = (track, rampKey, slot, target, value) => {
    const r = track.ramps.get(rampKey);
    const time = E.leafRampTime(track, slot, String(rampKey).slice(`slot${slot}_`.length));
    const timeArgs = time == null ? [] : ['time', time];
    if (r == null) {
      const bus = Bus.control(S, 1);
      const syn = Synth.new(S, 'poptart_ramp', ['out', bus.index, 'target', value, ...timeArgs], track.group, 'addToHead');
      E.nodeOwns?.(syn.nodeID, `a polled control (${rampKey})`);
      target.map(bus);
      track.ramps.set(rampKey, { synth: syn, bus, index: target.index, slot, target: value });
      E.tellRamp(track, rampKey, slot, syn, value);
    } else {
      r.target = value;
      // The plugin in this slot may have been swapped for one where the name is a different index:
      // follow it. (An open also clears the UGen's mappings - see dropSlotRamps.)
      if (target.index !== r.index) { r.index = target.index; target.map(r.bus); }
      r.synth.set('target', value, ...timeArgs);
      E.tellRamp(track, rampKey, slot, r.synth, value);
    }
  };

  // A ramp's control passing to a native modulator (whose map replaces the ramp's, leaving it
  // writing a bus nothing reads), or its plugin re-opening under it: the ramp goes, deferred like
  // any dropped modulator since the values already sent to it are timestamped ahead, and the poll
  // makes a fresh one if the control is still polled.
  E.dropRamp = (key, track, rampKey) => {
    const r = track.ramps.get(rampKey);
    if (r == null) return;
    track.ramps.delete(rampKey);
    E.tellRamp(track, rampKey, null, null, null);
    E.freeModulatorLater(key, track.group, r.synth, r.bus);
  };
  E.dropSlotRamps = (key, track, slot) => {
    for (const k of [...track.ramps.keys()]) if (track.ramps.get(k).slot === slot) E.dropRamp(key, track, k);
  };

  // --- polled values ---------------------------------------------------------------------------

  E.on('/poptart/setParam', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const value = Number(msg[4]);
    const latency = Number(msg[5]);
    const track = E.tracks.get(key);
    if (!E.isTrack(track)) return;
    const rampKey = `slot${slot}_${paramName}`;
    if (E.exprLeaf(paramName) != null) {
      // An expression's input takes any number - it is a term in the sum, not a position.
      E.bundleNow(latency, () => E.rampTo(track, rampKey, slot, E.paramTarget(track, slot, paramName), value));
    } else if (slot === -1) {
      // Channel controls live on the track synth itself, not a plugin. Not clipped to 0..1 - gain may
      // exceed unity, pan is -1..1 (the SynthDef clips sanely). The selectors among them (which
      // stereo pair, the cue switch) are set outright: a ramp passing through 1.5 is neither pair.
      if (E.steppedChannelControls.includes(paramName)) {
        E.bundleNow(latency, () => E.paramTarget(track, -1, paramName).set(value));
      } else {
        E.bundleNow(latency, () => E.rampTo(track, rampKey, -1, E.paramTarget(track, -1, paramName), value));
        // Back at rest - the pattern let go of the control, or set it there: once the glide is
        // over, the ramp goes and the control is simply set, so a control polled once in a set does
        // not hold a synth and a bus for the rest of it.
        if (value === E.channelDefault(paramName)) {
          E.sched(latency + 0.25, () => {
            const r = track.ramps.get(rampKey);
            if (r != null && r.target === value && E.tracks.get(key) === track) {
              const target = E.paramTarget(track, -1, paramName);
              E.dropRamp(key, track, rampKey);
              target.unmap();
            }
            return null;
          });
        }
      }
    } else if (track.controllers.get(slot) != null) {
      // Resolve by name (or a "Name#N" index suffix - see resolveParamIndex) and drive that specific
      // parameter; values are normalized 0..1.
      E.bundleNow(latency, () => {
        const target = E.paramTarget(track, slot, paramName);
        if (target != null) E.rampTo(track, rampKey, slot, target, Math.min(1, Math.max(0, value)));
      });
    }
  });

  // The pattern is about to drive a plugin parameter by poll: read what it is now and keep it, so a
  // release can put it back. The read is asynchronous; the first set is bundled a latency ahead, so
  // the answer is what the parameter was before the pattern reached it. A parameter already held
  // keeps its first reading - a second hold is a fresh Scheduler on the same track (an unmute).
  E.on('/poptart/holdParam', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const track = E.tracks.get(key);
    if (!E.isTrack(track) || slot < 0) return;
    const ctl = track.controllers.get(slot);
    const rampKey = `slot${slot}_${paramName}`;
    if (ctl != null && ctl.info != null && track.resting.get(rampKey) == null) {
      const index = E.resolveParamIndex(ctl.info, paramName);
      if (index != null) {
        // Marked before the answer lands, so a second hold in the meantime does not ask again.
        track.resting.set(rampKey, 'pending');
        ctl.get(index, (v) => { if (track.resting.get(rampKey) === 'pending') track.resting.set(rampKey, v); });
      }
    }
  });

  // ...and is done with it. The ramp goes (deferred, like any dropped modulator), the parameter is
  // unmapped from its bus, and set back to what the hold read. An answer that never came leaves the
  // parameter where the ramp left it.
  E.on('/poptart/releaseParam', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const latency = Number(msg[4]);
    const track = E.tracks.get(key);
    if (!E.isTrack(track) || slot < 0) return;
    const ctl = track.controllers.get(slot);
    const rampKey = `slot${slot}_${paramName}`;
    const resting = track.resting.get(rampKey);
    track.resting.delete(rampKey);
    if (E.exprLeaf(paramName) != null || (ctl != null && ctl.info != null)) {
      E.bundleNow(latency, () => {
        const target = E.paramTarget(track, slot, paramName);
        E.dropRamp(key, track, rampKey);
        if (target != null) {
          target.unmap();
          if (typeof resting === 'number' && target.kind === 'control') ctl.set(target.index, resting);
        }
      });
    }
  });

  // Pitch bend on its way out to a plugin (Sig#bend). The track synth posts its bend control at
  // bendPollHz while the track is bending; here that value becomes a MIDI pitch-bend message on the
  // instrument in slot 0. `bendrange` is how many semitones the plugin's full throw is worth.
  // Sent unbundled, at "now": the value already carries its musical timing.
  const offBend = S.on('/poptart/bendOut', (a) => {
    // a: [node, replyID, semitones, range]
    const key = E.bendTracks.get(isInt(a[0]));
    const semis = Number(a[2]);
    const range = Math.max(Number(a[3]), 1e-6);
    const track = key != null ? E.tracks.get(key) : null;
    const ctl = E.isTrack(track) ? track.controllers.get(0) : null;
    if (ctl != null && E.slotLive(track, 0)) {
      ctl.midi.bend(0, Math.min(16383, Math.max(0, Math.round(8192 + (semis / range) * 8192))));
    }
  });
  E.onStop(offBend);

  // --- native modulators -----------------------------------------------------------------------
  //
  // Map a control bus to the parameter once, drive the bus with a UGen oscillator in scsynth - no
  // further OSC traffic. Re-eval with the same shape updates the running LFO's args in place, so
  // its phase carries across edits. slot -1 = the track's channel controls.
  E.on('/poptart/setParamLFO', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const shape = String(msg[4]);
    const rateHz = Number(msg[5]);
    const phaseCycles = Number(msg[6]);
    const lo = Number(msg[7]);
    const hi = Number(msg[8]);
    // A patterned rate's changes arrive timestamped with its phase anchors (see anchorParamLFO), so
    // a re-send must not move a running modulator's rate: it lands now, the change is due later.
    const rateFromAnchors = isInt(msg[9] ?? 0) === 1;
    E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) {
        E.warn(`poptart: setParamLFO: no track ${key}`);
      } else {
        const target = await E.awaitTarget(track, slot, paramName, 'setParamLFO');
        if (target != null) {
          // Range warnings are for a plugin's 0..1 controls, not a channel or an expression input.
          const isChannel = target.kind !== 'control';
          const index = target.index;
          const lfoKey = `slot${slot}_${paramName}`;
          let existing = track.lfos.get(lfoKey);
          const atAudio = target.mapAudio != null;
          if (existing != null && (existing.audio ?? false) !== atAudio) {
            // The slot changed kind under it: the bus is the wrong kind for what reads it now.
            existing.synth.free();
            existing.bus.free();
            track.lfos.delete(lfoKey);
            existing = null;
          }
          // Warn on creation only: signal-valued bounds re-send continuously and may swing wide.
          if (existing == null && !isChannel && (lo < 0 || hi > 1)) {
            E.warn(`poptart: LFO range ${lo}..${hi} for '${paramName}' is outside the normalized 0..1 VST parameter `
              + 'range and will pin - use .range(0.2, 0.9)-style values until per-plugin calibration exists');
          }
          // An entry outlives the plugin it was mapped onto: re-map the bus on every send so a
          // swapped plugin, whose open cleared the UGen's mappings, still hears it.
          if (existing != null) {
            existing.index = index;
            if (atAudio) target.mapAudio(existing.bus, 1, 0); else target.map(existing.bus);
          }
          if (existing != null && existing.shape === shape) {
            if (rateFromAnchors) existing.synth.set('lo', lo, 'hi', hi);
            else existing.synth.set('freq', rateHz, 'lo', lo, 'hi', hi); // phase preserved
          } else if (existing != null) {
            // Shape changed: new oscillator, same bus + mapping. Freed immediately, unlike a DROPPED
            // modulator: the replacement writes to this same bus.
            existing.synth.free();
            existing.synth = Synth.new(S, E.lfoDefName(shape, atAudio),
              ['out', existing.bus.index, 'freq', rateHz, 'phase', phaseCycles, 'lo', lo, 'hi', hi],
              track.group, 'addToHead');
            existing.shape = shape;
          } else {
            const bus = atAudio ? Bus.audio(S, 2) : Bus.control(S, 1);
            const lfoSynth = Synth.new(S, E.lfoDefName(shape, atAudio),
              ['out', bus.index, 'freq', rateHz, 'phase', phaseCycles, 'lo', lo, 'hi', hi],
              track.group, 'addToHead');
            E.dropRamp(key, track, lfoKey);
            if (atAudio) target.mapAudio(bus, 1, 0); else target.map(bus);
            track.lfos.set(lfoKey, { synth: lfoSynth, bus, shape, index, audio: atAudio });
          }
        }
      }
      if (E.isTrack(track)) E.tellMods(track);
    });
  });

  // Phase re-anchor for a free-running LFO: resets the modulator's Sweep to `phase` at the bundled
  // target time, so audio-clock skew cannot accumulate into drift against the note grid. One that
  // arrives while the LFO is still being set up finds no entry and is dropped. A patterned rate
  // also sends the rate the modulator runs at from that moment (msg[6]).
  E.on('/poptart/anchorParamLFO', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const phase = Number(msg[4]);
    const latency = Number(msg[5]);
    let rate = msg[6];
    const track = E.tracks.get(key);
    const entry = E.isTrack(track) ? track.lfos.get(`slot${slot}_${paramName}`) : null;
    if (entry == null) return;
    if (rate == null) {
      E.bundleNow(latency, () => entry.synth.set('t_trig', 1, 'phase', phase));
    } else {
      const custom = entry.shape === 'custom';
      rate = Number(rate);
      if (custom) entry.rate = rate;
      E.bundleNow(latency, () => entry.synth.set('t_trig', 1, 'phase', phase, custom ? 'rate' : 'freq', rate));
    }
  });

  // lfo() drawn shapes: each shape a table in a Buffer, played by the one shape modulator def on the
  // same bus+map mechanism as setParamLFO. Modes: free (loops on its own clock), retrigger (loops,
  // phase resets on each noteOn), envelope (one pass per noteOn over 1/rate seconds, then holds).
  // Node sends the tables as files (msg[10], a JSON list of paths, read here and deleted) under a
  // key naming the shapes (msg[9]); a re-send of the same shapes sends the key and no files.
  E.on('/poptart/setParamShapeLFO', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const mode = String(msg[4]);
    const rateHz = Number(msg[5]);
    const phaseCycles = Number(msg[6]);
    const lo = Number(msg[7]);
    const hi = Number(msg[8]);
    const shapeKey = String(msg[9]);
    let paths = [];
    try { paths = (JSON.parse(String(msg[10] ?? '[]')) ?? []).map(String); } catch { paths = []; }
    // How long a swap between a patterned lfo("<pluck swell>")'s shapes glides, as a fraction of
    // one period.
    const glide = Number(msg[11] ?? 0);
    const rateFromAnchors = isInt(msg[12] ?? 0) === 1; // as setParamLFO's
    const del = (list) => list.forEach((p) => fs.rm(p, { force: true }, () => {}));
    E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      const envelope = mode === 'envelope' ? 1 : 0;
      let bufs = null;
      // The tables, read off their files (which then go): null when Node sent none.
      const readTables = async () => {
        if (paths.length === 0) return null;
        const read = paths.map((p) => Buffer.read(S, p));
        await S.sync();
        del(paths);
        paths = [];
        return read;
      };
      const freeTablesLater = (list) => {
        if (list) E.sched(E.modFreeDelay, () => { list.forEach((b) => b.free()); return null; });
      };
      if (track == null) {
        E.warn(`poptart: setParamShapeLFO: no track ${key}`);
        del(paths);
      } else {
        const target = await E.awaitTarget(track, slot, paramName, 'setParamShapeLFO');
        if (target == null) {
          del(paths);
        } else {
          const isChannel = target.kind !== 'control';
          const index = target.index;
          const atAudio = target.mapAudio != null;
          const defName = atAudio ? 'poptart_shape_lfo_ar' : 'poptart_shape_lfo';
          const lfoKey = `slot${slot}_${paramName}`;
          let existing = track.lfos.get(lfoKey);
          if (!isChannel && existing == null && (lo < 0 || hi > 1)) {
            E.warn(`poptart: shape range ${lo}..${hi} for '${paramName}' is outside the normalized 0..1 VST parameter range and will pin`);
          }
          if (existing != null && (existing.audio ?? false) !== atAudio) {
            // The slot changed kind under it. The tables are kept; the synth and bus start over.
            existing.synth.free();
            existing.bus.free();
            track.lfos.delete(lfoKey);
            bufs = existing.bufs;
            existing = null;
          }
          // An entry outlives the plugin it was mapped onto: re-map the bus on every send.
          if (existing != null) {
            existing.index = index;
            if (atAudio) target.mapAudio(existing.bus, 1, 0); else target.map(existing.bus);
          }
          const spec = `${mode}|${scFloat(glide)}|${shapeKey}`;
          if (existing != null && existing.shape === 'custom' && existing.spec === spec) {
            del(paths);
            if (rateFromAnchors) existing.synth.set('lo', lo, 'hi', hi);
            else {
              existing.synth.set('rate', rateHz, 'lo', lo, 'hi', hi);
              existing.rate = rateHz;
            }
            // A swap has to start the next shape at this one's rate and range.
            existing.lo = lo; existing.hi = hi;
          } else if (existing != null && existing.shape === 'custom' && existing.mode === mode
            && existing.glide === glide && paths.length === (existing.bufs ?? []).length) {
            // New shapes, same everything else: new tables under the running synth.
            const old = existing.bufs;
            bufs = await readTables();
            // A modulator the deferred free of a dropped one may already have taken.
            if (E.tracks.get(key) === track && track.lfos.get(lfoKey) === existing) {
              existing.synth.set('buf', bufs[existing.current ?? 0].bufnum, 'lo', lo, 'hi', hi,
                ...(rateFromAnchors ? [] : ['rate', rateHz]));
              existing.bufs = bufs;
              existing.spec = spec;
              if (!rateFromAnchors) existing.rate = rateHz;
              existing.lo = lo; existing.hi = hi;
              freeTablesLater(old);
            } else {
              freeTablesLater(bufs);
            }
          } else {
            const old = existing?.bufs ?? null;
            bufs = (await readTables()) ?? bufs ?? old;
            if (bufs == null) {
              E.warn(`poptart: setParamShapeLFO: '${paramName}' has no shape to play - evaluate it again`);
            } else {
              if (bufs !== old) freeTablesLater(old);
              let bus;
              if (existing != null) {
                // Immediate, for the reason setParamLFO's shape swap gives.
                existing.synth.free();
                bus = existing.bus;
              } else {
                bus = atAudio ? Bus.audio(S, 2) : Bus.control(S, 1);
              }
              const shapeSynth = Synth.new(S, defName,
                ['out', bus.index, 'buf', bufs[0].bufnum, 'rate', rateHz, 'phase', phaseCycles, 'lo', lo, 'hi', hi,
                  'envelope', envelope, 't_trig', mode !== 'free' && track.held > 0 ? 1 : 0],
                track.group, 'addToHead');
              if (existing == null) {
                E.dropRamp(key, track, lfoKey);
                if (atAudio) target.mapAudio(bus, 1, 0); else target.map(bus);
                track.lfos.set(lfoKey, {
                  synth: shapeSynth, bus, shape: 'custom', index, mode, spec, bufs, def: defName,
                  current: 0, glide, rate: rateHz, lo, hi, group: track.group, audio: atAudio,
                });
              } else {
                Object.assign(existing, {
                  synth: shapeSynth, shape: 'custom', mode, spec, bufs, def: defName, current: 0, glide,
                  rate: rateHz, lo, hi,
                });
                existing.pending = null; // a queued swap into shapes that are gone
              }
            }
          }
        }
      }
      if (E.isTrack(track)) E.tellMods(track);
    });
  });

  // Which shape a patterned lfo("<pluck swell>") is playing from now on: a timestamped exchange of
  // one running synth for another on the same bus, so the parameter never sees a gap. In the
  // note-gated modes the swap WAITS for the next note instead.
  E.on('/poptart/setParamShape', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const index = isInt(msg[4]);
    const latency = Number(msg[5]);
    // A patterned rate names the rate the new shape starts at; otherwise it keeps the running one.
    const swapRate = msg[6] != null ? Number(msg[6]) : null;
    const track = E.tracks.get(key);
    const lfoKey = `slot${slot}_${paramName}`;
    const existing = E.isTrack(track) ? track.lfos.get(lfoKey) : null;
    if (existing != null && existing.bufs != null && index >= 0 && index < existing.bufs.length
      && index !== existing.current) {
      const swap = () => {
        const old = existing.synth;
        const rate = swapRate ?? existing.rate ?? 1;
        // glide is a fraction of one LFO PERIOD, so its seconds follow the rate.
        const glideSec = (existing.glide ?? 0) / Math.max(Math.abs(rate), 0.001);
        const next = Synth.new(S, existing.def, ['out', existing.bus.index, 'buf', existing.bufs[index].bufnum,
          'rate', rate, 'phase', 0, 'lo', existing.lo ?? 0, 'hi', existing.hi ?? 1,
          'envelope', existing.mode === 'envelope' ? 1 : 0,
          't_trig', existing.mode === 'free' ? 0 : 1,
          'glideSec', glideSec, 'glideOn', glideSec > 0 ? 1 : 0],
        existing.group, 'addToHead');
        existing.synth = next;
        existing.current = index;
        existing.rate = rate;
        old.free(); // after the new one is made, so its In.kr still sees this one's last value
        E.tellMods(track);
      };
      if (existing.mode === 'free') E.bundleNow(latency, swap);
      else existing.pending = swap;
    }
    // Counted whatever happened, so Node knows when it may play this track's notes itself again.
    E.shapesHandled.set(key, (E.shapesHandled.get(key) ?? 0) + 1);
    if (E.isTrack(track)) E.tellMods(track);
    else E.tell('/poptart/ids/swap', key, E.shapesHandled.get(key), 0);
  });

  // Envelope flavor: same bus+map mechanism, the modulator an EnvGen gated by the track's note
  // events. On a control of one of poptart's own devices it runs at the sample rate on an audio
  // bus (poptart_env_ar); a plugin or a channel control is read once a block, so a control bus.
  E.on('/poptart/setParamEnv', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const atk = Number(msg[4]);
    const dec = Number(msg[5]);
    const sus = Number(msg[6]);
    const rel = Number(msg[7]);
    const curve = Number(msg[8]);
    const lo = Number(msg[9]);
    const hi = Number(msg[10]);
    const retrig = isInt(msg[11] ?? 0);
    E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) {
        E.warn(`poptart: setParamEnv: no track ${key}`);
      } else {
        const target = await E.awaitTarget(track, slot, paramName, 'setParamEnv');
        if (target != null) {
          const isChannel = target.kind !== 'control';
          const index = target.index;
          const envKey = `slot${slot}_${paramName}`;
          let existing = track.envs.get(envKey);
          const atAudio = target.mapAudio != null;
          if (existing != null && (existing.audio ?? false) !== atAudio) {
            // A plugin swapped for a native device or back: this envelope starts over on the right bus.
            existing.synth.free();
            existing.bus.free();
            track.envs.delete(envKey);
            existing = null;
          }
          // An entry outlives the plugin it was mapped onto: re-map the bus on every send.
          if (existing != null) {
            existing.index = index;
            if (atAudio) target.mapAudio(existing.bus, 1, 0); else target.map(existing.bus);
          }
          if (existing == null && !isChannel && (lo < 0 || hi > 1)) {
            E.warn(`poptart: env range ${lo}..${hi} for '${paramName}' is outside the normalized 0..1 VST parameter `
              + 'range and will pin - use .range(0.2, 0.9)-style values until per-plugin calibration exists');
          }
          if (existing != null) {
            existing.synth.set('atk', atk, 'dec', dec, 'sus', sus, 'rel', rel, 'curve', curve, 'lo', lo, 'hi', hi, 'retrig', retrig);
          } else {
            const bus = atAudio ? Bus.audio(S, 2) : Bus.control(S, 1);
            const envSynth = Synth.new(S, atAudio ? 'poptart_env_ar' : 'poptart_env',
              ['out', bus.index, 'atk', atk, 'dec', dec, 'sus', sus, 'rel', rel, 'curve', curve, 'lo', lo, 'hi', hi,
                'retrig', retrig, 'gate', track.held > 0 ? 1 : 0],
              track.group, 'addToHead');
            E.dropRamp(key, track, envKey);
            if (atAudio) target.mapAudio(bus, 1, 0); else target.map(bus);
            track.envs.set(envKey, { synth: envSynth, bus, index, audio: atAudio });
          }
        }
      }
      if (E.isTrack(track)) E.tellMods(track);
    });
  });

  // Unmapping a channel control (slot -1) also resets it to its neutral value.
  E.on('/poptart/clearParamEnv', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const track = E.tracks.get(key);
    const envKey = `slot${slot}_${paramName}`;
    const existing = E.isTrack(track) ? track.envs.get(envKey) : null;
    if (existing != null) {
      // Dropped first, so the control's other audio drivers going back on do not include this one.
      track.envs.delete(envKey);
      const target = E.paramTarget(track, slot, paramName, existing.index);
      if (target != null) {
        if (existing.audio === true) target.unmapAudio?.();
        else target.unmap();
      }
      E.freeModulatorLater(key, track.group, existing.synth, existing.bus);
    }
    if (E.isTrack(track)) E.tellMods(track);
  });

  // Takes a dropped modulator's synth and bus down a beat AFTER it was unmapped: note events are
  // sent up to a lookahead ahead and gate these synths from timestamped bundles, so freeing the node
  // at once pulls it out from under notes in flight. The UNMAP happens immediately; only the node
  // waits, and its bus with it. Only for a DROPPED modulator: a rebuild hands the same bus on.
  E.freeModulatorLater = (key, group, synth, bus) => {
    // Notes in flight will write to this node after it goes; accounted for here, where the reason
    // is known. Bounded: clearing it can cost one extra warning line.
    if (E.nodeGoneSaid.size > 2000) E.nodeGoneSaid.clear();
    if (synth != null) E.nodeGoneSaid.add(synth.nodeID);
    E.sched(E.modFreeDelay, () => {
      // A track destroyed (or rebuilt) inside the window already took the node down with its group,
      // but the bus is a client-side allocation and always has to be handed back here.
      const t = E.tracks.get(key);
      if (E.isTrack(t) && t.group === group) synth?.free();
      bus?.free();
      return null;
    });
  };

  E.on('/poptart/clearParamLFO', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const paramName = String(msg[3]);
    const track = E.tracks.get(key);
    const lfoKey = `slot${slot}_${paramName}`;
    const existing = E.isTrack(track) ? track.lfos.get(lfoKey) : null;
    if (existing != null) {
      track.lfos.delete(lfoKey);
      const target = E.paramTarget(track, slot, paramName, existing.index);
      if (target != null) {
        if (existing.audio === true) target.unmapAudio?.();
        else target.unmap();
      }
      E.freeModulatorLater(key, track.group, existing.synth, existing.bus);
      // A drawn shape's tables go with it, on the same deferral (nothing reads them after).
      if (existing.bufs) {
        const list = existing.bufs;
        E.sched(E.modFreeDelay, () => { list.forEach((b) => b.free()); return null; });
      }
    }
    if (E.isTrack(track)) E.tellMods(track);
  });

  // --- poptart's own devices: notes, files, curves, the live report -----------------------------

  E.on('/poptart/deviceNoteRoute', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const routed = isInt(msg[3]) > 0;
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(slot) : null;
    if (hasFn(ctl, 'noteRoute')) ctl.noteRoute(routed);
  });

  // "play this file on that control": a granulator's sample, a convolver's impulse response. The
  // buffer is one a sample pack already holds (see loadSamplePack), so nothing is read or freed here.
  // The last argument is the wavetable frame length the file declares (0 = it said nothing).
  E.on('/poptart/deviceSample', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const param = isInt(msg[3]);
    const index = isInt(msg[4]);
    const pack = String(msg[5]);
    const file = isInt(msg[6]);
    const frameLength = isInt(msg[7] ?? 0);
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(slot) : null;
    const buf = (E.samplePacks.get(pack) ?? [])[file];
    if (!hasFn(ctl, 'loadSample')) {
      E.warn(`poptart: there is no device in slot ${slot} of '${key}' to give a sample to`);
    } else if (buf == null) {
      E.warn(`poptart: '${pack}' has no file ${file} to play on ${key} slot ${slot}`);
    } else {
      ctl.loadSample(param, index, buf, frameLength);
    }
  });

  // "draw this curve on that control": [key, slot, param, optionSlot, point...], the curve already
  // sampled by Node, passed straight through to the UGen.
  E.on('/poptart/deviceShape', (msg) => {
    const key = String(msg[1]);
    const slot = isInt(msg[2]);
    const param = isInt(msg[3]);
    const index = isInt(msg[4]);
    const points = msg.slice(5).map(Number);
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(slot) : null;
    if (!hasFn(ctl, 'loadShape')) {
      E.warn(`poptart: there is no device in slot ${slot} of '${key}' to draw a curve on`);
    } else {
      ctl.loadShape(param, index, points);
    }
  });

  // "where is everything on that device right now": [requestId, key, slot], answered INLINE because
  // a device window polls this every frame. A count of -1: no device there, or it did not answer.
  E.on('/poptart/deviceLive', (msg) => {
    const requestId = msg[1];
    const key = String(msg[2]);
    const slot = isInt(msg[3]);
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(slot) : null;
    if (!hasFn(ctl, 'report')) {
      E.tell('/poptart/deviceLive.data', requestId, -1);
      return;
    }
    ctl.report((positions, report) => {
      if (positions == null) E.tell('/poptart/deviceLive.data', requestId, -1);
      else E.tell('/poptart/deviceLive.data', requestId, positions.length, ...positions, report.length, ...report);
    });
  });
}

// How sclang prints a Float in a string (glide.asString): integral values keep a ".0".
function scFloat(v) {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

module.exports = { install };
