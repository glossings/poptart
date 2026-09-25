// The Granular synth's scan.
//
// The scan moves the read position through the sample while a note is held, at a multiple of
// real time. The note repitches the grains; it must not also change how fast the position
// travels, or the same gesture played an octave up would get through the sample twice as fast.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GranularSynth } from './src/devices/granular.mjs';

const SR = 48000;
const BLOCK = 128;

function scannedAfter(note, fileRate, blocks = 50) {
  const synth = new GranularSynth(SR);
  const data = Float32Array.from({ length: fileRate * 2 }, (_, i) => Math.sin(i * 0.01));
  synth.loadSample('sample', 0, { channels: [data], sampleRate: fileRate });
  synth.setParams({ sample: 0, scan: 1, voices: 1 });
  synth.queueNoteOn(note, 1, 0);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) synth.process(l, r, BLOCK);
  return synth.voices[0].scanned;
}

test('the scan travels at the same speed whatever the note', () => {
  const low = scannedAfter(48, SR);
  const high = scannedAfter(72, SR);
  assert.ok(Math.abs(low - 50 * BLOCK) < 1e-6, `a scan of one should be real time, moved ${low}`);
  assert.ok(Math.abs(high - low) < 1e-6, `two octaves apart the scan moved ${low} and ${high}`);
});

test('the scan is real time in the file\'s own samples, whatever rate it was recorded at', () => {
  // A file at half the context's rate has half as many samples a second to travel through.
  assert.ok(Math.abs(scannedAfter(60, SR / 2) - 25 * BLOCK) < 1e-6);
});

test('each grain reports where it starts, how far along it is, its pan and the stretch it plays', () => {
  // The picture draws a grain as the stretch it reads, at its pan: Size and Spread made visible.
  const synth = new GranularSynth(SR);
  const data = Float32Array.from({ length: SR * 2 }, (_, i) => Math.sin(i * 0.01));
  synth.loadSample('sample', 0, { channels: [data], sampleRate: SR });
  synth.setParams({ sample: 0, voices: 2, density: 60, size: 400, spread: 1 });
  synth.queueNoteOn(60, 1, 0);
  synth.queueNoteOn(64, 1, 0);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < 60; b++) synth.process(l, r, BLOCK);
  const grains = synth.report().grains;
  assert.ok(grains.length > 4, `enough grains in the air to look at (${grains.length})`);
  for (const [from, at, pan, span] of grains) {
    assert.ok(from >= 0 && from < 1, 'the start is a fraction of the file');
    assert.ok(at >= 0 && at <= 1, 'how far along is a fraction of its length');
    assert.ok(pan >= -1 && pan <= 1, 'the pan is left to right');
    // 400 ms of a two-second file, at the note's rate: c3 reads at 1x, e3 a little faster.
    assert.ok(span > 0.19 && span < 0.27, `the stretch is the grain's size against the file (${span})`);
  }
});
