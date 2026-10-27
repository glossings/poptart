// Decoding audio files in the page.
//
// The browser decodes most audio itself, but what it can read differs by browser: Chrome and
// Firefox cannot read AIFF, which is what a lot of music libraries and sample packs are in. So
// AIFF (and its AIFF-C variants) is read here from its bytes, and everything else goes to the
// browser's decodeAudioData as before. Either way the result is an AudioBuffer at the context's
// rate, which is what decodeAudioData hands back and what everything downstream expects.

/** A file's samples read out of its bytes: { sampleRate, frames, channels: Float32Array[] }, or null when it isn't AIFF. */
export function decodeAiff(bytes) {
  const view = new DataView(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, bytes.byteOffset ?? 0, bytes.byteLength);
  if (view.byteLength < 12) return null;
  const tag = (at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== 'FORM') return null;
  const form = tag(8);
  if (form !== 'AIFF' && form !== 'AIFC') return null;

  let comm = null;
  let ssnd = null;
  for (let at = 12; at + 8 <= view.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4);
    const body = at + 8;
    if (id === 'COMM') comm = { at: body, size };
    else if (id === 'SSND') ssnd = { at: body, size: Math.min(size, view.byteLength - body) };
    at = body + size + (size & 1); // chunks are padded to an even length
  }
  if (!comm || !ssnd) throw new Error('this AIFF file has no sound in it (no COMM or SSND chunk)');

  const channelCount = view.getInt16(comm.at);
  const frames = view.getUint32(comm.at + 2);
  const bits = view.getInt16(comm.at + 6);
  const sampleRate = extendedToNumber(view, comm.at + 8);
  const compression = form === 'AIFC' && comm.size >= 22 ? tag(comm.at + 18) : 'NONE';
  if (!(channelCount > 0) || !(sampleRate > 0)) throw new Error('this AIFF file names no channels or no sample rate');

  let read;
  let width;
  switch (compression) {
    case 'NONE': case 'twos': case 'sowt': {
      const little = compression === 'sowt';
      width = Math.ceil(bits / 8);
      const scale = 2 ** (bits - 1);
      if (width === 1) read = (p) => view.getInt8(p) / scale;
      else if (width === 2) read = (p) => view.getInt16(p, little) / scale;
      else if (width === 3) {
        read = little
          ? (p) => ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) * 1) / 8388608
          : (p) => ((view.getInt8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2)) / 8388608;
      } else if (width === 4) read = (p) => view.getInt32(p, little) / 2147483648;
      else throw new Error(`this AIFF file has ${bits}-bit samples, which can't be read here`);
      break;
    }
    case 'raw ': width = 1; read = (p) => (view.getUint8(p) - 128) / 128; break;
    case 'fl32': case 'FL32': width = 4; read = (p) => view.getFloat32(p); break;
    case 'fl64': case 'FL64': width = 8; read = (p) => view.getFloat64(p); break;
    default:
      throw new Error(`this AIFF file is compressed ("${compression.trim()}"), which can't be read here`);
  }

  const dataStart = ssnd.at + 8 + view.getUint32(ssnd.at);
  const available = Math.floor((ssnd.at + ssnd.size - dataStart) / (width * channelCount));
  const count = Math.max(0, Math.min(frames, available));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(count));
  let p = dataStart;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < channelCount; c++) {
      channels[c][i] = read(p);
      p += width;
    }
  }
  return { sampleRate, frames: count, channels };
}

// AIFF writes its sample rate as an 80-bit extended float: sign and a 15-bit exponent, then a
// 64-bit mantissa with its integer bit showing.
function extendedToNumber(view, at) {
  const top = view.getUint16(at);
  const sign = top & 0x8000 ? -1 : 1;
  const exponent = top & 0x7fff;
  const hi = view.getUint32(at + 2);
  const lo = view.getUint32(at + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** (exponent - 16383 - 31) + lo * 2 ** (exponent - 16383 - 63));
}

/**
 * Bytes of any audio file to an AudioBuffer at the context's rate. AIFF is read here; anything
 * else is the browser's to decode (and decodeAudioData detaches what it is given - pass a copy if
 * the bytes are wanted again).
 */
export async function decodeAudio(context, bytes) {
  const aiff = decodeAiff(bytes);
  if (!aiff) return context.decodeAudioData(bytes);
  const own = context.createBuffer(aiff.channels.length, Math.max(1, aiff.frames), aiff.sampleRate);
  aiff.channels.forEach((data, c) => own.copyToChannel(data, c));
  if (aiff.sampleRate === context.sampleRate || typeof OfflineAudioContext === 'undefined') return own;
  // At another rate, resampled to the context's by the browser's own resampler - the same
  // answer decodeAudioData gives for a file at another rate.
  const length = Math.max(1, Math.round((aiff.frames * context.sampleRate) / aiff.sampleRate));
  const offline = new OfflineAudioContext(aiff.channels.length, length, context.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = own;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}
