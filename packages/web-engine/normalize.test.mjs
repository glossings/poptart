// The packs' WAV files brought to one peak level, format and chunks kept.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWav, PEAK_DB } from './build/packs/normalize.mjs';

/** A WAV of `samples` (-1..1) in the given format, with a chunk before the audio. */
function wav(samples, { format = 1, bits = 16 } = {}) {
  const bytes = bits / 8;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((s, i) => {
    if (format === 3) data.writeFloatLE(s, i * bytes);
    else data.writeIntLE(Math.round(s * (2 ** (bits - 1) - 1)), i * bytes, bytes);
  });
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(44100, 12);
  fmt.writeUInt32LE(44100 * bytes, 16);
  fmt.writeUInt16LE(bytes, 20);
  fmt.writeUInt16LE(bits, 22);
  const junk = Buffer.concat([Buffer.from('junk'), Buffer.from([4, 0, 0, 0]), Buffer.from('keep')]);
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, junk, head, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const peakOf = (buf, bytes, float = false) => {
  const start = buf.indexOf('data') + 8;
  let peak = 0;
  for (let at = start; at < buf.length; at += bytes) peak = Math.max(peak, Math.abs(float ? buf.readFloatLE(at) : buf.readIntLE(at, bytes) / 2 ** (bytes * 8 - 1)));
  return 20 * Math.log10(peak);
};

for (const [label, opts, bytes] of [['16-bit', { bits: 16 }, 2], ['24-bit', { bits: 24 }, 3], ['32-bit float', { format: 3, bits: 32 }, 4]]) {
  test(`a quiet ${label} file is brought up to the pack peak, and only its level changes`, () => {
    const quiet = wav([0, 0.01, -0.02, 0.005], opts);
    const { bytes: out, gainDb } = normalizeWav(quiet);
    assert.ok(Math.abs(peakOf(out, bytes, opts.format === 3) - PEAK_DB) < 0.01);
    assert.ok(gainDb > 30);
    assert.equal(out.length, quiet.length);
    assert.ok(out.includes(Buffer.from('keep')), 'the other chunks are kept');
    assert.deepEqual(out.subarray(0, quiet.indexOf('data')), quiet.subarray(0, quiet.indexOf('data')), 'every header byte as it was');
  });
}

test('a loud file is brought down, silence and formats it cannot read are left alone', () => {
  const { bytes: out } = normalizeWav(wav([0.99, -0.5]));
  assert.ok(Math.abs(peakOf(out, 2) - PEAK_DB) < 0.01);
  const silent = wav([0, 0, 0]);
  assert.equal(normalizeWav(silent).bytes, silent);
  const flac = Buffer.from('fLaC....');
  assert.equal(normalizeWav(flac).bytes, flac);
});
