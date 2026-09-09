'use strict';

// The worker half of analysis.js - see that file for why any of this is off-thread. Runs the two
// audio analyses that read a whole file into memory: transient detection for `.slice()` and the
// recorder's trim pass. Both are plain functions living in samples.js / wav.js; this only picks
// one by name and posts the result back, so the analyses stay directly unit-testable on the main
// thread (and the tests never spawn a worker).

const { parentPort } = require('node:worker_threads');

const { detectSlices } = require('./samples');
const { trimRecording, songWaveform } = require('./wav');
const { detectSongFacts } = require('./song-detect');
const { readAudioHead, extractFeatures, deriveMap } = require('./sample-map');

const JOBS = {
  slices: ({ path, ...opts }) => detectSlices(path, opts),
  trim: ({ srcPath, destPath, ...opts }) => trimRecording(srcPath, destPath, opts),
  songwave: ({ path, ...opts }) => songWaveform(path, opts),
  songdetect: ({ path, ...opts }) => detectSongFacts(path, opts),
  // A batch of files per message: one file is ~10ms of work, so per-file messaging would be
  // mostly overhead, while a whole library in one message would block the slice jobs behind it.
  mapfeatures: ({ paths }) => paths.map((p) => {
    const head = readAudioHead(p);
    if (!head) return null;
    return { features: extractFeatures(head.samples, head.sampleRate, head.totalSeconds), seconds: head.totalSeconds };
  }),
  // The map from the vectors: ~2s of CPU at library scale, which on the main thread would be
  // 2s of silence (see analysis.js's header).
  mapderive: ({ vectors, paths, ...opts }) => deriveMap(vectors, paths, opts),
};

parentPort.on('message', ({ id, kind, args }) => {
  try {
    const run = JOBS[kind];
    if (!run) throw new Error(`unknown analysis job "${kind}"`);
    parentPort.postMessage({ id, result: run(args) });
  } catch (err) {
    // Error objects don't survive the structured clone with their message intact in every Node
    // version - send the string and let the parent rebuild it.
    parentPort.postMessage({ id, error: err?.message ?? String(err) });
  }
});
