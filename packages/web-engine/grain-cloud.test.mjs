// The granular sample voice on the audio thread (devices/grain-cloud.mjs), played block by block
// as its worklet plays it, against what the desktop's GrainBuf does.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GrainCloud, WarpCloud, grainFileHeld, grainFiles } from './src/devices/grain-cloud.mjs';

const SR = 48000;
const BLOCK = 128;

let serial = 0;
function file(...channels) {
  const id = `test-${++serial}`;
  grainFiles({ id, channels });
  return id;
}

/** Plays `frames` frames; each param is a number or a function of the frame. */
function play(cloud, frames, params, from = 0) {
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < frames; at += BLOCK) {
    const block = {};
    for (const [k, v] of Object.entries(params)) {
      block[k] = typeof v === 'function' ? Float32Array.from({ length: BLOCK }, (_, i) => v(from + at + i)) : new Float32Array([v]);
    }
    cloud.process(l, r, BLOCK, from + at, block);
    outL.set(l.subarray(0, Math.min(BLOCK, frames - at)), at);
    outR.set(r.subarray(0, Math.min(BLOCK, frames - at)), at);
  }
  return { l: outL, r: outR };
}

const ones = (n = SR) => new Float32Array(n).fill(1);
const base = { size: 0.01, density: 10, pan: 0, pos: 0, detune: 0 };

/** Where the grains begin: the frames a silent output turns non-silent. */
function onsets(out) {
  const at = [];
  for (let i = 0; i < out.length; i++) if (out[i] !== 0 && (i === 0 || out[i - 1] === 0)) at.push(i);
  return at;
}

test('a grain starts on every trigger, on its own sample, from the voice\'s start', () => {
  const cloud = new GrainCloud(SR, { file: file(ones()), start: 1000 / SR });
  const { l } = play(cloud, SR / 2, { ...base, density: 40 });
  // 40 a second is a grain every 1200 frames, the first on the start's own sample.
  assert.deepEqual(onsets(l), [1000, 2200, 3400, 4600, 5800, 7000, 8200, 9400, 10600, 11800, 13000, 14200, 15400, 16600, 17800, 19000, 20200, 21400, 22600, 23800]);
});

test('each grain takes its size as it starts and keeps it, under GrainBuf\'s Hann', () => {
  const cloud = new GrainCloud(SR, { file: file(ones()) });
  // The size steps from 10 ms to 20 ms between the first grain and the second.
  const { l } = play(cloud, 9600, { ...base, density: 10, size: (f) => (f < 2400 ? 0.01 : 0.02) });
  const length = (from) => { let n = 0; while (l[from + n] !== 0) n++; return n; };
  // The window's last sample is its zero.
  assert.equal(length(0), 479);
  assert.equal(length(4800), 959);
  // sin^2 from its first step: GrainBuf's own window, at the middle a full 1 (mono gets its 3 dB).
  assert.ok(Math.abs(l[0] - Math.sin(Math.PI / 480) ** 2) < 1e-6);
  assert.ok(Math.abs(l[239] - 1) < 1e-4, `the window's top (${l[239]})`);
});

test('a stereo grain pans each side on its own, as GrainBuf does - not left mixed into right', () => {
  const left = ones();
  const right = new Float32Array(SR);
  const id = file(left, right);
  const at = (pan) => {
    const { l, r } = play(new GrainCloud(SR, { file: id }), 480, { ...base, pan });
    return [l[239], r[239]];
  };
  const [l0, r0] = at(0);
  assert.ok(Math.abs(l0 - 1) < 1e-4 && Math.abs(r0) < 1e-9, 'at center the file is as recorded');
  const [lh, rh] = at(0.5);
  // The left side has come to center; the right side (silent here) stays hard right.
  assert.ok(Math.abs(lh - Math.SQRT1_2) < 1e-4 && Math.abs(rh - Math.SQRT1_2) < 1e-4, `${lh} ${rh}`);
  const [l1, r1] = at(1);
  assert.ok(Math.abs(l1) < 1e-6 && Math.abs(r1 - 1) < 1e-4, 'at the edge both sides meet there');
  const [lm, rm] = at(-1);
  assert.ok(Math.abs(lm - 1) < 1e-4 && Math.abs(rm) < 1e-6);
});

test('a mono grain pans equal-power, at unity in both sides at center', () => {
  const id = file(ones());
  const { l, r } = play(new GrainCloud(SR, { file: id }), 480, { ...base, pan: 0 });
  assert.ok(Math.abs(l[239] - 1) < 1e-4 && Math.abs(r[239] - 1) < 1e-4);
  const right = play(new GrainCloud(SR, { file: id }), 480, { ...base, pan: 1 });
  assert.ok(Math.abs(right.l[239]) < 1e-6 && Math.abs(right.r[239] - Math.SQRT2) < 1e-4);
});

test('a grain reads at its pitch from its position, wrapping round the file', () => {
  const frames = 4800;
  const ramp = Float32Array.from({ length: frames }, (_, i) => i / frames / Math.SQRT2);
  const id = file(ramp);
  // A window of 1 everywhere and a mono grain hard left, so the output is the read, 3 dB up.
  const flat = new Float32Array(16).fill(1);
  const cloud = new GrainCloud(SR, { file: id, begin: 0.5, rate: 2, table: flat });
  const { l } = play(cloud, 256, { ...base, size: 0.004, pan: -1 });
  assert.ok(Math.abs(l[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(l[10] - (2400 + 20) / frames) < 1e-6, 'two frames of the file per frame out');
  const wrap = new GrainCloud(SR, { file: id, begin: 0.999, table: flat });
  const w = play(wrap, 64, { ...base, size: 0.004, pan: -1 });
  assert.ok(w.l[20] < 0.01 / Math.SQRT2, `past the end it reads on from the start (${w.l[20]})`);
  const back = new GrainCloud(SR, { file: id, begin: 0.5, rate: -1, table: flat });
  const b = play(back, 64, { ...base, size: 0.004, pan: -1 });
  assert.ok(b.l[10] < b.l[0], 'a negative rate reads backwards');
});

test('the position is the control\'s when it is live, and the event\'s begin when it is not', () => {
  const frames = 4800;
  const ramp = Float32Array.from({ length: frames }, (_, i) => i / frames / Math.SQRT2);
  const id = file(ramp);
  const flat = new Float32Array(16).fill(1);
  const live = play(new GrainCloud(SR, { file: id, begin: 0.1, posLive: true, table: flat }), 64, { ...base, pos: 0.75, pan: -1 });
  assert.ok(Math.abs(live.l[0] - 0.75) < 1e-6);
  const held = play(new GrainCloud(SR, { file: id, begin: 0.1, table: flat }), 64, { ...base, pos: 0.75, pan: -1 });
  assert.ok(Math.abs(held.l[0] - 0.1) < 1e-6);
});

test('a bend in cents repitches the grains that start under it', () => {
  const frames = 4800;
  const ramp = Float32Array.from({ length: frames }, (_, i) => i / frames / Math.SQRT2);
  const flat = new Float32Array(16).fill(1);
  const { l } = play(new GrainCloud(SR, { file: file(ramp), table: flat }), 64, { ...base, size: 0.004, pan: -1, detune: 1200 });
  assert.ok(Math.abs(l[10] - 20 / frames) < 1e-6, 'an octave up reads two frames a frame');
});

test('the cloud is leveled by the square root of half its overlap, as the desktop levels it', () => {
  const id = file(ones());
  const level = (size, density) => {
    const cloud = new GrainCloud(SR, { file: id });
    play(cloud, BLOCK, { ...base, size, density });
    return cloud.level;
  };
  assert.equal(level(0.08, 20), 1, 'under one grain at a time it is untouched');
  assert.ok(Math.abs(level(0.08, 100) - 0.5) < 1e-6);
  assert.ok(Math.abs(level(0.2, 1000) - 1 / 10) < 1e-6);
});

test('there is no ceiling on how many grains overlap', () => {
  const cloud = new GrainCloud(SR, { file: file(ones()) });
  play(cloud, SR / 4, { ...base, size: 0.5, density: 1000 });
  assert.ok(cloud.grains.length >= 249, `${cloud.grains.length} grains in the air`);
});

test('an end stops new grains and finishes the voice; a missing file is silence', () => {
  const cloud = new GrainCloud(SR, { file: file(ones()), end: 1 });
  cloud.end(0.01);
  const { l } = play(cloud, 1024, { ...base, size: 0.05 });
  assert.ok(l.slice(480).every((v) => v === 0));
  assert.equal(cloud.done, true);
  const none = new GrainCloud(SR, { file: 'nobody' });
  assert.ok(play(none, 512, base).l.every((v) => v === 0));
});

test('a file is held once for every voice, and let go when the page drops it', () => {
  const id = file(ones(16));
  assert.ok(grainFileHeld(id));
  grainFiles({ drop: [id] });
  assert.equal(grainFileHeld(id), false);
});

// --- the warp voice -----------------------------------------------------------------------------

const warp = (o, random = () => 0.5) => new WarpCloud(SR, { file: o.file, begin: 0, end01: 1, speed: 1, durSec: 1, ...o }, random);

test('the warp lays Warp1\'s grains: 100 ms Hann, eight overlapping, from the first sample', () => {
  // random 0.5 is no change in size: 4800-frame grains, a new one every 600.
  const cloud = warp({ file: file(ones()) });
  const { l, r } = play(cloud, 4800, { detune: 0 });
  assert.ok(Math.abs(l[0] - (Math.sin(Math.PI / 4800) ** 2) * 0.25) < 1e-9, 'one grain, under its window, at 2/8');
  // Once eight overlap, a constant file sums to eight Hann bells: 4 at 2/8 = 1.
  const settled = play(cloud, 4800, { detune: 0 }, 4800);
  assert.ok(Math.abs(settled.l[1000] - 1) < 0.01, `${settled.l[1000]}`);
  assert.equal(r[100], l[100], 'a mono file in both sides');
});

test('each warp grain is up to a tenth longer or shorter, at random', () => {
  const lengths = [0, 1].map((rnd) => {
    const cloud = warp({ file: file(ones()) }, () => rnd);
    play(cloud, 1, { detune: 0 });
    return cloud.channels[0].grains[0].count;
  });
  assert.deepEqual(lengths, [4320, 5280]);
});

test('the warp pointer walks the window in the event\'s time, at the file\'s own pitch', () => {
  const frames = SR;
  const ramp = Float32Array.from({ length: frames }, (_, i) => i / frames);
  // Half the file over two seconds: a stretch of four.
  const cloud = warp({ file: file(ramp), begin: 0.25, end01: 0.75, durSec: 2 });
  assert.ok(Math.abs(cloud.pointer(0) - 0.25) < 1e-12);
  assert.ok(Math.abs(cloud.pointer(1) - 0.5) < 1e-12);
  assert.equal(cloud.pointer(5), 0.75, 'held at the window\'s end, as a Line holds');
  const back = warp({ file: file(ramp), begin: 0.25, end01: 0.75, durSec: 2, speed: -1 });
  assert.ok(Math.abs(back.pointer(1) - 0.5) < 1e-12 && back.pointer(0) === 0.75, 'backwards from the end');
  const loop = warp({ file: file(ramp), begin: 0, end01: 0.5, durSec: 1, loop: true, loopLo: 0.2, loopHi: 0.4, loopEntry: 0.3 });
  assert.ok(Math.abs(loop.pointer(0.3) - 0.25) < 1e-9, 'round the loop');
  // A grain reads at the rate from where the pointer was as it started.
  play(cloud, 1, { detune: 1200 });
  const g = cloud.channels[0].grains[0];
  assert.equal(g.phase, 0.25 * frames + 2 * BLOCK, "two frames of the file per frame, an octave up");
});

test('a stereo file warps each side on its own schedule, as Warp1 does', () => {
  const l = ones();
  const r = new Float32Array(SR).fill(0.5);
  const cloud = warp({ file: file(l, r) });
  const out = play(cloud, 9600, { detune: 0 });
  assert.equal(cloud.channels.length, 2);
  assert.ok(Math.abs(out.r[8000] / out.l[8000] - 0.5) < 0.02, 'right is right, left is left');
});

test('the warp ends where it is told to', () => {
  const cloud = warp({ file: file(ones()), end: 0.05 });
  const { l } = play(cloud, 4800, { detune: 0 });
  assert.ok(l.slice(2400).every((v) => v === 0));
  assert.equal(cloud.done, true);
});
