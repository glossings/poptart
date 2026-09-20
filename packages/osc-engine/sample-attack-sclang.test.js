'use strict';

// A sample's first milliseconds come out as recorded (sc/poptart.scd).
//
// The bug this pins (2026-09-20, a 909 kick that lost its click): the sampler voices shaped their
// output with a CONTROL-rate EnvGen under a 3ms attack floor. A control-rate envelope holds its
// start level for its whole first block and only then ramps, a block at a time - so every voice was
// silent for its first 64 samples and short of full level for ~4ms. Measured on that graph: -inf
// until 1.35ms, -7.5 dB at 2ms. That window is where a drum's transient lives.
//
// The source here is a file of constant 1.0, so a render IS the gain each of the file's first frames
// was given. Two voices in one render:
//
//  - from the file's first frame: no fade at all. Full level from the second output sample (an
//    audio-rate envelope's first sample is its start level, which is the one sample this costs).
//  - from mid-file, where a read can land mid-waveform and a declick has a job: half a millisecond,
//    and no more than that.
//
// A third voice pins the other half of "as recorded", found the same day by diffing a real kick
// against its own render: the read step was taken from a span one frame short of the one `dur` is
// measured over, so a file at speed 1 stepped by (n-1)/n and every frame after the first was read
// BETWEEN samples, through the interpolator (-55 dB from the file). Its source is noise, which no
// interpolator can reconstruct between samples - so a render that matches the file sample for sample
// can only have stepped by exactly 1.
//
// Like buffer-precision-sclang.test.js: the def is lifted out of the shipped file, rendered offline
// through a real scsynth, and skipped (not failed) where sclang or scsynth can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { writeWav, readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SR = 48000;
// 4800 samples in = 75 whole blocks of 64, so the voices start exactly on a block edge and sample 0
// of each is a known offset into the render.
const START = 0.1;
const LANG_PORT = '57294'; // its own, like every sclang harness: only ten are tried from 57120 up

function extractSampleDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^        SynthDef\(\("poptart_sample_" \+\+ nc\)\.asSymbol, \{[\s\S]*?^        \}\)\.add;$/m);
  assert.ok(m, 'could not find the one-shot sampler SynthDef in sc/poptart.scd');
  return m[0].replace(/\.add;$/, '').replace(/\bnc\b/g, '1');
}

test('a sample voice does not fade in over the transient', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-attack-'));
  try {
    const wavPath = path.join(dir, 'dc.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: new Float32Array(SR).fill(1) });
    // Deterministic noise, float-exact on disk (the writer is 24-bit, so the values are 24-bit too).
    const NOISE_FRAMES = 12000;
    const noise = new Float32Array(NOISE_FRAMES);
    let seed = 12345;
    for (let i = 0; i < NOISE_FRAMES; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      noise[i] = Math.round((seed / 2147483648 - 0.5) * 0x7fffff) / 0x800000;
    }
    const noisePath = path.join(dir, 'noise.wav');
    writeWav(noisePath, { sampleRate: SR, channels: 1, data: noise });
    const outPath = path.join(dir, 'render.wav');
    const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
    // What Node sends for an event with no envelope set: attack 0, and the 50ms default release.
    const voice = (id, out, begin) => `[${START}, ["/s_new", "poptart_sample_1", ${id}, 0, 0,
        "out", ${out}, "buf", 0, "begin", ${begin}, "end", 1.0, "rate", 1.0, "dur", ${1 - begin}, "amp", 1.0,
        "atk", 0, "dec", 0, "sus", 1, "rel", 0.05]]`;
    const script = `(
var toStereo, sampleDef;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
toStereo = { |sig| sig ! 2 };
sampleDef = ${extractSampleDef()};
("SAMPLEDEF-OK<" ++ sampleDef.name ++ ">").postln;
Score.recordNRT([
    [0.0, ["/d_recv", sampleDef.asBytes]],
    [0.0, ["/b_allocRead", 0, ${JSON.stringify(wavPath)}]],
    // The file's first frame on channels 0/1, its middle on 2/3 - one render, both floors.
    ${voice(1000, 0, 0)},
    ${voice(1001, 2, 0.5)},
    // The noise file whole, on 4/5, with the dur Node sends for it: its length in seconds.
    [0.0, ["/b_allocRead", 1, ${JSON.stringify(noisePath)}]],
    [${START}, ["/s_new", "poptart_sample_1", 1002, 0, 0,
        "out", 4, "buf", 1, "begin", 0.0, "end", 1.0, "rate", 1.0, "dur", ${NOISE_FRAMES / SR}, "amp", 1.0,
        "atk", 0, "dec", 0, "sus", 1, "rel", 0.05]],
    [0.3, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(6), duration: 0.3,
    action: { "RENDER-DONE".postln; 0.exit });
)
`;
    const file = path.join(dir, 'harness.scd');
    fs.writeFileSync(file, script);
    let out;
    try {
      out = execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    if (!out.includes('Welcome to SuperCollider')) {
      t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
      return;
    }
    assert.match(out, /SAMPLEDEF-OK<poptart_sample_1>/, out);
    if (!out.includes('RENDER-DONE')) {
      t.skip(`scsynth did not render here: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }
    const r = readWavRaw(outPath);
    assert.ok(r, 'unreadable render');
    const s0 = Math.round(START * SR);
    const gain = (channel, i) => r.data[(s0 + i) * r.channels + channel];

    // From the file's first frame: as recorded from the second sample on.
    for (const i of [1, 2, 8, 32, 63, 64, 96]) {
      assert.ok(gain(0, i) > 0.999, `from the file's start, sample ${i} came out at ${gain(0, i).toFixed(4)} - the voice is fading in over the transient`);
    }
    // From mid-file: a declick that is over inside half a millisecond (24 samples at 48k) and is
    // genuinely a fade before that, not a step.
    assert.ok(gain(2, 2) < 0.6, `from mid-file, sample 2 is already at ${gain(2, 2).toFixed(4)} - no declick fade`);
    assert.ok(gain(2, 26) > 0.999, `from mid-file, sample 26 is still at ${gain(2, 26).toFixed(4)} - the declick outlasts half a millisecond`);
    // The noise, sample for sample - from the second sample (the envelope's first is its start
    // level) to a block short of the end (the gate closes on a block edge, so the release may
    // begin up to one block early).
    const stored = readWavRaw(noisePath);
    let worst = 0;
    let worstAt = 0;
    for (let i = 1; i < NOISE_FRAMES - 128; i++) {
      const err = Math.abs(gain(4, i) - stored.data[i]);
      if (err > worst) { worst = err; worstAt = i; }
    }
    t.diagnostic(`noise: worst difference from the file ${worst.toExponential(2)} at frame ${worstAt}`);
    assert.ok(worst < 1e-5, `frame ${worstAt} of the noise file came out ${worst.toExponential(2)} off - the read is stepping between samples, not on them`);
    t.diagnostic(`file start:${gain(0, 1).toFixed(4)} at sample 1; mid-file: ${gain(2, 8).toFixed(4)} at sample 8, ${gain(2, 26).toFixed(4)} at sample 26`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
