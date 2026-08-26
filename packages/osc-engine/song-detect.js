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

const { readWav, detectOnsets } = require('./samples');

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
function onsetFlux(samples, sampleRate, { lowpass = false } = {}) {
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
function combinedFlux(samples, sampleRate) {
  const hi = onsetFlux(samples, sampleRate);
  const lo = onsetFlux(samples, sampleRate, { lowpass: true });
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const mh = mean(hi) || 1;
  const ml = mean(lo) || 1;
  const out = new Float32Array(hi.length);
  for (let i = 0; i < hi.length; i++) out[i] = hi[i] / mh + lo[i] / ml;
  return { flux: out, bass: lo };
}

function detectBpm(samples, sampleRate, precomputedFlux = null) {
  const nHops = Math.floor(samples.length / BPM_HOP);
  if (nHops < 64) return null; // not even a couple of seconds of envelope
  const envRate = sampleRate / BPM_HOP;
  const flux = precomputedFlux ?? combinedFlux(samples, sampleRate).flux;

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
// Beatgrid - phase comb + least-squares grid fit + downbeat pick
// ---------------------------------------------------------------------------------------------
//
// What DJ software computes on analysis and what tempo sync actually needs: not just "about
// 128 bpm" but WHERE the beats are - a period to a hundredth of a bpm (a tenth of a bpm off
// drifts a locked pair by ~25ms a minute, a flam inside three) and the offset of beat one.
// A cue-and-anchor by hand is the fallback for when this guesses wrong, not the workflow.
//
// 1. Phase: with the period known (the tag's bpm, or detectBpm's), comb the onset flux over a
//    window in the middle of the track for the offset that lands on the most onset energy.
// 2. Fit: walk the predicted beats over the WHOLE track, pick the flux peak near each, and
//    least-squares a line through (beat index, peak time). The slope is the period measured
//    over hundreds of beats - far past the envelope's own resolution - and the intercept the
//    phase. Iterated, since a better period finds more peaks.
// 3. Downbeat: of the four beat classes, the one whose beats carry the most low-frequency
//    onset energy (the kick) - a heuristic that's right far more often than not on club music,
//    and the anchor button fixes the rest.

const GRID_SEARCH_FRAC = 1 / 6; // how far from a predicted beat its onset may sit (in beats)
const GRID_FIT_PASSES = 3;

/**
 * Fit the beatgrid of a mono signal. `bpmHint` (a tag, a typed value) fixes the tempo octave
 * and starting period; without it detectBpm's estimate does. Returns
 * { bpm, anchorSec, confidence } or null when no periodic structure could be read.
 */
function fitBeatGrid(samples, sampleRate, bpmHint = null) {
  const nHops = Math.floor(samples.length / BPM_HOP);
  if (nHops < 64) return null;
  const envRate = sampleRate / BPM_HOP;
  const { flux, bass } = combinedFlux(samples, sampleRate);
  let bpm0 = Number.isFinite(bpmHint) && bpmHint > 20 && bpmHint < 400 ? bpmHint : null;
  if (bpm0 == null) {
    const est = detectBpm(samples, sampleRate, flux);
    if (!est) return null;
    bpm0 = est.bpm;
  }
  let period = (60 * envRate) / bpm0; // hops per beat
  let mean = 0;
  for (let h = 0; h < nHops; h++) mean += flux[h];
  mean /= nHops;
  if (mean <= 0) return null;

  // 1. Coarse phase over ~30s mid-track (short enough that a period a tenth of a bpm off
  //    hasn't wandered a whole beat by the far end).
  const win = Math.min(nHops, Math.round(30 * envRate));
  const at = Math.floor((nHops - win) / 2);
  const fluxAt = (t) => {
    const lo = Math.floor(t);
    if (lo < 0 || lo + 1 >= nHops) return 0;
    return flux[lo] + (flux[lo + 1] - flux[lo]) * (t - lo);
  };
  let phase = 0;
  let best = -Infinity;
  for (let p = 0; p < period; p += 0.5) {
    let score = 0;
    for (let t = at + p; t < at + win; t += period) score += fluxAt(t);
    if (score > best) {
      best = score;
      phase = at + p;
    }
  }

  // 2. Least-squares grid fit over the whole track, iterated.
  const reach = Math.max(1, Math.round(period * GRID_SEARCH_FRAC));
  const threshold = mean * 1.5;
  let accepted = 0;
  let total = 0;
  for (let pass = 0; pass < GRID_FIT_PASSES; pass++) {
    const kMin = Math.ceil((1 - phase) / period);
    const kMax = Math.floor((nHops - 2 - phase) / period);
    let n = 0;
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    total = 0;
    for (let k = kMin; k <= kMax; k++) {
      total++;
      const pred = phase + k * period;
      const c = Math.round(pred);
      let peak = -1;
      let peakV = threshold;
      for (let h = Math.max(1, c - reach); h <= Math.min(nHops - 2, c + reach); h++) {
        if (flux[h] > peakV && flux[h] >= flux[h - 1] && flux[h] >= flux[h + 1]) {
          peakV = flux[h];
          peak = h;
        }
      }
      if (peak < 0) continue;
      // Sub-hop refinement of the peak position (parabola through its neighbours).
      const denom = flux[peak - 1] - 2 * flux[peak] + flux[peak + 1];
      const t = peak + (denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (flux[peak - 1] - flux[peak + 1])) / denom)) : 0);
      n++;
      sk += k;
      st += t;
      skk += k * k;
      skt += k * t;
    }
    accepted = n;
    if (n < 8) break; // too sparse a grid to fit - keep the comb's answer
    const varK = skk - (sk * sk) / n;
    if (varK <= 0) break;
    const slope = (skt - (sk * st) / n) / varK;
    const intercept = st / n - slope * (sk / n);
    // A fit that wanders more than a few percent from the starting tempo has latched onto
    // something else (a fill, a breakdown); keep the period we trust and only take the phase.
    if (Math.abs(slope / period - 1) < 0.03) period = slope;
    phase = intercept;
  }
  if (!(period > 0)) return null;

  // 2b. Produced tempos are whole numbers (or halves) far more often than not, and a fit a
  //     tenth off is usually the fit's error, not the track's. Comb the whole track at the
  //     free period and at the nearest integer / half-integer; a comb over minutes is brutally
  //     sensitive to period (a tenth of a bpm walks half a beat across a track), so if the
  //     round tempo scores as well, it IS the tempo - and if the track really is 139.9, the
  //     round comb collapses and the free fit stands.
  const combScore = (p) => {
    let bestP = 0;
    for (let ph = 0; ph < p; ph += 0.5) {
      let sc = 0;
      for (let t = phase + ph - Math.floor((phase + ph) / p) * p; t < nHops - 1; t += p) sc += fluxAt(t);
      if (sc > bestP) bestP = sc;
    }
    return bestP;
  };
  const freeBpm = (60 * envRate) / period;
  const roundBpm = Math.round(freeBpm * 2) / 2;
  if (Math.abs(roundBpm - freeBpm) > 1e-6 && Math.abs(roundBpm - freeBpm) < 0.3) {
    const roundPeriod = (60 * envRate) / roundBpm;
    if (combScore(roundPeriod) >= 0.97 * combScore(period)) {
      // Re-run the phase fit at the round period so the anchor sits where THIS grid's beats do.
      period = roundPeriod;
      const kMin = Math.ceil((1 - phase) / period);
      const kMax = Math.floor((nHops - 2 - phase) / period);
      let n = 0;
      let sum = 0;
      for (let k = kMin; k <= kMax; k++) {
        const c = Math.round(phase + k * period);
        let peak = -1;
        let peakV = threshold;
        for (let h = Math.max(1, c - reach); h <= Math.min(nHops - 2, c + reach); h++) {
          if (flux[h] > peakV && flux[h] >= flux[h - 1] && flux[h] >= flux[h + 1]) {
            peakV = flux[h];
            peak = h;
          }
        }
        if (peak < 0) continue;
        n++;
        sum += peak - k * period;
      }
      if (n) phase = sum / n;
    }
  }

  // 3. Downbeat. Kick weight alone can't tell (four-on-the-floor puts one on every beat), so
  //    three readings vote, each over the whole track:
  //    - novelty: how much the sound CHANGES going into each beat (bass / highs / level, per
  //      beat) - elements enter and leave on bar lines, and far more so on 4- and 8-bar
  //      phrase lines, so the 16-beat class with the most change names the downbeat too;
  //    - backbeat: snare on 2 and 4 - the highs flux decides {1,3} against {2,4} (never 1
  //      against 3, which is the two readings above's job);
  //    - kick weight: bass flux per class, for the tracks that do hit beat one harder.
  const highs = onsetFlux(samples, sampleRate);
  const level = new Float32Array(nHops);
  const bassLevel = new Float32Array(nHops);
  {
    const a = Math.exp((-2 * Math.PI * 120) / sampleRate);
    let lp = 0;
    for (let h = 0; h < nHops; h++) {
      let e = 0;
      let eb = 0;
      for (let i = h * BPM_HOP; i < (h + 1) * BPM_HOP; i++) {
        lp = a * lp + (1 - a) * samples[i];
        e += samples[i] * samples[i];
        eb += lp * lp;
      }
      level[h] = Math.sqrt(e / BPM_HOP);
      bassLevel[h] = Math.sqrt(eb / BPM_HOP);
    }
  }
  const nBeats = Math.floor((nHops - 1 - phase) / period);
  const feat = []; // per beat: [bass level, highs level (diff env ~ flux base), overall level]
  for (let k = 0; k < nBeats; k++) {
    const h0 = Math.max(0, Math.round(phase + k * period));
    const h1 = Math.min(nHops, Math.round(phase + (k + 1) * period));
    let b = 0;
    let l = 0;
    let f = 0;
    for (let h = h0; h < h1; h++) {
      b += bassLevel[h];
      l += level[h];
      f += highs[h];
    }
    const n = Math.max(1, h1 - h0);
    feat.push([b / n, Math.max(0, l - b) / n, l / n, f / n]);
  }
  // Novelty: how different beat k is from the same beat of the bar BEFORE (k-4, so a snare on
  // two and four compares with a snare, not a kick), credited only where the change BEGINS -
  // an element that enters stays different for a bar or more, and the bar line is the first
  // beat of that, not all four.
  const dist = new Float32Array(nBeats);
  for (let k = 4; k < nBeats; k++) {
    let v = 0;
    for (let j = 0; j < 3; j++) {
      const a = feat[k][j];
      const b = feat[k - 4][j];
      v += Math.abs(a - b) / (a + b + 1e-6);
    }
    dist[k] = v;
  }
  // Below NOVELTY_FLOOR a "change" is level wobble, not an event - identical bars must cast
  // no vote at all, or their noise gets normalized up into one.
  const NOVELTY_FLOOR = 0.3;
  const novelty = new Float32Array(nBeats);
  for (let k = 5; k < nBeats; k++) {
    const v = dist[k] - dist[k - 1];
    novelty[k] = v >= NOVELTY_FLOOR ? v : 0;
  }
  const bassAt = (t) => {
    const lo = Math.floor(t);
    if (lo < 0 || lo + 1 >= nHops) return 0;
    return bass[lo] + (bass[lo + 1] - bass[lo]) * (t - lo);
  };
  const nov4 = [0, 0, 0, 0];
  const nov16 = new Array(16).fill(0);
  const onset4 = [0, 0, 0, 0];
  const kick4 = [0, 0, 0, 0];
  let events = 0;
  for (let k = 0; k < nBeats; k++) {
    // The first and last bars are partial (the fade-in, the file's end) and change for no
    // musical reason - they cast no novelty vote.
    if (k >= 8 && k < nBeats - 8 && novelty[k] > 0) {
      events++;
      nov4[k % 4] += novelty[k];
      nov16[k % 16] += novelty[k];
    }
    onset4[k % 4] += feat[k][3];
    kick4[k % 4] += bassAt(phase + k * period);
  }
  // A couple of events is an accident, not structure - novelty only votes once it repeats.
  if (events < 6) nov4.fill(0) && nov16.fill(0);
  // Each reading votes by CONTRAST - how far a class stands above the reading's mean, relative
  // to it - so a flat reading (four equal kicks, no phrase changes) says nothing, rather than
  // having its noise scaled up to a full vote.
  const excess = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.map((v) => (m > 0 ? (v - m) / m : 0));
  };
  const n4 = excess(nov4);
  const n16 = excess(nov16);
  const k4 = excess(kick4);
  const snarePair = [onset4[0] + onset4[2], onset4[1] + onset4[3]];
  const backbeat = (snarePair[1] - snarePair[0]) / (snarePair[0] + snarePair[1] + 1e-9); // + favours {0,2}
  if (process.env.POPTART_GRID_DEBUG) {
    const f = (a) => a.map((v) => +v.toFixed(2));
    console.error(JSON.stringify({ events, n4: f(n4), n16: f(n16), k4: f(k4), backbeat: +backbeat.toFixed(2), phase: +phase.toFixed(1), period: +period.toFixed(2) })); // eslint-disable-line no-console
  }
  let down = 0;
  let downScore = -Infinity;
  for (let c = 0; c < 4; c++) {
    let phraseBest = 0;
    for (let c16 = c; c16 < 16; c16 += 4) phraseBest = Math.max(phraseBest, n16[c16]);
    const score = 0.5 * n4[c] + 0.5 * phraseBest + k4[c] + (c % 2 === 0 ? backbeat : -backbeat);
    if (score > downScore) {
      downScore = score;
      down = c;
    }
  }
  const bar = 4 * period;
  let anchor = phase + down * period;
  anchor -= Math.floor(anchor / bar) * bar; // the first downbeat at or after the top of the file
  const bpm = Math.round(((60 * envRate) / period) * 100) / 100;
  if (bpm < 20 || bpm > 400) return null;
  return {
    bpm,
    anchorSec: (anchor * BPM_HOP) / sampleRate,
    confidence: Math.round(clamp01(total ? accepted / total : 0) * 100) / 100,
  };
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
 * Everything a deck wants to know about a WAV file, in one read:
 * { bpm, bpmConfidence, anchorSec, gridConfidence, key, keyConfidence, onsets } with nulls
 * where nothing could be read, or null when the file isn't a parseable WAV at all. `bpmHint`
 * (the file's tag, the playlist's word) pins the tempo octave and is refined, not replaced:
 * the grid fit measures the period over the whole track, and a tag's "128" is usually 127.98.
 * `onsets` are the transient times (seconds) the anchor and cue gestures snap to.
 * `wavPath` must already be a WAV - see songs.js's resolveSongFile({ wav: true }).
 */
function detectSongFacts(wavPath, { bpmHint = null } = {}) {
  const wav = readWav(wavPath);
  if (!wav) return null;
  const grid = fitBeatGrid(wav.samples, wav.sampleRate, bpmHint);
  const bpm = grid ? null : detectBpm(wav.samples, wav.sampleRate);
  const key = detectKey(wav.samples, wav.sampleRate);
  const seconds = wav.samples.length / wav.sampleRate;
  const onsets = detectOnsets(wav.samples, wav.sampleRate).map((frac) => frac * seconds);
  // The grid fit reads an 11ms envelope; the transient detector a 5ms one that backs onto the
  // attack. Land the anchor on the hit it found (when there is one within a hop or two), so
  // the grid and the gestures that snap to transients agree on where a beat is.
  let anchorSec = grid?.anchorSec ?? null;
  if (anchorSec != null && onsets.length) {
    const near = onsets.reduce((b, t) => (Math.abs(t - anchorSec) < Math.abs(b - anchorSec) ? t : b), Infinity);
    if (Math.abs(near - anchorSec) <= 0.03) anchorSec = near;
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

module.exports = { detectSongFacts, detectBpm, detectKey, fitBeatGrid };
