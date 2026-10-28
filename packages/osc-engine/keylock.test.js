'use strict';

// The keylock song player the engine boots with (synthdef/): the Rubber Band pitch shifter
// (PoptartPitchShift, native/rubberband/) when that extension is installed, the in-graph SOLA
// stretcher otherwise. Both channel counts build in this configuration, and rendered offline
// through a real scsynth the player keeps every test tone's pitch and level at 5% faster - what the
// Warp1 player it replaced could not do (-32 dB at 500 Hz at that rate) - and, with the pitch
// shifter, its delay compensation lands the audio where the pointer says.
//
// Skipped, not failed, where scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderNRT, G } = require('./test-support/nrt');
const synthdef = require('./synthdef');
const U = require('./synthdef/ugens');
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
  const hasRb = !!flags.pitchShift;
  const defs = synthdef.defsFor(flags);
  const warp = (nc) => defs.find((d) => d.name === `poptart_songwarp_${nc}`)?.def;
  assert.ok(warp(1), 'the mono keylock def did not build');
  assert.ok(warp(2), 'the stereo keylock def did not build');
  // With the pitch shifter a probe reports its delay on channel 2 of the rate-1 render, and the
  // player is spawned with delay 0, so the audio is expected exactly that late. Without it (SOLA)
  // the probe is a silent stand-in and the delay is 0.
  const probe = new G.SynthDef('keylock_probe', {}, () => {
    const d = hasRb ? U.PoptartPitchShift.ar(U.Silent.ar(2), 1, 0)[2] : U.DC.ar(0);
    U.Out.ar(2, G.mul(d, 0.0001));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-keylock-'));
  try {
    const src = toneMix(6);
    const wavPath = path.join(dir, 'tones.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: src });
    const render = (rate) => renderNRT([
      [0, ['/d_recv', warp(1)]],
      [0, ['/d_recv', probe]],
      [0, ['/b_allocRead', 0, wavPath]],
      [0.05, ['/s_new', 'poptart_songwarp_1', 1000, 0, 0, 'out', 0, 'buf', 0, 'rate', rate, 't_seek', 1, 'seekFrame', 0]],
      [0.05, ['/s_new', 'keylock_probe', 1001, 0, 0]],
    ], { sampleRate: SR, duration: 4.0, outChannels: 3 });
    const A = render(1.0);
    if (!A.data) { t.skip(A.why); return; }
    const B = render(1.05);
    assert.ok(B.data, B.why);

  const channel = (r, k) => {
    const ch = new Float32Array(r.frames);
    for (let i = 0; i < r.frames; i++) ch[i] = r.at(k, i);
    return ch;
  };

  // Rate 1: the render is the source, `delay` samples after the spawn at block 2176 (the
  // 0.05 s bundle rounded down to a block). SOLA reconstructs it bit-exact; the pitch shifter
  // resynthesizes, so it only has to be well below audibility.
  const a = channel(A, 0);
  const delay = Math.round(channel(A, 2)[SR] / 0.0001);
  assert.ok(hasRb ? delay > 0 : delay === 0, `probe reported delay ${delay} with pitch shifter ${hasRb ? 'present' : 'absent'}`);
  const lag = alignLag(a, src);
  assert.ok(Math.abs(lag - (2176 + delay)) <= 1, `keylock audio landed at ${lag}, expected ${2176 + delay} (start 2176 + delay ${delay})`);
  let err = 0;
  let pow = 0;
  for (let i = SR; i < 3 * SR; i++) {
    err += (a[lag + i] - src[i]) ** 2;
    pow += src[i] ** 2;
  }
  const residualDb = 10 * Math.log10(err / pow);
  assert.ok(residualDb < (hasRb ? -30 : -40), `keylock at rate 1 is not transparent: residual ${residualDb.toFixed(1)} dB (lag ${lag})`);

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
