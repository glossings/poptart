'use strict';

// Song decks: a full-length audio file on a DJ deck track, in one buffer, walked into the track's
// input bus by a poptart_song_* player. Node owns the musical bookkeeping (position, quantized
// starts, the end-of-file pause); these handlers hold the buffer and the player. Ported from
// poptart.scd (see core.js for the conventions).

const { Synth, Buffer } = require('../server/objects');
const { freeFunc } = require('./tracks');

function install(E) {
  const S = E.S;

  // A player's position reports carry only its node id: forward them to Node tagged with the
  // track - the drift servo's actual side. Returns the remover.
  E.songPosFunc = (key, nodeID) => S.on('/poptart/songPos', (a) => {
    if (a[0] === nodeID) E.tell('/poptart/songPos', key, Number(a[2]));
  });

  E.freePosFunc = (song) => {
    if (song.posFunc != null) freeFunc(song.posFunc);
  };

  // A quantized start spawns its player in a FUTURE-timestamped bundle, and until then the node
  // does not exist: a message aimed at it earlier fails while the spawn still lands, leaving an
  // orphan under the next player. So every message at a player is clamped to just after the spawn
  // time songStart recorded (0.02 covers the clock jitter between recording and comparing).
  E.songLat = (song, latency) => Math.max(latency ?? 0, (song.spawnUntil ?? 0) - E.elapsed() + 0.02);

  // Load (or replace) a track's song: [requestId, key, path]. Replies with the buffer's shape. A
  // load IS a stop: the old player is released first.
  E.on('/poptart/songLoad', (msg) => {
    const requestId = msg[1];
    const key = String(msg[2]);
    const path = String(msg[3]);
    E.fork(async () => {
      const old = E.songs.get(key);
      let buf = null;
      let done = false;
      let tries = 0;
      if (old) {
        const lat = E.songLat(old, 0);
        // Released (declicked) rather than hard-freed, at the clamped time - the old player may be
        // a pending quantized start. Its buffer outlives the release fade.
        if (old.synth) { const s = old.synth; E.bundleNow(lat, () => s.set('gate', 0)); }
        E.freePosFunc(old);
        E.songs.delete(key);
        if (old.buf) { const b = old.buf; E.fork(async () => { await E.wait(lat + 0.2); b.free(); }); }
      }
      try {
        buf = Buffer.read(S, path, 0, -1, () => { done = true; });
      } catch (err) {
        E.replyErr('/poptart/songLoad', requestId, `couldn't read ${path}: ${err.message}`);
        buf = null;
      }
      if (buf == null) return;
      // Same cap style as loadSamplePack: reply inside Node's timeout even on a failure.
      while (!done && tries < 1100) { await E.wait(0.05); tries += 1; }
      if (!done || (buf.numFrames ?? 0) <= 0) {
        buf.free();
        E.replyErr('/poptart/songLoad', requestId, `couldn't read ${path} (not an audio file scsynth can decode?)`);
      } else {
        E.songs.set(key, { buf, synth: null });
        E.post(`poptart: song loaded on ${key}: ${path}`);
        E.replyOk('/poptart/songLoad', requestId, E.toJson({
          frames: buf.numFrames ?? 0, sampleRate: buf.sampleRate ?? 0, channels: buf.numChannels ?? 0, bufnum: buf.bufnum,
        }));
      }
    });
  });

  // Start (or restart) playback: [key, posSec, rate, latency, warp]. The player spawns at the
  // track group's head in a timestamped bundle, so a quantized start lands sample-accurately; a
  // running player is replaced.
  E.on('/poptart/songStart', (msg) => {
    const key = String(msg[1]);
    const posSec = Number(msg[2]);
    const rate = Number(msg[3]);
    const latency = Math.max(Number(msg[4]), 0);
    const warp = Math.trunc(msg[5] ?? 0); // 1 = keylock player, 0 = repitch
    const track = E.tracks.get(key);
    const song = E.songs.get(key);
    if (!(E.isTrack(track) && song != null)) return;
    const buf = song.buf;
    const defName = `${warp > 0 ? 'poptart_songwarp_' : 'poptart_song_'}${buf.numChannels}`;
    const sr = S.sampleRate ?? E.sampleRate;
    // The keylock player has a pipeline delay (rbDelay): it spawns that much EARLY with its pointer
    // set back as far, so its first real sample lands at the start. When the start is closer than
    // that, it spawns now and the old player holds on for the difference.
    const rbLat = warp > 0 ? (E.rbDelay ?? 0) / sr : 0;
    const spawnAt = Math.max(0, latency - rbLat);
    const seekSec = posSec - ((latency - spawnAt) * rate);
    const handover = Math.max(latency, spawnAt + rbLat);
    const frame = Math.min(Math.max(seekSec * (buf.sampleRate ?? sr), 0), Math.max(0, (buf.numFrames ?? 1) - 1));
    // The old player releases AT THE HANDOVER (clamped past its own spawn), fading under the new one.
    if (song.synth) { const s = song.synth; E.bundleNow(E.songLat(song, handover), () => s.set('gate', 0)); }
    E.freePosFunc(song);
    song.spawnUntil = E.elapsed() + spawnAt;
    E.bundleNow(spawnAt, () => {
      song.synth = Synth.new(S, defName,
        ['out', track.inBus.index, 'buf', buf, 'rate', rate, 'run', 1,
          't_seek', 1, 'seekFrame', frame, 'delay', warp > 0 ? (E.rbDelay ?? 0) : 0],
        track.group, 'addToHead');
    });
    song.posFunc = E.songPosFunc(key, song.synth.nodeID);
  });

  // Set one control on the running player: [key, name, value, latency]. `run` 0/1 is pause and
  // resume; `rate` the tempo-sync and nudge handle.
  E.on('/poptart/songSet', (msg) => {
    const key = String(msg[1]);
    const name = String(msg[2]);
    const value = Number(msg[3]);
    const latency = Number(msg[4]);
    const song = E.songs.get(key);
    if (song?.synth) { const s = song.synth; E.bundleNow(E.songLat(song, latency), () => s.set(name, value)); }
  });

  // Seek the running player: [key, posSec, latency]. One set, so the frame and its trigger
  // cannot arrive apart.
  E.on('/poptart/songSeek', (msg) => {
    const key = String(msg[1]);
    const posSec = Number(msg[2]);
    const latency = Number(msg[3]);
    const song = E.songs.get(key);
    if (!song) return;
    const buf = song.buf;
    const sr = S.sampleRate ?? E.sampleRate;
    const frame = Math.min(Math.max(posSec * (buf.sampleRate ?? sr), 0), Math.max(0, (buf.numFrames ?? 1) - 1));
    if (song.synth) { const s = song.synth; E.bundleNow(E.songLat(song, latency), () => s.set('seekFrame', frame, 't_seek', 1)); }
  });

  // Stop playback (declicked by the player's gate); the buffer stays for the next start.
  E.on('/poptart/songStop', (msg) => {
    const key = String(msg[1]);
    const latency = Number(msg[2]);
    const song = E.songs.get(key);
    if (!song) return;
    if (song.synth) { const s = song.synth; E.bundleNow(E.songLat(song, latency), () => s.set('gate', 0)); }
    song.synth = null;
    E.freePosFunc(song);
    song.posFunc = null;
  });

  // Unload the song: player released, buffer freed. The track stays (destroyTrack's to take down).
  E.on('/poptart/songFree', (msg) => {
    const key = String(msg[1]);
    const song = E.songs.get(key);
    if (!song) return;
    const lat = E.songLat(song, 0);
    if (song.synth) { const s = song.synth; E.bundleNow(lat, () => s.set('gate', 0)); }
    E.freePosFunc(song);
    E.songs.delete(key);
    // The buffer waits out the clamped release fade: a player still fading must not read a dead one.
    if (song.buf) { const b = song.buf; E.fork(async () => { await E.wait(lat + 0.2); b.free(); }); }
  });
}

module.exports = { install };
