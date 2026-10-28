'use strict';

// Introspection and plugin state: a slot's parameter list, its editor window, conf capture, and
// the program capture/restore that synth("Serum 2", { state }) and .preset() ride on. A port of
// poptart.scd's introspection and plugin-state sections.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const del = (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } };

function install(E) {
  const ctlOf = (key, slot) => {
    const track = E.tracks.get(key);
    return E.isTrack(track) ? track.controllers.get(slot) ?? null : null;
  };

  E.on('/poptart/getParams', (msg) => {
    const requestId = msg[1];
    const key = String(msg[2]);
    const slot = Math.trunc(msg[3]);
    const ctl = ctlOf(key, slot);
    if (ctl == null || ctl.info == null) {
      E.replyErr('/poptart/getParams', requestId, 'no plugin loaded in that slot');
    } else {
      const params = ctl.info.parameters.map((p, i) => ({ name: p.name, label: p.label ?? '', index: i }));
      E.replyOk('/poptart/getParams', requestId, E.toJson(params));
    }
  });

  E.on('/poptart/showPluginEditor', (msg) => {
    const ctl = ctlOf(String(msg[1]), Math.trunc(msg[2]));
    if (ctl != null) ctl.editor();
  });

  // "stop changing this slot's program." A scheduled restore sits on the clock until its onset, so
  // a slot taken over by hand has to be able to drop the swap already on its way. Raising the
  // sequence is all it takes: the waiting restore checks it and deletes its file instead.
  E.on('/poptart/cancelPluginState', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const seq = Math.trunc(msg[3]);
    const seqKey = `${key}_${slot}`;
    if (seq > (E.stateSeqs.get(seqKey) ?? 0)) {
      E.stateSeqs.set(seqKey, seq);
      // The load is off, so anything waiting for it is waiting for nothing - play it now.
      const p = E.statePending.get(seqKey);
      if (p != null) E.clearPending(seqKey, p.seq);
    }
  });

  // "conf" (configure) capture on/off for a track. The track may not exist yet, so wait for it;
  // confWant holds the latest request, so an on->off flip mid-build resolves to the last click.
  E.on('/poptart/setConfMode', (msg) => {
    const key = String(msg[1]);
    const on = Math.trunc(msg[2]);
    E.confWant.set(key, on === 1);
    E.fork(async () => {
      const track = E.builtTrack(key) ?? await E.awaitTrack(key, 30);
      if (track != null) {
        track.confMode = E.confWant.get(key);
        E.post(`poptart: conf capture ${E.confWant.get(key) ? 'ON' : 'OFF'} for track ${key}`);
      } else {
        E.warn(`poptart: conf: track '${key}' never appeared - conf not armed`
          + ' (evaluate the pattern, then toggle conf again)');
      }
    });
  });

  // Capture: write the slot's full program (VSTPlugin's own file format) to a temp file and reply
  // with its path; Node reads, deletes and compresses it.
  E.on('/poptart/getPluginState', (msg) => {
    const requestId = msg[1];
    const ctl = ctlOf(String(msg[2]), Math.trunc(msg[3]));
    if (ctl == null || ctl.info == null) {
      E.replyErr('/poptart/getPluginState', requestId, 'no plugin loaded in that slot');
      return;
    }
    const p = path.join(os.tmpdir(), `poptart-state-${requestId}.fxp`);
    ctl.writeProgram(p, (self, ok) => {
      if (ok) E.replyOk('/poptart/getPluginState', requestId, E.toJson({ path: p }));
      else E.replyErr('/poptart/getPluginState', requestId, 'writeProgram failed');
    });
  });

  // Restore: the state arrives as a program file path (Node already unpacked it). The slot's open
  // may still be in flight, so wait for it before applying. msg[4] is an optional latency: a
  // patterned .preset() schedules its swaps a lookahead early, and readProgram is a call on the
  // plugin rather than a server message, so the wait is a clock wait here.
  E.on('/poptart/setPluginState', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const p = String(msg[3]);
    const latency = msg.length > 4 ? Number(msg[4]) : 0;
    const seq = msg.length > 5 ? Math.trunc(msg[5]) : 0;
    const seqKey = `${key}_${slot}`;
    const apply = () => {
      // Superseded while it waited: its file still has to go.
      if (E.stateSeqs.get(seqKey) !== seq) { del(p); return; }
      E.fork(async () => {
        const track = E.builtTrack(key) ?? await E.awaitTrack(key);
        if (track != null && await E.awaitLoaded(track, slot)) {
          const ctl = track.controllers.get(slot);
          // Until a little after it lands, whatever this plugin says about itself is this program
          // arriving, not a pair of hands (see selfLoads).
          E.beginSelfLoad(seqKey);
          ctl.readProgram(p, (self, ok) => {
            if (ok) E.post(`poptart: restored plugin state for ${key} slot ${slot}`);
            else E.warn(`poptart: FAILED to restore plugin state for ${key} slot ${slot}`);
            E.endSelfLoad(seqKey);
            E.clearPending(seqKey, seq);
            del(p);
            // Node marks a program sent the moment it sends it; this says it is IN.
            E.tell('/poptart/stateLanded', key, slot, seq, ok ? 1 : 0);
          });
        } else {
          E.tell('/poptart/stateLanded', key, slot, seq, 0);
          E.warn(`poptart: setPluginState: no loaded plugin in ${key} slot ${slot}`);
          E.clearPending(seqKey, seq); // nothing to load into: don't hold its notes back
          del(p);
        }
      });
    };
    // Recorded at RECEIPT, so a message sent later can cancel one still waiting. Cold = the slot's
    // plugin is not open yet: the hold covers the whole open+load and its release drops missed notes.
    const t = E.tracks.get(key);
    const cold = !E.isTrack(t) || t.loaded.get(slot) == null;
    if (seq >= (E.stateSeqs.get(seqKey) ?? 0)) {
      E.stateSeqs.set(seqKey, seq);
      E.statePending.set(seqKey, { seq, at: E.elapsed() + latency, cold });
      E.sched(latency + (cold ? E.openWaitMax + E.coldWaitMax : E.stateWaitMax), () => { E.clearPending(seqKey, seq); return null; });
      if (latency > 0) E.sched(latency, () => { apply(); return null; });
      else apply();
    } else {
      del(p);
    }
  });

  // The swap's shadow, sent the moment Node's setPluginState is called: the program follows only
  // after Node has inflated and written it, while the notes at the swap's onset go at once. This
  // makes "a load is coming at this time" true before they ask (see waitForLoad).
  E.on('/poptart/statePending', (msg) => {
    const key = String(msg[1]);
    const slot = Math.trunc(msg[2]);
    const latency = Number(msg[3]);
    const seq = Math.trunc(msg[4]);
    const seqKey = `${key}_${slot}`;
    const t = E.tracks.get(key);
    const cold = !E.isTrack(t) || t.loaded.get(slot) == null;
    if (seq >= (E.stateSeqs.get(seqKey) ?? 0)) {
      E.stateSeqs.set(seqKey, seq);
      E.statePending.set(seqKey, { seq, at: E.elapsed() + latency, cold });
      E.sched(latency + (cold ? E.openWaitMax + E.coldWaitMax : E.stateWaitMax), () => { E.clearPending(seqKey, seq); return null; });
    }
  });

  E.on('/poptart/getKnownPlugins', (msg) => {
    E.replyOk('/poptart/getKnownPlugins', msg[1], E.toJson(E.pluginList()));
  });
}

module.exports = { install };
