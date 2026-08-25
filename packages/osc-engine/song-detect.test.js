'use strict';

// The songs phase 5 detection fallback: BPM by onset-envelope autocorrelation, key by chroma +
// Krumhansl profiles. Synthetic fixtures with a known ground truth - a beat pattern whose
// subdivisions disambiguate the tempo octave the way real music does, and chords whose pitch
// classes pin the key - plus the refusals (silence, noise, not-a-wav).

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectSongFacts, detectBpm, detectKey } = require('./song-detect');
const { encodeWav } = require('./wav');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-detect-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SR = 44100;

/**
 * A beat-patterned signal at `bpm`: a strong noise burst on every beat, a weak one on every
 * offbeat eighth. The strong/weak alternation is what disambiguates the tempo from its double
 * (as subdivisions do in real music).
 */
function beatSignal(bpm, seconds) {
  const frames = Math.round(seconds * SR);
  const data = new Float32Array(frames);
  const eighth = (60 / bpm / 2) * SR;
  for (let k = 0; k * eighth < frames; k++) {
    const amp = k % 2 === 0 ? 1 : 0.3;
    const at = Math.round(k * eighth);
    for (let i = 0; i < 0.03 * SR && at + i < frames; i++) {
      data[at + i] += amp * (Math.random() * 2 - 1) * (1 - i / (0.03 * SR));
    }
  }
  return data;
}

/** A steady chord: sines at the given frequencies, equal amplitude. */
function chordSignal(freqs, seconds) {
  const frames = Math.round(seconds * SR);
  const data = new Float32Array(frames);
  for (const f of freqs) {
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < frames; i++) data[i] += 0.2 * Math.sin(w * i);
  }
  return data;
}

test('detectBpm: reads a 128bpm beat pattern to within a fraction of a bpm', () => {
  const r = detectBpm(beatSignal(128, 40), SR);
  assert.ok(r, 'detected something');
  assert.ok(Math.abs(r.bpm - 128) < 1, `128 expected, got ${r.bpm}`);
  assert.ok(r.confidence > 0.4, `a clean grid should read confident (got ${r.confidence})`);
});

test('detectBpm: a slow tempo stays slow (no octave doubling of 87)', () => {
  const r = detectBpm(beatSignal(87, 40), SR);
  assert.ok(r, 'detected something');
  assert.ok(Math.abs(r.bpm - 87) < 1, `87 expected, got ${r.bpm}`);
});

test('detectBpm: silence and steady noise have no tempo', () => {
  assert.strictEqual(detectBpm(new Float32Array(SR * 10), SR), null, 'silence');
  const noise = new Float32Array(SR * 10);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
  const r = detectBpm(noise, SR);
  // Steady noise has a flat envelope after mean removal - either nothing, or nothing confident.
  assert.ok(r === null || r.confidence < 0.2, `noise must not read as a confident tempo (got ${JSON.stringify(r)})`);
});

test('detectKey: an A minor tonality reads as Am, not C', () => {
  // Tonic-weighted A minor material: Am triad across octaves with the tonic doubled.
  const r = detectKey(chordSignal([110, 220, 261.63, 329.63, 440], 20), SR);
  assert.ok(r, 'detected something');
  assert.strictEqual(r.key, 'Am');
  assert.ok(r.confidence > 0.2, `clear material should carry some confidence (got ${r.confidence})`);
});

test('detectKey: a C major tonality reads as C', () => {
  const r = detectKey(chordSignal([130.81, 261.63, 329.63, 392, 523.25], 20), SR);
  assert.ok(r, 'detected something');
  assert.strictEqual(r.key, 'C');
});

test('detectKey: noise has no key', () => {
  const noise = new Float32Array(SR * 10);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
  const r = detectKey(noise, SR);
  assert.ok(r === null || r.confidence < 0.2, `noise must not read as a confident key (got ${JSON.stringify(r)})`);
});

test('detectSongFacts: reads both from a file, and refuses a non-wav', () => {
  const beat = beatSignal(124, 30);
  const chord = chordSignal([220, 261.63, 329.63], 30);
  const data = new Float32Array(beat.length);
  for (let i = 0; i < data.length; i++) data[i] = beat[i] * 0.7 + chord[i];
  const file = path.join(TMP, 'song.wav');
  fs.writeFileSync(file, encodeWav({ sampleRate: SR, channels: 1, data }));

  const facts = detectSongFacts(file);
  assert.ok(facts, 'a wav parses');
  assert.ok(Math.abs(facts.bpm - 124) < 1, `124 expected, got ${facts.bpm}`);
  assert.strictEqual(facts.key, 'Am');
  assert.ok(facts.bpmConfidence > 0 && facts.keyConfidence > 0);

  const bad = path.join(TMP, 'notwav.mp3');
  fs.writeFileSync(bad, 'not audio at all');
  assert.strictEqual(detectSongFacts(bad), null);
});
