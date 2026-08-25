'use strict';

// BPM + key detection fallback (songs phase 5): when a file's tags say nothing, estimate both
// from the audio itself. BPM is onset-envelope autocorrelation - the rectified RMS flux that
// samples.js's transient detector already computes, autocorrelated over musical lags with
// half/double-tempo support and a gentle prior toward song tempos. Key is a chroma vector
// (FFT magnitude folded onto the 12 pitch classes) correlated against the Krumhansl-Kessler
// major/minor profiles. Both come back with a confidence in 0..1 and both are ESTIMATES: the
// deck pane shows them as such, and a tag, a playlist item, or a typed value always wins.
//
// Pure functions over a decoded WAV; the engine runs detectSongFacts on the analysis worker
// (analysis.js) because a full song's read and FFT pass is far past the scheduler's lookahead.

const { readWav } = require('./samples');

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------------------------
// BPM - onset envelope autocorrelation
// ---------------------------------------------------------------------------------------------

const BPM_LO = 65; // report inside this range; a faster/slower truth folds by octaves into it
const BPM_HI = 185;
const BPM_HOP = 512; // envelope rate ~86Hz at 44.1k - lag resolution well under a bpm after refinement
const BPM_WINDOW_SEC = 90; // analyze the middle of the track; intros/outros mislead

/**
 * Estimate the tempo of a mono signal. Returns { bpm, confidence } or null when there is no
 * periodic onset structure to read (silence, a drone, too short a file).
 */
function detectBpm(samples, sampleRate) {
  const nHops = Math.floor(samples.length / BPM_HOP);
  if (nHops < 64) return null; // not even a couple of seconds of envelope
  const envRate = sampleRate / BPM_HOP;

  // Onset strength: half-wave-rectified RMS flux (the transient detector's read, minus its
  // peak-picking - autocorrelation wants the whole strength curve, not discrete onsets). The
  // envelope is taken over the FIRST DIFFERENCE of the signal - a one-line high-pass - so a
  // sustained tonal bed (pads, bass drones) doesn't flatten the flux the drums ride on:
  // broadband transients keep their energy, steady low partials lose most of theirs.
  const env = new Float32Array(nHops);
  for (let h = 0; h < nHops; h++) {
    let e = 0;
    for (let i = Math.max(1, h * BPM_HOP); i < (h + 1) * BPM_HOP; i++) {
      const dv = samples[i] - samples[i - 1];
      e += dv * dv;
    }
    env[h] = Math.sqrt(e / BPM_HOP);
  }
  const flux = new Float32Array(nHops);
  for (let h = 1; h < nHops; h++) flux[h] = Math.max(0, env[h] - env[h - 1]);

  const win = Math.min(nHops, Math.round(BPM_WINDOW_SEC * envRate));
  const at = Math.floor((nHops - win) / 2);
  const d = new Float32Array(win);
  let mean = 0;
  for (let i = 0; i < win; i++) mean += flux[at + i];
  mean /= win;
  let energy = 0;
  for (let i = 0; i < win; i++) {
    d[i] = flux[at + i] - mean; // mean-removed, or the ACF rides a DC hump instead of the beat
    energy += d[i] * d[i];
  }
  if (energy / win < 1e-10) return null; // no onsets to correlate

  const lagMin = Math.max(2, Math.floor((60 / BPM_HI) * envRate));
  const lagMax = Math.min(win >> 1, Math.ceil((60 / BPM_LO) * envRate));
  if (lagMax <= lagMin + 2) return null;

  // Normalized ACF, from half the shortest musical lag (the half-beat support term below) out
  // to four times the longest (the four-beat refinement term): ~1 at the lag of a perfectly
  // periodic envelope, ~0 where there is no self-similarity.
  const acfFrom = Math.max(1, Math.floor(lagMin / 2));
  const acfTo = Math.min(win - 2, 4 * lagMax + 4);
  const acf = new Float32Array(acfTo + 2);
  const norm = energy / win;
  for (let lag = acfFrom; lag <= acfTo; lag++) {
    let s = 0;
    for (let i = 0; i + lag < win; i++) s += d[i] * d[i + lag];
    acf[lag] = s / (win - lag) / norm;
  }
  const acfAt = (lag) => {
    const lo = Math.floor(lag);
    if (lo < acfFrom || lo + 1 > acfTo) return 0;
    return acf[lo] + (acf[lo + 1] - acf[lo]) * (lag - lo);
  };

  // Score every candidate beat lag: its own periodicity, plus the two-beat lag (bars support
  // the beat over its double) and the half-beat (subdivisions support it over its half), under
  // a gentle log-normal prior centred on song tempos - what breaks the tie between a tempo and
  // its octaves when the envelope alone can't.
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * envRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    const score = (acf[lag] + 0.5 * acfAt(2 * lag) + 0.3 * acfAt(lag / 2)) * prior;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (!bestLag || acf[bestLag] <= 0) return null;

  // Parabolic refinement at the beat lag, then again around FOUR beats out - the same grid
  // measured over a longer span quarters the quantization error (~86Hz envelope means one raw
  // lag is ±3 bpm at 120; this gets it inside a tenth for steady material).
  const para = (i) => {
    const denom = acf[i - 1] - 2 * acf[i] + acf[i + 1];
    return denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (acf[i - 1] - acf[i + 1])) / denom)) : 0;
  };
  let lag = bestLag + para(bestLag);
  const l4 = Math.round(4 * lag);
  if (l4 + 1 <= acfTo && l4 - 1 >= acfFrom) {
    let peak = l4;
    for (let i = Math.max(acfFrom + 1, l4 - 3); i <= Math.min(acfTo - 1, l4 + 3); i++) {
      if (acf[i] > acf[peak]) peak = i;
    }
    if (acf[peak] > 0.3 * acf[bestLag]) lag = (peak + para(peak)) / 4;
  }

  const bpm = Math.round(((60 * envRate) / lag) * 10) / 10;
  if (bpm < 20 || bpm > 400) return null;
  // Confidence is simply the normalized autocorrelation at the chosen lag: how much of the
  // onset energy actually repeats on this grid.
  return { bpm, confidence: Math.round(clamp01(acf[bestLag]) * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------
// Key - chroma + Krumhansl-Kessler profiles
// ---------------------------------------------------------------------------------------------

// The K-K probe-tone profiles: how strongly each scale degree "belongs" in a major/minor key.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const FFT_N = 8192;
const KEY_FRAMES_MAX = 150; // frames spread over the track - plenty for one global chroma
const KEY_F_LO = 100; // below this the FFT bins are wider than a semitone
const KEY_F_HI = 2000; // above it is mostly cymbals and air

/** In-place iterative radix-2 FFT. re/im lengths must be a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * cr - im[i + k + half] * ci;
        const vi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const denom = Math.sqrt(saa * sbb);
  return denom ? sab / denom : 0;
}

/**
 * Estimate the key of a mono signal. Returns { key: "F#m"-style, confidence } or null when the
 * spectrum has no tonal reading (noise, silence, or nothing decisive between candidates).
 */
function detectKey(samples, sampleRate) {
  if (samples.length < FFT_N) return null;
  const hop = FFT_N * 2;
  const nFrames = Math.floor((samples.length - FFT_N) / hop) + 1;
  const stride = Math.max(1, Math.floor(nFrames / KEY_FRAMES_MAX));

  const winFn = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) winFn[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  const binLo = Math.max(1, Math.ceil((KEY_F_LO * FFT_N) / sampleRate));
  const binHi = Math.min((FFT_N >> 1) - 1, Math.floor((KEY_F_HI * FFT_N) / sampleRate));
  const chroma = new Float64Array(12);

  for (let fi = 0; fi < nFrames; fi += stride) {
    const off = fi * hop;
    let probe = 0; // cheap silence check so a long quiet tail costs no FFTs
    for (let i = 0; i < FFT_N; i += 64) probe += samples[off + i] * samples[off + i];
    if (probe < 1e-8) continue;
    for (let i = 0; i < FFT_N; i++) {
      re[i] = samples[off + i] * winFn[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = binLo; b <= binHi; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      const f = (b * sampleRate) / FFT_N;
      const pc = ((Math.round(12 * Math.log2(f / 261.6255)) % 12) + 12) % 12; // C4-referenced
      chroma[pc] += mag;
    }
  }
  let total = 0;
  for (const v of chroma) total += v;
  if (total < 1e-6) return null;

  const rotated = new Float64Array(12);
  let r1 = -2;
  let r2 = -2;
  let bestName = null;
  for (const [profile, minor] of [[KK_MAJOR, false], [KK_MINOR, true]]) {
    for (let tonic = 0; tonic < 12; tonic++) {
      for (let k = 0; k < 12; k++) rotated[k] = chroma[(tonic + k) % 12];
      const r = pearson(rotated, profile);
      if (r > r1) {
        r2 = r1;
        r1 = r;
        bestName = NOTE_NAMES[tonic] + (minor ? 'm' : '');
      } else if (r > r2) {
        r2 = r;
      }
    }
  }
  if (!(r1 > 0.4)) return null; // nothing correlates - atonal material, or just noise
  // Confidence: the winner's correlation, discounted when the runner-up is breathing down its
  // neck (a 0.05 correlation margin counts as fully decisive - K-S margins are small numbers).
  const confidence = Math.round(clamp01(r1) * clamp01((r1 - r2) / 0.05) * 100) / 100;
  return { key: bestName, confidence };
}

// ---------------------------------------------------------------------------------------------

/**
 * Both estimates for a WAV file, in one read: { bpm, bpmConfidence, key, keyConfidence } with
 * nulls where nothing could be read, or null when the file isn't a parseable WAV at all.
 * `wavPath` must already be a WAV - see songs.js's resolveSongFile({ wav: true }).
 */
function detectSongFacts(wavPath) {
  const wav = readWav(wavPath);
  if (!wav) return null;
  const bpm = detectBpm(wav.samples, wav.sampleRate);
  const key = detectKey(wav.samples, wav.sampleRate);
  return {
    bpm: bpm?.bpm ?? null,
    bpmConfidence: bpm?.confidence ?? null,
    key: key?.key ?? null,
    keyConfidence: key?.confidence ?? null,
  };
}

module.exports = { detectSongFacts, detectBpm, detectKey };
