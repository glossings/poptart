// A minimal WAV writer, for rendering the shipped sample packs at build time.
//
// osc-engine has a full RIFF reader and writer already, but it is a Node package that the web
// build does not depend on and should not start depending on for the sake of a build script.
// This writes one thing - 16-bit PCM - and reads nothing.

/**
 * A 16-bit PCM WAV file as bytes.
 *
 * `channels` is an array of Float32Arrays, one per channel, all the same length. Samples are
 * clamped rather than allowed to wrap: a sample that overflows sixteen bits wraps to the
 * opposite polarity and turns a loud kick into a click.
 */
export function encodeWav(channels, sampleRate) {
  const channelCount = channels.length;
  if (channelCount === 0) throw new Error('[wav] no channels to write');
  const frames = channels[0].length;
  for (const c of channels) {
    if (c.length !== frames) throw new Error('[wav] every channel must be the same length');
  }

  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM header length
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(at, Math.round(v * 32767), true);
      at += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** Peak-normalizes to `target`, and fades the last few samples so no file ends on a step. */
export function finish(channels, { target = 0.89, fadeSamples = 64 } = {}) {
  let peak = 0;
  for (const c of channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? target / peak : 1;
  const frames = channels[0].length;
  return channels.map((c) => {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let g = gain;
      const fromEnd = frames - 1 - i;
      if (fromEnd < fadeSamples) g *= fromEnd / fadeSamples;
      out[i] = c[i] * g;
    }
    return out;
  });
}

/**
 * Reads back a 16-bit PCM WAV written by encodeWav. Only what this project writes, so that the
 * rendered packs can be verified as FILES rather than as the buffers they came from - a bug in
 * the writer would otherwise be invisible to every test.
 */
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('[wav] not a RIFF WAVE file');

  let at = 12;
  let format = null;
  let data = null;
  while (at + 8 <= view.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = {
        encoding: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { at: body, size };
    }
    at = body + size + (size % 2);
  }
  if (!format || !data) throw new Error('[wav] missing a fmt or data chunk');
  if (format.encoding !== 1 || format.bits !== 16) throw new Error('[wav] only 16-bit PCM is read here');

  const frames = data.size / (2 * format.channels);
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < format.channels; c++) {
      channels[c][i] = view.getInt16(data.at + (i * format.channels + c) * 2, true) / 32768;
    }
  }
  return { sampleRate: format.sampleRate, channels };
}

/** Trims trailing near-silence, so a two-second buffer holding a 90 ms hat ships as 90 ms. */
export function trim(channels, { floor = 1e-4, tail = 256 } = {}) {
  let last = 0;
  for (const c of channels) {
    for (let i = c.length - 1; i >= 0; i--) {
      if (Math.abs(c[i]) > floor) { last = Math.max(last, i); break; }
    }
  }
  const end = Math.min(channels[0].length, last + tail);
  return channels.map((c) => c.slice(0, end));
}
