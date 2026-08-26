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

// The beatgrid (what tempo sync actually stands on): period to a hundredth, and the downbeat.
test('fitBeatGrid: period to a hundredth of a bpm and the downbeat offset', () => {
  const { fitBeatGrid } = require('./song-detect');
  // 127.6 bpm, first beat 0.37s in, a heavier hit (with low end) on every 4th beat.
  const bpm = 127.6;
  const beat = 60 / bpm;
  const seconds = 60;
  const frames = Math.round(seconds * SR);
  const data = new Float32Array(frames);
  for (let k = 0; 0.37 + k * beat < seconds; k++) {
    const at = Math.round((0.37 + k * beat) * SR);
    const down = k % 4 === 0;
    for (let i = 0; i < 0.03 * SR && at + i < frames; i++) {
      data[at + i] += (down ? 1 : 0.6) * (Math.random() * 2 - 1) * (1 - i / (0.03 * SR));
    }
    if (down) {
      for (let i = 0; i < 0.12 * SR && at + i < frames; i++) {
        data[at + i] += 0.8 * Math.sin((2 * Math.PI * 55 * i) / SR) * (1 - i / (0.12 * SR));
      }
    }
  }
  const g = fitBeatGrid(data, SR, 128); // the tag says 128; the fit should say 127.6
  assert.ok(g, 'fitted');
  assert.ok(Math.abs(g.bpm - bpm) < 0.05, `${bpm} expected, got ${g.bpm}`);
  const bar = 4 * beat;
  const err = Math.abs(((g.anchorSec - 0.37) % bar + bar) % bar);
  assert.ok(Math.min(err, bar - err) < 0.02, `downbeat at 0.37 (mod bar) expected, got ${g.anchorSec}`);
  assert.ok(g.confidence > 0.5, `a clean grid should read confident (got ${g.confidence})`);
  const free = fitBeatGrid(data, SR); // no hint: still lands on the tempo
  assert.ok(free && Math.abs(free.bpm - bpm) < 0.05, `unhinted: ${free?.bpm}`);
});

// The downbeat on club material: a kick on EVERY beat (no louder on one), a snare on two and
// four, and a pad that enters and leaves on 4-bar lines. Nothing but structure says which beat
// is one - which is what the vote has to read.
test('fitBeatGrid: finds the downbeat of four-on-the-floor from backbeat + phrase structure', () => {
  const { fitBeatGrid } = require('./song-detect');
  const bpm = 126;
  const beat = 60 / bpm;
  const seconds = 96;
  const frames = Math.round(seconds * SR);
  const data = new Float32Array(frames);
  const first = 0.61;
  for (let k = 0; first + k * beat < seconds; k++) {
    const at = Math.round((first + k * beat) * SR);
    for (let i = 0; i < 0.1 * SR && at + i < frames; i++) { // the kick: 55Hz thump, every beat
      data[at + i] += 0.8 * Math.sin((2 * Math.PI * 55 * i) / SR) * (1 - i / (0.1 * SR)) ** 2;
    }
    if (k % 2 === 1) { // the snare: noise burst on 2 and 4
      for (let i = 0; i < 0.05 * SR && at + i < frames; i++) data[at + i] += 0.5 * (Math.random() * 2 - 1) * (1 - i / (0.05 * SR));
    }
    if (Math.floor(k / 16) % 2 === 1) { // the pad: on for 4 bars, off for 4, switching on bar lines
      for (let i = 0; i < beat * SR && at + i < frames; i++) data[at + i] += 0.25 * Math.sin((2 * Math.PI * 440 * i) / SR);
    }
  }
  const g = fitBeatGrid(data, SR);
  assert.ok(g, 'fitted');
  assert.ok(Math.abs(g.bpm - bpm) < 0.05, `${bpm} expected, got ${g.bpm}`);
  const bar = 4 * beat;
  const err = ((g.anchorSec - first) % bar + bar) % bar;
  assert.ok(Math.min(err, bar - err) < 0.02, `downbeat at ${first} (mod bar ${bar.toFixed(3)}) expected, got ${g.anchorSec} (off by ${Math.min(err, bar - err).toFixed(3)}s)`);
});

// A tempo that comes out 139.9 is nearly always a 140 - unless the track really is 139.9.
test('fitBeatGrid: snaps a near-integer tempo to the integer only when the audio agrees', () => {
  const { fitBeatGrid } = require('./song-detect');
  const make = (bpm) => {
    const seconds = 120;
    const frames = Math.round(seconds * SR);
    const data = new Float32Array(frames);
    const beat = 60 / bpm;
    for (let k = 0; 0.2 + k * beat < seconds; k++) {
      const at = Math.round((0.2 + k * beat) * SR);
      for (let i = 0; i < 0.03 * SR && at + i < frames; i++) data[at + i] += (k % 4 ? 0.6 : 1) * (Math.random() * 2 - 1) * (1 - i / (0.03 * SR));
    }
    return data;
  };
  // Nudge the fit off with a hint a tenth low: the comb test should still land on 140.
  const g140 = fitBeatGrid(make(140), SR, 139.9);
  assert.equal(g140.bpm, 140, `140 expected, got ${g140.bpm}`);
  const g1399 = fitBeatGrid(make(139.6), SR);
  assert.ok(Math.abs(g1399.bpm - 139.6) < 0.05, `a real 139.6 stays 139.6 (got ${g1399.bpm})`);
});
