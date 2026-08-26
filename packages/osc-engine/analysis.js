'use strict';

// Audio analysis, off the event loop.
//
// This process also runs the note scheduler against a 150ms lookahead (see index.js's gzip note
// for the same problem in the plugin-state path), so anything synchronous here is silence: a
// block longer than the lookahead is time the scheduler spends not sending notes, and the music
// stops until it returns. The two analyses that read a whole audio file into memory are well
// past that budget - transient detection over a 775-file break pack measured ~2.8s in one tick,
// and the recorder's trim pass scales with the length of the bounce - so both run on a worker
// thread instead. Callers get a promise and simply don't play that sound until it resolves.
//
// One worker, spawned on first use and shared by every job, because the alternative is ~30ms of
// startup per file. It is unref'd while idle so it never holds the process open, and re-ref'd
// while jobs are in flight so an exit can't strand one. If it dies, pending jobs reject and the
// next call spawns a fresh one.

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_FILE = path.join(__dirname, 'analysis-worker.js');

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }

function failAll(err) {
  const jobs = [...pending.values()];
  pending.clear();
  worker = null;
  for (const job of jobs) job.reject(err);
}

// The worker is only worth keeping alive while something is waiting on it. Node counts a ref'd
// worker as a reason to keep running, which would stop `node index.js`-style callers exiting.
function updateRef() {
  if (!worker) return;
  if (pending.size > 0) worker.ref();
  else worker.unref();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_FILE);
  worker.on('message', ({ id, result, error }) => {
    const job = pending.get(id);
    if (!job) return; // already settled by a worker death
    pending.delete(id);
    updateRef();
    if (error) job.reject(new Error(error));
    else job.resolve(result);
  });
  worker.on('error', (err) => failAll(err));
  worker.on('exit', (code) => {
    if (pending.size) failAll(new Error(`analysis worker exited (code ${code}) with work outstanding`));
    else worker = null;
  });
  return worker;
}

function run(kind, args) {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    const id = nextId++;
    pending.set(id, { resolve, reject });
    updateRef();
    w.postMessage({ id, kind, args });
  });
}

/**
 * Normalized (0..1) slice-start positions for an audio file, or null if it can't be analyzed
 * (non-WAV - see samples.js's detectSlices, which this runs off-thread).
 * @returns {Promise<number[] | null>}
 */
function analyzeSlices(filePath) {
  return run('slices', { path: filePath });
}

/**
 * wav.js's trimRecording, off-thread. Same arguments and same return.
 * @returns {Promise<object | null>}
 */
function trimRecording(srcPath, destPath, opts) {
  return run('trim', { srcPath, destPath, ...opts });
}

/**
 * wav.js's songWaveform (the song deck's waveform pane), off-thread. Same arguments and same
 * return. `wavPath` must already be a WAV - see songs.js's resolveSongFile({ wav: true }).
 * @returns {Promise<object | null>}
 */
function songWaveform(wavPath, opts = {}) {
  return run('songwave', { path: wavPath, ...opts });
}

/**
 * song-detect.js's detectSongFacts (bpm, beatgrid, key, onsets), off-thread. Same arguments
 * and same return. `wavPath` must already be a WAV.
 * @returns {Promise<{ bpm: number|null, bpmConfidence: number|null, anchorSec: number|null, gridConfidence: number|null, key: string|null, keyConfidence: number|null, onsets: number[] } | null>}
 */
function songDetect(wavPath, opts = {}) {
  return run('songdetect', { path: wavPath, ...opts });
}

/**
 * Drop the worker. Anything still in flight rejects. Nothing in normal operation calls this - the
 * worker is a process-wide singleton that unrefs itself while idle, so it neither needs tearing
 * down at engine shutdown nor holds the process open; this exists so a test suite can end cleanly.
 */
async function shutdownAnalysis() {
  if (!worker) return;
  const w = worker;
  failAll(new Error('analysis worker shut down'));
  await w.terminate();
}

module.exports = { analyzeSlices, trimRecording, songWaveform, songDetect, shutdownAnalysis };
