'use strict';

// The sampler: packs read into buffers, one synth per sample event, and the granular voice's
// buffers. Ported from poptart.scd (see core.js for the conventions).

const fs = require('node:fs');
const { Synth, Buffer } = require('../server/objects');

/**
 * Env(levels, times, curves).asSignal(length) as the class library computes it: `length` points
 * across the whole duration, the last on its end, each stage a numeric curve (Env's shape 5).
 * The stage math is the class library's envAt primitive.
 */
function envSignal(levels, times, curves, length) {
  const duration = times.reduce((a, b) => a + b, 0);
  const ratio = duration / (length - 1);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = envAt(levels, times, curves, i * ratio);
  return Array.from(out);
}

function envAt(levels, times, curves, time) {
  let begLevel = levels[0];
  let begTime = 0;
  for (let i = 0; i < times.length; i++) {
    const endLevel = levels[i + 1];
    const dur = times[i];
    const endTime = begTime + dur;
    if (time < endTime) {
      const pos = (time - begTime) / dur;
      const curve = curves[i % curves.length] ?? 0;
      if (Math.abs(curve) < 0.0001) return pos * (endLevel - begLevel) + begLevel;
      const denom = 1 - Math.exp(curve);
      const numer = 1 - Math.exp(pos * curve);
      return begLevel + (endLevel - begLevel) * (numer / denom);
    }
    begTime = endTime;
    begLevel = endLevel;
  }
  return begLevel;
}

function install(E) {
  const S = E.S;

  // The buffers a granular voice reads each side of a file from: a mono file is both of its own
  // sides, a stereo one gets a one-channel copy of each, read the first time an event asks. null
  // means "not yet" - the playSample handler waits out what lead the event has.
  E.grainSidesFor = (buf) => {
    const have = E.grainSides.get(buf.bufnum);
    if (buf.numChannels === 1) return [buf, buf];
    if (Array.isArray(have)) return have;
    if (have != null) return null; // 'loading', or 'failed' - which stays failed until the pack is reloaded
    let done = 0;
    let pair;
    E.grainSides.set(buf.bufnum, 'loading');
    // Buffer.read* THROWS once the allocator is empty (see loadSamplePack).
    try {
      const reads = [];
      for (const ch of [0, 1]) {
        reads.push(Buffer.readChannel(S, buf.path, 0, -1, [ch], () => {
          done += 1;
          if (done === 2) {
            // The pack may have been reloaded under the reads, and taken the entry with it.
            if (E.grainSides.get(buf.bufnum) === 'loading') E.grainSides.set(buf.bufnum, pair);
            else pair.forEach((b) => b.free());
          }
        }));
      }
      pair = reads;
    } catch {
      E.grainSides.set(buf.bufnum, 'failed');
      E.warn(`poptart: .grain(): the audio server is out of buffers - ${buf.path} plays nothing granular until the engine restarts`);
    }
    return null;
  };

  E.freeGrainSides = (buf) => {
    const have = E.grainSides.get(buf.bufnum);
    E.grainSides.delete(buf.bufnum);
    if (Array.isArray(have)) have.forEach((b) => b.free());
  };

  // The buffer holding a grain window (Sig#grainshape), by the breakpoint JSON the event carried:
  // the same x/y/c points a drawn LFO shape arrives as, turned into the same Env and rendered. -1
  // is GrainBuf's built-in bell, for no window or one still being sent. Past a few dozen, the
  // windows nothing has asked for lately go - "lately" outlasting the longest grain.
  E.grainWindowFor = (json) => {
    const now = E.elapsed();
    if (!json || json.length === 0) return -1;
    const have = E.grainWindows.get(json);
    if (have != null) {
      have.used = now;
      return have.buf?.bufnum ?? -1;
    }
    const points = JSON.parse(json);
    const xs = points.map((p) => Number(p.x));
    const ys = points.map((p) => Number(p.y));
    const cs = points.map((p) => Number(p.c ?? 0));
    const times = [];
    for (let k = 1; k < xs.length; k++) times.push(Math.max(0, xs[k] - xs[k - 1]));
    const entry = { used: now, buf: null };
    E.grainWindows.set(json, entry);
    Buffer.sendCollection(S, envSignal(ys, times, cs.slice(0, Math.max(0, cs.length - 1)), E.grainWindowFrames), 1,
      (b) => { entry.buf = b; });
    if (E.grainWindows.size > 48) {
      for (const [k, e] of [...E.grainWindows]) {
        if (now - e.used > 30) { e.buf?.free(); E.grainWindows.delete(k); }
      }
    }
    return -1;
  };

  // Reads a pack's files (enumerated Node-side, filename order) into buffers and replies with each
  // file's shape. A file scsynth can't read still occupies its index (frames 0), so indices stay
  // aligned with the sorted list. The path list arrives as a temp file (a big pack's is ~70KB).
  E.on('/poptart/loadSamplePack', (msg) => {
    const requestId = msg[1];
    const pack = String(msg[2]);
    const pathsFile = String(msg[3]);
    E.fork(async () => {
      const paths = JSON.parse(fs.readFileSync(pathsFile, 'utf8'));
      let done = 0;
      let tries = 0;
      const bufs = [];
      let starved = false;
      fs.rmSync(pathsFile, { force: true });
      const old = E.samplePacks.get(pack);
      if (old) old.forEach((b) => { E.freeGrainSides(b); b.free(); });
      // Buffer.read THROWS once the allocator is empty: turn a library too big for numBuffers into
      // an immediate, explicable failure rather than a reply that never comes.
      for (const p of paths) {
        if (starved) continue;
        try {
          bufs.push(Buffer.read(S, String(p), 0, -1, () => { done += 1; }));
        } catch {
          starved = true;
        }
      }
      // Cap just under Node's PACK_LOAD_TIMEOUT_MS so a partial read still replies in time.
      while (done < bufs.length && tries < 2200) { await E.wait(0.05); tries += 1; }
      if (starved) {
        // Waited for the in-flight reads first, so freeing here can't race their /done.
        bufs.forEach((b) => { E.freeGrainSides(b); b.free(); });
        E.samplePacks.delete(pack);
        E.replyErr('/poptart/loadSamplePack', requestId,
          `the audio server ran out of buffers loading ${paths.length} file(s) (${bufs.length} read before it gave out) - `
          + 'other packs already loaded this session hold the rest. Restart the engine, or raise numBuffers in server/server.js.');
      } else {
        E.samplePacks.set(pack, bufs);
        E.post(`poptart: sample pack '${pack}': ${done}/${bufs.length} file(s) read`);
        E.replyOk('/poptart/loadSamplePack', requestId, E.toJson(bufs.map((b) => ({
          frames: b.numFrames ?? 0, sampleRate: b.sampleRate ?? 0, channels: b.numChannels ?? 0, bufnum: b.bufnum,
        }))));
      }
    });
  });

  // One sample event. Node already resolved slices/fit down to begin/end/rate/dur; this picks the
  // voice def for (loop, stretch, channels), spawns it into the track's voice group writing the
  // track's input bus, and gates env/lfo modulators as a note does. Loops and gate-mode one-shots
  // get a gate-off bundle at the event's end; other one-shots free themselves after dur.
  E.on('/poptart/playSample', (msg) => {
    const key = String(msg[1]);
    const pack = String(msg[2]);
    const idx = Math.trunc(msg[3]);
    const begin = Number(msg[4]);
    const end = Number(msg[5]);
    const loop = Math.trunc(msg[6]);
    const rate = Number(msg[7]);
    const stretch = Number(msg[8]);
    const dur = Number(msg[9]);
    const latency0 = Number(msg[10]);
    const stopLatency0 = Number(msg[11]);
    const amp = Number(msg[12] ?? 1);
    const cut = Math.trunc(msg[13] ?? 0);
    // ADSR: atk/dec/rel in seconds (Node applies .envscale()), sus a 0..1 level.
    const atk = Number(msg[14] ?? 0);
    const dec = Number(msg[15] ?? 0);
    const sus = Number(msg[16] ?? 1);
    const rel = Number(msg[17] ?? 0);
    // Loop shape (only the loop defs read it).
    const loopLo = Number(msg[18] ?? 0);
    const loopHi = Number(msg[19] ?? 1);
    const entry = Number(msg[20] ?? 0);
    const pingpong = Math.trunc(msg[21] ?? 0);
    // The granular voice (Sig#grain).
    const grain = Math.trunc(msg[22] ?? 0);
    const grainSize = Number(msg[23] ?? 0.08);
    const grainRate = Number(msg[24] ?? 20);
    const grainPan = Number(msg[25] ?? 0);
    const posLive = Math.trunc(msg[26] ?? 0);
    const windowJson = String(msg[27] ?? '');
    const arrived = E.elapsed();
    const track = E.tracks.get(key);
    const bufs = E.samplePacks.get(pack);
    const buf = bufs && bufs.length ? bufs[((idx % bufs.length) + bufs.length) % bufs.length] : null;
    const warp = Math.abs(stretch - 1) > 1e-4;
    const gated = loop === 1 || cut === 1;
    if (!(E.isTrack(track) && buf != null && (buf.numFrames ?? 0) > 0)) return;
    // `sides` is the granular voice's buffer pair (see grainSidesFor), null for every other voice.
    const spawn = (latency, stopLatency, sides) => {
      let synth;
      const defName = sides != null
        ? `poptart_sample_grain_${buf.numChannels === 1 ? 1 : 2}`
        : `poptart_sample_${warp ? 'warp_' : ''}${loop === 1 ? 'loop_' : ''}${buf.numChannels}`;
      E.heldBy(track, 1);
      let args;
      if (sides != null) {
        const bus = track.grainBus.index;
        args = ['out', track.inBus.index, 'bufL', sides[0], 'bufR', sides[1], 'begin', begin,
          'rate', rate, 'gate', 1, 'amp', amp, 'atk', atk, 'dec', dec, 'sus', sus, 'rel', rel,
          'bend', track.bendBus.asMap(), 'posLive', posLive, 'win', E.grainWindowFor(windowJson),
          // Mapped, like bend, in the bus's own order.
          'grainpos', `c${bus}`, 'grainsize', `c${bus + 1}`, 'grainrate', `c${bus + 2}`, 'grainpan', `c${bus + 3}`,
          // ...and per sample, off its driver, a control an audio-rate driver is on (setChanAr).
          ...['grainpos', 'grainsize', 'grainrate', 'grainpan', 'bend'].flatMap((n) => [`${n}Ar`, track.chanAr?.get(n) ?? -1])];
      } else {
        args = ['out', track.inBus.index, 'buf', buf, 'begin', begin, 'end', end,
          'rate', rate, 'dur', dur, 'gate', 1, 'amp', amp,
          'atk', atk, 'dec', dec, 'sus', sus, 'rel', rel,
          // Pitch bend as a MAP: the voice follows the track's bend bus for as long as it sounds,
          // mapped in the creation message itself so it never sounds one block unbent.
          'bend', track.bendBus.asMap()];
      }
      // Only the loop defs have these controls.
      if (loop === 1 && sides == null) args.push('loopLo', loopLo, 'loopHi', loopHi, 'entry', entry, 'pingpong', pingpong);
      E.bundleNow(latency, () => {
        if (sides != null) {
          // The voice's first grain fires a block before the head next republishes these, so the
          // bus is seeded with this onset's values in the same bundle, and the head told too.
          track.grainBus.setn([posLive === 1 ? begin : 0, grainSize, grainRate, grainPan]);
          track.head.set('grainsize', grainSize, 'grainrate', grainRate, 'grainpan', grainPan);
          if (posLive === 1) track.head.set('grainpos', begin);
        }
        synth = Synth.new(S, defName, args, track.voices ?? track.group, 'addToHead');
        E.voiceBorn(synth); // ...and the oldest one goes if the engine is already full
        for (const e of track.envs.values()) e.synth?.set('gate', 1, 't_retrig', 1);
        for (const e of track.lfos.values()) {
          if (e.mode === 'retrigger' || e.mode === 'envelope') e.synth?.set('t_trig', 1);
        }
      });
      if (gated) E.bundleNow(stopLatency, () => synth.set('gate', 0));
      E.sched(gated ? stopLatency : latency + dur, () => {
        E.voiceDone(synth);
        E.heldBy(track, -1);
        if (track.held === 0) for (const e of track.envs.values()) e.synth?.set('gate', 0);
        return null;
      });
    };
    if (grain === 1) {
      let sides = E.grainSidesFor(buf);
      if (sides != null) spawn(latency0, stopLatency0, sides);
      else {
        // A stereo file's first granular event: its sides are being read. Wait out the lead it has,
        // and play nothing if that isn't enough - the plain voice is a different sound entirely.
        E.fork(async () => {
          let spent = 0;
          while (sides == null && spent < latency0 - 0.02) {
            await E.wait(0.01);
            sides = E.grainSidesFor(buf);
            spent = E.elapsed() - arrived;
          }
          if (sides != null) spawn(latency0 - spent, stopLatency0 - spent, sides);
        });
      }
    } else {
      spawn(latency0, stopLatency0, null);
    }
  });
}

module.exports = { install, envSignal, envAt };
