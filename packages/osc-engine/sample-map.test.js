'use strict';

// The sample map's stages on synthetic material with a known answer: a kick, a hat and a long
// noise bed that the features must tell apart, vector groups the neighbors/clusters must
// recover, and the name vocabulary's edge cases (camel-case, "open", the cymbal family).

const { test } = require('node:test');
const assert = require('node:assert');

const sm = require('./sample-map');
const { encodeWav, decodeWavRaw } = require('./wav');

const SR = 44100;

/** A decaying sine - a kick-ish one-shot. */
function tone(freq, seconds, decay = 8, lead = 0) {
  const n = Math.round((seconds + lead) * SR);
  const out = new Float32Array(n);
  const start = Math.round(lead * SR);
  for (let i = start; i < n; i++) {
    const t = (i - start) / SR;
    out[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-decay * t);
  }
  return out;
}

/** A decaying noise burst - a hat-ish one-shot. Seeded so runs are repeatable. */
function burst(seconds, decay = 40, seed = 5) {
  const rng = sm.mulberry32(seed);
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * Math.exp((-decay * i) / SR);
  return out;
}

const scalar = (feat, name) => feat[sm.MEL_BANDS * sm.SEGMENTS_SEC.length + sm.SCALAR_NAMES.indexOf(name)];

test('mixdownHead: a truncated read still knows the whole file length', () => {
  const full = encodeWav({ sampleRate: SR, channels: 2, data: new Float32Array(SR * 10 * 2).fill(0.1) });
  const head = sm.mixdownHead(decodeWavRaw(full.subarray(0, 44 + SR * 2 * 3)), 1);
  assert.strictEqual(head.samples.length, SR);
  assert.ok(Math.abs(head.totalSeconds - 10) < 1e-6, `10s declared, got ${head.totalSeconds}`);
  assert.ok(Math.abs(head.samples[0] - 0.1) < 1e-3, 'stereo mixed down to mono');
});

test('extractFeatures: a kick and a hat differ where a producer would expect', () => {
  const kick = sm.extractFeatures(tone(55, 1), SR);
  const hat = sm.extractFeatures(burst(0.15), SR);
  assert.strictEqual(kick.length, sm.FEATURE_LENGTH);
  assert.ok(scalar(kick, 'low') > 0.8, `kick is mostly sub (low share ${scalar(kick, 'low')})`);
  assert.ok(scalar(hat, 'low') < 0.1, `hat has no sub (low share ${scalar(hat, 'low')})`);
  assert.ok(scalar(hat, 'centroid') > scalar(kick, 'centroid') + 3, 'hat is octaves brighter');
  assert.ok(scalar(hat, 'flatness') > scalar(kick, 'flatness') + 0.2, 'noise is flatter than a sine');
  assert.ok(scalar(hat, 'logSounding') < scalar(kick, 'logSounding'), 'the hat is over sooner');
  assert.ok(scalar(kick, 'pitched') > 0.8 && scalar(hat, 'pitched') < 0.5, 'only the kick is periodic');
});

test('extractFeatures: a clap re-attacks, a snare and a hat do not', () => {
  // Clap: four noise hits 8ms apart, each ~80% of the first, then a tail.
  const clap = new Float32Array(Math.round(0.3 * SR));
  for (let hit = 0; hit < 4; hit++) {
    const b = burst(0.25, 60, 20 + hit);
    const at = Math.round(hit * 0.008 * SR);
    for (let i = 0; i + at < clap.length && i < b.length; i++) clap[at + i] += b[i] * (hit ? 0.8 : 1);
  }
  const snare = burst(0.25, 25);
  const tone_ = tone(180, 0.25, 20);
  for (let i = 0; i < snare.length; i++) snare[i] = snare[i] * 0.7 + tone_[i] * 0.5;
  const hat = burst(0.25, 15);
  const flam = (sig) => scalar(sm.extractFeatures(sig, SR), 'flam');
  assert.ok(flam(clap) > 0.5, `clap should re-attack (got ${flam(clap)})`);
  assert.ok(flam(snare) < 0.3, `snare should not (got ${flam(snare)})`);
  assert.ok(flam(hat) < 0.3, `a noise burst's roughness must not count (got ${flam(hat)})`);
});

test('extractFeatures: leading silence and gain do not move a sample', () => {
  const a = sm.extractFeatures(tone(80, 0.5), SR, 0.5);
  const padded = tone(80, 0.5, 8, 0.3);
  for (let i = 0; i < padded.length; i++) padded[i] *= 0.2;
  const b = sm.extractFeatures(padded, SR, 0.5);
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  // Near-floor mel bands can move a tenth or so: the padded signal gets the 2ms onset back-off,
  // the unpadded one has nothing before sample 0 to back into. Anything larger is a real drift.
  assert.ok(maxDiff < 0.2, `features moved by ${maxDiff}`);
});

test('extractFeatures: silence gets a vector, not a crash', () => {
  const f = sm.extractFeatures(new Float32Array(SR), SR, 1);
  assert.strictEqual(f.length, sm.FEATURE_LENGTH);
  assert.ok(f.every(Number.isFinite));
  assert.ok(Math.abs(scalar(f, 'logDuration') - 0) < 1e-6, 'duration is still recorded');
});

/** Three tight groups of vectors around distinct centers. */
function groupedVectors(perGroup = 20, dims = 8) {
  const rng = sm.mulberry32(11);
  const vectors = [];
  const truth = [];
  for (let g = 0; g < 3; g++) {
    for (let i = 0; i < perGroup; i++) {
      const v = new Float32Array(dims);
      for (let d = 0; d < dims; d++) v[d] = (d % 3 === g ? 5 : 0) + (rng() - 0.5);
      vectors.push(v);
      truth.push(g);
    }
  }
  return { vectors, truth };
}

test('prepareVectors + knn: neighbors come from the same group', () => {
  const { vectors, truth } = groupedVectors();
  const prep = sm.prepareVectors(vectors, { dims: 4, blocks: [{ start: 0, length: 8, weight: 1 }] });
  assert.strictEqual(prep.points.length, vectors.length);
  assert.strictEqual(prep.points[0].length, 4);
  const nn = sm.knn(prep.points, 5);
  for (let i = 0; i < nn.length; i++) {
    for (const j of nn[i].index) assert.strictEqual(truth[j], truth[i], `neighbor of ${i} crossed groups`);
    assert.ok(nn[i].dist[0] <= nn[i].dist[4], 'sorted nearest first');
  }
  // A new raw vector projects to where its group lives.
  const p = sm.projectRaw(vectors[0], prep);
  assert.ok(p.every((v, k) => Math.abs(v - prep.points[0][k]) < 1e-5));
});

test('knnGraph + cluster: three groups become three communities', () => {
  const { vectors, truth } = groupedVectors(30);
  const prep = sm.prepareVectors(vectors, { dims: 4, blocks: [{ start: 0, length: 8, weight: 1 }] });
  const graph = sm.knnGraph(sm.knn(prep.points, 8));
  assert.ok(graph.weight.every((w) => w > 0 && w <= 1 + 1e-6), 'fuzzy weights in (0, 1]');
  // Modularity finds sub-structure inside a uniform blob, so at the default resolution the
  // groups subdivide; what must hold is that no community ever straddles two groups.
  for (const resolution of [1, 0.1]) {
    const clusters = sm.cluster(graph, vectors.length, { resolution });
    const groupOf = new Map();
    for (let i = 0; i < clusters.length; i++) {
      const prev = groupOf.get(clusters[i]);
      if (prev === undefined) groupOf.set(clusters[i], truth[i]);
      else assert.strictEqual(prev, truth[i], `community ${clusters[i]} straddles groups at resolution ${resolution}`);
    }
    if (resolution === 0.1) assert.strictEqual(groupOf.size, 3, `coarse resolution should recover the 3 groups, got ${groupOf.size}`);
  }
});

test('layout: deterministic, finite, and keeps groups together', () => {
  const { vectors, truth } = groupedVectors(30);
  const prep = sm.prepareVectors(vectors, { dims: 4, blocks: [{ start: 0, length: 8, weight: 1 }] });
  const graph = sm.knnGraph(sm.knn(prep.points, 8));
  const a = sm.layout(graph, prep.points, { epochs: 100 });
  const b = sm.layout(graph, prep.points, { epochs: 100 });
  assert.deepStrictEqual(Array.from(a), Array.from(b), 'same seed, same layout');
  assert.ok(Array.from(a).every(Number.isFinite));
  // Every point's nearest on the plane is a group-mate.
  for (let i = 0; i < vectors.length; i++) {
    let best = -1; let bestD = Infinity;
    for (let j = 0; j < vectors.length; j++) {
      if (j === i) continue;
      const d = (a[i * 2] - a[j * 2]) ** 2 + (a[i * 2 + 1] - a[j * 2 + 1]) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    assert.strictEqual(truth[best], truth[i], `plane neighbor of ${i} is from another group`);
  }
});

test('nameTokens: splits separators, case changes and digit edges', () => {
  assert.deepStrictEqual(sm.nameTokens('TR-707Hat_C'), ['tr', '707', 'hat', 'c']);
  assert.deepStrictEqual(sm.nameTokens('closedHat01'), ['closed', 'hat', '01']);
  assert.deepStrictEqual(sm.nameTokens('bd2'), ['bd', '2']);
});

test('nameVotes: the vocabulary and its context rules', () => {
  assert.strictEqual(sm.topVote(sm.nameVotes('/lib/classic/TR-707Hat_C.wav')), 'hat');
  assert.strictEqual(sm.topVote(sm.nameVotes('/lib/x/VEC3 Cymbals HH Open 002.wav')), 'openhat');
  assert.strictEqual(sm.topVote(sm.nameVotes('/lib/x/VEC3 Cymbals Crash 01.wav')), 'crash');
  assert.strictEqual(sm.topVote(sm.nameVotes('/lib/x/VEC3 Cymbals 01.wav')), 'crash', 'family name alone falls back to crash');
  assert.strictEqual(sm.topVote(sm.nameVotes('/lib/x/Open Road.wav')), null, '"open" without a hat says nothing');
  const folderOnly = sm.nameVotes('/lib/bd2/001.wav');
  assert.strictEqual(sm.topVote(folderOnly), 'kick');
  assert.ok(folderOnly.kick < 1, 'a folder vote is weaker than a name vote');
  assert.deepStrictEqual(sm.nameVotes('/lib/rave/Belgium Anthem.wav'), {});
});

test('labelPoints: a neighborhood vote, own name weighted, null with nothing to go on', () => {
  // 0 and 1 are named; 2 is unnamed among claps; 3 is a lone kick whose neighbors are claps.
  const neighbors = [
    { index: Int32Array.from([1, 2]) },
    { index: Int32Array.from([0, 2]) },
    { index: Int32Array.from([0, 1]) },
    { index: Int32Array.from([0, 1]) },
    { index: Int32Array.from([5]) },
    { index: Int32Array.from([4]) },
  ];
  const votes = [{ clap: 1 }, { clap: 1 }, {}, { kick: 1 }, {}, {}];
  assert.deepStrictEqual(sm.labelPoints(neighbors, votes), ['clap', 'clap', 'clap', 'kick', null, null]);
  // With no weight on its own name, the lone kick goes with its neighborhood.
  assert.strictEqual(sm.labelPoints(neighbors, votes, { ownWeight: 0 })[3], 'clap');
});

test('labelClusters: majority with a minimum share, unlabeled otherwise', () => {
  const clusters = Int32Array.from([0, 0, 0, 1, 1, 2]);
  const votes = [{ kick: 1 }, { kick: 1 }, { snare: 1 }, { hat: 0.5 }, {}, { kick: 1, snare: 1, clap: 1, hat: 1 }];
  const labels = sm.labelClusters(clusters, votes, { minShare: 0.5 });
  assert.deepStrictEqual(labels, ['kick', 'hat', null]);
});

test('farthestFrom: max-min distance to the kit, most isolated when the kit is empty', () => {
  const points = [[0, 0], [1, 0], [10, 0], [0, 2], [5, 5]].map((p) => Float32Array.from(p));
  assert.strictEqual(sm.farthestFrom(points, []), 2, 'farthest from the center');
  assert.strictEqual(sm.farthestFrom(points, [2]), 3, 'farthest from the lone kit member');
  assert.strictEqual(sm.farthestFrom(points, [0, 2]), 4, 'farthest from BOTH');
  assert.strictEqual(sm.farthestFrom(points, [0, 2], { candidates: [1, 3] }), 3, 'restricted to candidates');
  assert.strictEqual(sm.farthestFrom(points, [0, 2], { exclude: new Set([4]) }), 3, 'exclusions honored');
});
