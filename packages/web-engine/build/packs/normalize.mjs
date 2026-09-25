// Peak normalization for the packs' WAV files.
//
// A one-shot is heard against every other one-shot in a pattern, and a library recorded at the
// level each instrument happened to be played at - a guiro 30 dB under a clap - makes every pick
// a trip to the gain control. So each file is scaled until its loudest sample sits at PEAK_DB,
// the level poptart's own rendered packs are made at. Only the level changes: the format, the
// sample rate and every chunk beside the audio (loop points, a producer's notes) are kept as they
// were.
//
// Only what can be read is touched. A format this does not know is handed back unchanged, which
// is a file at its original level rather than a file damaged by a guess about its layout.

/** Where a normalized file peaks, in dBFS: the rendered packs' level, with headroom for repitching up. */
export const PEAK_DB = -1;

/** The fmt/data layout of a RIFF WAV, or null for anything that is not one this can scale. */
function layout(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      let format = buf.readUInt16LE(body);
      const bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = { format, bits };
    } else if (id === 'data') {
      data = { start: body, end: Math.min(buf.length, body + size) };
    }
    at = body + size + (size & 1);
  }
  if (!fmt || !data) return null;
  const { format, bits } = fmt;
  if (format === 1 && [16, 24, 32].includes(bits)) return { ...data, kind: 'int', bytes: bits / 8 };
  if (format === 3 && bits === 32) return { ...data, kind: 'float', bytes: 4 };
  return null;
}

const readers = {
  int: (buf, at, bytes) => buf.readIntLE(at, bytes) / 2 ** (bytes * 8 - 1),
  float: (buf, at) => buf.readFloatLE(at),
};

/**
 * The file with its peak at `peakDb`: a new buffer, or the same one when there is nothing to do -
 * a format this cannot read, or silence, which no gain makes into anything.
 * @returns {{ bytes: Buffer, gainDb: number|null }}
 */
export function normalizeWav(buf, { peakDb = PEAK_DB } = {}) {
  const shape = layout(buf);
  if (!shape) return { bytes: buf, gainDb: null };
  const { start, end, kind, bytes } = shape;
  const read = readers[kind];
  let peak = 0;
  for (let at = start; at + bytes <= end; at += bytes) peak = Math.max(peak, Math.abs(read(buf, at, bytes)));
  if (peak === 0) return { bytes: buf, gainDb: null };
  const gain = 10 ** (peakDb / 20) / peak;
  const out = Buffer.from(buf);
  const full = 2 ** (bytes * 8 - 1);
  for (let at = start; at + bytes <= end; at += bytes) {
    const v = read(buf, at, bytes) * gain;
    if (kind === 'float') out.writeFloatLE(v, at);
    else out.writeIntLE(Math.max(-full, Math.min(full - 1, Math.round(v * full))), at, bytes);
  }
  return { bytes: out, gainDb: 20 * Math.log10(gain) };
}
