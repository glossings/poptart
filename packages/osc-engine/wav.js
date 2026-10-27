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
 * @returns {{ sampleRate: number, channels: number, frames: number, totalFrames: number, data: Float32Array } | null}
 *   `data` is interleaved samples in -1..1; null for anything this reader can't decode.
 *   `frames` is what was decoded; `totalFrames` is what the header says the file holds. They
 *   differ only when the buffer was cut short of the data chunk - the sample map reads just
 *   the head of a long file and still wants to know how long the whole thing is.
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

/**
 * The wavetable frame length a WAV declares in its `clm ` chunk ("<!>2048 ..."), the spelling
 * wavetable editors share - or 0 when it declares none, or the file is not a WAV.
 *
 * The browser's decodeWav reads the same chunk before cutting a file into frames; on the desktop
 * the frames are read into a server buffer, which keeps none of the header, so the engine reads
 * this much of the file itself. Only the chunk headers are read, never the samples.
 */
function wavFrameLength(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return 0;
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return 0;
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(8);
    let at = 12;
    while (at + 8 <= size) {
      if (fs.readSync(fd, chunk, 0, 8, at) < 8) return 0;
      const id = chunk.toString('ascii', 0, 4);
      const length = chunk.readUInt32LE(4);
      if (id === 'clm ') {
        const text = Buffer.alloc(Math.min(length, 64));
        fs.readSync(fd, text, 0, text.length, at + 8);
        const m = /<!>(\d+)/.exec(text.toString('latin1'));
        return m ? Number(m[1]) : 0;
      }
      at += 8 + length + (length & 1);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
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
    if (id === 'data') data = { off: body, size: Math.min(size, buf.length - body), declared: size };
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
  // A streamed file can declare 0 or 0xffffffff (unknown length); trust what was read then.
  const declared = Math.floor(data.declared / (bytesPer * channels));
  const totalFrames = declared >= frames && data.declared !== 0xffffffff ? declared : frames;
  return { sampleRate, channels, frames, totalFrames, data: out };
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

/** What a normalized take peaks at: -1 dBFS, which leaves a resampler's overshoot somewhere to go. */
const NORMALIZE_PEAK = 10 ** (-1 / 20);
/** Below this a take is silence (see `silent` below), and gain would only bring up the noise floor. */
const SILENT_PEAK = 0.001;

/**
 * Scale a take, in place, so its loudest sample sits at NORMALIZE_PEAK - up for a quiet one, down
 * for one that went over. A bounce is a sample from here on, and a sample that has to be found
 * again with .gain() every time it is used is a worse sample. A silent take is left alone.
 *
 * @returns {number} the linear gain applied (1 when nothing was done).
 */
function normalizePeak(audio, target = NORMALIZE_PEAK) {
  let peak = 0;
  for (let i = 0; i < audio.data.length; i++) peak = Math.max(peak, Math.abs(audio.data[i]));
  if (peak < SILENT_PEAK) return 1;
  const gain = target / peak;
  for (let i = 0; i < audio.data.length; i++) audio.data[i] *= gain;
  return gain;
}

/**
 * Read a raw capture, cut the window out of it, and write the result. Takes the window in SECONDS
 * because that is what the caller knows - the transport's times - and the sample rate it would
 * need to convert them is inside the file. Returns what it wrote (plus the drawable peaks,
 * computed here because the samples are already in memory), or null if the capture couldn't be
 * read at all.
 *
 * @param {{ startSec: number, lengthSec: number, wrapTail?: boolean, normalize?: boolean, peakBuckets?: number }} opts
 *   `startSec` is the pre-roll's length; see trimWindow for `wrapTail`. `normalize` (on by default)
 *   brings the take's peak to NORMALIZE_PEAK - after the wrap, since a folded tail adds to the head.
 */
function trimRecording(srcPath, destPath, { startSec, lengthSec, wrapTail = false, normalize = true, peakBuckets = DEFAULT_BUCKETS }) {
  const src = readWavRaw(srcPath);
  if (!src) return null;
  const out = trimWindow(src, {
    startFrame: startSec * src.sampleRate,
    lengthFrames: lengthSec * src.sampleRate,
    wrapTail,
  });
  const gain = normalize ? normalizePeak(out) : 1;
  writeWav(destPath, out);
  const env = envelope(out, peakBuckets);
  return {
    sampleRate: out.sampleRate,
    channels: out.channels,
    frames: out.frames,
    seconds: out.frames / out.sampleRate,
    gainDb: 20 * Math.log10(gain), // what normalizing added (0 when off, or nothing to do)
    ...env,
    // Nothing came out of the track - almost always a routing or mute mistake, and worth saying so
    // before the bounce is written into the code rather than after.
    silent: Math.max(...env.peaks) < SILENT_PEAK,
  };
}

// The envelope, the song waveform's detail and overview and the band balance are
// wave-core.mjs, which the browser build draws with too.
const { envelope, reduceEnvelope, normalizeBands, waveformOf, DEFAULT_BUCKETS } = require('./wave-core.mjs');

/**
 * Everything the song deck's waveform pane draws (see wave-core.mjs's waveformOf), from a WAV on
 * the disk. `wavPath` must be a WAV - songs.js's resolveSongFile({ wav: true }) gets any
 * deck-playable file there first. Returns null when the file can't be read as WAV. Runs on the
 * analysis worker (see analysis.js) - a 5-minute file is a full read plus filter math, well past
 * the note scheduler's budget.
 */
function songWaveform(wavPath, opts = {}) {
  const src = readWavRaw(wavPath);
  if (!src) return null;
  return waveformOf(src, opts);
}

/** Per-bucket peak amplitude across all channels. See envelope(), which computes it. */
function peaks(audio, buckets = DEFAULT_BUCKETS) {
  return envelope(audio, buckets).peaks;
}

/** Per-bucket [low, mid, high] energy balance. See envelope(), which computes it. */
function bands(audio, buckets = DEFAULT_BUCKETS) {
  return envelope(audio, buckets).bands;
}

module.exports = {
  readWavRaw,
  wavFrameLength,
  decodeWavRaw,
  encodeWav,
  writeWav,
  trimWindow,
  normalizePeak,
  NORMALIZE_PEAK,
  trimRecording,
  envelope,
  reduceEnvelope,
  songWaveform,
  peaks,
  bands,
};
