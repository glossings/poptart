// The waveform maths, shared by both builds: a recording's or a song's peak, rms and band
// balance per bucket, and the song deck's detail strip and overview built from them.
//
// As an ES module with no disk in it, so the desktop (wav.js, which reads the WAV off the disk)
// and the browser build (a worker handed decoded audio) draw a song the same way. Nothing here
// may reach for node or the DOM.

// Crossover frequencies for the three-band color split. Not a mixing decision - just enough
// separation for a kick, a snare body, and a hi-hat to land in visibly different bands.
export const BAND_LOW_HZ = 200;
export const BAND_HIGH_HZ = 2000;

// Buckets per drawn waveform. Roughly two per screen pixel at the panel's width: the resolution
// is what stops a busy track reading as one solid block, and it costs a few tens of KB once per
// bounce on a localhost poll.
export const DEFAULT_BUCKETS = 1520;

/**
 * Everything the editor draws a waveform from, in ONE pass over the samples: per-bucket peak, per
 * bucket RMS, and the low/mid/high energy balance that colors it.
 *
 * Peak AND rms, because peak alone is what makes a waveform look like a blob: over a bucket of a
 * few milliseconds a busy track hits near full scale almost every time, so the outline saturates
 * and all the dynamics vanish. Drawing the quieter rms body inside the peak envelope is what puts
 * the shape back - it's why a DJ waveform reads as music rather than a rectangle.
 *
 * The band split is two nested one-pole lowpasses: below the first is "low", between them "mid",
 * what's left is "high", each normalized so the three sum to 1. Deliberately crude (6dB/octave, on
 * a mono mixdown) because it drives a color, not a crossover.
 *
 * `audio` is { sampleRate, channels, frames } with the samples either interleaved in `data`
 * (-1..1, the WAV reader's shape) or one array per channel in `planes`, each read times `scale`
 * (the browser keeps a decoded song as 16-bit planes - see its song player - so `scale` is
 * 1/32768 there).
 *
 * @returns {{ peaks: number[], rms: number[], bands: Array<[number, number, number]> }}
 */
export function envelope(audio, buckets = DEFAULT_BUCKETS) {
  const { sampleRate, frames, planes = null, scale = 1 } = audio;
  const channels = planes ? planes.length : audio.channels;
  const data = audio.data;
  const n = Math.max(1, Math.min(Math.round(buckets), frames));
  // One-pole coefficients: the fraction of the new sample each filter takes per step.
  const kLow = 1 - Math.exp((-2 * Math.PI * BAND_LOW_HZ) / sampleRate);
  const kHigh = 1 - Math.exp((-2 * Math.PI * BAND_HIGH_HZ) / sampleRate);
  let lpLow = 0;
  let lpHigh = 0;

  const outPeaks = new Array(n).fill(0);
  const outRms = new Array(n).fill(0);
  const outBands = new Array(n);

  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * frames) / n);
    const to = Math.max(from + 1, Math.floor(((b + 1) * frames) / n));
    const acc = [0, 0, 0];
    let peak = 0;
    let sumSq = 0;
    for (let f = from; f < to; f++) {
      let mono = 0;
      for (let c = 0; c < channels; c++) {
        const v = planes ? planes[c][f] * scale : data[f * channels + c];
        mono += v;
        const a = Math.abs(v);
        if (a > peak) peak = a; // peak is across the channels, not of their sum
      }
      mono /= channels;
      sumSq += mono * mono;
      lpLow += kLow * (mono - lpLow);
      lpHigh += kHigh * (mono - lpHigh);
      // The filters nest, so each band is the difference between two of them.
      acc[0] += lpLow * lpLow;
      acc[1] += (lpHigh - lpLow) ** 2;
      acc[2] += (mono - lpHigh) ** 2;
    }
    outPeaks[b] = Math.round(peak * 1000) / 1000;
    outRms[b] = Math.round(Math.sqrt(sumSq / (to - from)) * 1000) / 1000;
    outBands[b] = normalizeBands(acc);
  }
  return { peaks: outPeaks, rms: outRms, bands: outBands };
}

// --- the song decks' waveform (songs phase 3) ---

// The zoomed strip's resolution: ~13ms per bucket, about a column per pixel at a typical DJ
// zoom (10s across ~800px). Capped so a very long file thins out evenly instead of producing
// an unbounded payload; the overview is folded from the detail so the file is read ONCE.
export const SONG_DETAIL_PER_SEC = 75;
export const SONG_DETAIL_MAX = 30000; // full resolution up to ~6.5 minutes
export const SONG_OVERVIEW_BUCKETS = 1200;

/**
 * Fold an envelope down to fewer buckets: peak keeps the max, rms averages energy, and the
 * band balance is the energy-weighted mean of the folded buckets' shares (a loud bucket's
 * color should win over a near-silent neighbor's).
 */
export function reduceEnvelope(env, buckets) {
  const n = env.peaks.length;
  const m = Math.max(1, Math.min(Math.round(buckets), n));
  const outPeaks = new Array(m).fill(0);
  const outRms = new Array(m).fill(0);
  const outBands = new Array(m);
  for (let b = 0; b < m; b++) {
    const from = Math.floor((b * n) / m);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / m));
    let peak = 0;
    let sumSq = 0;
    const acc = [0, 0, 0];
    for (let i = from; i < to; i++) {
      if (env.peaks[i] > peak) peak = env.peaks[i];
      const e = (env.rms[i] ?? 0) ** 2;
      sumSq += e;
      const w = e || 1e-9; // silence still votes, just barely - keeps a quiet region neutral
      for (let c = 0; c < 3; c++) acc[c] += (env.bands[i]?.[c] ?? 0) * w;
    }
    outPeaks[b] = peak;
    outRms[b] = Math.round(Math.sqrt(sumSq / (to - from)) * 1000) / 1000;
    outBands[b] = normalizeBands(acc);
  }
  return { peaks: outPeaks, rms: outRms, bands: outBands };
}

/**
 * Everything the song deck's waveform pane draws, in one pass over the audio: a high-resolution
 * detail strip for the zoomed view and a full-track overview folded from it. `audio` is what
 * envelope() reads.
 *
 * @returns {{ seconds, sampleRate, channels,
 *             detail: { perSec, peaks, rms, bands },
 *             overview: { peaks, rms, bands } }}
 */
export function waveformOf(audio, {
  detailPerSec = SONG_DETAIL_PER_SEC,
  maxDetail = SONG_DETAIL_MAX,
  overviewBuckets = SONG_OVERVIEW_BUCKETS,
} = {}) {
  const seconds = audio.frames / audio.sampleRate;
  const detailBuckets = Math.max(1, Math.min(maxDetail, Math.round(seconds * detailPerSec)));
  const detail = envelope(audio, detailBuckets);
  const overview = reduceEnvelope(detail, overviewBuckets);
  return {
    seconds,
    sampleRate: audio.sampleRate,
    channels: audio.planes ? audio.planes.length : audio.channels,
    // From the envelope's ACTUAL bucket count (it clamps to the frame count), so a client
    // mapping time -> bucket index stays exact however short the file.
    detail: { perSec: detail.peaks.length / seconds, ...detail },
    overview,
  };
}

export function normalizeBands(acc) {
  const total = acc[0] + acc[1] + acc[2];
  // Silence has no balance to report - call it all mid so it draws in a neutral color rather
  // than whatever a divide-by-zero would produce.
  if (total <= 1e-12) return [0, 1, 0];
  return acc.map((v) => Math.round((v / total) * 100) / 100);
}
