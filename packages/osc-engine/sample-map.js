'use strict';

// The sample map: every sample in the user's chosen folders as a point on a plane, near the
// ones that sound like it, in groups that (mostly) turn out to be kicks, snares, hats and so on.
// The map is a SOURCING tool - it helps build a pack out of dissimilar sounds and swap one hit
// for a near neighbor - and never a pattern-time lookup: the index changes whenever a folder
// is added, so nothing a pattern plays may depend on it. Everything the map does ends as a
// file path written into a `_pack()` definition.
//
// Pipeline, all plain functions so each stage is unit-testable on synthetic signals:
//
//   readAudioHead     the first few seconds of a file as mono, plus its true length
//   extractFeatures   one fixed-length vector per sample (see FEATURE LAYOUT)
//   prepareVectors    standardize, weight the feature blocks, project with PCA
//   knn               each sample's nearest neighbors in the projected space
//   layout            a 2D embedding of the kNN graph (attraction along edges, sampled repulsion)
//   cluster           communities of the same graph, so the groups agree with the blobs
//   labelPoints       a type per sample by vote over its neighbors' file/folder names
//   labelClusters     a type per cluster the same way, for naming a group
//
// The 2D picture is only for looking at: "next neighbor" and "farthest from the kit" are
// answered in the projected feature space, where distances mean something. A plane can't keep
// every neighbor adjacent and the layout is allowed to lie locally so that it tells the truth
// globally.

const fs = require('node:fs');
const path = require('node:path');

const { decodeWavRaw } = require('./wav');
const { fft } = require('./song-detect');

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** How much of a file the features look at. A one-shot is over well before this; for a loop
 *  or a break it is the first bar or two, which is as much as a listener needs to place it. */
const HEAD_SECONDS = 4;

// Enough bytes for HEAD_SECONDS of the widest format worth planning for (96k stereo float) plus
// headers. Reading only the head is what keeps indexing a 16GB library a matter of seconds of
// disk rather than minutes: most of that size is in a few hundred long files.
const HEAD_BYTES = 4 * 1024 * 1024;

/**
 * The first HEAD_SECONDS of a WAV as a mono mixdown. Returns { sampleRate, samples, totalSeconds }
 * or null for anything wav.js can't decode. `totalSeconds` comes from the header, so it is the
 * whole file's length even though only the head was read.
 */
function readAudioHead(filePath, { seconds = HEAD_SECONDS } = {}) {
  let buf;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      buf = Buffer.allocUnsafe(Math.min(size, HEAD_BYTES));
      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, got);
        if (!n) break;
        got += n;
      }
      buf = buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const raw = decodeWavRaw(buf);
  if (!raw) return null;
  return mixdownHead(raw, seconds);
}

/** The mono head of a decoded WAV. Split from readAudioHead so tests can feed buffers. */
function mixdownHead(raw, seconds = HEAD_SECONDS) {
  const { sampleRate, channels, frames, totalFrames, data } = raw;
  const n = Math.min(frames, Math.round(seconds * sampleRate));
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data[i * channels + c];
    samples[i] = sum / channels;
  }
  return { sampleRate, samples, totalSeconds: totalFrames / sampleRate };
}

// ---------------------------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------------------------

// STFT resolution: ~23ms frames at 44.1k. Percussion is placed by its envelope and its broad
// spectral tilt, neither of which needs finer bins, and every doubling here doubles the cost of
// indexing the library.
const FFT_SIZE = 1024;
const HOP = 512;

// Mel filterbank. 30Hz catches a sub kick's fundamental; the top stops short of the 22k edge so a
// 44.1k file and a 96k file see the same bands.
const MEL_BANDS = 32;
const MEL_LO_HZ = 30;
const MEL_HI_HZ = 16000;

// Time segments for the spectro-temporal shape block, in seconds from the sample's onset. The
// boundaries follow what distinguishes drum types: a click and a body (0-50ms), the decay a
// snare has and a clap doesn't (50-200ms), a tail (200-800ms), and "still going" (the rest).
const SEGMENTS_SEC = [0, 0.05, 0.2, 0.8, HEAD_SECONDS];

// The onset is the first sample within this much of the peak: a file with leading silence and
// one without it should get the same features.
const ONSET_RATIO = 0.01; // -40dB
// Where the envelope is deemed to have ended, relative to its peak.
const TAIL_DB = -40;

const LOG_FLOOR = 1e-8;
const PROFILE_FLOOR = 1e-6; // -60dB below the loudest mel cell

/*
 * FEATURE LAYOUT - three blocks, each carrying one kind of information, weighted as blocks in
 * prepareVectors so that a block's dimensionality doesn't decide its influence:
 *
 *   profile  [MEL_BANDS]        the energy-weighted mean log-mel spectrum, max band at 0: what
 *                               it sounds like, ignoring how loud or how long.
 *   shape    [MEL_BANDS x 4]    the share of the sample's energy in each (band, segment) cell,
 *                               sqrt-compressed: where the energy goes over time. Sums to 1, so
 *                               a short bright hat and a long dark tom are far apart here even
 *                               if their profiles overlap.
 *   scalars  [SCALAR_NAMES]     the handful of numbers a producer would describe the sound by.
 */
const SCALAR_NAMES = [
  'logDuration', // whole-file length, from the header
  'logSounding', // how long the head keeps sounding (to TAIL_DB), capped at HEAD_SECONDS
  'logAttack', // onset to envelope peak
  'decay', // dB/s over the half-second after the peak (negative = decaying)
  'centroid', // log2 Hz, energy-weighted
  'flatness', // spectral flatness in the active frames: noise-like vs tonal
  'zcr', // zero-crossing rate of the first 200ms
  'crest', // peak / rms of the first 200ms
  'low', // share of energy under 200Hz
  'high', // share of energy over 4kHz
  'pitched', // autocorrelation peak strength (40Hz..1kHz lag) just after the onset
  'flam', // re-attacks in the first 60ms: a clap is several hits a few ms apart, a snare is one
];
const FEATURE_LENGTH = MEL_BANDS + MEL_BANDS * (SEGMENTS_SEC.length - 1) + SCALAR_NAMES.length;

// Bump whenever extractFeatures changes meaning, so a cached index re-analyzes rather than
// mixing vectors from two definitions of the same dimension.
const FEATURE_VERSION = 3;

const BLOCKS = [
  { name: 'profile', start: 0, length: MEL_BANDS, weight: 1 },
  { name: 'shape', start: MEL_BANDS, length: MEL_BANDS * (SEGMENTS_SEC.length - 1), weight: 1 },
  { name: 'scalars', start: MEL_BANDS * SEGMENTS_SEC.length, length: SCALAR_NAMES.length, weight: 1.5 },
];

const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

const filterbankCache = new Map();

/** Triangular mel filters over FFT_SIZE/2+1 bins, as [{ lo, hi, weights }] - one per band. */
function melFilterbank(sampleRate) {
  const cached = filterbankCache.get(sampleRate);
  if (cached) return cached;
  const bins = FFT_SIZE / 2 + 1;
  const hzPerBin = sampleRate / FFT_SIZE;
  const top = Math.min(MEL_HI_HZ, sampleRate / 2);
  const melLo = hzToMel(MEL_LO_HZ);
  const melHi = hzToMel(top);
  const edges = [];
  for (let i = 0; i <= MEL_BANDS + 1; i++) edges.push(melToHz(melLo + ((melHi - melLo) * i) / (MEL_BANDS + 1)) / hzPerBin);
  const bank = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const [l, c, r] = [edges[b], edges[b + 1], edges[b + 2]];
    const lo = Math.max(0, Math.floor(l));
    const hi = Math.min(bins - 1, Math.ceil(r));
    const weights = new Float32Array(hi - lo + 1);
    let sum = 0;
    for (let k = lo; k <= hi; k++) {
      const w = k < c ? (k - l) / (c - l) : (r - k) / (r - c);
      if (w > 0) { weights[k - lo] = w; sum += w; }
    }
    // A band too narrow for any bin (low bands at high sample rates) takes its nearest bin, so
    // no band is ever silent by construction.
    if (sum === 0) { weights[Math.round(c) - lo] = 1; sum = 1; }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    bank.push({ lo, hi, weights });
  }
  filterbankCache.set(sampleRate, bank);
  return bank;
}

const hannCache = new Map();
function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
  }
  return w;
}

/** Index of the first sample within ONSET_RATIO of the peak, backed off by a couple of ms. */
function findOnset(samples, sampleRate) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return { onset: 0, peak: 0 };
  const thresh = peak * ONSET_RATIO;
  let onset = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= thresh) { onset = i; break; }
  }
  return { onset: Math.max(0, onset - Math.round(0.002 * sampleRate)), peak };
}

/**
 * The feature vector of one sample. `totalSeconds` is the whole file's length (the head may be
 * shorter). Silence gets a vector too - all zeros but for the duration - rather than null, so a
 * blank file still has a place on the map instead of a hole in the index.
 * @returns {Float32Array} of FEATURE_LENGTH
 */
function extractFeatures(samplesIn, sampleRate, totalSeconds = samplesIn.length / sampleRate) {
  const out = new Float32Array(FEATURE_LENGTH);
  const scalarAt = (name, v) => { out[MEL_BANDS * SEGMENTS_SEC.length + SCALAR_NAMES.indexOf(name)] = v; };
  scalarAt('logDuration', Math.log(Math.max(0.005, totalSeconds)));

  const { onset, peak } = findOnset(samplesIn, sampleRate);
  if (peak === 0) return out;

  // From the onset on, peak-normalized: gain is not a similarity.
  const samples = new Float32Array(samplesIn.length - onset);
  for (let i = 0; i < samples.length; i++) samples[i] = samplesIn[onset + i] / peak;

  // --- STFT -> mel energies per frame ---
  const bank = melFilterbank(sampleRate);
  const win = hann(FFT_SIZE);
  const nFrames = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const mel = new Float32Array(nFrames * MEL_BANDS); // linear energy
  const frameEnergy = new Float32Array(nFrames);
  const frameCentroid = new Float32Array(nFrames);
  const frameFlatness = new Float32Array(nFrames);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const bins = FFT_SIZE / 2 + 1;
  const power = new Float32Array(bins);
  const hzPerBin = sampleRate / FFT_SIZE;
  const lowBin = Math.round(200 / hzPerBin);
  const highBin = Math.round(4000 / hzPerBin);
  let lowEnergy = 0;
  let highEnergy = 0;
  let totalEnergy = 0;

  for (let f = 0; f < nFrames; f++) {
    const at = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = at + i < samples.length ? samples[at + i] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let e = 0;
    let cent = 0;
    let logSum = 0;
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power[k] = p;
      e += p;
      cent += p * k;
      logSum += Math.log(p + LOG_FLOOR);
      if (k < lowBin) lowEnergy += p;
      else if (k >= highBin) highEnergy += p;
    }
    totalEnergy += e;
    frameEnergy[f] = e;
    frameCentroid[f] = e > 0 ? (cent / e) * hzPerBin : 0;
    // Geometric / arithmetic mean of the power spectrum: 1 for white noise, ~0 for a sine.
    frameFlatness[f] = e > 0 ? Math.exp(logSum / bins) / (e / bins) : 0;
    for (let b = 0; b < MEL_BANDS; b++) {
      const { lo, weights } = bank[b];
      let s = 0;
      for (let i = 0; i < weights.length; i++) s += power[lo + i] * weights[i];
      mel[f * MEL_BANDS + b] = s;
    }
  }
  if (totalEnergy === 0) return out;

  // --- profile: energy-weighted mean log-mel, shifted so the loudest band sits at 0 ---
  // Log relative to the loudest cell with a -60dB floor: a band with nothing in it reads as
  // the floor rather than as whatever window leakage happens to be there.
  let melMax = 0;
  for (let i = 0; i < mel.length; i++) if (mel[i] > melMax) melMax = mel[i];
  let profMax = -Infinity;
  for (let b = 0; b < MEL_BANDS; b++) {
    let acc = 0;
    for (let f = 0; f < nFrames; f++) acc += frameEnergy[f] * Math.log(mel[f * MEL_BANDS + b] / melMax + PROFILE_FLOOR);
    out[b] = acc / totalEnergy;
    if (out[b] > profMax) profMax = out[b];
  }
  for (let b = 0; b < MEL_BANDS; b++) out[b] -= profMax;

  // --- shape: sqrt of the energy share per (band, segment) ---
  const segFrames = SEGMENTS_SEC.map((s) => Math.round((s * sampleRate) / HOP));
  for (let s = 0; s < SEGMENTS_SEC.length - 1; s++) {
    const from = Math.min(nFrames, segFrames[s]);
    const to = Math.min(nFrames, Math.max(from, segFrames[s + 1]));
    for (let b = 0; b < MEL_BANDS; b++) {
      let acc = 0;
      for (let f = from; f < to; f++) acc += mel[f * MEL_BANDS + b];
      out[MEL_BANDS + s * MEL_BANDS + b] = Math.sqrt(acc / totalEnergy);
    }
  }

  // --- scalars ---
  let peakFrame = 0;
  for (let f = 1; f < nFrames; f++) if (frameEnergy[f] > frameEnergy[peakFrame]) peakFrame = f;
  const peakDb = 10 * Math.log10(frameEnergy[peakFrame] + LOG_FLOOR);
  let endFrame = nFrames;
  for (let f = peakFrame; f < nFrames; f++) {
    if (10 * Math.log10(frameEnergy[f] + LOG_FLOOR) - peakDb < TAIL_DB) { endFrame = f; break; }
  }
  const frameSec = HOP / sampleRate;
  scalarAt('logSounding', Math.log(Math.max(frameSec, endFrame * frameSec)));
  scalarAt('logAttack', Math.log(Math.max(0.001, peakFrame * frameSec + FFT_SIZE / sampleRate / 2)));

  // Decay: least-squares slope of the dB envelope over the half-second after the peak.
  {
    const span = Math.min(nFrames - peakFrame, Math.round(0.5 / frameSec));
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let n = 0;
    for (let i = 0; i < span; i++) {
      const y = Math.max(TAIL_DB, 10 * Math.log10(frameEnergy[peakFrame + i] + LOG_FLOOR) - peakDb);
      const x = i * frameSec;
      sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
    }
    const slope = n > 1 && n * sxx - sx * sx > 0 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
    scalarAt('decay', Math.max(-400, Math.min(0, slope)) / 100);
  }

  {
    let cent = 0; let flat = 0; let flatW = 0;
    for (let f = 0; f < nFrames; f++) {
      cent += frameEnergy[f] * frameCentroid[f];
      // Flatness only over frames that carry real energy, or the tail's near-silence (which is
      // flat) would call everything noise.
      if (frameEnergy[f] > frameEnergy[peakFrame] * 0.001) { flat += frameFlatness[f] * frameEnergy[f]; flatW += frameEnergy[f]; }
    }
    scalarAt('centroid', Math.log2(Math.max(20, cent / totalEnergy)));
    scalarAt('flatness', flatW ? flat / flatW : 0);
  }

  {
    const n = Math.min(samples.length, Math.round(0.2 * sampleRate));
    let crossings = 0; let sumSq = 0; let pk = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[i];
      if (i && (v >= 0) !== (samples[i - 1] >= 0)) crossings++;
      sumSq += v * v;
      if (Math.abs(v) > pk) pk = Math.abs(v);
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    scalarAt('zcr', n ? crossings / n : 0);
    scalarAt('crest', rms > 0 ? Math.min(40, pk / rms) / 10 : 0);
  }

  scalarAt('low', lowEnergy / totalEnergy);
  scalarAt('high', highEnergy / totalEnergy);
  scalarAt('pitched', pitchStrength(samples, sampleRate));
  scalarAt('flam', reattack(samples, sampleRate));
  return out;
}

const FLAM_WINDOW_SEC = 0.06;
const FLAM_HOP_SEC = 0.0005;
const FLAM_RMS_SEC = 0.002;

const FLAM_PROMINENCE = 0.25; // of the peak - what a re-peak must climb from its dip to count

/**
 * How much the envelope climbs again after its first peak, within the first 60ms: the summed
 * prominence (rise from the dip before it) of every later peak of the fine envelope (2ms RMS,
 * 0.5ms hop) that climbs at least a quarter of the main peak, relative to that peak. One hit
 * decays and scores 0; a clap's three or four hits a few ms apart each climb back to most of the
 * peak and score 1..2 (clipped at 2). The prominence gate is what keeps a noise burst's own
 * roughness - a few percent a hop - from counting. This is what tells a clap from a snare whose
 * spectrum it otherwise shares.
 *
 * The envelope is taken over the signal's first difference - a one-line high-pass - because a
 * 2ms window rides the waveform of anything below a few hundred Hz: a kick's 50Hz fundamental
 * would read as a re-attack every 20ms, a snare's 200Hz body every 5ms. Re-attacks are
 * broadband; the pitch is not.
 */
function reattack(samples, sampleRate) {
  const n = Math.min(samples.length, Math.round(FLAM_WINDOW_SEC * sampleRate));
  const hop = Math.max(1, Math.round(FLAM_HOP_SEC * sampleRate));
  const win = Math.max(hop, Math.round(FLAM_RMS_SEC * sampleRate));
  const env = [];
  for (let at = 1; at + win <= n; at += hop) {
    let s = 0;
    for (let i = at; i < at + win; i++) { const d = samples[i] - samples[i - 1]; s += d * d; }
    env.push(Math.sqrt(s / win));
  }
  if (env.length < 3) return 0;
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
  if (peak === 0) return 0;
  // Count from the FIRST substantial peak, not the loudest: in a clap the loudest hit is often
  // the last one, and everything before it is exactly what should be counted.
  let first = 0;
  while (first < env.length - 1 && !(env[first] >= 0.5 * peak && env[first] >= env[first + 1])) first++;
  let score = 0;
  let dip = env[first]; // lowest point since the last counted peak
  for (let i = first + 1; i < env.length - 1; i++) {
    if (env[i] < dip) dip = env[i];
    const isPeak = env[i] > env[i - 1] && env[i] >= env[i + 1];
    if (isPeak && env[i] - dip >= FLAM_PROMINENCE * peak) {
      score += (env[i] - dip) / peak;
      dip = env[i];
    }
  }
  return Math.min(2, score);
}

/**
 * How periodic the first 100ms after the onset is: the normalized autocorrelation peak over lags
 * of 1ms..25ms (40Hz..1kHz). A tom, a stab or an 808 score high; a clap or a hat near zero.
 */
function pitchStrength(samples, sampleRate) {
  const n = Math.min(samples.length, Math.round(0.1 * sampleRate));
  const minLag = Math.round(sampleRate / 1000);
  const maxLag = Math.min(n >> 1, Math.round(sampleRate / 40));
  if (maxLag <= minLag) return 0;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += samples[i] * samples[i];
  if (e0 === 0) return 0;
  let best = 0;
  // Coarse lag stride keeps this cheap; a peak's neighborhood scores nearly as high as the peak.
  const stride = Math.max(1, Math.round(sampleRate / 44100));
  for (let lag = minLag; lag < maxLag; lag += stride) {
    let acc = 0;
    let e1 = 0;
    for (let i = 0; i + lag < n; i++) { acc += samples[i] * samples[i + lag]; e1 += samples[i + lag] * samples[i + lag]; }
    const r = acc / Math.sqrt(e0 * e1 + LOG_FLOOR);
    if (r > best) best = r;
  }
  return Math.max(0, best);
}

// ---------------------------------------------------------------------------------------------
// Vector preparation: standardize -> block weights -> PCA
// ---------------------------------------------------------------------------------------------

const PCA_DIMS = 24;

/**
 * Turn raw feature vectors into the space neighbors and the layout are computed in. Each
 * dimension is standardized over the library, each block scaled so its total weight is fixed
 * (a 128-dim block would otherwise outvote an 11-dim one by dimensionality alone), then PCA
 * keeps the top `dims` directions - which both denoises and makes kNN cheap.
 *
 * @param {Float32Array[]} vectors - raw features, all FEATURE_LENGTH long
 * @returns {{ points: Float32Array[], mean: Float32Array, scale: Float32Array, basis: Float32Array[] }}
 *   `points` are the projected vectors; the rest is what projects a NEW sample into the same
 *   space without recomputing everything (so an added file can be placed incrementally).
 */
function prepareVectors(vectors, { dims = PCA_DIMS, blocks = BLOCKS } = {}) {
  const n = vectors.length;
  const d = vectors[0]?.length ?? FEATURE_LENGTH;
  const mean = new Float32Array(d);
  const scale = new Float32Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i];
  for (let i = 0; i < d; i++) mean[i] /= Math.max(1, n);
  for (const v of vectors) for (let i = 0; i < d; i++) scale[i] += (v[i] - mean[i]) ** 2;
  for (let i = 0; i < d; i++) scale[i] = Math.sqrt(scale[i] / Math.max(1, n - 1)) || 1;
  for (const b of blocks) {
    const w = Math.sqrt(b.weight / b.length);
    for (let i = b.start; i < b.start + b.length && i < d; i++) scale[i] /= w;
  }
  const normed = vectors.map((v) => {
    const o = new Float32Array(d);
    for (let i = 0; i < d; i++) o[i] = (v[i] - mean[i]) / scale[i];
    return o;
  });
  const basis = pcaBasis(normed, Math.min(dims, d, Math.max(1, n - 1)));
  const points = normed.map((v) => project(v, basis));
  return { points, mean, scale, basis };
}

/** Project an already-standardized vector onto a basis. */
function project(v, basis) {
  const o = new Float32Array(basis.length);
  for (let k = 0; k < basis.length; k++) {
    const b = basis[k];
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * b[i];
    o[k] = s;
  }
  return o;
}

/** Standardize + project one new raw vector with a prepareVectors result. */
function projectRaw(raw, { mean, scale, basis }) {
  const v = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) v[i] = (raw[i] - mean[i]) / scale[i];
  return project(v, basis);
}

/**
 * Top principal directions of centered data by power iteration with deflation on the covariance
 * matrix. The data is a few hundred dims wide at most, so the covariance is small and this is
 * both simpler and faster than anything that touches the n x n side.
 */
function pcaBasis(vectors, dims) {
  const n = vectors.length;
  const d = vectors[0].length;
  const cov = new Float64Array(d * d);
  for (const v of vectors) {
    for (let i = 0; i < d; i++) {
      const vi = v[i];
      if (vi === 0) continue;
      const row = i * d;
      for (let j = i; j < d; j++) cov[row + j] += vi * v[j];
    }
  }
  for (let i = 0; i < d; i++) for (let j = i; j < d; j++) { cov[i * d + j] /= Math.max(1, n - 1); cov[j * d + i] = cov[i * d + j]; }

  const rng = mulberry32(7);
  const basis = [];
  const tmp = new Float64Array(d);
  for (let k = 0; k < dims; k++) {
    let vec = new Float64Array(d);
    for (let i = 0; i < d; i++) vec[i] = rng() - 0.5;
    let lambda = 0;
    for (let it = 0; it < 200; it++) {
      for (let i = 0; i < d; i++) {
        let s = 0;
        const row = i * d;
        for (let j = 0; j < d; j++) s += cov[row + j] * vec[j];
        tmp[i] = s;
      }
      let norm = 0;
      for (let i = 0; i < d; i++) norm += tmp[i] * tmp[i];
      norm = Math.sqrt(norm) || 1;
      let delta = 0;
      for (let i = 0; i < d; i++) { const nv = tmp[i] / norm; delta += Math.abs(nv - vec[i]); vec[i] = nv; }
      lambda = norm;
      if (delta < 1e-7) break;
    }
    basis.push(Float32Array.from(vec));
    // Deflate: remove this direction's variance so the next iteration finds the next one.
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) cov[i * d + j] -= lambda * vec[i] * vec[j];
  }
  return basis;
}

// ---------------------------------------------------------------------------------------------
// Nearest neighbors
// ---------------------------------------------------------------------------------------------

const KNN_K = 15;

/**
 * Brute-force k nearest neighbors by Euclidean distance. O(n^2 d), which at library scale
 * (thousands of samples, a couple of dozen dims) is a second or two - not worth a tree.
 * @returns {{ index: Int32Array, dist: Float32Array }[]} per point, nearest first, self excluded
 */
function knn(points, k = KNN_K) {
  const n = points.length;
  const kk = Math.min(k, Math.max(0, n - 1));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const idx = new Int32Array(kk).fill(-1);
    const dst = new Float32Array(kk).fill(Infinity);
    const a = points[i];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const b = points[j];
      let s = 0;
      for (let t = 0; t < a.length; t++) { const df = a[t] - b[t]; s += df * df; }
      if (s >= dst[kk - 1]) continue;
      // Insertion into the sorted top-k.
      let p = kk - 1;
      while (p > 0 && dst[p - 1] > s) { dst[p] = dst[p - 1]; idx[p] = idx[p - 1]; p--; }
      dst[p] = s;
      idx[p] = j;
    }
    for (let t = 0; t < kk; t++) dst[t] = Math.sqrt(dst[t]);
    out[i] = { index: idx, dist: dst };
  }
  return out;
}

/**
 * The kNN graph as a symmetric weighted edge list, with the neighborhoods made fuzzy the way
 * the manifold-learning literature does: each point's distances are scaled so its own
 * neighborhood's total membership is log2(k), which makes a point in a dense cluster and a
 * point out on its own comparable. Both the layout and the clustering run on this graph, which
 * is why the colors land on the blobs.
 * @returns {{ from: Int32Array, to: Int32Array, weight: Float32Array }}
 */
function knnGraph(neighbors) {
  const n = neighbors.length;
  const k = neighbors[0]?.index.length ?? 0;
  const target = Math.log2(Math.max(2, k));
  const memberships = new Map(); // "i,j" -> weight (directed)
  for (let i = 0; i < n; i++) {
    const { index, dist } = neighbors[i];
    const rho = dist[0] ?? 0;
    // Binary search for the sigma that puts the neighborhood's total membership at `target`.
    let lo = 0; let hi = Infinity; let sigma = 1;
    for (let it = 0; it < 64; it++) {
      let sum = 0;
      for (let t = 0; t < k; t++) sum += Math.exp(-Math.max(0, dist[t] - rho) / sigma);
      if (Math.abs(sum - target) < 1e-4) break;
      if (sum > target) { hi = sigma; sigma = (lo + hi) / 2; } else { lo = sigma; sigma = hi === Infinity ? sigma * 2 : (lo + hi) / 2; }
    }
    for (let t = 0; t < k; t++) {
      const j = index[t];
      if (j < 0) continue;
      memberships.set(i * n + j, Math.exp(-Math.max(0, dist[t] - rho) / sigma));
    }
  }
  const from = []; const to = []; const weight = [];
  for (const [key, a] of memberships) {
    const i = Math.floor(key / n);
    const j = key % n;
    if (j < i && memberships.has(j * n + i)) continue; // the pair was emitted from the other side
    const b = memberships.get(j * n + i) ?? 0;
    from.push(i); to.push(j); weight.push(a + b - a * b);
  }
  return { from: Int32Array.from(from), to: Int32Array.from(to), weight: Float32Array.from(weight) };
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/**
 * A 2D embedding of the kNN graph: stochastic gradient descent pulling each edge's endpoints
 * together in proportion to its weight and pushing randomly sampled non-neighbors apart (the
 * negative-sampling family of layouts). Linear in edges rather than quadratic in points, so a
 * library-sized map is seconds, not minutes. Initialized from the first two principal
 * components so the global arrangement is meaningful and the result is deterministic.
 *
 * @param {ReturnType<typeof knnGraph>} graph
 * @param {Float32Array[]} points - the PCA-space points, for the initial positions
 * @returns {Float32Array} xy pairs, roughly centered and scaled to ~[-10, 10]
 */
function layout(graph, points, { epochs = 300, negatives = 5, minDist = 0.1, seed = 1 } = {}) {
  const n = points.length;
  const pos = new Float32Array(n * 2);
  {
    // Spread the PCA init to ~10 units, matching the scale the attraction/repulsion curve
    // below is tuned for.
    // Each axis to its own unit variance: the first component carries far more variance than
    // the second, and scaling them together would start the map as a strip.
    let sx = 0; let sy = 0; let sxx = 0; let syy = 0;
    for (const p of points) { sx += p[0]; sy += p[1] ?? 0; sxx += p[0] ** 2; syy += (p[1] ?? 0) ** 2; }
    const mx = sx / n; const my = sy / n;
    const sdx = Math.sqrt(Math.max(0, sxx / n - mx * mx)) || 1;
    const sdy = Math.sqrt(Math.max(0, syy / n - my * my)) || 1;
    const rng = mulberry32(seed);
    for (let i = 0; i < n; i++) {
      pos[i * 2] = ((points[i][0] - mx) / sdx) * 3 + (rng() - 0.5) * 0.1;
      pos[i * 2 + 1] = (((points[i][1] ?? 0) - my) / sdy) * 3 + (rng() - 0.5) * 0.1;
    }
  }
  // The attraction/repulsion curve 1 / (1 + a d^2b), fitted for a min_dist of 0.1 at spread 1.
  const a = minDist <= 0.1 ? 1.577 : 1.0;
  const b = minDist <= 0.1 ? 0.895 : 1.0;
  const m = graph.from.length;
  if (!m) return pos;
  let wMax = 0;
  for (let e = 0; e < m; e++) if (graph.weight[e] > wMax) wMax = graph.weight[e];
  // Each edge is sampled every (wMax / w) epochs: strong edges pull every epoch, weak ones rarely.
  const every = new Float32Array(m);
  const next = new Float32Array(m);
  for (let e = 0; e < m; e++) { every[e] = wMax / graph.weight[e]; next[e] = every[e]; }
  const rng = mulberry32(seed + 1);
  const clip = (g) => Math.max(-4, Math.min(4, g));
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const alpha = 1 - (epoch - 1) / epochs;
    for (let e = 0; e < m; e++) {
      if (next[e] > epoch) continue;
      next[e] += every[e];
      const i = graph.from[e]; const j = graph.to[e];
      const ix = i * 2; const jx = j * 2;
      let dx = pos[ix] - pos[jx]; let dy = pos[ix + 1] - pos[jx + 1];
      let d2 = dx * dx + dy * dy;
      if (d2 > 0) {
        const g = (-2 * a * b * d2 ** (b - 1)) / (1 + a * d2 ** b);
        const gx = clip(g * dx) * alpha; const gy = clip(g * dy) * alpha;
        pos[ix] += gx; pos[ix + 1] += gy;
        pos[jx] -= gx; pos[jx + 1] -= gy;
      }
      for (let s = 0; s < negatives; s++) {
        const k = Math.floor(rng() * n);
        if (k === i) continue;
        const kx = k * 2;
        dx = pos[ix] - pos[kx]; dy = pos[ix + 1] - pos[kx + 1];
        d2 = dx * dx + dy * dy;
        if (d2 <= 0) continue;
        const g = (2 * b) / ((0.001 + d2) * (1 + a * d2 ** b));
        pos[ix] += clip(g * dx) * alpha;
        pos[ix + 1] += clip(g * dy) * alpha;
      }
    }
  }
  // Centre.
  let cx = 0; let cy = 0;
  for (let i = 0; i < n; i++) { cx += pos[i * 2]; cy += pos[i * 2 + 1]; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) { pos[i * 2] -= cx; pos[i * 2 + 1] -= cy; }
  return pos;
}

// ---------------------------------------------------------------------------------------------
// Clustering - modularity communities of the kNN graph
// ---------------------------------------------------------------------------------------------

/**
 * Louvain community detection on the weighted kNN graph. Emergent grouping with no count to
 * pick: the algorithm keeps merging while it raises modularity and stops on its own.
 * `resolution` above 1 asks for smaller communities, below 1 for larger.
 * @returns {Int32Array} community id per node, ids dense from 0, largest community first
 */
function cluster(graph, n, { resolution = 1, seed = 3 } = {}) {
  // Adjacency as arrays of [neighbor, weight] per node, at the current aggregation level.
  let nodes = n;
  let adj = buildAdjacency(graph.from, graph.to, graph.weight, n);
  let membership = Int32Array.from({ length: n }, (_, i) => i); // original node -> community
  const rng = mulberry32(seed);

  for (let level = 0; level < 20; level++) {
    const { community, moved } = localMoving(adj, nodes, resolution, rng);
    // Dense ids.
    const remap = new Map();
    const dense = new Int32Array(nodes);
    for (let i = 0; i < nodes; i++) {
      let id = remap.get(community[i]);
      if (id === undefined) { id = remap.size; remap.set(community[i], id); }
      dense[i] = id;
    }
    for (let i = 0; i < n; i++) membership[i] = dense[membership[i]];
    if (!moved || remap.size === nodes) break;
    // Aggregate: communities become nodes, edge weights sum.
    const agg = new Map();
    for (let i = 0; i < nodes; i++) {
      for (const [j, w] of adj[i]) {
        const ci = dense[i]; const cj = dense[j];
        const key = ci * remap.size + cj;
        agg.set(key, (agg.get(key) ?? 0) + w);
      }
    }
    nodes = remap.size;
    adj = Array.from({ length: nodes }, () => []);
    for (const [key, w] of agg) adj[Math.floor(key / nodes)].push([key % nodes, w]);
  }
  // Order ids by size, largest first, so "cluster 0" is always the big one.
  const counts = new Map();
  for (const c of membership) counts.set(c, (counts.get(c) ?? 0) + 1);
  const order = [...counts.keys()].sort((x, y) => counts.get(y) - counts.get(x));
  const rank = new Map(order.map((c, i) => [c, i]));
  return Int32Array.from(membership, (c) => rank.get(c));
}

function buildAdjacency(from, to, weight, n) {
  const adj = Array.from({ length: n }, () => []);
  for (let e = 0; e < from.length; e++) {
    adj[from[e]].push([to[e], weight[e]]);
    adj[to[e]].push([from[e], weight[e]]);
  }
  return adj;
}

/** One Louvain level: move nodes between communities while modularity rises. */
function localMoving(adj, n, resolution, rng) {
  const degree = new Float64Array(n);
  let total = 0; // 2m
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adj[i]) { degree[i] += w; total += w; if (j === i) degree[i] += w; }
  }
  const community = Int32Array.from({ length: n }, (_, i) => i);
  const commDegree = Float64Array.from(degree);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let moved = false;
  const links = new Map(); // community -> weight of links from the node being moved
  for (let pass = 0; pass < 50; pass++) {
    let movedThisPass = false;
    for (const i of order) {
      links.clear();
      for (const [j, w] of adj[i]) {
        if (j === i) continue;
        links.set(community[j], (links.get(community[j]) ?? 0) + w);
      }
      const own = community[i];
      commDegree[own] -= degree[i];
      let best = own;
      let bestGain = (links.get(own) ?? 0) - (resolution * commDegree[own] * degree[i]) / total;
      for (const [c, w] of links) {
        const gain = w - (resolution * commDegree[c] * degree[i]) / total;
        if (gain > bestGain + 1e-12) { bestGain = gain; best = c; }
      }
      commDegree[best] += degree[i];
      if (best !== own) { community[i] = best; movedThisPass = true; moved = true; }
    }
    if (!movedThisPass) break;
  }
  return { community, moved };
}

// ---------------------------------------------------------------------------------------------
// Labels from names
// ---------------------------------------------------------------------------------------------

/**
 * What a file or folder name can say about a sample's type. The vocabulary is deliberately the
 * common abbreviations of well-organized libraries; anything it misses gets its type from the
 * cluster it lands in, which is the point of voting per cluster rather than per file.
 */
const TYPE_TOKENS = {
  kick: ['kick', 'kik', 'kck', 'bd', 'bassdrum', 'bassdrums', 'kicks'],
  snare: ['snare', 'snr', 'sn', 'sd', 'snares'],
  clap: ['clap', 'clp', 'cp', 'claps'],
  hat: ['hat', 'hats', 'hh', 'hihat', 'hihats', 'chh', 'ch', 'phh', 'closedhat'],
  openhat: ['oh', 'ohh', 'openhat', 'openhats'],
  ride: ['ride', 'rd', 'rides'],
  crash: ['crash', 'crashes'],
  tom: ['tom', 'toms'],
  rim: ['rim', 'rimshot', 'rs', 'rims'],
  perc: ['perc', 'percussion', 'conga', 'congas', 'bongo', 'bongos', 'shaker', 'shk', 'tamb', 'tambourine',
    'cowbell', 'cow', 'clave', 'claves', 'cabasa', 'agogo', 'block', 'woodblock', 'triangle', 'guiro', 'maracas', 'timbale'],
  stab: ['stab', 'stabs', 'chord', 'chords', 'hit', 'hits'],
  bass: ['bass', 'sub', '808bass'],
  vox: ['vox', 'vocal', 'vocals', 'voice', 'acapella', 'acap', 'acapellas'],
  fx: ['fx', 'sfx', 'riser', 'risers', 'sweep', 'impact', 'impacts', 'noise', 'noises', 'ir', 'reverb'],
  loop: ['break', 'breaks', 'loop', 'loops', 'drumloop', 'beat', 'beats', 'tops', 'top', 'groove'],
  pad: ['pad', 'pads', 'drone', 'drones', 'texture'],
  synth: ['synth', 'lead', 'leads', 'keys', 'pluck', 'plucks', 'arp', 'blip'],
};

// Words that only mean something next to another: "open" beside a hat word makes the hat an open
// hat (and outvotes the hat word itself); "cymbal" is a family name that votes crash only when
// no member of the family - hat, open hat, ride, crash - is named alongside it.
const OPEN_TOKENS = new Set(['open', 'opened']);
const CYMBAL_TOKENS = new Set(['cym', 'cymbal', 'cymbals']);
const CYMBAL_FAMILY = new Set(['hat', 'openhat', 'ride', 'crash']);

const tokenToType = new Map();
for (const [type, tokens] of Object.entries(TYPE_TOKENS)) for (const t of tokens) tokenToType.set(t, type);

/** Lower-case word tokens of a name, splitting on separators, case changes and letter/digit edges. */
function nameTokens(name) {
  return String(name ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Type votes for a file from its own name (weight 1) and its enclosing folders (weight 0.5 for
 * the nearest, less further up), as { type: weight }. Empty when nothing in the path is in the
 * vocabulary.
 */
function nameVotes(filePath) {
  const votes = {};
  const add = (tokens, weight) => {
    const types = new Set(tokens.map((t) => tokenToType.get(t)).filter(Boolean));
    const open = types.has('hat') && tokens.some((t) => OPEN_TOKENS.has(t));
    const familyNamed = [...types].some((t) => CYMBAL_FAMILY.has(t));
    for (const t of tokens) {
      let type = tokenToType.get(t);
      if (!type && CYMBAL_TOKENS.has(t) && !familyNamed) type = 'crash';
      if (!type) continue;
      if (type === 'hat' && open) type = 'openhat';
      votes[type] = (votes[type] ?? 0) + weight;
    }
  };
  const base = path.basename(filePath, path.extname(filePath));
  add(nameTokens(base), 1);
  const parts = path.dirname(filePath).split(path.sep).filter(Boolean).reverse();
  parts.slice(0, 3).forEach((dir, depth) => add(nameTokens(dir), 0.5 / (depth + 1)));
  return votes;
}

/** The strongest type in a votes object, or null. */
function topVote(votes) {
  let best = null;
  let bestW = 0;
  for (const [type, w] of Object.entries(votes)) if (w > bestW) { best = type; bestW = w; }
  return best;
}

/**
 * A type per SAMPLE: the weighted vote of its neighbors' names, nearest counting most, plus its
 * own name at `ownWeight` when it has one. This is the label the map colors by. Voting over the
 * neighborhood rather than the cluster matters exactly where types border each other - claps
 * beside snares, toms beside kicks - because a community boundary falls somewhere through the
 * border and then every member inherits one side of it; a neighborhood vote follows the border
 * sample by sample. An unnamed file in a named neighborhood gets the neighborhood's type; a
 * neighborhood with no names at all gives null.
 * @param {ReturnType<typeof knn>} neighbors
 * @param {object[]} votesPerFile - nameVotes() per sample
 * @returns {(string | null)[]} label per sample
 */
function labelPoints(neighbors, votesPerFile, { ownWeight = 3, rankFalloff = 0.2 } = {}) {
  return neighbors.map(({ index }, i) => {
    const acc = {};
    for (const [type, w] of Object.entries(votesPerFile[i] ?? {})) acc[type] = (acc[type] ?? 0) + w * ownWeight;
    index.forEach((j, rank) => {
      if (j < 0) return;
      const w = 1 / (1 + rank * rankFalloff);
      for (const [type, v] of Object.entries(votesPerFile[j] ?? {})) acc[type] = (acc[type] ?? 0) + v * w;
    });
    return topVote(acc);
  });
}

/**
 * A type per cluster by summing its members' name votes - the name a GROUP goes by in the UI
 * (labelPoints is what colors the individual samples). A cluster is labeled when the winning
 * type has at least `minShare` of the votes cast; otherwise it stays unlabeled (a real group
 * with no name to give it) and the UI shows it as its cluster number.
 * @returns {(string | null)[]} label per cluster id
 */
function labelClusters(clusters, votesPerFile, { minShare = 0.3 } = {}) {
  const sums = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    sums[c] ??= {};
    for (const [type, w] of Object.entries(votesPerFile[i] ?? {})) sums[c][type] = (sums[c][type] ?? 0) + w;
  }
  return sums.map((votes) => {
    if (!votes) return null;
    const total = Object.values(votes).reduce((a, b) => a + b, 0);
    const best = topVote(votes);
    return best && votes[best] / total >= minShare ? best : null;
  });
}

// ---------------------------------------------------------------------------------------------
// Kit-building queries, in the projected space
// ---------------------------------------------------------------------------------------------

/**
 * The sample farthest from a set of already-chosen ones: the candidate whose distance to its
 * NEAREST chosen sample is largest (farthest-point sampling). Given an empty kit it returns the
 * most isolated sample. `candidates` restricts the search (a filtered map), `exclude` drops
 * indices (already in the kit) from consideration.
 */
function farthestFrom(points, chosen, { candidates = null, exclude = new Set() } = {}) {
  const pool = candidates ?? points.map((_, i) => i);
  let best = -1;
  let bestD = -Infinity;
  for (const i of pool) {
    if (exclude.has(i) || chosen.includes(i)) continue;
    let nearest = Infinity;
    for (const c of chosen) {
      const d = distance(points[i], points[c]);
      if (d < nearest) nearest = d;
    }
    if (!chosen.length) {
      // Empty kit: pick the sample farthest from the center of the map, which is the first
      // "most different from everything" the kit can be seeded with.
      nearest = distance(points[i], centroid(points));
    }
    if (nearest > bestD) { bestD = nearest; best = i; }
  }
  return best;
}

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function centroid(points) {
  const d = points[0]?.length ?? 0;
  const c = new Float32Array(d);
  for (const p of points) for (let i = 0; i < d; i++) c[i] += p[i];
  for (let i = 0; i < d; i++) c[i] /= Math.max(1, points.length);
  return c;
}

// ---------------------------------------------------------------------------------------------

/** Small seeded PRNG so layouts and clusterings are reproducible run to run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  HEAD_SECONDS,
  FEATURE_LENGTH,
  FEATURE_VERSION,
  SCALAR_NAMES,
  MEL_BANDS,
  SEGMENTS_SEC,
  BLOCKS,
  readAudioHead,
  mixdownHead,
  extractFeatures,
  prepareVectors,
  projectRaw,
  knn,
  knnGraph,
  layout,
  cluster,
  nameTokens,
  nameVotes,
  topVote,
  labelPoints,
  labelClusters,
  farthestFrom,
  mulberry32,
};
