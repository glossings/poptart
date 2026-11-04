'use strict';

// The keylock song player the engine boots with (synthdef/): the PoptartKeylock UGen
// (native/keylock/) when that extension is installed, the in-graph SOLA stretcher otherwise.
// Both channel counts build in this configuration, and rendered offline through a real scsynth
// the player lands its audio where the pointer says, with no latency, and keeps every test tone's
// pitch and level at 5% faster - what the Warp1 player before both could not do (-32 dB at 500 Hz
// at that rate). With the UGen, the render is the browser's song reader's, sample for sample:
// a keylocked start, a seek crossfading and a pause going quiet.
//
// Skipped, not failed, where scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderNRT } = require('./test-support/nrt');
const synthdef = require('./synthdef');
const { writeWav } = require('./wav.js');
const { locateServer } = require('./server/locate');
const { extensionFlags } = require('./server/defs');

const SR = 44100;
const TONES = [
  { f: 55, a: 0.4 },
  { f: 110, a: 0.28 },
  { f: 220, a: 0.2 },
  { f: 880, a: 0.12 },
];

function toneMix(seconds) {
  const data = new Float32Array(seconds * SR);
  for (let i = 0; i < data.length; i++) {
    let v = 0;
    for (const { f, a } of TONES) v += a * Math.sin((2 * Math.PI * f * i) / SR);
    data[i] = v;
  }
  return data;
}

/** Peak DFT magnitude (dB re full scale, 1 Hz bins) within ±5% of f, and the bin it sits in. */
function peak(seg, f) {
  let best = 0;
  let at = 0;
  for (let ff = Math.floor(f * 0.95); ff <= f * 1.05; ff++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < seg.length; i++) {
      const a = (2 * Math.PI * ff * i) / SR;
      re += seg[i] * Math.cos(a);
      im += seg[i] * Math.sin(a);
    }
    const m = Math.hypot(re, im);
    if (m > best) {
      best = m;
      at = ff;
    }
  }
  return { dB: 20 * Math.log10(best / (seg.length / 2)), hz: at };
}

// Where the render's copy of the source starts, by residual over a window well past any
// pipeline warm-up: the synth spawns at a block boundary near its bundle time, so don't assume.
function alignLag(out, src) {
  let bestLag = 0;
  let bestErr = Infinity;
  for (let lag = 1000; lag < 6000; lag++) {
    let e = 0;
    for (let i = SR; i < 2 * SR; i += 7) e += (out[lag + i] - src[i]) ** 2;
    if (e < bestErr) {
      bestErr = e;
      bestLag = lag;
    }
  }
  return bestLag;
}

test('keylock player builds, keeps pitch and level at rate 1.05, and lands its audio on time', (t) => {
  const flags = extensionFlags(locateServer().extensionsDir);
  const hasUGen = !!flags.keylock;
  const defs = synthdef.defsFor(flags);
  const warp = (nc) => defs.find((d) => d.name === `poptart_songwarp_${nc}`)?.def;
  assert.ok(warp(1), 'the mono keylock def did not build');
  assert.ok(warp(2), 'the stereo keylock def did not build');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-keylock-'));
  try {
    const src = toneMix(6);
    const wavPath = path.join(dir, 'tones.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: src });
    const render = (rate) => renderNRT([
      [0, ['/d_recv', warp(1)]],
      [0, ['/b_allocRead', 0, wavPath]],
      [0.05, ['/s_new', 'poptart_songwarp_1', 1000, 0, 0, 'out', 0, 'buf', 0, 'rate', rate, 't_seek', 1, 'seekFrame', 0]],
    ], { sampleRate: SR, duration: 4.0, outChannels: 2 });
    const A = render(1.0);
    if (!A.data) { t.skip(A.why); return; }
    const B = render(1.05);
    assert.ok(B.data, B.why);

  const channel = (r, k) => {
    const ch = new Float32Array(r.frames);
    for (let i = 0; i < r.frames; i++) ch[i] = r.at(k, i);
    return ch;
  };

  // Rate 1: the render is the source, from the spawn at block 2176 (the 0.05 s bundle rounded
  // down to a block) - neither player is late. SOLA reconstructs it bit-exact, and so does the
  // UGen's stretcher at rate 1, to rounding.
  const a = channel(A, 0);
  const lag = alignLag(a, src);
  assert.strictEqual(lag, 2176, `keylock audio landed at ${lag}, expected 2176 (${hasUGen ? 'PoptartKeylock' : 'SOLA'})`);
  let err = 0;
  let pow = 0;
  for (let i = SR; i < 3 * SR; i++) {
    err += (a[lag + i] - src[i]) ** 2;
    pow += src[i] ** 2;
  }
  const residualDb = 10 * Math.log10(err / pow);
  assert.ok(residualDb < -40, `keylock at rate 1 is not transparent: residual ${residualDb.toFixed(1)} dB (lag ${lag})`);

  // Rate 1.05: every tone at its own pitch, within 2 dB of the source.
  const b = channel(B, 0);
  const seg = b.subarray(SR, 3 * SR);
  const ref = src.subarray(SR, 3 * SR);
  for (const { f } of TONES) {
    const got = peak(seg, f);
    const want = peak(ref, f);
    assert.strictEqual(got.hz, want.hz, `${f} Hz moved to ${got.hz} Hz under keylock at rate 1.05`);
    assert.ok(Math.abs(got.dB - want.dB) < 2, `${f} Hz is ${(got.dB - want.dB).toFixed(1)} dB off under keylock at rate 1.05`);
  }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The browser's song reader, keylocked, over the same song and the same moments - what the UGen
// has to sound like. Its frames are the render's from the spawn's block on.
async function browserKeylock(song, events, frames) {
  const { SongReader } = await import('../web-engine/src/devices/song-reader.mjs');
  const reader = new SongReader(SR);
  const planes = [Int16Array.from(song, (v) => Math.round(v * 32768))];
  reader.receive({ kind: 'load', planes, frames: song.length });
  for (const e of events) reader.receive(e);
  const out = new Float32Array(frames);
  const l = new Float32Array(64);
  const r = new Float32Array(64);
  for (let at = 0; at < frames; at += 64) {
    reader.process(l, r, 64, at);
    out.set(l.subarray(0, Math.min(64, frames - at)), at);
  }
  return { out, planes };
}

test('the keylock UGen plays what the browser does: a start, a seek crossfading, a pause', async (t) => {
  const flags = extensionFlags(locateServer().extensionsDir);
  if (!flags.keylock) { t.skip('PoptartKeylock is not installed'); return; }
  const defs = synthdef.defsFor(flags);
  const warp = defs.find((d) => d.name === 'poptart_songwarp_1').def;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-keylock-'));
  try {
    // 16-bit values, so the browser's planes hold exactly what the buffer does.
    const src = toneMix(8).map((v) => Math.round(v * 16384) / 32768);
    const wavPath = path.join(dir, 'tones.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: src });
    // A rate a float32 control holds exactly, so both sides run the same playhead. The seek and
    // the pause land on block boundaries, where scsynth applies them.
    const rate = 0.9375;
    const start = 2176;
    const seekAt = 64 * 1000;
    const pauseAt = 64 * 2000;
    const r = renderNRT([
      [0, ['/d_recv', warp]],
      [0, ['/b_allocRead', 0, wavPath]],
      [start / SR, ['/s_new', 'poptart_songwarp_1', 1000, 0, 0, 'out', 0, 'buf', 0, 'rate', rate, 't_seek', 1, 'seekFrame', SR]],
      [seekAt / SR, ['/n_set', 1000, 't_seek', 1, 'seekFrame', 5 * SR]],
      [pauseAt / SR, ['/n_set', 1000, 'run', 0]],
    ], { sampleRate: SR, duration: 3.5, outChannels: 2 });
    if (!r.data) { t.skip(r.why); return; }
    const desk = new Float32Array(r.frames);
    for (let i = 0; i < r.frames; i++) desk[i] = r.at(0, i);
    const { out: web } = await browserKeylock(src, [
      { kind: 'start', pos: 1, rate, time: start / SR, keylock: true },
      { kind: 'seek', pos: 5, time: seekAt / SR },
    ], pauseAt);
    // Past the start's fade (the desktop's envelope is a control-rate ramp, the browser's per
    // sample), every sample to the pause, the seek's crossfade included.
    let worst = 0;
    let worstAt = -1;
    for (let i = start + 512; i < pauseAt; i++) {
      const d = Math.abs(desk[i] - web[i]);
      if (d > worst) { worst = d; worstAt = i; }
    }
    assert.ok(worst < 1e-4, `desktop and browser keylocks differ by ${worst.toExponential(2)} at frame ${worstAt} (seek at ${seekAt})`);
    // The pause mutes as it stops: nothing held, nothing droning.
    let after = 0;
    for (let i = pauseAt + Math.round(0.2 * SR); i < r.frames; i++) after = Math.max(after, Math.abs(desk[i]));
    assert.ok(after < 1e-3, `a paused keylock still sounds at ${after}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
