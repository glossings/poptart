'use strict';

// What goes into a slot: plugin and device opens, their serialization and edit watchers, unloads,
// and the waiting a note or a restore does for a load (program loads in flight, self loads).
// Ported from poptart.scd (see core.js for the conventions).

const { freeFunc } = require('./tracks');

// VSTPlugin's dict as a Map, whichever shape the host hands back.
const asMap = (d) => {
  if (!d) return new Map();
  if (d instanceof Map) return d;
  return new Map(Object.entries(d));
};

// One-at-a-time lock (sclang's Semaphore(1)).
class Lock {
  constructor() {
    this._busy = false;
    this._queue = [];
  }

  wait() {
    if (!this._busy) { this._busy = true; return Promise.resolve(); }
    return new Promise((resolve) => this._queue.push(resolve));
  }

  signal() {
    const next = this._queue.shift();
    if (next) next(); else this._busy = false;
  }
}

function isVstCtl(ctl) {
  if (!ctl) return false;
  try {
    const { VstController } = require('../server/vst');
    return ctl instanceof VstController;
  } catch {
    return false;
  }
}

function install(E) {
  const S = E.S;
  E.deadNodes ??= new Set();
  E.isVstController = isVstCtl;

  // Waits for the plugin in a slot to be open, for as long as an open is actually in flight for it
  // (`wanted` is set by loadInstrument/loadEffect before the open is queued and cleared when the
  // open fails or the slot is unloaded). `graceSec` is for message ordering only. Past the grace,
  // an unmarked slot is an empty one and this returns at once; a marked one is waited for up to
  // openWaitMax (a stuck-open guard, not a budget). Resolves whether the plugin is open.
  E.awaitLoaded = async (track, slot, graceSec = 1) => {
    let tries = 0;
    const grace = Math.trunc(graceSec / 0.05);
    const max = Math.trunc(E.openWaitMax / 0.05);
    while (track.loaded.get(slot) == null && tries < max && (track.wanted.get(slot) != null || tries < grace)) {
      await E.wait(0.05);
      tries += 1;
    }
    return track.loaded.get(slot) != null;
  };

  E.slotKey = (key, slot) => `${key}_${slot}`;

  // Whether a slot has a plugin to send MIDI to: one that is OPEN, and not on a synth the server
  // has told us it does not have (see deadNodes). Asked at send time, not at arrival: a note
  // queued behind a load (see waitForLoad) is judged by how the load turned out.
  E.slotLive = (track, slot) => {
    if (track.loaded.get(slot) == null) return false;
    const n = E.slotNode(track, slot);
    return n != null ? !E.deadNodes.has(n.nodeID) : false;
  };

  // A note due at or after the start of a program load WAITS for that load instead of being bundled
  // through it: loading suspends the plugin and resets its voices. Decided when the note MESSAGE
  // arrives, not at its onset - once a bundle is at scsynth nothing can hold it back. Only a note
  // the load reaches waits for it.
  E.waitForLoad = (key, slot, at, fire) => {
    const seqKey = E.slotKey(key, slot);
    const pending = E.statePending.get(seqKey);
    // A warm swap only claims notes near its onset; a cold load claims everything until it clears.
    const window = pending != null && pending.cold === true ? Infinity : E.stateWaitMax;
    if (pending != null && pending.at <= at && at <= pending.at + window) {
      E.noteQueues.set(seqKey, [...(E.noteQueues.get(seqKey) ?? []), { at, fire }]);
      return true;
    }
    return false;
  };

  // Everything waiting on one slot, in arrival order - a note-off must never overtake its note-on.
  // Each keeps its ORIGINAL onset; the 2ms floor keeps the bundle just ahead of scsynth.
  // `dropBefore` (a time, or null) is the cold-load release: entries whose onset is older are
  // history and do not play late in a burst.
  E.flushNotes = (seqKey, dropBefore = null) => {
    const waiting = E.noteQueues.get(seqKey);
    E.noteQueues.delete(seqKey);
    if (!waiting) return;
    const now = E.elapsed();
    for (const e of waiting) {
      if (dropBefore == null || e.at >= dropBefore) e.fire(Math.max(e.at - now, 0.002));
    }
  };

  // Ends the wait for one load - finished, failed, superseded or cancelled, the notes must go
  // either way. Only for the load it names: a newer one may have taken the slot over.
  E.clearPending = (seqKey, seq) => {
    const pending = E.statePending.get(seqKey);
    if (pending != null && pending.seq === seq) {
      E.statePending.delete(seqKey);
      const at = seqKey.lastIndexOf('_');
      if (at >= 0) {
        E.tell('/poptart/ids/loadDone', seqKey.slice(0, at), Math.trunc(Number(seqKey.slice(at + 1))), seq);
      }
      E.flushNotes(seqKey, pending.cold === true ? E.elapsed() - 0.02 : null);
    }
  };

  // The three ends of the self-load window (see selfLoads). `running` lets the tail be the real end
  // of it: the deadline taken at the start is only the failsafe for a load that never reports.
  E.beginSelfLoad = (seqKey) => {
    const e = E.selfLoads.get(seqKey) ?? { running: 0, until: 0 };
    e.running += 1;
    e.until = Math.max(e.until, E.elapsed() + E.coldWaitMax);
    E.selfLoads.set(seqKey, e);
  };

  E.endSelfLoad = (seqKey) => {
    const e = E.selfLoads.get(seqKey);
    if (!e) return;
    e.running = Math.max(e.running - 1, 0);
    if (e.running === 0) e.until = E.elapsed() + E.selfLoadTail;
  };

  // Whether what this slot's plugin is reporting is a program we handed it.
  E.selfLoading = (key, slot) => (E.selfLoads.get(E.slotKey(key, slot))?.until ?? 0) > E.elapsed();

  // `.synth("Serum 2")` uses the display name, but VSTPlugin's dict keys carry the file extension
  // ('Serum 2.vst3') - accept exact key, display name, or a literal file path.
  E.resolvePlugin = (pluginId) => {
    const dict = asMap(E.vst?.plugins());
    const id = String(pluginId);
    const hit = dict.get(id);
    // An exact key wins - EXCEPT when that key IS a bare display name. VSTPlugin keys a VST2 by its
    // plain name and a VST3 by "Name.vst3", so for a plugin installed in both formats the VST2 owns
    // the bare name, and loading it would fold the sidechain into extra channels instead of the
    // second bus the fx def feeds. A key carrying an extension or a path is unambiguous and wins.
    let desc;
    if (hit != null && String(hit.name) !== id) {
      desc = hit;
    } else {
      // Display-name lookup; prefer the VST3 so resolution is deterministic.
      const matches = [...dict.values()].filter((d) => d.name === id);
      desc = matches.find((d) => String(d.key).endsWith('.vst3')) ?? hit ?? matches[0];
    }
    return desc != null ? desc.key ?? id : id;
  };

  // Resolve a parameter name to its index. A plain name matches the first parameter with that name
  // (VSTPlugin's own lookup). A "Name#N" suffix addresses parameter index N directly; a real name
  // is tried first, so a parameter whose actual name contains '#' still resolves. null if nothing.
  E.resolveParamIndex = (info, name) => {
    let idx = info != null ? info.findParamIndex(String(name)) : null;
    if (idx == null && info != null) {
      const s = String(name);
      const at = s.lastIndexOf('#');
      if (at >= 0) {
        const suffix = s.slice(at + 1);
        if (suffix.length > 0 && /^[0-9]+$/.test(suffix)) {
          const n = Number(suffix);
          if (n >= 0 && n < info.parameters.length) idx = n;
        }
      }
    }
    return idx ?? null;
  };

  // Auto-pin + "conf" capture: everything we watch on a freshly opened plugin. Called once per
  // successful open. Three signals tell Node "this slot's plugin no longer matches the code":
  //   - parameterAutomated: a control moved in the plugin's own GUI;
  //   - /vst_program_index: a program switch;
  //   - /vst_update: the "updateDisplay" callback a plugin with its own preset browser fires.
  // Node debounces. Deliberately NOT /vst_param: that also fires for parameters we modulate.
  E.watchPluginEdits = (track, key, slot, ctl) => {
    // ...and a fourth signal, the one this must NOT hear: a program we loaded ourselves fires all
    // three (see selfLoads), and capturing that back is a feedback loop.
    const ours = () => E.selfLoading(key, slot);
    const notify = () => { if (!ours()) E.tell('/poptart/pluginEdited', key, slot); };
    ctl.parameterAutomated = (index, value) => {
      // Conf mode is deaf to our own loads for the same reason.
      if (track.confMode === true && !ours()) {
        const p = ctl.info?.parameters?.[index];
        if (p) E.tell('/poptart/paramAutomated', key, slot, String(p.name), index, Number(value));
      }
      notify();
    };
    // A re-open into the same controller must not stack a second set of watchers.
    const prev = track.editWatch.get(slot);
    if (prev) prev.forEach(freeFunc);
    const nodeID = ctl.synth.nodeID;
    const index = ctl.synthIndex;
    track.editWatch.set(slot, ['/vst_update', '/vst_program_index'].map((p) => S.on(p, (a) => {
      if (a[0] === nodeID && a[1] === index) notify();
    })));
  };

  // Plugin opens are SERIALIZED, engine-wide: evaluating a whole song fires its every open at once,
  // and a burst of simultaneous heavyweight instantiations starves the audio callback. One in
  // flight at a time, with a breather after each. A plugin whose open never reports back must not
  // wedge every later load of the set.
  E.pluginOpenLock = new Lock();
  E.openQueued = (ctl, desc, action) => E.fork(async () => {
    let signal;
    const done = new Promise((r) => { signal = r; });
    let test = false;
    const finish = () => { if (!test) { test = true; signal(); } };
    await E.pluginOpenLock.wait();
    try {
      ctl.open(desc, {
        editor: true,
        action: (self, ok) => {
          action(self, ok);
          finish();
        },
      });
    } catch (err) {
      E.warn(`poptart: plugin open threw: ${err?.message ?? err}`);
      finish();
    }
    E.fork(async () => { await E.wait(30); finish(); }); // stuck-open failsafe
    await done;
    await E.wait(0.05); // let the audio thread breathe between instantiations
    E.pluginOpenLock.signal();
  });

  E.on('/poptart/loadInstrument', (msg) => {
    const key = String(msg[1]);
    const pluginId = String(msg[2]);
    return E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) { E.warn(`poptart: loadInstrument: no track ${key}`); return; }
      // Livecoding re-eval sends the same chain again - don't reload an already-open plugin, nor
      // one whose open is still queued.
      E.slotKindGuard(key, track, 0, true);
      if (track.loaded.get(0) !== pluginId && track.wanted.get(0) !== pluginId) {
        const ctl = track.controllers.get(0) ?? E.vstController(track.head, 'slot0', E.trackDef.head.name);
        track.controllers.set(0, ctl);
        track.loaded.delete(0);
        // Marks the open in flight - what a restore waiting on this slot follows (see awaitLoaded).
        track.wanted.set(0, pluginId);
        E.tellSlot(track, 0);
        E.openQueued(ctl, E.resolvePlugin(pluginId), (self, ok) => {
          if (ok) {
            if (track.wanted.get(0) === pluginId) {
              track.loaded.set(0, pluginId);
              E.tellSlot(track, 0);
              // Emulated DAW transport from the first sample on.
              self.setPlaying(true);
              self.setTempo(E.trackTempo.get(key) ?? E.currentTempo);
              E.dropSlotRamps?.(key, track, 0); // the open cleared their mappings
              E.reassertExprs?.(key, track, 0); // and so did an expression's output
              E.watchPluginEdits(track, key, 0, self);
              E.post(`poptart: loaded instrument ${pluginId}`);
            }
          } else {
            track.wanted.delete(0);
            E.warn(`poptart: FAILED to load instrument '${pluginId}' ${E.scanning
              ? '- the plugin scan is still running, so it may simply not have been probed yet; try again when the scan finishes'
              : '(name must match a scanned plugin - see the plugin browser)'}`);
          }
        });
      }
    });
  });

  E.on('/poptart/loadEffect', (msg) => {
    const key = String(msg[1]);
    const pluginId = String(msg[2]);
    const position = Math.trunc(msg[3]); // -1 = next free slot
    return E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) { E.warn(`poptart: loadEffect: no track ${key}`); return; }
      // -1 is the slot after the last the track has.
      const slot = position >= 1 ? position : Math.max(0, ...track.nodes.keys()) + 1;
      if (slot < 1) { E.warn(`poptart: loadEffect: bad slot ${position}`); return; }
      // A slot changing kind has to be emptied before the plugin goes in (see slotKindGuard).
      E.slotKindGuard(key, track, slot, true);
      if (track.loaded.get(slot) !== pluginId && track.wanted.get(slot) !== pluginId) {
        const ctl = track.controllers.get(slot)
          ?? E.vstController(E.ensureFxNode(key, track, slot), 'slot', E.trackDef.fx.name);
        track.controllers.set(slot, ctl);
        track.loaded.delete(slot);
        // `wanted` marks the open in flight: the action only commits if the slot still wants this
        // plugin when the open completes. A failed open clears it so the next eval retries.
        track.wanted.set(slot, pluginId);
        E.tellSlot(track, slot);
        E.openQueued(ctl, E.resolvePlugin(pluginId), (self, ok) => {
          if (ok) {
            if (track.wanted.get(slot) === pluginId) {
              track.loaded.set(slot, pluginId);
              E.tellSlot(track, slot);
              self.setPlaying(true);
              self.setTempo(E.trackTempo.get(key) ?? E.currentTempo);
              // Un-bypass the slot, on its plugin half.
              track.nodes.get(slot)?.set('active', 1, 'native', 0);
              E.dropSlotRamps?.(key, track, slot);
              E.reassertExprs?.(key, track, slot);
              E.watchPluginEdits(track, key, slot, self);
              E.post(`poptart: loaded effect ${pluginId} in slot ${slot}`);
            }
          } else {
            track.wanted.delete(slot);
            E.warn(`poptart: FAILED to load effect '${pluginId}'${E.scanning
              ? ' - the plugin scan is still running, so it may simply not have been probed yet; try again when the scan finishes'
              : ''}`);
          }
        });
      }
    });
  });

  // --- poptart's own devices -------------------------------------------------------------------
  //
  // A slot carries two kinds of device and exactly one of them at a time. When a pattern changes
  // `synth("Serum 2")` to `synth("Plaits")` the slot changes kind, and whatever was there has to go.
  // Answers "is this slot already the kind we want", and empties it when it is not.
  E.slotKindGuard = (key, track, slot, wantPlugin) => {
    const ctl = track.controllers.get(slot);
    if (ctl != null && isVstCtl(ctl) !== wantPlugin) {
      if (slot >= 1) track.nodes.get(slot)?.set('active', 0); // bypass before the close
      ctl.close();
      track.controllers.delete(slot);
      track.loaded.delete(slot);
      track.wanted.delete(slot);
      E.tellSlot(track, slot);
      E.dropSlotRamps?.(key, track, slot);
      const funcs = track.editWatch.get(slot);
      if (funcs) funcs.forEach(freeFunc);
      track.editWatch.delete(slot);
    }
  };

  // Load one of poptart's own devices into a slot. Node resolves the name and sends the device's
  // controls along with it, as id/name/default triples. `position` is 0 for the instrument slot and
  // 1.. for an effect, or -1 for the next free one. Not serialized: the heavy part happens on the
  // server's helper thread, with no editor and no out-of-process probe.
  E.on('/poptart/loadDevice', (msg) => {
    const key = String(msg[1]);
    const position = Math.trunc(msg[2]);
    const name = String(msg[3]);
    const rest = msg.slice(4);
    const params = [];
    for (let i = 0; i < rest.length; i += 3) {
      params.push({ id: String(rest[i]), name: String(rest[i + 1]), default: rest[i + 2] != null ? Number(rest[i + 2]) : null });
    }
    return E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key);
      if (track == null) { E.warn(`poptart: loadDevice: no track ${key}`); return; }
      if (!E.hasNativeDevices) {
        E.warn(`poptart: '${name}' is one of poptart's own devices, and this engine has no `
          + 'PoptartDevice extension installed - nothing will sound in that slot. The '
          + 'extension ships prebuilt for macOS; on another platform it has to be built '
          + 'there (packages/web-engine/build/devices/native.mjs)');
        return;
      }
      const slot = position >= 0 ? position : Math.max(0, ...track.nodes.keys()) + 1;
      if (slot < 0) { E.warn(`poptart: loadDevice: bad slot ${position}`); return; }
      E.slotKindGuard(key, track, slot, false);
      // Re-eval sends the same chain again: an already-open device stays open, and so does one
      // whose open is still in flight.
      if (track.loaded.get(slot) === name || track.wanted.get(slot) === name) return;
      const ctl = track.controllers.get(slot) ?? (slot === 0
        ? E.deviceController(track.head, 'nslot0', E.trackDef.head.name)
        : E.deviceController(E.ensureFxNode(key, track, slot), 'nslot', E.trackDef.fx.name));
      track.controllers.set(slot, ctl);
      track.loaded.delete(slot);
      track.wanted.set(slot, name);
      E.tellSlot(track, slot);
      ctl.open(name, params, (self, ok) => {
        if (ok && track.wanted.get(slot) === name) {
          track.loaded.set(slot, name);
          E.tellSlot(track, slot);
          // Un-bypassed on its device half, in one message so no block hears the plugin half's
          // pass-through.
          if (slot >= 1) track.nodes.get(slot)?.set('active', 1, 'native', 1);
          E.dropSlotRamps?.(key, track, slot);
          E.reassertExprs?.(key, track, slot);
          E.watchPluginEdits(track, key, slot, self);
          // What the device has to be told rather than hear for itself: the tempo, where the
          // transport is, and whether anything is routed into its key input.
          self.setTempo(E.trackTempo.get(key) ?? E.currentTempo);
          if (E.trackBeats) self.setTransportPos(E.trackBeats(key));
          E.tellKeyPatched(track, slot, null, key);
          // And how late a chain in its feedback loop comes back, if it has one.
          E.tellLoop?.(track, slot);
          // And anything patched onto its controls: the device starts with every control on its
          // own default, and a route outlives the device.
          for (const e of E.paramRoutes.values()) {
            if (e.targetKey === key && e.slot === slot && e.pending == null) E.applyParamRoute(track, e);
          }
          E.post(`poptart: loaded device ${name} in slot ${slot}`);
        } else if (!ok) {
          track.wanted.delete(slot);
          E.warn(`poptart: FAILED to load device '${name}' - the engine's `
            + 'PoptartDevice extension does not have it (it is built from '
            + 'the same list the browser build ships)');
        }
      });
    });
  });

  // Commenting a .fx(...) out of a chain must actually silence it: re-bypass the slot, then close
  // the plugin. The controller is kept for reuse. No-op when the slot is already empty, decided
  // synchronously, so the scheduler can blanket-clear trailing slots on every eval without forking
  // a routine per slot.
  E.on('/poptart/unloadEffect', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const track = E.tracks.get(key);
    if (slot < 1) { E.warn(`poptart: unloadEffect: bad slot ${slot}`); return; }
    if (!E.isTrack(track)) {
      if (track == null) E.warn(`poptart: unloadEffect: no track ${key}`); // 'pending': empty, nothing to do
      return;
    }
    // ...or a node the chain no longer runs through, which goes.
    if (track.loaded.get(slot) != null || track.controllers.get(slot) != null || track.wanted.get(slot) != null
      || (track.nodes.get(slot) != null && !(track.wired ?? new Set()).has(slot))) {
      E.fork(async () => {
        const ctl = track.controllers.get(slot);
        track.wanted.delete(slot); // an in-flight open() must no longer commit
        if (track.loaded.get(slot) != null || ctl != null) {
          track.nodes.get(slot)?.set('active', 0); // bypass before the close
          ctl?.close();
          E.dropSlotRamps?.(key, track, slot); // nothing left to drive
          // A closed plugin can't be edited - drop its auto-pin watchers.
          const funcs = track.editWatch.get(slot);
          if (funcs) funcs.forEach(freeFunc);
          track.editWatch.delete(slot);
          const id = track.loaded.get(slot);
          if (id != null) E.post(`poptart: unloaded effect ${id} from slot ${slot}`);
          track.loaded.delete(slot);
        }
        // A slot the chain no longer has: its node goes too, and its controller with it. A slot
        // the chain still runs through keeps its node, bypassed, so its wiring holds.
        if (!(track.wired ?? new Set()).has(slot)) {
          const n = track.nodes.get(slot);
          track.nodes.delete(slot);
          n?.free();
          track.controllers.delete(slot);
        }
        E.tellSlot(track, slot);
      });
    }
  });
}

module.exports = { install, Lock };
