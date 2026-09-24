// What a bounce becomes once it is captured: cut, folded, leveled, drawn and written as a file.
//
// The desktop does this to a file on disk (osc-engine's wav.js, trimRecording); this is the same
// arithmetic on the frames the page's recorder hands back, so a take made in either build comes
// out the same. The numbers are wav.js's: a 10 ms fade on a folded tail's end, a -1 dBFS peak
// for a normalized take, 0.001 as the line below which a take is silence, 1520 buckets across the
// drawn waveform, and a three-band color split at 200 Hz and 2 kHz. Written as 24-bit PCM.

const TAIL_FADE_SEC = 0.01;
const NORMALIZE_PEAK = 10 ** (-1 / 20);
const SILENT_PEAK = 0.001;
const DEFAULT_BUCKETS = 1520;
const BAND_LOW_HZ = 200;
const BAND_HIGH_HZ = 2000;
/** Names a recording may not take, because the language reads them as something else. */
const RESERVED = new Set(['r', 'i', 'p', 'round', 'floor', 'ceil']);

/** Two channels as one interleaved buffer, the shape the rest of this file works on. */
export function interleave({ sampleRate, left, right }) {
  const frames = left.length;
  const data = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) { data[f * 2] = left[f]; data[f * 2 + 1] = right[f]; }
  return { sampleRate, channels: 2, frames, data };
}

/**
 * The window out of a capture that ran on past it. `wrapTail` folds what came after the window -
 * the release of its last notes - back over its head, never more than the window itself, with
 * only the tail's own end faded so the seam it hides gets no dip. See wav.js for when it is wanted.
 */
export function trimWindow(src, { startFrame, lengthFrames, wrapTail = false }) {
  const { sampleRate, channels, frames } = src;
  const start = Math.max(0, Math.min(frames, Math.round(startFrame)));
  const length = Math.max(1, Math.min(frames - start, Math.round(lengthFrames)));
  const out = src.data.slice(start * channels, (start + length) * channels);
  if (wrapTail) {
    const tailStart = start + length;
    const tailFrames = Math.min(frames - tailStart, length);
    const fade = Math.min(tailFrames, Math.round(TAIL_FADE_SEC * sampleRate));
    for (let f = 0; f < tailFrames; f++) {
      const g = f >= tailFrames - fade ? (tailFrames - 1 - f) / Math.max(1, fade - 1) : 1;
      for (let c = 0; c < channels; c++) out[f * channels + c] += src.data[(tailStart + f) * channels + c] * g;
    }
  }
  return { sampleRate, channels, frames: length, data: out };
}

/** Scales a take in place so it peaks at -1 dBFS; a silent one is left alone. Returns the gain. */
export function normalizePeak(audio, target = NORMALIZE_PEAK) {
  let peak = 0;
  for (let i = 0; i < audio.data.length; i++) peak = Math.max(peak, Math.abs(audio.data[i]));
  if (peak < SILENT_PEAK) return 1;
  const gain = target / peak;
  for (let i = 0; i < audio.data.length; i++) audio.data[i] *= gain;
  return gain;
}

function normalizeBands(acc) {
  const total = acc[0] + acc[1] + acc[2];
  if (total <= 1e-12) return [0, 1, 0];
  return acc.map((v) => Math.round((v / total) * 100) / 100);
}

/** Per bucket: the peak across the channels, the rms of their mix, and the low/mid/high balance. */
export function envelope(audio, buckets = DEFAULT_BUCKETS) {
  const { sampleRate, channels, frames, data } = audio;
  const n = Math.max(1, Math.min(Math.round(buckets), frames));
  const kLow = 1 - Math.exp((-2 * Math.PI * BAND_LOW_HZ) / sampleRate);
  const kHigh = 1 - Math.exp((-2 * Math.PI * BAND_HIGH_HZ) / sampleRate);
  let lpLow = 0;
  let lpHigh = 0;
  const peaks = new Array(n).fill(0);
  const rms = new Array(n).fill(0);
  const bands = new Array(n);
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * frames) / n);
    const to = Math.max(from + 1, Math.floor(((b + 1) * frames) / n));
    const acc = [0, 0, 0];
    let peak = 0;
    let sumSq = 0;
    for (let f = from; f < to; f++) {
      let mono = 0;
      for (let c = 0; c < channels; c++) {
        const v = data[f * channels + c] ?? 0;
        mono += v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      mono /= channels;
      sumSq += mono * mono;
      lpLow += kLow * (mono - lpLow);
      lpHigh += kHigh * (mono - lpHigh);
      acc[0] += lpLow * lpLow;
      acc[1] += (lpHigh - lpLow) ** 2;
      acc[2] += (mono - lpHigh) ** 2;
    }
    peaks[b] = Math.round(peak * 1000) / 1000;
    rms[b] = Math.round(Math.sqrt(sumSq / (to - from)) * 1000) / 1000;
    bands[b] = normalizeBands(acc);
  }
  return { peaks, rms, bands };
}

/** 24-bit PCM WAV bytes. A sample past full scale saturates rather than wrapping round. */
export function encodeWav({ sampleRate, channels, data }) {
  const bytesPer = 3;
  const dataBytes = data.length * bytesPer;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPer, true);
  view.setUint16(32, channels * bytesPer, true);
  view.setUint16(34, bytesPer * 8, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, data[i])) * 0x7fffff);
    const at = 44 + i * bytesPer;
    view.setUint8(at, v & 0xff);
    view.setUint8(at + 1, (v >> 8) & 0xff);
    view.setUint8(at + 2, (v >> 16) & 0xff);
  }
  return buf;
}

/**
 * The whole pass: a capture that began `startSec` before the window, cut to `lengthSec`, folded
 * and leveled as asked. Answers the file's bytes and what the record panel draws.
 */
export function finishTake(capture, { startSec, lengthSec, wrapTail = false, normalize = true }) {
  const src = interleave(capture);
  const out = trimWindow(src, { startFrame: startSec * src.sampleRate, lengthFrames: lengthSec * src.sampleRate, wrapTail });
  const gain = normalize ? normalizePeak(out) : 1;
  const env = envelope(out);
  return {
    bytes: encodeWav(out),
    info: {
      sampleRate: out.sampleRate,
      channels: out.channels,
      frames: out.frames,
      seconds: out.frames / out.sampleRate,
      gainDb: 20 * Math.log10(gain),
      ...env,
      silent: Math.max(...env.peaks) < SILENT_PEAK,
    },
  };
}

/** A recording name that is one plain segment - the desktop's rule (osc-engine's recordings.js). */
export function sanitizeName(raw) {
  let name = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) name = 'take';
  if (RESERVED.has(name)) name = `${name}-take`;
  if (/^\d/.test(name)) name = `t${name}`; // a bare number is a value, not a name
  return name.slice(0, 64);
}

/** "bass", then "bass-2", "bass-3" … - unique among the names already taken. */
export function mintName(base, taken) {
  const clean = sanitizeName(base);
  const have = new Set(taken);
  if (!have.has(clean)) return clean;
  for (let n = 2; ; n++) if (!have.has(`${clean}-${n}`)) return `${clean}-${n}`;
}
