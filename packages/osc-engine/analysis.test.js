'use strict';

// The two analyses that read a whole audio file - transient detection for .slice() and the
// recorder's trim pass - run on a worker thread, because this process also runs the note
// scheduler against a 150ms lookahead and anything longer than that on the main thread is a gap
// in the music. Slice detection is lazy on top of that: it must not happen at all for a file
// nobody sliced. These tests pin the lazy per-file trigger in playSample, that the worker agrees
// with the in-process functions, and that the work leaves the event loop running.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OscEngine } = require('./index.js');
const analysis = require('./analysis.js');
const { analyzeSlices, shutdownAnalysis } = analysis;
const { detectSlices } = require('./samples.js');
const { encodeWav, trimRecording, songWaveform } = require('./wav.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-slices-'));
after(async () => {
  await shutdownAnalysis();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const SR = 48000;

/** A mono WAV of `seconds` with a short noise burst every `hitEvery` seconds - i.e. clear onsets. */
function writeClickTrack(name, seconds, hitEvery = 0.5) {
  const frames = Math.round(seconds * SR);
  const data = new Float32Array(frames);
  for (let hit = 0; hit * hitEvery < seconds; hit++) {
    const at = Math.round(hit * hitEvery * SR);
    // Decaying noise burst: loud onset, ~50ms of tail, which is what the flux detector looks for.
    for (let i = 0; i < 0.05 * SR && at + i < frames; i++) {
      data[at + i] = (Math.random() * 2 - 1) * (1 - i / (0.05 * SR));
    }
  }
  const file = path.join(TMP, name);
  fs.writeFileSync(file, encodeWav({ sampleRate: SR, channels: 1, data }));
  return file;
}

function engineWithFile(filePath, duration) {
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  engine.getTime = () => 0;
  engine._packs.set('breaks', {
    status: 'ready',
    files: [{ path: filePath, duration, channels: 1 }],
  });
  const sent = [];
  engine._send = (addr, args) => sent.push({ addr, args });
  return { engine, sent, file: engine._packs.get('breaks').files[0] };
}

test('a pack arrives unanalyzed - loading one costs no transient detection at all', () => {
  const file = writeClickTrack('pack.wav', 2);
  const { file: entry } = engineWithFile(file, 2);
  assert.strictEqual(entry.slices, undefined, 'nothing analyzed the file just because the pack loaded');
});

test('the first .slice() on a file skips the event and starts the analysis; later ones play', async () => {
  const file = writeClickTrack('lazy.wav', 2);
  const { engine, sent, file: entry } = engineWithFile(file, 2);

  const first = engine.playSample('t1', 'breaks', { slice: 1, secPerCycle: 2 }, 0, 2);
  assert.match(first.skipped, /analyzing slices/, 'the sound waits rather than guessing a window');
  assert.strictEqual(sent.length, 0, 'nothing reached the engine');

  // A second event while the analysis is still in flight must not queue another one.
  const job = entry.slicesJob;
  engine.playSample('t1', 'breaks', { slice: 2, secPerCycle: 2 }, 0, 2);
  assert.strictEqual(entry.slicesJob, job, 'one analysis per file, however many events ask');

  await job;
  assert.ok(entry.slices.length > 1, `the click track produced slices (got ${entry.slices?.length})`);

  const info = engine.playSample('t1', 'breaks', { slice: 1, secPerCycle: 2 }, 0, 2);
  assert.strictEqual(info.skipped, undefined, 'now it plays');
  assert.strictEqual(info.begin, entry.slices[1], 'and on the analyzed slice point');
});

test('a file with no analysis to have plays whole, rather than waiting forever', async () => {
  // Not a WAV: readWavRaw gives up, detectSlices reports null, and that is a final answer.
  const file = path.join(TMP, 'notaudio.aiff');
  fs.writeFileSync(file, 'FORM....this is not a wav');
  const { engine, file: entry } = engineWithFile(file, 2);

  assert.match(engine.playSample('t1', 'breaks', { slice: 1, secPerCycle: 2 }, 0, 2).skipped, /analyzing slices/);
  await entry.slicesJob;
  assert.strictEqual(entry.slices, null, 'analyzed, and there are none');

  const info = engine.playSample('t1', 'breaks', { slice: 1, secPerCycle: 2 }, 0, 2);
  assert.strictEqual(info.skipped, undefined, 'the sample still plays');
  assert.strictEqual(info.begin, 0, 'just not sliced');
  assert.strictEqual(info.end, 1);
});

test('the worker returns exactly what the in-process detector would', async () => {
  const file = writeClickTrack('parity.wav', 3, 0.25);
  assert.deepStrictEqual(await analyzeSlices(file), detectSlices(file));
});

test('the recorder trim pass agrees with the in-process one, audio and all', async () => {
  const src = writeClickTrack('capture.wav', 4, 0.25);
  const opts = { startSec: 0.5, lengthSec: 2, wrapTail: true };
  const viaWorker = path.join(TMP, 'trim-worker.wav');
  const viaMain = path.join(TMP, 'trim-main.wav');

  const info = await analysis.trimRecording(src, viaWorker, opts);
  assert.deepStrictEqual(info, trimRecording(src, viaMain, opts), 'same report (peaks, bands, length)');
  // The report is derived from the samples, but only the file proves the right audio was written.
  assert.deepStrictEqual(fs.readFileSync(viaWorker), fs.readFileSync(viaMain), 'byte-identical output');
});

test('the song waveform pass agrees with the in-process one', async () => {
  const src = writeClickTrack('song.wav', 4, 0.25);
  const opts = { detailPerSec: 50, overviewBuckets: 24 };
  assert.deepStrictEqual(await analysis.songWaveform(src, opts), songWaveform(src, opts));
});

test('an unreadable capture rejects rather than resolving to a bad bounce', async () => {
  const file = path.join(TMP, 'empty.wav');
  fs.writeFileSync(file, '');
  // readWavRaw gives up on this, so trimRecording reports null - the caller turns that into the
  // "couldn't read the capture" error rather than writing a broken recording.
  assert.strictEqual(await analysis.trimRecording(file, path.join(TMP, 'nope.wav'), { startSec: 0, lengthSec: 1 }), null);
});

test('a pack\'s worth of analysis leaves the event loop running', async () => {
  // No single file is slow (even a three-minute one measures tens of milliseconds); what cost
  // seconds was doing it once per file across a whole break folder, all inside one tick. So a
  // pack's worth at once is the case worth pinning.
  const files = [];
  for (let i = 0; i < 60; i++) files.push(writeClickTrack(`pack-${i}.wav`, 2, 0.25));

  // Deliberately an ordering assertion rather than a stopwatch one: how long the analysis takes
  // varies per machine, but a timer scheduled alongside it must ALWAYS come back first, because
  // the work is on another thread. Run synchronously the timer could not even be registered until
  // every file was done, so this ordering is precisely what tells the two implementations apart.
  // The probe ticks faster than the real scheduler's 30ms so that it stays a decisive test even
  // on a machine that chews through this synthetic pack inside one real tick.
  const order = [];
  let ticks = 0;
  const ticking = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (++ticks === 1) order.push('tick');
      if (ticks >= 3) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });

  const analyzing = Promise.all(files.map(analyzeSlices)).then((all) => {
    order.push('analysis');
    return all;
  });

  const [all] = await Promise.all([analyzing, ticking]);
  assert.ok(all.every((s) => s.length > 1), 'it really did the work, for every file');
  assert.strictEqual(order[0], 'tick', `the scheduler tick ran before the analysis finished (order: ${order})`);
});
