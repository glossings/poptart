// The sample map's heavy half, off the page's thread: a file's features are ~10 ms of FFTs and the
// layout of a library is a couple of seconds, and on the thread that schedules the notes either
// one is heard. Decoding stays on the page - only it has decodeAudioData - so what arrives here is
// each file's first seconds as mono, and what goes back is numbers.

import * as core from '/osc-engine/sample-map-core.mjs';

const JOBS = {
  features: ({ heads }) => heads.map((h) => (h
    ? { features: core.extractFeatures(h.samples, h.sampleRate, h.totalSeconds), seconds: h.totalSeconds }
    : null)),
  derive: ({ vectors, paths, opts }) => core.deriveMap(vectors, paths, opts),
};

self.onmessage = ({ data: { id, kind, args } }) => {
  try {
    const run = JOBS[kind];
    if (!run) throw new Error(`unknown sample map job "${kind}"`);
    self.postMessage({ id, result: run(args) });
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
