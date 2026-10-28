'use strict';

// Global mixer monitoring (the editor's mixer modal), the headphone section and the DJ deck
// meters: poptart.scd's mixer, headphones and deck-meter sections.

const { Synth, Bus } = require('../server/objects');
const { sendDefs } = require('../server/defs');
const synthdef = require('../synthdef');

const sameFreqs = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

function install(E) {
  const S = E.S;
  // The band centers the analysis def on the server was built for: those it was loaded with at
  // boot, if any (see boot's mixFreqs).
  E.mixBandFreqs = E.defs.has('poptart_mix_analysis') && Array.isArray(E.config.mixFreqs)
    ? E.config.mixFreqs.map(Number) : null;
  E.mixMaster = null;

  // The analysis defs for these band centers, built and sent (the def is named the same whatever
  // the bands, so a new set replaces the old on the server).
  E.buildMixDef = async (freqs) => {
    E.mixBandFreqs = freqs;
    const entries = synthdef.mixDefsFor(freqs, { nativeDevices: E.hasNativeDevices, spectrum: E.hasNativeDevices });
    await sendDefs(S, entries);
    for (const e of entries) E.defs.add(e.name, e.meta);
  };

  // Both replies answer here and carry only a node id: forward them tagged with the key they
  // meter ("*" for the master). Values from a[2] ([nodeID, replyID, values...]).
  E.mixForwards = (key, synth, full = true) => {
    const node = synth.nodeID;
    const funcs = [
      S.on('/poptart/mixLevel', (a) => {
        if (a[0] === node) E.tell('/poptart/mixLevel', key, a[2], a[3], a[4], a[5]);
      }),
    ];
    if (full) {
      funcs.push(S.on('/poptart/mixSpec', (a) => {
        if (a[0] === node) E.tell('/poptart/mixSpec', key, ...a.slice(2));
      }));
    }
    return funcs;
  };

  // Tap one track for the mixer: a private bus, a mix tap on the strip, an analysis synth reading
  // it (the full analyzer, or the meter-only def when `full` is false). Independent of the
  // recorder's tap, so the record panel and the mixer never fight over one bus.
  E.startMixTap = (key, full = true) => {
    const track = E.tracks.get(key);
    if (E.mixTaps.get(key) == null && E.isTrack(track)) {
      const bus = Bus.audio(S, 2);
      const synth = Synth.new(S, full ? 'poptart_mix_analysis' : 'poptart_mix_meter', ['bus', bus.index], E.recGroup, 'addToTail');
      E.stripTap(track, 'mix', bus.index, 1, 0);
      E.mixTaps.set(key, { bus, synth, funcs: E.mixForwards(key, synth, full), full });
    }
  };

  E.stopMixTap = (key) => {
    const entry = E.mixTaps.get(key);
    if (entry == null) return;
    const track = E.tracks.get(key);
    if (E.isTrack(track)) E.stripTap(track, 'mix', null);
    for (const f of entry.funcs) f();
    entry.synth.free();
    entry.bus.free();
    E.mixTaps.delete(key);
  };

  E.stopMixMaster = () => {
    const m = E.mixMaster;
    if (m == null) return;
    for (const f of m.funcs) f();
    m.synth.free();
    E.mixMaster = null;
  };

  // Bring the taps to what Node last asked for. Analyzers start a beat apart: scsynth builds a
  // graph on the audio thread, and many landing in one block is itself a dropout. One reconcile
  // at a time; a request mid-run marks it dirty and the loop goes round again.
  E.mixReconcile = () => {
    if (E.mixReconciling) { E.mixDirty = true; return; }
    E.fork(async () => {
      E.mixReconciling = true;
      E.mixDirty = true;
      try {
        while (E.mixDirty) {
          E.mixDirty = false;
          for (const key of [...E.mixTaps.keys()]) {
            if (!E.mixWanted.has(key)) E.stopMixTap(key);
          }
          if (!E.mixOn) E.stopMixMaster();
          for (const key of [...E.mixWanted]) {
            if (E.mixOn && E.mixTaps.get(key) == null && E.isTrack(E.tracks.get(key))) {
              E.startMixTap(key);
              await E.wait(0.02);
            }
          }
          if (E.mixOn && E.mixMaster == null) {
            const synth = Synth.new(S, 'poptart_mix_analysis', ['bus', 0], E.recGroup, 'addToTail');
            E.mixMaster = { synth, funcs: E.mixForwards('*', synth) };
          }
        }
      } finally {
        E.mixReconciling = false;
      }
    });
  };

  // Mixer on/off. On: [1, bandCentersJSON, trackIdsJSON]: rebuild the analyzer if the bands
  // changed (tearing down what was built against the old def), then reconcile. Off: tear down.
  E.on('/poptart/mixMeters', (msg) => {
    const on = Math.trunc(msg[1]);
    E.fork(async () => {
      if (on === 1) {
        const parse = (j) => { try { return JSON.parse(String(j)); } catch { return null; } };
        let freqs = msg[2] != null ? parse(msg[2]) : null;
        const wanted = msg[3] != null ? parse(msg[3]) : null;
        // Never build an analyzer with no bands.
        freqs = (Array.isArray(freqs) ? freqs : []).map(Number);
        if (freqs.length === 0) freqs = [200.0, 2000.0, 8000.0];
        if (!sameFreqs(E.mixBandFreqs, freqs)) {
          for (const key of [...E.mixTaps.keys()]) E.stopMixTap(key);
          E.stopMixMaster();
          await E.buildMixDef(freqs);
          await S.sync();
        }
        E.mixOn = true;
        E.mixWanted = new Set((Array.isArray(wanted) ? wanted : []).map(String));
      } else {
        E.mixOn = false;
        E.mixWanted = new Set();
      }
      E.mixReconcile();
    });
  });

  // [level, mix], both 0..1. Held as well as set, so a value before the synth exists is what it
  // starts with. Nothing to do on an engine with no cue pair.
  E.on('/poptart/headphones', (msg) => {
    E.headphoneLevel = Number(msg[1]);
    E.headphoneMix = Number(msg[2]);
    E.headphoneSynth?.set('level', E.headphoneLevel, 'mix', E.headphoneMix);
  });

  // On: one poptart_deck_meter per deck reading its meter bus in the tail group. Off: free them.
  E.on('/poptart/deckMeters', (msg) => {
    if (Math.trunc(msg[1]) === 1) {
      if (E.deckMeterSynths == null) {
        E.deckMeterSynths = [0, 1].map((i) => Synth.new(S, 'poptart_deck_meter',
          ['bus', E.deckMeterBus.index + i * 2, 'id', i], E.recGroup, 'addToTail'));
      }
    } else {
      for (const s of E.deckMeterSynths ?? []) s.free();
      E.deckMeterSynths = null;
    }
  });

  // Both deck readers answer here ([nodeID, deck, peakL, rmsL, peakR, rmsR]): forward by deck.
  S.on('/poptart/deckLevel', (a) => {
    E.tell('/poptart/deckLevel', Math.trunc(a[1]), a[2], a[3], a[4], a[5]);
  });

  // The master meter ([nodeID, replyID, then peak and rms for each side]), folded to the louder side.
  S.on('/poptart/masterLevel', (a) => {
    const v = a.slice(2);
    let peak = -Infinity;
    let rms = -Infinity;
    for (let i = 0; i + 1 < v.length; i += 2) { peak = Math.max(peak, v[i]); rms = Math.max(rms, v[i + 1]); }
    E.tell('/poptart/masterLevel', peak, rms);
  });

  // ...and the decks' band energies ([nodeID, deck, low, mid, high]).
  S.on('/poptart/deckBands', (a) => {
    E.tell('/poptart/deckBands', Math.trunc(a[1]), a[2], a[3], a[4]);
  });
}

module.exports = { install };
