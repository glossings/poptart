'use strict';

// Per-track recording (see wav.js and web-app's track-record section) and the master recording
// (/poptart/record): poptart.scd's tap, recordTrack and record handlers, and the class library's
// Recorder that record() used.

const fs = require('node:fs');
const path = require('node:path');
const { Synth, Bus, Buffer } = require('../server/objects');
const { readAudioHeader } = require('../audio-header');

function install(E) {
  const S = E.S;

  // Tap a track's post-fader output: a private bus, a tap node on it and a meter synth streaming
  // peaks to Node for the record panel. Idempotent: only the first call does anything.
  E.startTap = (key) => {
    const track = E.tracks.get(key);
    let entry = E.recTaps.get(key);
    if (entry == null && E.isTrack(track)) {
      const bus = Bus.audio(S, 2);
      entry = { bus, meter: null, disk: null, buf: null, path: null, meterFunc: null };
      E.recTaps.set(key, entry);
      E.stripTap(track, 'rec', bus.index, 1, 0);
      entry.meter = Synth.new(S, 'poptart_rec_meter', ['bus', bus.index], E.recGroup, 'addToTail');
      // SendPeakRMS lays its values out as [nodeID, replyID, peakL, rmsL, peakR, rmsR]. Both peak
      // and rms go on: their ratio is the crest factor the editor colors a transient by.
      const node = entry.meter.nodeID;
      entry.meterFunc = S.on('/poptart/recLevel', (a) => {
        if (a[0] !== node) return;
        E.tell('/poptart/recLevel', key, Math.max(a[2], a[4]), Math.max(a[3], a[5]));
      });
    }
    return entry ?? null;
  };

  // Undo startTap. Frees an in-flight bounce too: its file is closed and simply never trimmed.
  E.stopTap = (key) => {
    const entry = E.recTaps.get(key);
    if (entry == null) return;
    const track = E.tracks.get(key);
    if (E.isTrack(track)) E.stripTap(track, 'rec', null);
    entry.meterFunc?.();
    entry.meter?.free();
    entry.disk?.free();
    // Close, then free, in order (see recordTrack). A cancelled capture's file is never read.
    if (entry.buf) { entry.buf.close(); entry.buf.free(); }
    entry.bus.free();
    E.recTaps.delete(key);
  };

  E.on('/poptart/tapTrack', (msg) => {
    const key = String(msg[1]);
    const on = Math.trunc(msg[2]);
    E.fork(async () => {
      if (on === 1) { if (!E.builtTrack(key)) await E.awaitTrack(key); E.startTap(key); } else E.stopTap(key);
    });
  });

  E.on('/poptart/recordTrack', (msg) => {
    const requestId = msg[1];
    const key = String(msg[2]);
    const file = String(msg[3]);
    const startLatency = Number(msg[4]);
    const stopLatency = Number(msg[5]);
    // `stage` is a breadcrumb: the watchdog below reports whichever step we stalled on.
    let stage = 'starting';
    let replied = false;
    const finish = (ok, detail) => {
      if (replied) return;
      replied = true;
      if (ok) E.replyOk('/poptart/recordTrack', requestId, detail);
      else E.replyErr('/poptart/recordTrack', requestId, detail);
    };
    // Fires only if the normal path never got there: the backstop, not the schedule.
    E.sched(stopLatency + 10, () => {
      if (!replied) {
        E.warn(`poptart: record ${key} never finished (stuck at: ${stage})`);
        finish(false, `the engine stalled while recording (last step: ${stage})`);
      }
      return null;
    });
    E.fork(async () => {
      const t0 = E.elapsed();
      try {
        if (!E.builtTrack(key)) await E.awaitTrack(key);
        stage = 'tapping the track';
        const entry = E.startTap(key);
        if (entry == null) {
          finish(false, `no track ${key}`);
          return;
        }
        stage = 'allocating the record buffer';
        const buf = Buffer.alloc(S, 65536, 2);
        await S.sync();
        stage = `opening ${file}`;
        buf.write(file, 'wav', 'int24', 0, 0, true); // leaveOpen: DiskOut streams into it
        await S.sync();
        entry.buf = buf;
        entry.path = file;
        // Node measured both latencies from when it SENT this; setup took round trips since.
        const setupSec = E.elapsed() - t0;
        stage = 'scheduling the window';
        E.bundleNow(Math.max(0, startLatency - setupSec), () => {
          entry.disk = Synth.new(S, 'poptart_rec_disk', ['bus', entry.bus.index, 'buf', buf.bufnum], E.recGroup, 'addToTail');
        });
        E.bundleNow(Math.max(0, stopLatency - setupSec), () => { entry.disk.free(); });
        stage = 'recording';
        await E.wait(Math.max(0.5, stopLatency - setupSec + 0.5));
        // Closing flushes DiskOut's last block and writes the real data size into the header, so
        // it comes after the synth is gone and before Node reads the file: close, sync, free.
        stage = 'closing the file';
        buf.close();
        await S.sync();
        buf.free();
        entry.buf = null;
        entry.disk = null;
        stage = `reading back ${file}`;
        const frames = readAudioHeader(file)?.frames ?? 0;
        if (frames === 0) E.warn(`poptart: record ${key} wrote an empty file - is the track's rec tap up?`);
        stage = 'done';
        finish(true, E.toJson({ path: file, frames }));
      } catch (err) {
        E.error(`record ${key} (${stage})`, err);
      }
    });
  });

  // Record the master bus to a WAV file for `seconds`: bounce/export, and how a test checks audio
  // comes out. What the class library's Recorder did for server.record (header WAV, int16).
  E.on('/poptart/record', (msg) => {
    const requestId = msg[1];
    const file = path.resolve(String(msg[2]).replace(/^~(?=$|\/)/, require('node:os').homedir()));
    const seconds = Number(msg[3]);
    E.recordMaster(file, seconds);
    E.fork(async () => {
      await E.wait(seconds + 0.5);
      E.replyOk('/poptart/record', requestId, E.toJson({ path: file }));
    });
  });

  // Recorder.record(path, duration:): a buffer the size of the next power of two above the sample
  // rate, its file left open, and a DiskOut on buses 0-1 at the very tail of the tree.
  E.recordMaster = (file, seconds) => E.fork(async () => {
    if (E.masterRec) { E.warn(`Recording already (${file})`); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sr = S.sampleRate ?? E.sampleRate;
    const frames = 2 ** Math.ceil(Math.log2(sr));
    const buf = Buffer.alloc(S, frames, 2);
    E.masterRec = { buf, node: null };
    E.post(`Preparing recording on 'poptart'`);
    await buf.ready;
    buf.write(file, 'wav', 'int16', 0, 0, true);
    await S.sync();
    const node = Synth.new(S, 'poptart_rec_disk', ['bus', 0, 'buf', buf.bufnum], 0, 'addToTail');
    E.masterRec.node = node;
    E.post(`Recording channels [ 0, 1 ] ... \npath: '${file}'`);
    E.bundleNow(seconds, () => node.free());
    await E.wait(seconds);
    // prStopRecord: the node is gone, close the file and free the buffer.
    await S.sync();
    buf.close();
    buf.free();
    E.masterRec = null;
    E.post(`Recording Stopped: (${path.basename(file)})`);
  });
}

module.exports = { install };
