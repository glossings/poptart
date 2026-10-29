'use strict';

// The desktop halves of the file picker's routes (file-preview.js): a pack listed by name, a
// reference resolved the way the engine resolves one, and the two previews in the shapes the
// picker draws (the same shapes public/web/host.mjs answers with).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodeWav, readWavRaw } = require('@poptart/osc-engine/wav');
const { splitRef, packFiles, fileInPack, drawableStack, wavetablePreview, samplePreview } = require('./file-preview');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-preview-'));
const sine = (n, cycles) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * cycles * i) / n));
const saw = path.join(TMP, 'Saw.wav');
const buzz = path.join(TMP, 'buzz.wav');
fs.writeFileSync(saw, encodeWav({ sampleRate: 48000, channels: 1, data: sine(4096, 2) }));
fs.writeFileSync(buzz, encodeWav({ sampleRate: 48000, channels: 2, data: sine(96000, 50) }));
const listPackFiles = (pack) => (pack === 'wt' ? [saw, buzz] : null);

test('a reference is "pack:name", and nothing else', () => {
  assert.deepStrictEqual(splitRef('wt:Saw.wav'), { pack: 'wt', name: 'Saw.wav' });
  assert.strictEqual(splitRef('Saw'), null);
  assert.strictEqual(splitRef(':Saw'), null);
});

test('a pack lists its files by name, with what they weigh; a pack that is not there is empty', () => {
  const out = packFiles('wt', { listPackFiles });
  assert.deepStrictEqual(out.files, ['Saw.wav', 'buzz.wav']);
  assert.strictEqual(out.count, 2);
  assert.ok(out.bytes > 0);
  assert.deepStrictEqual(packFiles('nope', { listPackFiles }), { pack: 'nope', files: [], count: 0, bytes: 0 });
});

test('a file is found as the engine finds it: by index, by name, without its extension, any case', () => {
  assert.strictEqual(fileInPack('wt', '1', { listPackFiles }), buzz);
  assert.strictEqual(fileInPack('wt', 'Saw.wav', { listPackFiles }), saw);
  assert.strictEqual(fileInPack('wt', 'saw', { listPackFiles }), saw);
  assert.strictEqual(fileInPack('wt', 'kick', { listPackFiles }), null);
  assert.strictEqual(fileInPack('nope', 'saw', { listPackFiles }), null);
});

test('a drawable stack is a few dozen outlines of a few dozen points, over the whole table', () => {
  const frames = Array.from({ length: 200 }, (_, k) => Float32Array.from({ length: 2048 }, () => k));
  const stack = drawableStack(frames);
  assert.ok(stack.length <= 48 && stack.length >= 40, `${stack.length} outlines`);
  assert.strictEqual(stack[0].length, 96);
  assert.strictEqual(stack[0][0], 0);
  assert.ok(stack[stack.length - 1][0] > 190, 'the last frames drawn are from the end of the table');
});

test('a wavetable preview cuts the file into frames, and a bare name is one of the device\'s own tables', async () => {
  const { decodeWav, framesOf } = await import('../web-engine/src/dsp/wavfile.mjs');
  const tables = [{ name: 'basic', frameCount: 2, mips: [[Float32Array.from([0, 1, 0, -1])], [Float32Array.from([1, 1, -1, -1])]] }];
  const own = wavetablePreview('basic', { listPackFiles, decodeWav, framesOf, tables });
  assert.deepStrictEqual([own.name, own.frameCount, own.frameLength, own.stack.length], ['basic', 2, 4, 2]);
  const file = wavetablePreview('wt:saw', { listPackFiles, decodeWav, framesOf, tables });
  assert.deepStrictEqual([file.name, file.frameCount, file.frameLength, file.sampleRate, file.stack.length], ['saw', 2, 2048, 48000, 2]);
  assert.throws(() => wavetablePreview('wt:kick', { listPackFiles, decodeWav, framesOf, tables }), /no file called/);
  assert.throws(() => wavetablePreview('nothing', { listPackFiles, decodeWav, framesOf, tables }), /no table called/);
});

test('a sample preview is the lowest and highest sample per column, with the length and channels', () => {
  const out = samplePreview('wt:buzz', { listPackFiles, readWavRaw });
  assert.strictEqual(out.name, 'buzz');
  assert.strictEqual(out.channels, 2);
  assert.ok(Math.abs(out.seconds - 1) < 0.01);
  assert.ok(out.peaks.length >= 200 && out.peaks.length <= 230);
  assert.ok(out.peaks.every(([lo, hi]) => lo <= 0 && hi >= 0 && lo >= -1 && hi <= 1));
  assert.ok(out.peaks.some(([, hi]) => hi > 0.9), 'a full-scale sine reaches the top');
  assert.throws(() => samplePreview('buzz', { listPackFiles, readWavRaw }), /not a file/);
});
