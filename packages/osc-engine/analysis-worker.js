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

const JOBS = {
  slices: ({ path }) => detectSlices(path),
  trim: ({ srcPath, destPath, ...opts }) => trimRecording(srcPath, destPath, opts),
  songwave: ({ path, ...opts }) => songWaveform(path, opts),
  songdetect: ({ path }) => detectSongFacts(path),
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
