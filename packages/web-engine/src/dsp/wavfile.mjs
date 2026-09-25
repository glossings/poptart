// Reading a WAV file into float samples, in the page.
//
// The browser can decode audio itself, and for a sample that is the right tool. It is the wrong
// one for a WAVETABLE: decodeAudioData resamples to the context's rate, and a table is a stack
// of frames that are exactly 2048 samples long in the file - resampled to 48 kHz from 44.1, the
// frame boundaries land between samples and every waveform in the stack is read through the end
// of the one before it. So a table is read from its bytes here, at the file's own rate, and the
// frame length the file declares (or the one every wavetable editor assumes) is honored.
//
// PCM in 8, 16, 24 and 32 bits and IEEE float in 32 and 64 are read, which covers what an editor
// exports. Anything else - compressed, or a format tag this has never seen - is refused by name.

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function fourcc(view, at) {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

/**
 * Decodes a WAV file.
 *
 * Returns `{ sampleRate, channels, frameLength }` - `channels` an array of Float32Arrays in -1..1
 * and `frameLength` the wavetable frame size the file declares in a `clm ` chunk (the spelling
 * wavetable editors share), or null when it declares none.
 */
export function decodeWav(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buf);
  if (buf.byteLength < 12 || fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'WAVE') {
    throw new Error('[wav] not a WAV file');
  }
  let format = null;
  let data = null;
  let frameLength = null;
  let at = 12;
  while (at + 8 <= buf.byteLength) {
    const id = fourcc(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      let tag = view.getUint16(body, true);
      const channelCount = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      // An extensible header carries the real format tag in its sub-format GUID's first word.
      if (tag === FORMAT_EXTENSIBLE && size >= 26) tag = view.getUint16(body + 24, true);
      format = { tag, channelCount, sampleRate, bits };
    } else if (id === 'data') {
      data = { at: body, size: Math.min(size, buf.byteLength - body) };
    } else if (id === 'clm ') {
      // "<!>2048 01000000 wavetable (…)" - the first number is the frame length.
      let text = '';
      for (let i = 0; i < Math.min(size, 64); i++) text += String.fromCharCode(view.getUint8(body + i));
      const m = text.match(/<!>(\d+)/);
      if (m) frameLength = Number(m[1]);
    }
    at = body + size + (size & 1);
  }
  if (!format) throw new Error('[wav] no format chunk');
  if (!data) throw new Error('[wav] no data chunk');
  const { tag, channelCount, sampleRate, bits } = format;
  if (channelCount < 1) throw new Error('[wav] no channels');
  const bytesPer = bits / 8;
  if (!Number.isInteger(bytesPer) || bytesPer < 1 || bytesPer > 8) throw new Error(`[wav] ${bits}-bit samples are not readable here`);
  const frames = Math.floor(data.size / (bytesPer * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));

  let read;
  if (tag === FORMAT_FLOAT && bits === 32) read = (o) => view.getFloat32(o, true);
  else if (tag === FORMAT_FLOAT && bits === 64) read = (o) => view.getFloat64(o, true);
  else if (tag === FORMAT_PCM && bits === 8) read = (o) => (view.getUint8(o) - 128) / 128;
  else if (tag === FORMAT_PCM && bits === 16) read = (o) => view.getInt16(o, true) / 32768;
  else if (tag === FORMAT_PCM && bits === 24) {
    read = (o) => {
      const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
      return v / 8388608;
    };
  } else if (tag === FORMAT_PCM && bits === 32) read = (o) => view.getInt32(o, true) / 2147483648;
  else throw new Error(`[wav] format ${tag} at ${bits} bits is not readable here`);

  let o = data.at;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      channels[c][i] = read(o);
      o += bytesPer;
    }
  }
  return { sampleRate, channels, frameLength };
}

/** The frame length wavetable editors assume when a file does not say. */
export const DEFAULT_FRAME_LENGTH = 2048;

/** The most frames one loaded table keeps. Past this a file is a sample, not a table. */
export const MAX_FRAMES = 256;

/**
 * Cuts a channel of samples into wavetable frames.
 *
 * A file shorter than one frame is a single cycle - the way single-cycle waveforms are shared -
 * and is stretched to one frame by linear interpolation so its one period fills the table. A
 * longer file is cut every `frameLength` samples, and the frames are peak-normalized together
 * so a quiet export does not become a quiet oscillator.
 */
export function framesOf(samples, frameLength = DEFAULT_FRAME_LENGTH) {
  const n = Math.max(4, frameLength | 0);
  const frames = [];
  if (samples.length < n) {
    const one = new Float32Array(n);
    const m = samples.length;
    if (m > 0) {
      for (let i = 0; i < n; i++) {
        const x = (i / n) * m;
        const j = Math.floor(x);
        const f = x - j;
        one[i] = samples[j % m] + (samples[(j + 1) % m] - samples[j % m]) * f;
      }
    }
    frames.push(one);
  } else {
    const count = Math.min(MAX_FRAMES, Math.floor(samples.length / n));
    for (let k = 0; k < count; k++) frames.push(Float32Array.from(samples.subarray(k * n, (k + 1) * n)));
  }
  let peak = 0;
  for (const f of frames) for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
  if (peak > 0 && peak !== 1) {
    const g = 1 / peak;
    for (const f of frames) for (let i = 0; i < f.length; i++) f[i] *= g;
  }
  return frames;
}
