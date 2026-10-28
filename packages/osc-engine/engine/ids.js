'use strict';

// The ids Node's direct path plays with (../direct.js). Node sends notes, sample voices and polled
// values straight to scsynth, so it needs the ids the engine makes. They are told here as they
// change ('/poptart/ids/*'); Node never guesses one, and sends anything it has no id for through
// the engine's handlers as before. Ported from poptart.scd (see core.js for the conventions).

function install(E) {
  E.tellTrack = (track) => {
    E.tell('/poptart/ids/track', track.key, track.group.nodeID, (track.voices ?? track.group).nodeID,
      track.inBus.index, track.bendBus.index, track.head.nodeID);
    E.tellSlot(track, 0);
    E.tellMods(track);
  };

  E.tellSlot = (track, slot) => {
    const ctl = track.controllers.get(slot);
    const node = ctl?.synth ?? E.slotNode(track, slot);
    if (track.key == null) return;
    // The last field: whether the slot holds one of poptart's own devices.
    const native = ctl != null && !E.isVstController(ctl) ? 1 : 0;
    E.tell('/poptart/ids/slot', track.key, slot, ctl != null ? 1 : 0,
      track.loaded.get(slot) != null ? 1 : 0, node?.nodeID ?? -1, ctl?.synthIndex ?? -1, native);
  };

  // Every env and every lfo, between a begin and an end so Node swaps the whole set at once, and
  // then whether a drawn shape's swap waits on the next note.
  E.tellMods = (track) => {
    const key = track.key;
    if (key == null) return;
    E.tell('/poptart/ids/modsBegin', key);
    for (const [k, e] of track.envs) if (e.synth) E.tell('/poptart/ids/mod', key, k, e.synth.nodeID, 0);
    for (const [k, e] of track.lfos) {
      let kind = 2;
      if (e.shape !== 'custom') kind = 1;
      else if (e.mode === 'retrigger') kind = 3;
      else if (e.mode === 'envelope') kind = 4;
      if (e.synth) E.tell('/poptart/ids/mod', key, k, e.synth.nodeID, kind);
    }
    E.tell('/poptart/ids/modsEnd', key);
    E.tell('/poptart/ids/swap', key, E.shapesHandled.get(key) ?? 0,
      [...track.lfos.values()].some((e) => e.pending != null) ? 1 : 0);
  };

  // A channel control coming to rest is the one value Node must not send itself: the ramp's drop is
  // scheduled on it, and has to see whatever comes after. null synth = gone.
  E.tellRamp = (track, rampKey, slot, synth, value) => {
    const key = track.key;
    if (key == null) return;
    if (synth == null) {
      E.tell('/poptart/ids/ramp', key, rampKey, 0, 0, 0);
      return;
    }
    const rest = slot === -1 ? E.channelDefault(String(rampKey).slice(`slot${slot}_`.length)) : null;
    const direct = typeof rest === 'number' && value === rest ? 0 : 1;
    E.tell('/poptart/ids/ramp', key, rampKey, synth.nodeID, slot, direct, ...(typeof rest === 'number' ? [rest] : []));
  };

  E.tellTap = (track, name, node) => {
    if (track.key != null) E.tell('/poptart/ids/tap', track.key, name, node?.nodeID ?? 0);
  };

  // A held-count change this side made itself (a note through its own handlers, a MIDI keyboard):
  // Node's count follows. Node's own changes arrive as /poptart/direct/* and are not told back.
  E.heldBy = (track, delta) => {
    const before = track.held;
    track.held = Math.max(0, before + delta);
    if (track.held !== before && track.key != null) E.tell('/poptart/ids/held', track.key, track.held - before);
  };
}

module.exports = { install };
