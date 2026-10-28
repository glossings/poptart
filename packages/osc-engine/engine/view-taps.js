'use strict';

// The editor's inline audio displays ('/poptart/viewTaps' - .scope(), .spectrum() and the rest;
// see ../view-taps.js): poptart.scd's view-tap section.
//
// Per tapped track, or the master (key '*'): a copy of the strip's output onto a private bus (a
// strip tap of its own, 'view' - see stripTap), a stereo ring of that bus's latest samples with the
// newest frame's index on a control bus, and an FFT buffer when a spectrum is drawn of it.
// ../view-taps.js reads the buffers straight from scsynth with /b_getn; this side only builds and
// frees them. `wanted` is what Node last asked for (key -> whether it wants the FFT), `taps` what
// exists. The defs (poptart_view_tap, poptart_view_fft) are loaded at boot with the rest.

const { Synth, Bus, Buffer } = require('../server/objects');

function install(E) {
  const S = E.S;
  const V = {
    taps: new Map(), wanted: new Map(), on: false,
    busy: false, dirty: false,
    ringFrames: 1024, decim: 2, fftFrames: 2048,
  };
  E.viewTap = V;

  // Tap one track (or the master): the buffers, then - once the server has them - the synths that
  // write them in the tail group, then the strip's 'view' tap pointed at the bus, and last Node is
  // told where everything is. A track that does not exist yet is skipped; its birth reconciles.
  V.start = async (key, fft) => {
    const master = key === '*';
    if (V.taps.has(key) || !(master || E.isTrack(E.tracks.get(key)))) return;
    const bus = master ? null : Bus.audio(S, 2);
    const ring = Buffer.alloc(S, V.ringFrames, 2);
    const head = Bus.control(S, 1);
    const fftBuf = fft ? Buffer.alloc(S, V.fftFrames, 1) : null;
    const reads = master ? 0 : bus.index;
    const entry = { bus, ring, head, fftBuf, fft };
    await S.sync();
    entry.tap = Synth.new(S, 'poptart_view_tap', ['bus', reads, 'ring', ring.bufnum, 'head', head.index,
      'frames', V.ringFrames, 'decim', V.decim], E.recGroup, 'addToTail');
    if (fftBuf) {
      entry.fftSynth = Synth.new(S, 'poptart_view_fft', ['bus', reads, 'buf', fftBuf.bufnum], E.recGroup, 'addToTail');
    }
    V.taps.set(key, entry);
    // The track may have gone during the sync: its teardown found no tap to stop, so stop it here.
    const track = E.tracks.get(key);
    if (!master && !E.isTrack(track)) { V.stop(key); return; }
    if (!master) E.stripTap(track, 'view', bus.index, 1, 0);
    E.tell('/poptart/viewTap', key, ring.bufnum, head.index, fftBuf ? fftBuf.bufnum : -1,
      V.ringFrames, V.decim, S.sampleRate ?? E.sampleRate, E.scsynthPort);
  };

  V.stop = (key) => {
    const entry = V.taps.get(key);
    if (!entry) return;
    const track = E.tracks.get(key);
    if (entry.bus && E.isTrack(track)) E.stripTap(track, 'view', null);
    entry.tap.free();
    entry.fftSynth?.free();
    entry.ring.free();
    entry.fftBuf?.free();
    entry.head.free();
    entry.bus?.free();
    V.taps.delete(key);
    E.tell('/poptart/viewTapGone', key);
  };

  // Bring the taps to what Node last asked for, a beat apart like the mixer's (see mixReconcile): a
  // tap of the wrong kind - a spectrum added or dropped - is rebuilt, a tap nobody wants goes. One
  // run at a time; an ask arriving mid-run goes round the loop again.
  V.reconcile = () => {
    if (V.busy) { V.dirty = true; return; }
    E.fork(async () => {
      V.busy = true;
      V.dirty = true;
      try {
        while (V.dirty) {
          V.dirty = false;
          for (const key of [...V.taps.keys()]) {
            const want = V.wanted.get(key);
            if (want == null || want !== V.taps.get(key).fft) V.stop(key);
          }
          for (const [key, want] of [...V.wanted]) {
            if (!V.taps.has(key) && want != null) {
              await V.start(key, want);
              await E.wait(0.02);
            }
          }
        }
      } finally {
        V.busy = false;
      }
    });
  };

  // [key, fft, key, fft, ...]: the whole set of taps Node wants, '*' being the master. Empty for none.
  E.on('/poptart/viewTaps', (msg) => {
    const wanted = new Map();
    const args = msg.slice(1);
    for (let i = 0; i + 1 < args.length; i += 2) wanted.set(String(args[i]), Math.trunc(Number(args[i + 1])) === 1);
    V.wanted = wanted;
    V.on = wanted.size > 0;
    V.reconcile();
  });
}

module.exports = { install };
