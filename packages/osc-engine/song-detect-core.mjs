// A song's tempo, beatgrid and key, from its audio - the maths of song-detect.js, shared by both
// builds. BPM is onset-envelope autocorrelation - the rectified RMS flux that the transient
// detector already computes, autocorrelated over musical lags with half/double-tempo support and
// a gentle prior toward song tempos. The beatgrid is beats and downbeats decoded jointly over the
// whole track near that tempo, fitted to a constant grid. Key is a chroma vector (FFT magnitude folded onto the 12 pitch classes) correlated
// against the Krumhansl-Kessler major/minor profiles. All of it comes back with a confidence in
// 0..1, and all of it is an ESTIMATE: the deck pane shows it as one, and a tag, a playlist item
// or a typed value always wins.
//
// Plain functions over mono samples, as an ES module, so the desktop (song-detect.js, which adds
// reading a WAV off the disk) and the browser build (a worker handed decoded audio) run the same
// code and find the same grid. Nothing here may reach for node or the DOM.

import { fft } from './sample-map-core.mjs';

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
/**
 * Onset strength per hop: half-wave-rectified RMS flux (the transient detector's read, minus
 * its peak-picking - autocorrelation and grid fitting want the whole strength curve, not
 * discrete onsets). The envelope is taken over the FIRST DIFFERENCE of the signal - a
 * one-line high-pass - so a sustained tonal bed (pads, bass drones) doesn't flatten the flux
 * the drums ride on: broadband transients keep their energy, steady low partials lose most
 * of theirs. `lowpass` instead takes the flux of a ~120Hz one-pole low-pass - the kick's
 * envelope, which is what tells a downbeat from the other three beats.
 */
export function onsetFlux(samples, sampleRate, { lowpass = false } = {}) {
  const nHops = Math.floor(samples.length / BPM_HOP);
  const env = new Float32Array(nHops);
  const a = Math.exp((-2 * Math.PI * 120) / sampleRate); // one-pole coefficient at 120Hz
  let lp = 0;
  for (let h = 0; h < nHops; h++) {
    let e = 0;
    for (let i = Math.max(1, h * BPM_HOP); i < (h + 1) * BPM_HOP; i++) {
      let v;
      if (lowpass) {
        lp = a * lp + (1 - a) * samples[i];
        v = lp;
      } else {
        v = samples[i] - samples[i - 1];
      }
      e += v * v;
    }
    env[h] = Math.sqrt(e / BPM_HOP);
  }
  const flux = new Float32Array(nHops);
  for (let h = 1; h < nHops; h++) flux[h] = Math.max(0, env[h] - env[h - 1]);
  return flux;
}

/**
 * The onset strength the tempo and grid readers share: highs flux and bass flux, each scaled
 * to its own mean and summed - so a track carried by a sub kick (invisible to the high-pass)
 * reads as well as one carried by hats, and a snare and a kick each count as a beat.
 */
export function combinedFlux(samples, sampleRate) {
  const hi = onsetFlux(samples, sampleRate);
  const lo = onsetFlux(samples, sampleRate, { lowpass: true });
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const mh = mean(hi) || 1;
  const ml = mean(lo) || 1;
  const out = new Float32Array(hi.length);
  for (let i = 0; i < hi.length; i++) out[i] = hi[i] / mh + lo[i] / ml;
  return { flux: out, hi, bass: lo };
}

/**
 * Per-frame RMS level of four bands, each a one-pole low-pass and/or high-pass: `sub` (below
 * ~100Hz - the kick's weight, the bassline), `body` (80-1600Hz - a kick's punch, a snare's
 * crack, without the sub, where a sidechained bass or a kick's rumble swells on the off-beat,
 * and without the air, where the off-beat hats live), `snare` (200Hz-5kHz) and `air` (above
 * ~5kHz - hats, claps' sizzle), at `fps` frames a second. The beatgrid's downbeat cue reads
 * these (see beatObservations); its beat cue reads the same bands' spectral flux (bandFlux).
 */
const BANDS = { sub: [0, 100], body: [80, 1600], snare: [200, 5000], air: [5000, 0] };
function bandLevels(samples, sampleRate, fps) {
  const hop = sampleRate / fps;
  const nFrames = Math.floor(samples.length / hop);
  const names = Object.keys(BANDS);
  const coef = (hz) => (hz ? Math.exp((-2 * Math.PI * hz) / sampleRate) : 0);
  const aLo = names.map((k) => coef(BANDS[k][1])); // low-pass corner (0 = none)
  const aHi = names.map((k) => coef(BANDS[k][0])); // high-pass corner (0 = none)
  const env = names.map(() => new Float32Array(nFrames));
  for (let b = 0; b < names.length; b++) {
    const a = aLo[b];
    const c = aHi[b];
    const out = env[b];
    let lp = 0;
    let hp = 0;
    for (let f = 0; f < nFrames; f++) {
      const i0 = Math.round(f * hop);
      const i1 = Math.round((f + 1) * hop);
      let e = 0;
      for (let i = i0; i < i1; i++) {
        let v = samples[i];
        if (a) v = lp = a * lp + (1 - a) * v;
        if (c) {
          hp = c * hp + (1 - c) * v;
          v -= hp;
        }
        e += v * v;
      }
      out[f] = Math.sqrt(e / Math.max(1, i1 - i0));
    }
  }
  return Object.fromEntries(names.map((k, b) => [k, env[b]]));
}

/**
 * Per-frame onset strength of the `body` and `snare` bands (BANDS' corners) at `fps` frames a
 * second: linear-magnitude spectral flux - the summed rise of each FFT bin's magnitude from the
 * frame before, over a FLUX_N-point Hann window centered on the frame's start. Unlike the rise
 * of a band's RMS level, it ignores sustained tones: two partials a few tens of hertz apart beat,
 * and a 10ms level reading of that beating rises and falls as if struck; in separate bins
 * neither magnitude moves. Two frames go through each complex FFT (one as the real part, one as
 * the imaginary).
 */
const FLUX_N = 512;
function bandFlux(samples, sampleRate, fps, nFrames) {
  const N = FLUX_N;
  const half = N >> 1;
  const hop = sampleRate / fps;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = sampleRate / N;
  const names = ['body', 'snare'];
  const lo = names.map((k) => Math.max(1, Math.round(BANDS[k][0] / binHz)));
  const hi = names.map((k) => Math.min(half - 1, Math.round(BANDS[k][1] / binHz)));
  const out = names.map(() => new Float32Array(nFrames));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mags = [new Float64Array(half), new Float64Array(half)];
  const prev = new Float64Array(half);
  for (let f0 = 0; f0 < nFrames; f0 += 2) {
    for (let p = 0; p < 2; p++) {
      const into = p === 0 ? re : im;
      const c = Math.round((f0 + p) * hop) - half;
      for (let i = 0; i < N; i++) {
        const j = c + i;
        into[i] = j >= 0 && j < samples.length ? samples[j] * win[i] : 0;
      }
    }
    fft(re, im);
    for (let k = 1; k < half; k++) {
      // Z = A + iB, so A[k] = (Z[k] + conj Z[N-k]) / 2 and B[k] = (Z[k] - conj Z[N-k]) / 2i.
      mags[0][k] = Math.hypot(re[k] + re[N - k], im[k] - im[N - k]) / 2;
      mags[1][k] = Math.hypot(im[k] + im[N - k], re[N - k] - re[k]) / 2;
    }
    for (let p = 0; p < 2 && f0 + p < nFrames; p++) {
      const m = mags[p];
      for (let b = 0; b < names.length; b++) {
        let sum = 0;
        for (let k = lo[b]; k <= hi[b]; k++) if (m[k] > prev[k]) sum += m[k] - prev[k];
        out[b][f0 + p] = f0 + p ? sum : 0;
      }
      prev.set(m);
    }
  }
  return Object.fromEntries(names.map((k, b) => [k, out[b]]));
}

/** Half-wave-rectified first difference of an envelope: its onsets. */
function riseOf(env) {
  const flux = new Float32Array(env.length);
  for (let h = 1; h < env.length; h++) flux[h] = Math.max(0, env[h] - env[h - 1]);
  return flux;
}

export function detectBpm(samples, sampleRate, precomputed = null) {
  const nHops = Math.floor(samples.length / BPM_HOP);
  if (nHops < 64) return null; // not even a couple of seconds of envelope
  const envRate = sampleRate / BPM_HOP;
  const { hi, bass } = precomputed ?? combinedFlux(samples, sampleRate);

  const win = Math.min(nHops, Math.round(BPM_WINDOW_SEC * envRate));
  const at = Math.floor((nHops - win) / 2);
  const lagMin = Math.max(2, Math.floor((60 / BPM_HI) * envRate));
  const lagMax = Math.min(win >> 1, Math.ceil((60 / BPM_LO) * envRate));
  if (lagMax <= lagMin + 2) return null;

  // Normalized ACF, from half the shortest musical lag (the half-beat support term below) out
  // to four times the longest (the bar-level comb term): ~1 at the lag of a perfectly periodic
  // envelope, ~0 where there is no self-similarity. The highs and the bass are autocorrelated
  // SEPARATELY and averaged: the ACF of their sum carries cross terms - a kick one beat and a
  // half before an off-beat hat - that read as periodicity at a dotted-quarter (3:2) or a
  // two-beat (half-time) lag; each band on its own only repeats at the beat.
  const acfFrom = Math.max(1, Math.floor(lagMin / 2));
  const acfTo = Math.min(win - 2, 4 * lagMax + 4);
  const acf = new Float32Array(acfTo + 2);
  let bands = 0;
  for (const band of [hi, bass]) {
    const d = new Float32Array(win);
    let mean = 0;
    for (let i = 0; i < win; i++) mean += band[at + i];
    mean /= win;
    let energy = 0;
    for (let i = 0; i < win; i++) {
      d[i] = band[at + i] - mean; // mean-removed, or the ACF rides a DC hump instead of the beat
      energy += d[i] * d[i];
    }
    if (energy / win < 1e-10) continue; // this band has no onsets to correlate
    bands++;
    const norm = energy / win;
    for (let lag = acfFrom; lag <= acfTo; lag++) {
      let s = 0;
      for (let i = 0; i + lag < win; i++) s += d[i] * d[i + lag];
      acf[lag] += s / (win - lag) / norm;
    }
  }
  if (!bands) return null; // no onsets to correlate
  for (let lag = acfFrom; lag <= acfTo; lag++) acf[lag] /= bands;
  const acfAt = (lag) => {
    const lo = Math.floor(lag);
    if (lo < acfFrom || lo + 1 > acfTo) return 0;
    return acf[lo] + (acf[lo + 1] - acf[lo]) * (lag - lo);
  };

  // Score every candidate beat lag, in quarter-hop steps (a whole hop is ~3 bpm at 140, coarse
  // enough to miss a peak): a comb over one to four beats - a true beat repeats at the beat,
  // the half bar, the dotted half and the bar, where a dotted-quarter or two-beat impostor only
  // lines up with some of them - plus the half-beat (subdivisions support the beat over its
  // half), under a log-normal prior centered on club tempos, which breaks the tie between a
  // tempo and its octaves when the envelope alone can't. Its center and width were fitted on a
  // DJ library against reference beatgrids.
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag += 0.25) {
    const bpm = (60 * envRate) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 130) ** 2);
    const comb = acfAt(lag) + acfAt(2 * lag) + acfAt(3 * lag) + acfAt(4 * lag);
    const score = Math.max(0, comb + acfAt(lag / 2)) * prior;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  bestLag = Math.round(bestLag);
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
// Beatgrid - beat/downbeat activations + bar-pointer HMM (Viterbi) + constant-grid fit
// ---------------------------------------------------------------------------------------------
//
// What DJ software computes on analysis and what tempo sync actually needs: not just "about
// 128 bpm" but WHERE the beats are - a period to a hundredth of a bpm (a tenth of a bpm off
// drifts a locked pair by ~25ms a minute, a flam inside three) and the offset of beat one.
// A cue-and-anchor by hand is the fallback for when this guesses wrong, not the workflow.
//
// 1. Activations, 100 frames a second: how likely each frame is a beat (the onsets of the
//    drums' body and snare bands' spectral flux - the kick's punch and the backbeat, not the
//    off-beat hats),
//    and how much more likely a downbeat (the sound changes across bar lines; claps and hats
//    land on 2 and 4, the kick on 1 and 3).
// 2. Decode: a bar-pointer state space (Krebs, Böck & Widmer 2015, "An efficient state-space
//    model for joint tempo and meter tracking") - a state is a beat interval and a position in
//    the bar, the tempo may change only on a beat - decoded jointly for beats and downbeats by
//    Viterbi over the whole track, with the observation model of Böck, Krebs & Widmer 2016
//    ("Joint beat and downbeat tracking with recurrent neural networks"). The tempo octave
//    comes from detectBpm (or the tag); the decoder searches a few percent either side of it.
// 3. Constant grid: the period and phase most of the decoded beats agree on (a stretch the
//    decoder tracked on the off-beat, through a breakdown, costs only its own beats), refined
//    by least squares through them, snapped to a whole or half bpm when the audio agrees; the
//    anchor is the bar line most decoded downbeats fall on.
//
// The decoder reads only per-frame log-densities (beatObservations), so a trained activation
// network's output (observationsOf) can replace the hand-built activations without touching it.

const BEAT_FPS = 100; // activation frames a second
const GRID_TEMPO_SPAN = 0.04; // the decoder's tempo range either side of detectBpm's (or the tag's)
const GRID_TEMPI = 12; // tempi spanning that range, before rounding to whole frames
const TRANSITION_LAMBDA = 100; // tempo-change penalty: weight exp(-lambda * |tau_j / tau_i - 1|)
const TRANSITION_FLOOR = 1e-4; // tempo changes less likely than this are not modeled at all
const OBSERVATION_LAMBDA = 16; // the first 1/lambda of each beat is its beat (or downbeat) state
const BEATS_PER_BAR = 4;
const GRID_INLIER = 0.05; // how far (in beats) a decoded beat may sit from the constant grid
const GRID_MIN_FIT = 8; // decoded beats needed to measure the period rather than keep detectBpm's

/**
 * Per-frame log-densities for the decoder from a network's activations: `beatProb` and
 * `downProb` are each frame's probability of a beat that is not a downbeat and of a downbeat
 * (the remainder is no beat), as a three-class beat/downbeat network outputs them. Returns
 * { none, beat, down } - what decodeBars reads.
 */
export function observationsOf(beatProb, downProb, observationLambda = OBSERVATION_LAMBDA) {
  const n = beatProb.length;
  const none = new Float32Array(n);
  const beat = new Float32Array(n);
  const down = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const pb = Math.max(1e-6, beatProb[t]);
    const pd = Math.max(1e-6, downProb[t]);
    none[t] = Math.log(Math.max(1e-6, 1 - pb - pd) / (observationLambda - 1));
    beat[t] = Math.log(pb);
    down[t] = Math.log(pd);
  }
  return { none, beat, down };
}

/** The value at fraction `q` of the sorted positive entries of `a` (0 when there are none). */
function positiveQuantile(a, q) {
  const pos = a.filter((v) => v > 0).sort();
  return pos.length ? pos[Math.min(pos.length - 1, Math.floor(q * pos.length))] : 0;
}

/**
 * The hand-built activations, as decoder log-densities over `levels` (bandLevels at BEAT_FPS)
 * and `flux` (bandFlux at BEAT_FPS), with `beatFrames` the beat length in frames that detectBpm
 * (or the tag) reads.
 * - beat: the mean of the body and snare spectral flux, each scaled to its own 99th percentile and
 *   clipped, mapped to a probability in 0.05..0.9. (The broadband and air onsets are off the
 *   beat on more club tracks than on it - the hats - and the sub's rise lags the kick.)
 * - down: a downbeat state scores the beat's density plus a bonus: how much the band levels
 *   change across the frame (one and two beats either side, relative to the track's mean
 *   change), the backbeat parity (air onsets one and three beats on, body onsets now and two
 *   beats on) and the accent (the sub's onset against the next three beats'). The bonus
 *   averages zero, so it moves the bar lines without favoring more
 *   beats.
 * Weights and scales were fitted on a DJ library against reference beatgrids.
 */
export function beatObservations(levels, flux, beatFrames, observationLambda = OBSERVATION_LAMBDA) {
  const n = levels.body.length;
  const x = new Float32Array(n);
  for (const name of ['body', 'snare']) {
    const r = flux[name];
    const scale = positiveQuantile(r, 0.99) || 1;
    for (let t = 0; t < n; t++) x[t] += Math.min(1, r[t] / scale) / 2;
  }
  const none = new Float32Array(n);
  const beat = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const a = 0.05 + 0.85 * x[t];
    none[t] = Math.log((1 - a) / (observationLambda - 1));
    beat[t] = Math.log(a);
  }
  const bonus = downbeatCue(levels, beatFrames);
  const down = new Float32Array(n);
  for (let t = 0; t < n; t++) down[t] = beat[t] + bonus[t];
  return { none, beat, down, strength: x };
}

/** The downbeat bonus of beatObservations, per frame. */
function downbeatCue(levels, tau) {
  const n = levels.body.length;
  const names = Object.keys(BANDS);
  const cum = names.map((k) => {
    const c = new Float64Array(n + 1);
    for (let t = 0; t < n; t++) c[t + 1] = c[t] + levels[k][t];
    return c;
  });
  const logMean = (c, a, b) => {
    a = Math.max(0, Math.min(n, Math.round(a)));
    b = Math.max(0, Math.min(n, Math.round(b)));
    return b > a ? Math.log(1e-4 + (c[b] - c[a]) / (b - a)) : NaN;
  };
  // Level change across frame t over `span` beats, scaled to its mean over the track (0 = an
  // ordinary amount of change, where the windows run off either end of the track too).
  const change = (span) => {
    const out = new Float64Array(n);
    let sum = 0;
    let count = 0;
    for (let t = 0; t < n; t++) {
      let d = 0;
      for (const c of cum) d += Math.abs(logMean(c, t, t + span * tau) - logMean(c, t - span * tau, t));
      out[t] = d;
      if (!Number.isNaN(d)) {
        sum += d;
        count++;
      }
    }
    const mean = count ? sum / count : 0;
    for (let t = 0; t < n; t++) out[t] = Number.isNaN(out[t]) || !mean ? 0 : (out[t] - mean) / mean;
    return out;
  };
  const c1 = change(1);
  const c2 = change(2);
  // Each band's strongest onset within a few frames of t.
  const peaks = (env) => {
    const r = riseOf(env);
    const out = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      let v = 0;
      for (let h = Math.max(1, t - 2); h <= Math.min(n - 1, t + 3); h++) v = Math.max(v, r[h]);
      out[t] = v;
    }
    return out;
  };
  const air = peaks(levels.air);
  const body = peaks(levels.body);
  const at = (a, t) => {
    const i = Math.round(t);
    return i >= 0 && i < n ? a[i] : 0;
  };
  // + when beats 2 and 4 of a bar starting at t carry the claps and hats, 1 and 3 the kick.
  const pairs = (a, t) => {
    const even = at(a, t) + at(a, t + 2 * tau);
    const odd = at(a, t + tau) + at(a, t + 3 * tau);
    return (odd - even) / (odd + even || 1);
  };
  const bonus = new Float32Array(n);
  // + when the sub hits harder at t than on the three beats after it: the bar's accent.
  const sub = peaks(levels.sub);
  const accent = (t) => {
    const own = at(sub, t);
    const rest = (at(sub, t + tau) + at(sub, t + 2 * tau) + at(sub, t + 3 * tau)) / 3;
    return (own - rest) / (own + rest || 1);
  };
  for (let t = 0; t < n; t++) bonus[t] = 0.5 * (c1[t] + c2[t] + pairs(air, t) - pairs(body, t)) + accent(t);
  return bonus;
}

/**
 * Joint beat and downbeat decoding: Viterbi through the bar-pointer state space over per-frame
 * log-densities `obs` ({ none, beat, down } - beatObservations or observationsOf). A state is a
 * beat interval tau (whole frames, from `minBpm`..`maxBpm` in `tempi` log-spaced steps, repeats
 * dropped) and a position in the bar; the first ceil(tau / observationLambda) positions of each
 * beat are its beat states (the bar's first beat: downbeat states). Positions advance one a
 * frame; the tempo may change only from the last position of a beat to the first of the next,
 * weighted exp(-transitionLambda * |tau_to / tau_from - 1|), normalized over each source tempo.
 *
 * Only beat entries branch, so the recursion keeps one score per (tempo, beat of the bar) entry
 * and the observations of a whole beat come from prefix sums: the work is per frame in the
 * number of tempo transitions, not the number of states, and the backtrace stores one byte per
 * entry and frame. Returns { beats: frame of each decoded beat, beatInBar: 0 for downbeats }; a
 * beat's frame is the one of its beat states that its observation favors most.
 */
export function decodeBars(obs, {
  fps = BEAT_FPS,
  minBpm,
  maxBpm,
  tempi = GRID_TEMPI,
  transitionLambda = TRANSITION_LAMBDA,
  observationLambda = OBSERVATION_LAMBDA,
  beatsPerBar = BEATS_PER_BAR,
} = {}) {
  const T = obs.beat.length;
  const intervals = [];
  for (let i = 0; i < tempi; i++) {
    const bpm = minBpm * (maxBpm / minBpm) ** (tempi > 1 ? i / (tempi - 1) : 0);
    const tau = Math.max(1, Math.round((60 * fps) / bpm));
    if (!intervals.includes(tau)) intervals.push(tau);
  }
  intervals.sort((a, b) => a - b);
  const N = intervals.length;
  const B = beatsPerBar;
  if (N > 256) throw new RangeError('decodeBars: more than 256 beat intervals');
  const tau = Int32Array.from(intervals);
  const beatStates = Int32Array.from(intervals, (t) => Math.max(1, Math.ceil(t / observationLambda)));
  const tauMax = tau[N - 1];

  // Transitions into each tempo i from tempo j, normalized over each source j's destinations.
  const weight = intervals.map((tj) => {
    const w = intervals.map((ti) => Math.exp(-transitionLambda * Math.abs(ti / tj - 1)));
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map((v) => v / sum);
  });
  const predStart = new Int32Array(N + 1);
  const predTempo = [];
  const predLog = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (weight[j][i] > TRANSITION_FLOOR) {
        predTempo.push(j);
        predLog.push(Math.log(weight[j][i]));
      }
    }
    predStart[i + 1] = predTempo.length;
  }
  const pJ = Int32Array.from(predTempo);
  const pW = Float64Array.from(predLog);

  // Prefix sums of each class's log-density, behind tauMax neutral frames: a path may enter
  // the track at any tempo and position.
  const pad = tauMax;
  const L = T + pad;
  const sumNone = new Float64Array(L + 1);
  const sumBeat = new Float64Array(L + 1);
  const sumDown = new Float64Array(L + 1);
  for (let t = 0; t < L; t++) {
    const real = t >= pad;
    sumNone[t + 1] = sumNone[t] + (real ? obs.none[t - pad] : 0);
    sumBeat[t + 1] = sumBeat[t] + (real ? obs.beat[t - pad] : 0);
    sumDown[t + 1] = sumDown[t] + (real ? obs.down[t - pad] : 0);
  }

  // entry[t][i][k]: best score of a path whose beat k of the bar starts at frame t at tempo i,
  // counting the frames before t (a ring of the last tauMax + 1 frames; entries in the padding
  // are 0). back[t][i][k]: the tempo of the beat before it.
  const NB = N * B;
  const R = tauMax + 1;
  const entry = new Float64Array(R * NB);
  const back = new Uint8Array((L + 1) * NB);
  const done = new Float64Array(NB); // per (tempo j, beat k): a beat entered tau_j ago, scored
  for (let t = pad; t <= L; t++) {
    for (let j = 0; j < N; j++) {
      const t0 = t - tau[j];
      const m = t0 + beatStates[j];
      const rest = sumNone[t] - sumNone[m];
      const r0 = (t0 % R) * NB + j * B;
      done[j * B] = entry[r0] + sumDown[m] - sumDown[t0] + rest;
      const beatScore = sumBeat[m] - sumBeat[t0] + rest;
      for (let k = 1; k < B; k++) done[j * B + k] = entry[r0 + k] + beatScore;
    }
    const rt = (t % R) * NB;
    const bt = t * NB;
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < B; k++) {
        const kPrev = k === 0 ? B - 1 : k - 1;
        let best = -Infinity;
        let arg = 0;
        for (let q = predStart[i]; q < predStart[i + 1]; q++) {
          const v = done[pJ[q] * B + kPrev] + pW[q];
          if (v > best) {
            best = v;
            arg = pJ[q];
          }
        }
        entry[rt + i * B + k] = best;
        back[bt + i * B + k] = arg;
      }
    }
  }

  // The path ends partway through its last beat: score each beat entered within one interval
  // of the end with the frames it covers.
  let best = -Infinity;
  let endT = L;
  let endI = 0;
  let endK = 0;
  for (let j = 0; j < N; j++) {
    for (let t0 = Math.max(pad, L - tau[j] + 1); t0 <= L; t0++) {
      const m = Math.min(L, t0 + beatStates[j]);
      for (let k = 0; k < B; k++) {
        const head = k === 0 ? sumDown[m] - sumDown[t0] : sumBeat[m] - sumBeat[t0];
        const v = entry[(t0 % R) * NB + j * B + k] + head + sumNone[L] - sumNone[m];
        if (v > best) {
          best = v;
          endT = t0;
          endI = j;
          endK = k;
        }
      }
    }
  }
  const beats = [];
  const beatInBar = [];
  for (let t = endT, i = endI, k = endK; t >= pad; ) {
    if (t < L) {
      // The beat is the frame of its beat states that the observations favor most over no
      // beat - any of them can carry the onset, and the path enters at the first.
      const cls = k === 0 ? obs.down : obs.beat;
      let pick = t - pad;
      for (let u = pick + 1; u < Math.min(T, pick + beatStates[i]); u++) {
        if (cls[u] - obs.none[u] > cls[pick] - obs.none[pick]) pick = u;
      }
      beats.push(pick);
      beatInBar.push(k);
    }
    const j = back[t * NB + i * B + k];
    t -= tau[j];
    i = j;
    k = k === 0 ? B - 1 : k - 1;
  }
  beats.reverse();
  beatInBar.reverse();
  return { beats: Int32Array.from(beats), beatInBar: Int8Array.from(beatInBar) };
}

/**
 * The constant grid decoded beats agree on: { period, phase, down, confidence } in frames
 * (`phase` a beat, `down` the beat class 0..3 after it that the most decoded downbeats fall on).
 * Each beat sits at the peak of `strength` near it and counts by that peak squared - a beat
 * the decoder carried through a breakdown on no onset counts for little. The period is the
 * one under which the most of that weight lies within GRID_INLIER beats of one phase
 * (searched in steps finer than a quarter beat over the whole track), then least squares
 * through those beats. Fewer than GRID_MIN_FIT beats (a one- or two-bar loop) are too few to
 * measure a period: `period0` (detectBpm's, or the tag's) stands and only the phase is read.
 * Confidence is the share of the weight that agrees.
 */
function gridOfBeats(beats, beatInBar, strength, period0) {
  const n = beats.length;
  if (n < 2) return null;
  const at = new Float64Array(n);
  const w = new Float64Array(n);
  let wSum = 0;
  for (let q = 0; q < n; q++) {
    let pk = beats[q];
    for (let h = Math.max(1, beats[q] - 2); h <= Math.min(strength.length - 2, beats[q] + 3); h++) {
      if (strength[h] > strength[pk]) pk = h;
    }
    let off = 0;
    if (pk > 0 && pk < strength.length - 1) {
      const den = strength[pk - 1] - 2 * strength[pk] + strength[pk + 1];
      if (den) off = Math.max(-0.5, Math.min(0.5, (0.5 * (strength[pk - 1] - strength[pk + 1])) / den));
    }
    at[q] = pk + off;
    w[q] = Math.max(1e-6, strength[pk]) ** 2;
    wSum += w[q];
  }
  const fit = n >= GRID_MIN_FIT;
  let period = period0;
  if (fit) {
    const gaps = [];
    for (let q = 1; q < n; q++) gaps.push(beats[q] - beats[q - 1]);
    gaps.sort((a, b) => a - b);
    period = gaps[gaps.length >> 1];
  }

  const BINS = 100;
  const win = Math.round(GRID_INLIER * BINS);
  const hist = new Float64Array(BINS);
  const agreement = (p) => {
    hist.fill(0);
    for (let q = 0; q < n; q++) {
      const x = at[q] / p;
      hist[Math.floor((x - Math.floor(x)) * BINS) % BINS] += w[q];
    }
    let run = 0;
    for (let b = -win; b <= win; b++) run += hist[(b + BINS) % BINS];
    let most = run;
    let arg = 0;
    for (let c = 1; c < BINS; c++) {
      run += hist[(c + win) % BINS] - hist[(c - win - 1 + BINS) % BINS];
      if (run > most) {
        most = run;
        arg = c;
      }
    }
    return [most / wSum, ((arg + 0.5) / BINS) * p];
  };
  let [confidence, phase] = agreement(period);
  const step = 0.25 / n;
  for (const [span, dr] of fit ? [[0.03, step], [2 * step, step / 10]] : []) {
    const center = period;
    for (let r = -span; r <= span + 1e-12; r += dr) {
      const [c, ph] = agreement(center * (1 + r));
      if (c > confidence) {
        confidence = c;
        period = center * (1 + r);
        phase = ph;
      }
    }
  }
  for (let pass = 0; fit && pass < 3; pass++) {
    let m = 0;
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    for (let q = 0; q < n; q++) {
      const kf = (at[q] - phase) / period;
      const k = Math.round(kf);
      if (Math.abs(kf - k) > GRID_INLIER) continue;
      m += w[q];
      sk += w[q] * k;
      st += w[q] * at[q];
      skk += w[q] * k * k;
      skt += w[q] * k * at[q];
    }
    const varK = skk - (sk * sk) / m;
    if (!(varK > 0)) break;
    const slope = (skt - (sk * st) / m) / varK;
    if (Math.abs(slope / period - 1) > 0.002) break;
    period = slope;
    phase = st / m - period * (sk / m);
  }
  phase -= Math.floor(phase / period) * period;
  const votes = [0, 0, 0, 0];
  for (let q = 0; q < n; q++) {
    if (beatInBar[q] !== 0) continue;
    const k = Math.round((at[q] - phase) / period);
    votes[((k % 4) + 4) % 4]++;
  }
  let down = 0;
  for (let c = 1; c < 4; c++) if (votes[c] > votes[down]) down = c;
  return { period, phase, down, confidence };
}

/**
 * Fit the beatgrid of a mono signal. `bpmHint` (a tag, a typed value) fixes the tempo octave
 * and starting period; without it detectBpm's estimate does. Returns
 * { bpm, anchorSec, confidence } or null when no periodic structure could be read.
 */
export function fitBeatGrid(samples, sampleRate, bpmHint = null) {
  if (Math.floor(samples.length / BPM_HOP) < 64) return null;
  let bpm0 = Number.isFinite(bpmHint) && bpmHint > 20 && bpmHint < 400 ? bpmHint : null;
  if (bpm0 == null) {
    const est = detectBpm(samples, sampleRate);
    if (!est) return null;
    bpm0 = est.bpm;
  }
  const fps = BEAT_FPS;
  const levels = bandLevels(samples, sampleRate, fps);
  const obs = beatObservations(levels, bandFlux(samples, sampleRate, fps, levels.body.length), (60 * fps) / bpm0);
  const { strength } = obs;
  const nFrames = strength.length;
  let peak = 0;
  for (let t = 0; t < nFrames; t++) peak = Math.max(peak, strength[t]);
  if (!(peak > 0)) return null; // no onsets to decode
  const { beats, beatInBar } = decodeBars(obs, {
    fps,
    minBpm: bpm0 * (1 - GRID_TEMPO_SPAN),
    maxBpm: bpm0 * (1 + GRID_TEMPO_SPAN),
  });
  const grid = gridOfBeats(beats, beatInBar, strength, (60 * fps) / bpm0);
  if (!grid) return null;
  let { period, phase } = grid;

  // Produced tempos are whole numbers (or halves) far more often than not, and a fit a tenth
  // off is usually the fit's error, not the track's (a short loop gives it few beats to
  // measure). Comb the onset strength over the whole track at the free period and at the
  // nearest integer / half-integer; a comb over minutes is brutally sensitive to period (a
  // tenth of a bpm walks half a beat across a track), so if the round tempo scores as well,
  // it IS the tempo - and if the track really is 139.9, the round comb collapses.
  const strengthAt = (t) => {
    const lo = Math.floor(t);
    if (lo < 0 || lo + 1 >= nFrames) return 0;
    return strength[lo] + (strength[lo + 1] - strength[lo]) * (t - lo);
  };
  const comb = (p) => {
    let most = 0;
    let shift = 0;
    for (let d = -3; d <= 3; d += 0.5) {
      let sc = 0;
      for (let t = phase + d - Math.floor((phase + d) / p) * p; t < nFrames - 1; t += p) sc += strengthAt(t);
      if (sc > most) {
        most = sc;
        shift = d;
      }
    }
    return [most, shift];
  };
  const freeBpm = (60 * fps) / period;
  const roundBpm = Math.round(freeBpm * 2) / 2;
  if (Math.abs(roundBpm - freeBpm) > 1e-6 && Math.abs(roundBpm - freeBpm) < 0.3) {
    const roundPeriod = (60 * fps) / roundBpm;
    const [roundScore, shift] = comb(roundPeriod);
    if (roundScore >= 0.97 * comb(period)[0]) {
      period = roundPeriod;
      phase += shift;
    }
  }

  const bar = BEATS_PER_BAR * period;
  let anchor = phase + grid.down * period;
  anchor -= Math.floor(anchor / bar) * bar; // the first downbeat at or after the top of the file
  const bpm = Math.round(((60 * fps) / period) * 100) / 100;
  if (bpm < 20 || bpm > 400) return null;
  return {
    bpm,
    anchorSec: anchor / fps,
    confidence: Math.round(clamp01(grid.confidence) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------------------------
// Key - semitone chroma + Krumhansl-Kessler profiles
// ---------------------------------------------------------------------------------------------

// The K-K probe-tone profiles: how strongly each scale degree "belongs" in a major/minor key.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// The signal is low-passed and decimated to about 5.5 kHz before the FFT, so an 8192-point frame
// is 1.5 s long with 0.67 Hz bins: fine enough to tell semitones apart down to A0 (27.5 Hz,
// where neighbors are 1.6 Hz apart). Frames overlap by half; a long track is strided down to
// KEY_FRAMES_MAX of them.
const KEY_RATE = 5512.5;
const KEY_N = 8192;
const KEY_HOP = 4096;
const KEY_FRAMES_MAX = 400;
// Six whole octaves from A0 (27.5-1760 Hz at A440): every pitch class gets exactly six semitone
// bands, so none is counted more often than another. Bass is kept - in dance music it is often
// the clearest statement of the tonic (cutting below 55 Hz loses ~10% of correct reads).
const KEY_OCTAVES = 6;
// Band power is compressed (power^0.3) before it is summed into pitch classes, so one loud bass
// note does not drown out the harmony above it.
const KEY_COMPRESS = 0.3;
// Tuning is read from spectral peaks in this range, where a bin is well under a quarter semitone.
const KEY_TUNE_LO = 200;
const KEY_TUNE_HI = 1700;
// A chroma whose neighboring pitch classes differ by less than this (mean |step| over the mean)
// has no tonal reading. White noise measures ~0.03, pink noise ~0.01, music 0.04 and up.
const KEY_CONTRAST_MIN = 0.035;

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
 * Low-pass and decimate to about KEY_RATE: a Hamming-windowed sinc cut at the new Nyquist, 12
 * taps per unit of the factor (a ~0.27 x output-rate transition band, so everything up to the
 * top key band at ~1.8 kHz passes and nothing that aliases lands below ~2 kHz).
 */
function keyDecimate(samples, sampleRate) {
  const f = Math.max(1, Math.floor(sampleRate / KEY_RATE));
  if (f === 1) return { x: samples, rate: sampleRate };
  const taps = 12 * f;
  const fc = 0.5 / f;
  const h = new Float64Array(taps + 1);
  let sum = 0;
  for (let i = 0; i <= taps; i++) {
    const t = i - taps / 2;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / taps));
    sum += h[i];
  }
  for (let i = 0; i <= taps; i++) h[i] /= sum;
  const n = Math.max(0, Math.floor((samples.length - taps - 1) / f) + 1);
  const x = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const o = j * f;
    let acc = h[taps / 2] * samples[o + taps / 2];
    for (let i = 0; i < taps / 2; i++) acc += h[i] * (samples[o + i] + samples[o + taps - i]); // h is symmetric
    x[j] = acc;
  }
  return { x, rate: sampleRate / f };
}

/** The power between two fractional bin positions, from a prefix sum (each bin spread evenly). */
function bandPower(cum, a, b) {
  const at = (p) => {
    const i = Math.floor(p);
    return cum[i] + (p - i) * (cum[i + 1] - cum[i]);
  };
  return at(b) - at(a);
}

/**
 * The reference A the track is tuned to: the spectral peaks of the summed spectrum, placed by
 * parabolic interpolation, their offsets from the A440 semitone grid averaged on the circle (a
 * semitone is one turn) weighted by power. Clamped to a quarter semitone either way (~434-446 Hz).
 */
function keyTuning(power, binHz) {
  let cx = 0;
  let cy = 0;
  const b0 = Math.max(1, Math.ceil(KEY_TUNE_LO / binHz));
  const b1 = Math.min(power.length - 2, Math.floor(KEY_TUNE_HI / binHz));
  for (let b = b0; b <= b1; b++) {
    const y = power[b];
    if (!(y > power[b - 1] && y >= power[b + 1])) continue;
    const l = Math.log(power[b - 1] + 1e-30);
    const c = Math.log(y + 1e-30);
    const r = Math.log(power[b + 1] + 1e-30);
    const den = l - 2 * c + r;
    const d = den < 0 ? (0.5 * (l - r)) / den : 0;
    const semi = 12 * Math.log2(((b + d) * binHz) / 440);
    const phase = 2 * Math.PI * (semi - Math.round(semi));
    cx += y * Math.cos(phase);
    cy += y * Math.sin(phase);
  }
  const dev = cx || cy ? Math.atan2(cy, cx) / (2 * Math.PI) : 0;
  return 440 * 2 ** (Math.max(-0.25, Math.min(0.25, dev)) / 12);
}

/**
 * Estimate the key of a mono signal. Returns { key: "F#m"-style, confidence } or null when the
 * spectrum has no tonal reading (noise, silence, or nothing decisive between candidates).
 *
 * Chroma: each frame's power is summed over semitone-wide bands centered on the track's own
 * tuning (six octaves from A0), compressed, folded into pitch classes and normalized to the
 * frame's loudest class, then averaged over the track - a time-smoothed chroma in which every
 * pitch class is the sum of the same number of equal-width (in cents) bands.
 */
export function detectKey(samples, sampleRate) {
  const { x, rate } = keyDecimate(samples, sampleRate);
  if (x.length < KEY_N) return null;
  const nFrames = Math.floor((x.length - KEY_N) / KEY_HOP) + 1;
  const stride = Math.max(1, Math.ceil(nFrames / KEY_FRAMES_MAX));
  const binHz = rate / KEY_N;
  const top = 1760 * 2 ** (0.25 / 12 + 1 / 24); // the highest band edge at the sharpest tuning
  const nBins = Math.min(KEY_N >> 1, Math.ceil(top / binHz) + 2);

  const win = new Float64Array(KEY_N);
  for (let i = 0; i < KEY_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (KEY_N - 1));
  const re = new Float64Array(KEY_N);
  const im = new Float64Array(KEY_N);
  const frames = [];
  const sum = new Float64Array(nBins);
  for (let fi = 0; fi < nFrames; fi += stride) {
    const off = fi * KEY_HOP;
    let probe = 0; // cheap silence check so a long quiet tail costs no FFTs
    for (let i = 0; i < KEY_N; i += 16) probe += x[off + i] * x[off + i];
    if (probe < 1e-8) continue;
    for (let i = 0; i < KEY_N; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const power = new Float32Array(nBins);
    for (let b = 0; b < nBins; b++) {
      power[b] = re[b] * re[b] + im[b] * im[b];
      sum[b] += power[b];
    }
    frames.push(power);
  }
  if (!frames.length) return null;

  const tuning = keyTuning(sum, binHz);
  const nBands = 12 * KEY_OCTAVES;
  const a0 = tuning / 16;
  const lo = new Float64Array(nBands);
  const hi = new Float64Array(nBands);
  for (let k = 0; k < nBands; k++) {
    const f = a0 * 2 ** (k / 12);
    lo[k] = (f * 2 ** (-1 / 24)) / binHz;
    hi[k] = (f * 2 ** (1 / 24)) / binHz;
  }
  const chroma = new Float64Array(12);
  const frame = new Float64Array(12);
  const cum = new Float64Array(nBins + 1);
  for (const power of frames) {
    for (let b = 0; b < nBins; b++) cum[b + 1] = cum[b] + power[b];
    frame.fill(0);
    for (let k = 0; k < nBands; k++) frame[(9 + k) % 12] += bandPower(cum, lo[k], hi[k]) ** KEY_COMPRESS; // band 0 is an A
    let peak = 0;
    for (let i = 0; i < 12; i++) peak = Math.max(peak, frame[i]);
    if (!(peak > 0)) continue;
    for (let i = 0; i < 12; i++) chroma[i] += frame[i] / peak;
  }
  let mean = 0;
  let steps = 0;
  for (let i = 0; i < 12; i++) {
    mean += chroma[i] / 12;
    steps += Math.abs(chroma[i] - chroma[(i + 11) % 12]) / 12;
  }
  if (!(mean > 0)) return null;
  const contrast = steps / mean;
  if (!(contrast > KEY_CONTRAST_MIN)) return null; // flat: noise, or nothing tonal at all

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
  if (!(r1 > 0)) return null;
  // Confidence: the winner's correlation, discounted when the runner-up is breathing down its
  // neck (a 0.05 correlation margin counts as fully decisive - K-S margins are small numbers)
  // and when the chroma is nearly flat (contrast 0.085 and up counts as fully tonal).
  const confidence = Math.round(
    clamp01(r1) * clamp01((r1 - r2) / 0.05) * clamp01((contrast - KEY_CONTRAST_MIN) / 0.05) * 100,
  ) / 100;
  return { key: bestName, confidence };
}

// ---------------------------------------------------------------------------------------------

/**
 * Everything a deck wants to know about a song, from its audio as mono samples:
 * { bpm, bpmConfidence, anchorSec, gridConfidence, key, keyConfidence, onsets } with nulls where
 * nothing could be read. `bpmHint` (the file's tag, the playlist's word) pins the tempo octave
 * and is refined, not replaced: the grid fit measures the period over the whole track, and a
 * tag's "128" is usually 127.98. `onsetFracs` are the transient detector's positions (0..1 of
 * the file - see samples.js's detectOnsets), which come back as the seconds the anchor and cue
 * gestures snap to.
 */
export function songFactsOf(samples, sampleRate, { bpmHint = null, onsetFracs = [] } = {}) {
  const grid = fitBeatGrid(samples, sampleRate, bpmHint);
  const bpm = grid ? null : detectBpm(samples, sampleRate);
  const key = detectKey(samples, sampleRate);
  const seconds = samples.length / sampleRate;
  const onsets = onsetFracs.map((frac) => frac * seconds);
  // The grid fit reads an 11ms envelope; the transient detector a 5ms one that backs onto the
  // attack. Land the anchor on the hit it found (when there is one within about a hop - any
  // further and it is usually some other hit just before the beat, which pulls the grid early),
  // so the grid and the gestures that snap to transients agree on where a beat is.
  let anchorSec = grid?.anchorSec ?? null;
  if (anchorSec != null && onsets.length) {
    const near = onsets.reduce((b, t) => (Math.abs(t - anchorSec) < Math.abs(b - anchorSec) ? t : b), Infinity);
    if (Math.abs(near - anchorSec) <= 0.01) anchorSec = near;
  }
  return {
    bpm: grid?.bpm ?? bpm?.bpm ?? null,
    bpmConfidence: grid ? grid.confidence : (bpm?.confidence ?? null),
    anchorSec,
    gridConfidence: grid?.confidence ?? null,
    key: key?.key ?? null,
    keyConfidence: key?.confidence ?? null,
    onsets,
  };
}

export { fft };
