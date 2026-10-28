'use strict';

// Notes, hush, and what happens when the server says a node is not there. Ported from poptart.scd
// (see core.js for the conventions): the direct path's bookkeeping, the note handlers, hushTrack,
// the sampler's voice ceiling and the /fail repair.

const { Synth } = require('../server/objects');

const isDeviceMidi = (ctl) => ctl?.midi?.constructor?.name === 'DeviceMidiProxy';

function install(E) {
  const S = E.S;
  E.deadNodes ??= new Set();
  E.nodeGoneSaid = new Set();
  E.nodeOwners = new Map(); // nodeID -> what it was made for
  E.outOfRoomSaid = new Set();
  E.outOfRoomPhrases = ['out of real time memory', 'too many nodes', 'exceeded number of interconnect buffers',
    'alloc failed', 'too many buffers'];

  // --- what Node played itself -------------------------------------------------------------
  //
  // The books this side still keeps for it: the held count (modulators born later read it), what a
  // hush must release (markSounding) and the voice ceiling (voiceBorn). None of these carry timing.

  E.on('/poptart/direct/note', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const note = Number(msg[3]);
    const offLat = Number(msg[4]);
    const track = E.tracks.get(key);
    if (E.isTrack(track)) {
      if (offLat < 0) {
        if (slot === 0) track.held += 1;
        E.markSounding(track, slot, note, Infinity);
      } else {
        if (slot === 0) track.held = Math.max(0, track.held - 1);
        E.markSounding(track, slot, note, E.elapsed() + offLat);
      }
    }
  });

  E.on('/poptart/direct/voice', (msg) => {
    const key = String(msg[1]);
    const id = Math.trunc(msg[2]);
    const def = String(msg[3]);
    const doneLat = Number(msg[4]);
    const track = E.tracks.get(key);
    const synth = Synth.basicNew(def, S, id);
    E.voiceBorn(synth); // ...which releases the oldest past the ceiling, as for a voice made here
    if (E.isTrack(track)) track.held += 1;
    E.sched(doneLat, () => { E.voiceDone(synth); return null; });
  });

  E.on('/poptart/direct/held', (msg) => {
    const track = E.tracks.get(String(msg[1]));
    if (E.isTrack(track)) track.held = Math.max(0, track.held + Math.trunc(msg[2]));
  });

  // A deck player Node spawned: this side keeps it for songLoad/songFree and forwards its position.
  E.on('/poptart/direct/song', (msg) => {
    const key = String(msg[1]);
    const id = Math.trunc(msg[2]);
    const def = String(msg[3]);
    const spawnLat = Number(msg[4]);
    const song = E.songs.get(key);
    if (song) {
      E.freePosFunc(song);
      song.synth = Synth.basicNew(def, S, id);
      song.spawnUntil = E.elapsed() + spawnLat;
      song.posFunc = E.songPosFunc(key, id);
    }
  });

  E.on('/poptart/direct/songStop', (msg) => {
    const key = String(msg[1]);
    const id = Math.trunc(msg[2]);
    const song = E.songs.get(key);
    if (song && song.synth != null && song.synth.nodeID === id) {
      song.synth = null;
      E.freePosFunc(song);
      song.posFunc = null;
    }
  });

  // --- what a slot has sounding ----------------------------------------------------------------
  //
  // Which notes a slot's plugin has sounding, as note -> the time its note-off lands (Infinity
  // until one is known). Times, not a set an off empties: the scheduler sends a note's on and off
  // together, a lookahead before either happens, so only when each note ends says what is
  // ringing. This is what a hush releases by name; entries whose end has passed are dropped as
  // new ones arrive.
  E.markSounding = (track, slot, note, offAt) => {
    const slots = track.sounding;
    if (slots == null) return;
    if (!slots.has(slot)) slots.set(slot, new Map());
    const notes = slots.get(slot);
    const now = E.elapsed();
    for (const [n, at] of [...notes]) if (at < now) notes.delete(n);
    notes.set(note, offAt);
  };

  // The note an instrument slot is handed. poptart's own devices play a note exactly as written; a
  // plugin takes MIDI, so it gets the nearest key. Every on, off and hush goes through this, so an
  // off always names the same key its on did.
  E.noteKey = (ctl, note) => (isDeviceMidi(ctl) ? Number(note) : Math.round(Number(note)));

  // Note events also gate the track's env modulators, in the same timestamped bundle, so envelope
  // attacks line up with their notes. The gate follows a held-note count: open on the first held
  // note, closed when the last one ends (the count moves when the message arrives, the gate when
  // the bundle plays - right while events arrive in onset order, which they do).
  E.on('/poptart/noteOn', (msg) => {
    const key = String(msg[1]);
    const note = Number(msg[2]);
    const veloc = Number(msg[3]);
    const latency = Number(msg[4]);
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(0) : null;
    if (ctl == null) return;
    const fire = (lat) => {
      E.bundleNow(lat, () => {
        if (E.slotLive(track, 0)) ctl.midi.noteOn(0, E.noteKey(ctl, note), Math.round(veloc * 127));
        for (const e of track.envs.values()) e.synth?.set('gate', 1, 't_retrig', 1);
        // Note-synced lfo() shapes reset on every onset - and a patterned shape's swap happens
        // here in those modes, just before the trigger, so the note gets the new shape whole.
        for (const e of track.lfos.values()) {
          if (e.pending != null) { const f = e.pending; e.pending = null; f(); }
          if (e.mode === 'retrigger' || e.mode === 'envelope') e.synth?.set('t_trig', 1);
        }
      });
    };
    E.heldBy(track, 1);
    E.markSounding(track, 0, note, Infinity);
    // A swap due at or before this onset means the plugin will be mid-load when it would have
    // sounded, so it waits for the program instead (see waitForLoad).
    if (!E.waitForLoad(key, 0, E.elapsed() + latency, fire)) fire(latency);
  });

  E.on('/poptart/noteOff', (msg) => {
    const key = String(msg[1]);
    const note = Number(msg[2]);
    const latency = Number(msg[3]);
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(0) : null;
    if (ctl == null) return;
    const fire = (lat) => {
      E.bundleNow(lat, () => {
        if (E.slotLive(track, 0)) ctl.midi.noteOff(0, E.noteKey(ctl, note), 0);
        if (track.held === 0) for (const e of track.envs.values()) e.synth?.set('gate', 0);
      });
    };
    E.heldBy(track, -1);
    E.markSounding(track, 0, note, E.elapsed() + latency);
    // Queued behind its own note-on when one is waiting, or the note would never be released.
    if (!E.waitForLoad(key, 0, E.elapsed() + latency, fire)) fire(latency);
  });

  // --- hush: release everything a track is sounding, now ---------------------------------------
  //
  // Sent when a stopped track is played again: the stop lets everything ring out, but the restart
  // must not play over the old copy. The sample voices are released with one gate-off on their
  // group; each plugin has the notes it still has sounding released by name, with MIDI
  // all-notes-off behind that for a VST2 plugin only (VST3 has no such message); the env gates
  // close. Notes waiting on a program load are dropped. `again` repeats the release that many
  // seconds on, for events still in flight - on the same track object only.
  E.hushTrack = (key, again) => {
    const track = E.tracks.get(key);
    const release = (t, notes) => {
      E.bundleNow(null, () => {
        t.voices?.set('gate', 0);
        for (const [slot, ctl] of t.controllers) {
          // Only a slot with a plugin in it: an empty controller would answer with a warning.
          if (ctl != null && E.slotLive(t, slot)) {
            for (const note of notes.get(slot) ?? []) ctl.midi.noteOff(0, E.noteKey(ctl, note), 0);
            if (ctl.info != null && !String(ctl.info.sdkVersion ?? 'nil').includes('VST 3')) ctl.midi.allNotesOff(0);
          }
        }
        for (const e of t.envs.values()) e.synth?.set('gate', 0);
      });
      t.held = 0;
      // Every slot's queue the track has, whichever slots those are.
      const head = `${key}_`;
      for (const k of [...E.noteQueues.keys()]) {
        const rest = k.slice(head.length);
        if (k.startsWith(head) && rest.length && /^[0-9]+$/.test(rest)) E.noteQueues.delete(k);
      }
    };
    if (E.isTrack(track)) {
      // Everything whose end is still to come. Read once - the repeat releases the same notes.
      const now = E.elapsed();
      const notes = new Map();
      for (const [slot, slotNotes] of track.sounding ?? []) {
        notes.set(slot, [...slotNotes].filter(([, offAt]) => offAt > now).map(([n]) => n));
        slotNotes.clear();
      }
      release(track, notes);
      if (again > 0) E.sched(again, () => { if (E.tracks.get(key) === track) release(track, notes); return null; });
    }
  };

  E.on('/poptart/hush', (msg) => {
    E.hushTrack(String(msg[1]), Number(msg[2] ?? 0));
  });

  // MIDI to one slot's plugin (Sig#trig): a side channel that does NOT touch the held count or
  // gate the track's modulators. A note-off matches the same slot and pitch.
  E.on('/poptart/noteOnSlot', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const note = Number(msg[3]);
    const veloc = Number(msg[4]);
    const latency = Number(msg[5]);
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(slot) : null;
    if (ctl == null) return;
    const fire = (lat) => E.bundleNow(lat, () => {
      if (E.slotLive(track, slot)) {
        ctl.midi.noteOn(0, E.noteKey(ctl, note), Math.min(127, Math.max(1, Math.round(veloc * 127))));
      }
    });
    E.markSounding(track, slot, note, Infinity);
    if (!E.waitForLoad(key, slot, E.elapsed() + latency, fire)) fire(latency);
  });

  E.on('/poptart/noteOffSlot', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const note = Number(msg[3]);
    const latency = Number(msg[4]);
    const track = E.tracks.get(key);
    const ctl = E.isTrack(track) ? track.controllers.get(slot) : null;
    if (ctl == null) return;
    const fire = (lat) => E.bundleNow(lat, () => {
      if (E.slotLive(track, slot)) ctl.midi.noteOff(0, E.noteKey(ctl, note), 0);
    });
    E.markSounding(track, slot, note, E.elapsed() + latency);
    if (!E.waitForLoad(key, slot, E.elapsed() + latency, fire)) fire(latency);
  });

  // --- the sampler's voice ceiling ---------------------------------------------------------
  //
  // Every sample event is a new synth, so past a ceiling the OLDEST voice is released early to make
  // room, as a hardware sampler does when run out of polyphony: a moment too dense loses its tail
  // instead of the server running out of room for the rest of the night. Set far above any
  // musical number on purpose.
  E.voiceBorn = (synth) => {
    if (E.liveVoices.size >= E.maxVoices) {
      const oldest = E.liveVoices.values().next().value;
      if (oldest != null) {
        E.liveVoices.delete(oldest);
        oldest.set('gate', 0);
      }
      // Worth saying, but not once per voice: at the ceiling this happens as often as notes do.
      if (E.elapsed() - E.voiceCapSaidAt > 10) {
        E.voiceCapSaidAt = E.elapsed();
        E.warn(`poptart: ${E.maxVoices} sample voices are already sounding - releasing the oldest `
          + 'to make room. The pattern is denser than the engine can hold; this protects the '
          + 'server, which cannot recover if it runs out of room');
      }
    }
    E.liveVoices.add(synth);
  };
  // A voice that ended on its own. Its node outlives this by its release tail, so the count runs a
  // little low - the safe direction for a ceiling.
  E.voiceDone = (synth) => { E.liveVoices.delete(synth); };

  // --- a node the server does not have -------------------------------------------------------
  //
  // scsynth answers a command it could not carry out with /fail. A polled control re-sends its
  // value every poll and moves the SAME ramp synth each time, so a ramp node the server does not
  // have turns into a storm of failed writes with the parameter frozen. So the server is taken at
  // its word: the entry pointing at that node is dropped, and the next poll builds a fresh ramp.

  // What poptart made a node FOR, so a failure can say whose it was even after the track is gone.
  E.nodeOwns = (nodeID, what) => {
    if (E.nodeOwners.size > 4000) E.nodeOwners = new Map(); // bounded over a long set
    E.nodeOwners.set(nodeID, what);
  };

  // A failure because the server RAN OUT OF SOMETHING - the one that stops poptart making sound at
  // all, and does not recover. Said once per reason, plainly, because the answer is a restart.
  E.outOfRoom = (cmd, reason) => {
    const key = String(reason);
    if (!E.outOfRoomSaid.has(key)) {
      E.outOfRoomSaid.add(key);
      E.warn(`poptart: THE AUDIO SERVER IS OUT OF ROOM - ${reason} (${cmd} failed). `
        + 'Nothing new can be created from here: notes stop playing and plugins stop opening, '
        + 'and it does not recover on its own. Restart the engine. If this happens again, the '
        + "server's allocation needs raising (see server.options.memSize / maxNodes).");
    }
  };

  // A command that happens once and cannot be repaired (/u_cmd, /s_new): attributed, once, and
  // the node remembered so nothing else still in flight for it is sent.
  E.nodeMissing = (cmd, nodeID) => {
    if (nodeID != null && !E.nodeGoneSaid.has(nodeID)) {
      E.nodeGoneSaid.add(nodeID);
      E.deadNodes.add(nodeID);
      E.tell('/poptart/ids/dead', nodeID);
      if (E.deadNodes.size > 4000) E.deadNodes = new Set();
      E.warn(`poptart: the server has no node ${nodeID} (${E.nodeOwners.get(nodeID) ?? 'nothing poptart has a record of'}) - `
        + `${cmd} could not be delivered; anything else already in flight for it is dropped`);
    }
  };

  E.nodeGone = (nodeID) => {
    let fixed = false;
    if (nodeID == null) return;
    for (const [key, track] of E.tracks) {
      if (!E.isTrack(track)) continue;
      for (const k of [...track.ramps.keys()]) {
        const r = track.ramps.get(k);
        if (r != null && r.synth != null && r.synth.nodeID === nodeID) {
          track.ramps.delete(k);
          E.tellRamp(track, k, null, null, null);
          fixed = true;
          E.warn(`poptart: ${key}'s polled control ${k} was writing to node ${nodeID}, which the server does not have - rebuilding it`);
        }
      }
    }
    // Anything else: said ONCE per node - a storm of identical lines is its own kind of invisible.
    if (!fixed && !E.nodeGoneSaid.has(nodeID)) {
      E.nodeGoneSaid.add(nodeID);
      E.warn(`poptart: the server has no node ${nodeID} - something is writing to a node that is gone (this is said once per node)`);
    }
  };

  // The node id out of a `/fail <command> <reason> [...]` message (msg[0] the address), or null:
  // in the reason text ("Node 7961 not found"), or as an argument of its own.
  E.nodeFailId = (msg) => {
    for (const a of msg.slice(2)) {
      if (typeof a === 'number') return Math.trunc(a);
      const m = String(a).match(/[0-9]+/);
      if (m) return Number(m[0]);
    }
    return null;
  };

  // The /n_set family REPEATS, so it is REPAIRED; /u_cmd and /s_new happen once, so they are
  // ATTRIBUTED. Running out of room is checked first, on every command: it makes every other
  // failure a consequence rather than a cause.
  E.serverFail = (msg) => {
    const cmd = String(msg[1]);
    const reason = String(msg[2] ?? '');
    const room = E.outOfRoomPhrases.find((p) => reason.toLowerCase().includes(p.toLowerCase()));
    if (room != null) {
      E.outOfRoom(cmd, reason);
    } else if (['/n_set', '/n_setn', '/n_map', '/n_mapn'].includes(cmd)) {
      E.nodeGone(E.nodeFailId(msg));
    } else if (['/u_cmd', '/s_new'].includes(cmd)) {
      E.nodeMissing(cmd, E.nodeFailId(msg));
    }
  };

  // Every /fail reaches this side straight from the server now. A relay of the same failure from
  // Node ('/poptart/fail', from when it had a socket of its own) is dropped when the server's own
  // copy has already been handled, so nothing is counted twice.
  const fromServer = new Map(); // JSON of the reply -> when the server's copy was handled
  const keyOf = (args) => JSON.stringify(args.map((a) => (typeof a === 'number' ? a : String(a))));
  const offFail = S.on('/fail', (a) => {
    const now = E.elapsed();
    for (const [x, t] of fromServer) if (now - t > 1) fromServer.delete(x);
    fromServer.set(keyOf(a), now);
    E.serverFail(['/fail', ...a]);
  });
  E.onStop(offFail);
  E.on('/poptart/fail', (msg) => {
    const t = fromServer.get(keyOf(msg.slice(1)));
    if (t == null || E.elapsed() - t > 1) E.serverFail(msg);
  });
}

module.exports = { install };
