'use strict';

// WAV read/write for the recorder's trim pass. samples.js's slice analysis only ever needed a
// mono mixdown, so its reader threw the channels away; bouncing a track has to keep them, and
// has to write a file back out. The RIFF parsing lives here now and samples.js mixes down from
// it, so there is one WAV reader in the package rather than two.
//
// Why a trim pass exists at all: freeing a DiskOut synth drops whatever is still sitting in its
// realtime buffer - up to ~1.4s at the default size - so a recording that ran for exactly the
// wanted window would come back short by an unpredictable amount. The engine instead records
// [pre-roll][window][post-roll] and this file cuts the exact window out of it, which also gives
// the release tail somewhere to go (see trimRecording's `wrapTail`).

const fs = require('node:fs');

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/**
 * Parse a WAV file, keeping its channels interleaved.
 * @returns {{ sampleRate: number, channels: number, frames: number, data: Float32Array } | null}
 *   `data` is interleaved samples in -1..1; null for anything this reader can't decode.
 */
function readWavRaw(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  return decodeWavRaw(buf);
}

/** The buffer half of readWavRaw - separated so tests can drive it without touching the disk. */
function decodeWavRaw(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { off: body, size };
    if (id === 'data') data = { off: body, size: Math.min(size, buf.length - body) };
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data || fmt.size < 16) return null;

  let format = buf.readUInt16LE(fmt.off);
  const channels = buf.readUInt16LE(fmt.off + 2);
  const sampleRate = buf.readUInt32LE(fmt.off + 4);
  const bits = buf.readUInt16LE(fmt.off + 14);
  if (format === 0xfffe && fmt.size >= 40) format = buf.readUInt16LE(fmt.off + 24); // EXTENSIBLE: real format is in the GUID
  if (!channels || !sampleRate) return null;

  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / (bytesPer * channels));
  if (!frames) return null;

  const readSample = sampleReader(format, bits, buf);
  if (!readSample) return null;

  const out = new Float32Array(frames * channels);
  for (let i = 0; i < out.length; i++) out[i] = readSample(data.off + i * bytesPer);
  return { sampleRate, channels, frames, data: out };
}

function sampleReader(format, bits, buf) {
  if (format === 1 && bits === 16) return (o) => buf.readInt16LE(o) / 0x8000;
  if (format === 1 && bits === 24) return (o) => ((buf.readIntLE(o, 3) << 8) >> 8) / 0x800000;
  if (format === 1 && bits === 32) return (o) => buf.readInt32LE(o) / 0x80000000;
  if (format === 1 && bits === 8) return (o) => (buf.readUInt8(o) - 128) / 128;
  if (format === 3 && bits === 32) return (o) => buf.readFloatLE(o);
  if (format === 3 && bits === 64) return (o) => buf.readDoubleLE(o);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/**
 * Encode interleaved float samples as a 24-bit PCM WAV. 24-bit because a bounce is a master, not
 * a delivery format: it costs 50% over int16 and puts the quantization floor far enough down that
 * a quiet track can be gained up afterwards without the noise coming with it.
 * @param {{ sampleRate: number, channels: number, data: Float32Array }} audio
 * @returns {Buffer}
 */
function encodeWav({ sampleRate, channels, data }) {
  const bytesPer = 3;
  const dataBytes = data.length * bytesPer;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // format 1 = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPer, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPer, 32); // block align
  buf.writeUInt16LE(bytesPer * 8, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < data.length; i++) {
    // Clamp before scaling: a sum that ran past unity (the tail wrap can do it) must saturate
    // rather than wrap around into the opposite polarity.
    const v = Math.max(-1, Math.min(1, data[i]));
    buf.writeIntLE(Math.round(v * 0x7fffff), 44 + i * bytesPer, 3);
  }
  return buf;
}

function writeWav(filePath, audio) {
  fs.writeFileSync(filePath, encodeWav(audio));
}

// ---------------------------------------------------------------------------------------------
// The trim pass
// ---------------------------------------------------------------------------------------------

/** Length of the equal-gain fade applied to a wrapped tail's own end, so folding it can't click. */
const TAIL_FADE_SEC = 0.01;

/**
 * Cut the exact recorded window out of a [pre-roll][window][post-roll] capture.
 *
 * `wrapTail` folds the post-roll (the release tail of the last events) back over the head of the
 * window, so a bounce started from silence still loops seamlessly. It defaults to OFF because the
 * usual case is bouncing a pattern that is ALREADY looping: at the window's start the previous
 * iteration's tail is still sounding and gets recorded into the head, and for a pattern whose
 * period divides the window that incoming tail is the same audio the outgoing one would be. Adding
 * it again would play the tail twice. Turn it on for a track that was silent going in.
 *
 * @param {{ sampleRate: number, channels: number, frames: number, data: Float32Array }} src
 * @param {object} opts
 * @param {number} opts.startFrame - first frame of the window (i.e. the pre-roll's length).
 * @param {number} opts.lengthFrames - the window's length.
 * @param {boolean} [opts.wrapTail] - fold the post-roll over the head (see above).
 * @returns {{ sampleRate: number, channels: number, frames: number, data: Float32Array }}
 */
function trimWindow(src, { startFrame, lengthFrames, wrapTail = false }) {
  const { sampleRate, channels, frames } = src;
  const start = Math.max(0, Math.min(frames, Math.round(startFrame)));
  const length = Math.max(1, Math.min(frames - start, Math.round(lengthFrames)));
  const out = src.data.slice(start * channels, (start + length) * channels);

  if (wrapTail) {
    const tailStart = start + length;
    // Never fold more than the window itself: a tail longer than the loop would wrap round onto
    // its own folded self, which is a delay effect, not a bounce.
    const tailFrames = Math.min(frames - tailStart, length);
    const fade = Math.min(tailFrames, Math.round(TAIL_FADE_SEC * sampleRate));
    for (let f = 0; f < tailFrames; f++) {
      // Only the tail's own truncated end is faded - its start must stay at full level, or the
      // seam it exists to hide gets a dip instead. The ramp reaches exactly 0 on the tail's last
      // frame, and exactly 1 where the un-faded region left off, so there's no step at either end.
      const g = f >= tailFrames - fade ? (tailFrames - 1 - f) / Math.max(1, fade - 1) : 1;
      for (let c = 0; c < channels; c++) {
        out[f * channels + c] += src.data[(tailStart + f) * channels + c] * g;
      }
    }
  }
  return { sampleRate, channels, frames: length, data: out };
}

/**
 * Read a raw capture, cut the window out of it, and write the result. Takes the window in SECONDS
 * because that is what the caller knows - the transport's times - and the sample rate it would
 * need to convert them is inside the file. Returns what it wrote (plus the drawable peaks,
 * computed here because the samples are already in memory), or null if the capture couldn't be
 * read at all.
 *
 * @param {{ startSec: number, lengthSec: number, wrapTail?: boolean, peakBuckets?: number }} opts
 *   `startSec` is the pre-roll's length; see trimWindow for `wrapTail`.
 */
function trimRecording(srcPath, destPath, { startSec, lengthSec, wrapTail = false, peakBuckets = DEFAULT_BUCKETS }) {
  const src = readWavRaw(srcPath);
  if (!src) return null;
  const out = trimWindow(src, {
    startFrame: startSec * src.sampleRate,
    lengthFrames: lengthSec * src.sampleRate,
    wrapTail,
  });
  writeWav(destPath, out);
  const env = envelope(out, peakBuckets);
  return {
    sampleRate: out.sampleRate,
    channels: out.channels,
    frames: out.frames,
    seconds: out.frames / out.sampleRate,
    ...env,
    // Nothing came out of the track - almost always a routing or mute mistake, and worth saying so
    // before the bounce is written into the code rather than after.
    silent: Math.max(...env.peaks) < 0.001,
  };
}

// Crossover frequencies for the three-band colour split. Not a mixing decision - just enough
// separation for a kick, a snare body, and a hi-hat to land in visibly different bands.
const BAND_LOW_HZ = 200;
const BAND_HIGH_HZ = 2000;

// Buckets per drawn waveform. Roughly two per screen pixel at the panel's width: the resolution
// is what stops a busy track reading as one solid block, and it costs a few tens of KB once per
// bounce on a localhost poll.
const DEFAULT_BUCKETS = 1520;

/**
 * Everything the editor draws a waveform from, in ONE pass over the samples: per-bucket peak, per
 * bucket RMS, and the low/mid/high energy balance that colours it.
 *
 * Peak AND rms, because peak alone is what makes a waveform look like a blob: over a bucket of a
 * few milliseconds a busy track hits near full scale almost every time, so the outline saturates
 * and all the dynamics vanish. Drawing the quieter rms body inside the peak envelope is what puts
 * the shape back - it's why a DJ waveform reads as music rather than a rectangle.
 *
 * The band split is two nested one-pole lowpasses: below the first is "low", between them "mid",
 * what's left is "high", each normalized so the three sum to 1. Deliberately crude (6dB/octave, on
 * a mono mixdown) because it drives a colour, not a crossover.
 *
 * @returns {{ peaks: number[], rms: number[], bands: Array<[number, number, number]> }}
 */
function envelope(audio, buckets = DEFAULT_BUCKETS) {
  const { sampleRate, channels, frames, data } = audio;
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
        const v = data[f * channels + c];
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

/** Per-bucket peak amplitude across all channels. See envelope(), which computes it. */
function peaks(audio, buckets = DEFAULT_BUCKETS) {
  return envelope(audio, buckets).peaks;
}

/** Per-bucket [low, mid, high] energy balance. See envelope(), which computes it. */
function bands(audio, buckets = DEFAULT_BUCKETS) {
  return envelope(audio, buckets).bands;
}

function normalizeBands(acc) {
  const total = acc[0] + acc[1] + acc[2];
  // Silence has no balance to report - call it all mid so it draws in a neutral colour rather
  // than whatever a divide-by-zero would produce.
  if (total <= 1e-12) return [0, 1, 0];
  return acc.map((v) => Math.round((v / total) * 100) / 100);
}

module.exports = {
  readWavRaw,
  decodeWavRaw,
  encodeWav,
  writeWav,
  trimWindow,
  trimRecording,
  envelope,
  peaks,
  bands,
};
