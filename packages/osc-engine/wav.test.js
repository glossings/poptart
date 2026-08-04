'use strict';

// The recorder's WAV layer. The trim pass is the part worth pinning down: the engine deliberately
// records wider than the window (a freed DiskOut drops its unflushed buffer), so getting the exact
// window back out - and putting the release tail in the right place when asked - is what makes a
// bounce loop at all. Pure buffer work, no engine and no disk beyond a temp file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decodeWavRaw, encodeWav, writeWav, readWavRaw, trimWindow, trimRecording, envelope, peaks, bands } = require('./wav');

const SR = 48000;

// Interleaved stereo whose sample value encodes its own frame index, so a trim can be checked by
// reading the values back: frame f is [f/1e6, -f/1e6].
function ramp(frames) {
  const data = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    data[f * 2] = f / 1e6;
    data[f * 2 + 1] = -f / 1e6;
  }
  return { sampleRate: SR, channels: 2, frames, data };
}

const frameAt = (audio, f) => Math.round(audio.data[f * audio.channels] * 1e6);

test('encode/decode round-trips shape and samples', () => {
  const src = ramp(1000);
  const out = decodeWavRaw(encodeWav(src));
  assert.equal(out.sampleRate, SR);
  assert.equal(out.channels, 2);
  assert.equal(out.frames, 1000);
  // 24-bit quantization, so compare within a step of it rather than exactly.
  for (let f = 0; f < 1000; f += 97) {
    assert.ok(Math.abs(out.data[f * 2] - src.data[f * 2]) < 1e-6, `frame ${f} survived the round trip`);
  }
});

test('encoded samples clamp instead of wrapping', () => {
  // The tail wrap sums two signals and can exceed unity; saturating is right, wrapping to the
  // opposite polarity would be a loud click.
  const src = { sampleRate: SR, channels: 1, frames: 3, data: new Float32Array([1.8, -1.8, 0]) };
  const out = decodeWavRaw(encodeWav(src));
  assert.ok(out.data[0] > 0.99 && out.data[0] <= 1);
  assert.ok(out.data[1] < -0.99 && out.data[1] >= -1);
});

test('writeWav / readWavRaw survive a real file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-wav-')), 'x.wav');
  writeWav(file, ramp(500));
  const out = readWavRaw(file);
  assert.equal(out.frames, 500);
  assert.equal(out.channels, 2);
});

test('readWavRaw returns null for a file that is not a WAV', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-wav-')), 'nope.wav');
  fs.writeFileSync(file, 'this is not audio');
  assert.equal(readWavRaw(file), null);
});

test('trimWindow cuts exactly the window out of a padded capture', () => {
  // 100 frames of pre-roll, 400 of window, the rest post-roll: the result must be the 400 frames
  // starting at 100 - the whole point of recording wide and trimming.
  const out = trimWindow(ramp(1200), { startFrame: 100, lengthFrames: 400 });
  assert.equal(out.frames, 400);
  assert.equal(frameAt(out, 0), 100);
  assert.equal(frameAt(out, 399), 499);
});

test('trimWindow leaves the tail out by default', () => {
  // The default suits the usual case - bouncing a pattern that is ALREADY looping, whose head
  // already carries the previous pass's tail. Adding the outgoing tail would play it twice.
  const out = trimWindow(ramp(1200), { startFrame: 100, lengthFrames: 400 });
  assert.equal(frameAt(out, 0), 100, 'head is untouched');
});

test('wrapTail folds the post-roll over the head', () => {
  // 100 pre-roll, 400 window (frames 100..499), 150 post-roll (frames 500..649). The tail is
  // shorter than the window, so only the window's head is touched.
  const src = ramp(650);
  const plain = trimWindow(src, { startFrame: 100, lengthFrames: 400 });
  const wrapped = trimWindow(src, { startFrame: 100, lengthFrames: 400, wrapTail: true });
  assert.equal(wrapped.frames, 400, 'wrapping does not change the length');
  // Frame 0 of the window gains frame 500 (the first post-roll frame), at full level: the whole
  // point is that the seam gets the tail undimmed.
  assert.equal(frameAt(wrapped, 0), frameAt(plain, 0) + 500);
  // Past the tail's length, the window is untouched.
  assert.equal(frameAt(wrapped, 200), frameAt(plain, 200));
  assert.equal(frameAt(wrapped, 399), frameAt(plain, 399));
});

test('wrapTail never folds more than one window in', () => {
  // A post-roll longer than the window would otherwise wrap onto its own folded self - a delay,
  // not a bounce. 50 frames of window against 1000+ of tail.
  const out = trimWindow(ramp(1200), { startFrame: 100, lengthFrames: 50, wrapTail: true });
  assert.equal(out.frames, 50);
  // Every frame stays finite and bounded - nothing ran off the end of the source buffer.
  for (let f = 0; f < out.frames; f++) assert.ok(Number.isFinite(out.data[f * 2]));
});

test('wrapTail fades the tail it had to cut short, not the tail it kept', () => {
  // A tail truncated at the window's end would click; a tail that fitted must not be dimmed at
  // the seam it exists to hide. Sample rate 1000 here so the 10ms fade is 10 frames, not 480.
  const src = { ...ramp(600), sampleRate: 1000 }; // 100 pre, 400 window, 100 tail
  const out = trimWindow(src, { startFrame: 100, lengthFrames: 400, wrapTail: true });
  // Window frame f is source frame 100+f and picks up tail frame 500+f, so an un-faded fold reads
  // (100+f) + (500+f).
  assert.equal(frameAt(out, 0), 600, 'the tail starts at full level');
  assert.equal(frameAt(out, 89), 778, 'still full level just before the fade (100-frame tail, 10-frame fade)');
  assert.ok(frameAt(out, 95) < 790, 'inside the fade the tail contributes less than its full value');
  assert.equal(frameAt(out, 99), 199, 'the tail has faded out completely by its last frame');
});

test('trimWindow clamps a window that runs past the capture', () => {
  const out = trimWindow(ramp(300), { startFrame: 100, lengthFrames: 999 });
  assert.equal(out.frames, 200); // whatever was actually recorded, not a crash
});

test('trimRecording takes the window in seconds and converts against the file itself', () => {
  // The caller knows the transport's times, not frames - and the sample rate it would need to
  // convert them is inside the capture, so wav.js does the conversion.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-wav-'));
  const capture = path.join(dir, 'capture.wav');
  const dest = path.join(dir, 'take.wav');
  writeWav(capture, ramp(SR * 2)); // 2 seconds

  const info = trimRecording(capture, dest, { startSec: 0.25, lengthSec: 1 });
  assert.equal(info.frames, SR);
  assert.ok(Math.abs(info.seconds - 1) < 1e-9);
  assert.equal(readWavRaw(dest).frames, SR, 'and it actually wrote that file');
  // The window starts a quarter-second in, i.e. at frame 12000 of the capture.
  assert.equal(frameAt(readWavRaw(dest), 0), 12000);
});

test('trimRecording flags a silent take', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-wav-'));
  const capture = path.join(dir, 'capture.wav');
  writeWav(capture, { sampleRate: SR, channels: 2, frames: SR, data: new Float32Array(SR * 2) });
  const info = trimRecording(capture, path.join(dir, 'take.wav'), { startSec: 0, lengthSec: 0.5 });
  assert.equal(info.silent, true);

  writeWav(capture, ramp(SR));
  assert.equal(trimRecording(capture, path.join(dir, 'take2.wav'), { startSec: 0, lengthSec: 0.5 }).silent, false);
});

test('trimRecording returns null rather than throwing on an unreadable capture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-wav-'));
  assert.equal(trimRecording(path.join(dir, 'nope.wav'), path.join(dir, 'out.wav'), { startSec: 0, lengthSec: 1 }), null);
});

test('peaks summarize amplitude across both channels', () => {
  const frames = 1000;
  const data = new Float32Array(frames * 2);
  data[10] = 0.5; // left, first bucket
  data[frames * 2 - 1] = -0.9; // right, last bucket - magnitude is what counts
  const p = peaks({ sampleRate: SR, channels: 2, frames, data }, 10);
  assert.equal(p.length, 10);
  assert.equal(p[0], 0.5);
  assert.equal(p[9], 0.9);
  assert.equal(p[5], 0);
});

test('peaks never asks for more buckets than there are frames', () => {
  const p = peaks({ sampleRate: SR, channels: 1, frames: 3, data: new Float32Array([1, 0, 0.5]) }, 480);
  assert.equal(p.length, 3);
});

// A mono sine at `hz`, for the band split below.
function tone(hz, frames = SR) {
  const data = new Float32Array(frames);
  for (let f = 0; f < frames; f++) data[f] = Math.sin((2 * Math.PI * hz * f) / SR);
  return { sampleRate: SR, channels: 1, frames, data };
}

test('bands put a tone in the band it belongs to', () => {
  // The colour split only has to be right in the obvious cases: a bass note is not a hi-hat.
  const dominant = (audio) => {
    const b = bands(audio, 8)[4]; // a bucket well past the filters' settling time
    return b.indexOf(Math.max(...b));
  };
  assert.equal(dominant(tone(60)), 0, '60 Hz reads as low');
  assert.equal(dominant(tone(800)), 1, '800 Hz reads as mid');
  assert.equal(dominant(tone(8000)), 2, '8 kHz reads as high');
});

test('each bucket of bands sums to 1, so it is a balance and not a level', () => {
  for (const b of bands(tone(440), 16)) {
    assert.ok(Math.abs(b[0] + b[1] + b[2] - 1) < 0.05, `${JSON.stringify(b)} sums to about 1`);
  }
});

test('bands returns one entry per bucket, and copes with silence', () => {
  const silent = { sampleRate: SR, channels: 2, frames: 1000, data: new Float32Array(2000) };
  const b = bands(silent, 12);
  assert.equal(b.length, 12);
  // Silence has no balance to report - a neutral answer, not NaN.
  for (const x of b) assert.ok(x.every(Number.isFinite));
});

test('bands never returns fewer buckets than asked for, even on a tiny file', () => {
  const tiny = { sampleRate: SR, channels: 1, frames: 5, data: new Float32Array([1, -1, 1, -1, 0]) };
  assert.equal(bands(tiny, 480).length, 5);
});

test('envelope reports rms below peak - the pair is what gives the waveform its shape', () => {
  // A sine's rms is peak/sqrt(2). Peak alone saturates on anything busy and draws as a solid
  // block; the rms body inside it is where the dynamics actually show.
  const env = envelope(tone(440), 8);
  for (let b = 1; b < env.peaks.length; b++) {
    assert.ok(env.rms[b] < env.peaks[b], `bucket ${b}: rms ${env.rms[b]} sits inside peak ${env.peaks[b]}`);
    assert.ok(Math.abs(env.rms[b] - env.peaks[b] / Math.SQRT2) < 0.05, `bucket ${b}: rms is about peak/sqrt(2)`);
  }
});

test('envelope separates a quiet passage from a loud one', () => {
  // The blob problem in one assertion: two halves at different levels must not read the same.
  const frames = SR;
  const data = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const amp = f < frames / 2 ? 1 : 0.15;
    data[f] = amp * Math.sin((2 * Math.PI * 440 * f) / SR);
  }
  const env = envelope({ sampleRate: SR, channels: 1, frames, data }, 8);
  assert.ok(env.peaks[1] > 0.9 && env.rms[1] > 0.6, 'the loud half reads loud');
  assert.ok(env.peaks[6] < 0.25 && env.rms[6] < 0.2, 'the quiet half reads quiet');
});

test('envelope agrees with the peaks/bands helpers built on it', () => {
  const audio = tone(440);
  const env = envelope(audio, 16);
  assert.deepEqual(peaks(audio, 16), env.peaks);
  assert.deepEqual(bands(audio, 16), env.bands);
});

test('trimRecording carries the band balance alongside the peaks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-wav-'));
  const capture = path.join(dir, 'capture.wav');
  writeWav(capture, tone(60, SR));
  const info = trimRecording(capture, path.join(dir, 'take.wav'), { startSec: 0, lengthSec: 0.5 });
  assert.equal(info.bands.length, info.peaks.length);
  assert.ok(info.bands[4][0] > info.bands[4][2], 'a 60 Hz capture is mostly low');
});
