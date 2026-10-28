'use strict';

// What a track's plugins are known to hold, kept across a Scheduler rebuild.
//
// A solo, an unsolo, a mute or a label coming back stops a track's Scheduler and, on its return,
// builds a fresh one on the same engine track - plugins still open, still holding their programs.
// A fresh Scheduler knows nothing, so its first setPattern pushed every `{ state }` and preset
// again: a load per plugin, each resetting its voices. The retiring Scheduler's known states
// (Scheduler#knownStates) are parked here, by engine track, and handed to the next one built for
// that track (Scheduler#adoptKnownStates), so only what changed is sent.
//
// A record is only good while the plugins it describes are the ones still open, so it goes:
//   - with the engine track (destroyTrack - see forgetTrack),
//   - with the engine (an engine restart opens everything afresh - see clear, and the engine
//     check in adopt, which a record from an earlier engine never passes),
//   - per slot, wherever the server would have told a live Scheduler to forget it (forgetSlot).
// A slot whose plugin the new pattern changes is the Scheduler's own business (see setPattern).

class StateCarry {
  constructor() {
    this._byTrack = new Map(); // engine track id -> { engine, states: "slot:pluginId" -> state }
  }

  /** Parks what a Scheduler being dropped knows - read BEFORE its stop(), which drops the
   * hand-edit holds knownStates leaves out. `engine` is the engine it ran on. */
  retire(sch, engine) {
    const states = sch.knownStates();
    if (states.size) this._byTrack.set(sch.trackId, { engine, states });
    else this._byTrack.delete(sch.trackId);
  }

  /** Hands a newly built Scheduler what its engine track's last one knew, once. */
  adopt(sch, engine) {
    const held = this._byTrack.get(sch.trackId);
    this._byTrack.delete(sch.trackId);
    if (held && held.engine === engine) sch.adoptKnownStates(held.states);
  }

  /** The engine track was destroyed: its plugins are closed. */
  forgetTrack(trackId) {
    this._byTrack.delete(trackId);
  }

  /** The engine is going: nothing it holds survives. */
  clear() {
    this._byTrack.clear();
  }

  /** A slot's plugin no longer holds what was last sent (see Scheduler#forgetAppliedState). */
  forgetSlot(trackId, slot) {
    const held = this._byTrack.get(trackId);
    if (!held) return;
    for (const key of [...held.states.keys()]) {
      if (key.startsWith(`${slot}:`)) held.states.delete(key);
    }
  }

  /** A state read out of a parked track's plugin (see Scheduler#markStateApplied). */
  markApplied(trackId, slot, pluginId, state, engine) {
    if (pluginId == null) return;
    let held = this._byTrack.get(trackId);
    if (held && held.engine !== engine) held = null;
    if (!held) this._byTrack.set(trackId, (held = { engine, states: new Map() }));
    held.states.set(`${slot}:${pluginId}`, state);
  }

  /** What a parked track's slot is known to hold, or undefined (see Scheduler#appliedState). */
  applied(trackId, slot, pluginId) {
    return pluginId == null ? undefined : this._byTrack.get(trackId)?.states.get(`${slot}:${pluginId}`);
  }
}

module.exports = { StateCarry };
