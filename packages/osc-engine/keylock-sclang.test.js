'use strict';

// The keylock song player in sc/poptart.scd. There are two: the Rubber Band pitch shifter
// (PoptartPitchShift, native/rubberband/) when that extension is installed, and the in-graph
// SOLA stretcher otherwise. This checks that (1) the whole if/else builds a def for both channel
// counts in whichever configuration this sclang has, and (2) rendered offline through a real
// scsynth, the player keeps every test tone's pitch and level at 5% faster - which is precisely
// what the Warp1 player it replaced could not do (-32 dB at 500 Hz at that rate) - and, with
// the pitch shifter, that its delay compensation lands the audio where the pointer says.
//
// Like songs-sclang.test.js: the source is lifted out of the shipped file, run in a real sclang,
// and skipped (not failed) where sclang or scsynth can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { writeWav, readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SR = 44100;
const TONES = [
  { f: 55, a: 0.4 },
  { f: 110, a: 0.28 },
  { f: 220, a: 0.2 },
  { f: 880, a: 0.12 },
];

// The if/else choosing the keylock def, minus the two `.add`s: with no server the constructors
// alone build the graphs, and the block's value is then the def the branch chose.
function extractWarpChoice() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^        if \(\\PoptartPitchShift\.asClass\.notNil\) \{[\s\S]*?^        \};$/m);
  assert.ok(m, 'could not find the keylock def choice in sc/poptart.scd');
  const defs = m[0].match(/SynthDef\(\("poptart_songwarp_" \+\+ nc\)/g);
  assert.strictEqual(defs?.length, 2, 'expected both keylock defs inside the choice');
  return m[0].replace(/\}\)\.add;/g, '});').replace(/;$/, '');
}

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

function runSclang(dir, wavPath) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const outA = path.join(dir, 'rate1.wav');
  const outB = path.join(dir, 'rate105.wav');
  // With the pitch shifter: a probe reports its delay on channel 2 of the rate-1 render, and
  // the player is spawned with delay 0, so the audio is expected exactly that late. Without it
  // (SOLA) the probe is a silent stand-in and the delay is 0.
  const script = `(
var toStereo, defs, render, hasRb, probe, pending = 2;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
hasRb = \\PoptartPitchShift.asClass.notNil;
("HAS-RB<" ++ hasRb ++ ">").postln;
defs = [1, 2].collect { |nc|
    toStereo = { |sig| if (nc == 1) { sig ! 2 } { sig } };
    ${extractWarpChoice()};
};
defs.do { |def| ("WARPDEF-OK<" ++ def.name ++ ">").postln };
probe = SynthDef(\\keylock_probe, {
    var d = if (hasRb) { \\PoptartPitchShift.asClass.ar(Silent.ar(2), 1, 0)[2] } { DC.ar(0) };
    Out.ar(2, d * 0.0001);
});
render = { |rate, outPath|
    var score = [
        [0.0, ["/d_recv", defs[0].asBytes]],
        [0.0, ["/d_recv", probe.asBytes]],
        [0.0, ["/b_allocRead", 0, ${JSON.stringify(wavPath)}]],
        [0.05, ["/s_new", "poptart_songwarp_1", 1000, 0, 0, "out", 0, "buf", 0, "rate", rate, "t_seek", 1, "seekFrame", 0]],
        [0.05, ["/s_new", "keylock_probe", 1001, 0, 0]],
        [4.0, ["/c_set", 0, 0]]
    ];
    Score.recordNRT(score, outPath ++ ".osc", outPath, sampleRate: ${SR}, headerFormat: "WAV",
        sampleFormat: "float", options: ServerOptions.new.numOutputBusChannels_(3), duration: 4.0,
        action: { pending = pending - 1; if (pending == 0) { "RENDER-DONE".postln; 0.exit } });
};
render.(1.0, ${JSON.stringify(outA)});
render.(1.05, ${JSON.stringify(outB)});
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let out;
  try {
    out = execFileSync(sclang, [file], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { out, outA, outB };
}

test('keylock player builds, keeps pitch and level at rate 1.05, and lands its audio on time', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-keylock-'));
  const src = toneMix(6);
  const wavPath = path.join(dir, 'tones.wav');
  writeWav(wavPath, { sampleRate: SR, channels: 1, data: src });

  const { out, outA, outB } = runSclang(dir, wavPath);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^WARPDEF-OK<poptart_songwarp_1>$/m, `the mono keylock def did not build:\n${out}`);
  assert.match(out, /^WARPDEF-OK<poptart_songwarp_2>$/m, `the stereo keylock def did not build:\n${out}`);
  if (!out.includes('RENDER-DONE') || !fs.existsSync(outA) || !fs.existsSync(outB)) {
    t.skip(`scsynth could not render offline here:\n${out.trim().split('\n').slice(-5).join('\n')}`);
    return;
  }
  const hasRb = /^HAS-RB<true>$/m.test(out);

  const channel = (p, k) => {
    const wav = readWavRaw(p);
    assert.ok(wav, `unreadable render ${p}`);
    const ch = new Float32Array(wav.frames);
    for (let i = 0; i < wav.frames; i++) ch[i] = wav.data[i * wav.channels + k];
    return ch;
  };

  // Rate 1: the render is the source, `delay` samples after the spawn at block 2176 (the
  // 0.05 s bundle rounded down to a block). SOLA reconstructs it bit-exact; the pitch shifter
  // resynthesizes, so it only has to be well below audibility.
  const a = channel(outA, 0);
  const delay = Math.round(channel(outA, 2)[SR] / 0.0001);
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
  const b = channel(outB, 0);
  const seg = b.subarray(SR, 3 * SR);
  const ref = src.subarray(SR, 3 * SR);
  for (const { f } of TONES) {
    const got = peak(seg, f);
    const want = peak(ref, f);
    assert.strictEqual(got.hz, want.hz, `${f} Hz moved to ${got.hz} Hz under keylock at rate 1.05`);
    assert.ok(Math.abs(got.dB - want.dB) < 2, `${f} Hz is ${(got.dB - want.dB).toFixed(1)} dB off under keylock at rate 1.05`);
  }
});
