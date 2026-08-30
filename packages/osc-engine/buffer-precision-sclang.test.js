'use strict';

// Buffer reads stay accurate DEEP into a long file (sc/poptart.scd).
//
// The bug this pins (2026-08-29, a 4-minute acapella through s(...).begin()): a phase handed to
// BufRd travels an audio wire, and a wire is float32. Above 2^23 frames - ~190s at 44.1k - the
// gap between representable values is a whole frame, so a read that should advance 0.91875 frames
// per output sample (a 44.1k file on poptart's 48k server) instead lurches 1,1,1,1,0,1,1... and
// the interpolation has nothing left to interpolate. The result is a nearest-neighbour hold with
// irregularly repeated frames: gritty aliasing, on exactly the material a DJ set is made of.
//
// Both players moved to PlayBuf, which keeps its phase in a double INSIDE the UGen. The test is
// the one that would have caught it: render a pure tone from a position past the cliff and check
// what comes back is still a pure tone. It fails loudly on the old graph (the hold puts tens of
// percent of the energy outside the fundamental) and is nowhere near the threshold on the new one.
//
// Like keylock-sclang.test.js: the defs are lifted out of the shipped file, rendered offline
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

const FILE_SR = 44100; // the file's rate...
const RENDER_SR = 48000; // ...and the server's, which is the mismatch that exposes the bug
// 9.6M frames = 218s. The cliff is at 2^23 = 8,388,608 frames, and BEGIN is past it, so the whole
// read happens in the region where a float32 phase cannot hold a fraction.
const FRAMES = 9600000;
const BEGIN = 0.9;
const START_FRAME = BEGIN * FRAMES; // 8,640,000 - comfortably over the cliff
const TONE_HZ = 3000; // an exact 16 samples per period at 48k, so the DFT below has no leakage

/** The one-shot sampler voice and the repitch song player, minus their `.add;`. */
function extractDef(re, what) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(re);
  assert.ok(m, `could not find the ${what} SynthDef in sc/poptart.scd`);
  return m[0].replace(/\.add;$/, '');
}
const extractSampleDef = () =>
  extractDef(/^        SynthDef\(\("poptart_sample_" \+\+ nc\)\.asSymbol, \{[\s\S]*?^        \}\)\.add;$/m, 'one-shot sampler');
const extractSongDef = () =>
  extractDef(/^        SynthDef\(\("poptart_song_" \+\+ nc\)\.asSymbol, \{[\s\S]*?^        \}\)\.add;$/m, 'song player');

function toneFile(filePath) {
  const data = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * TONE_HZ * i) / FILE_SR);
  writeWav(filePath, { sampleRate: FILE_SR, channels: 1, data });
}

/**
 * How much of a segment's energy is NOT the test tone, in dB.
 *
 * Played at its natural rate a 3 kHz tone comes back at 3 kHz whatever the two sample rates are,
 * so one DFT bin holds all of it and everything else is artifact. `seg` is a whole number of
 * periods, so the rectangular window leaks nothing and this needs no windowing.
 */
function spuriousDb(seg) {
  let re = 0;
  let im = 0;
  let total = 0;
  for (let i = 0; i < seg.length; i++) {
    const a = (2 * Math.PI * TONE_HZ * i) / RENDER_SR;
    re += seg[i] * Math.cos(a);
    im += seg[i] * Math.sin(a);
    total += seg[i] * seg[i];
  }
  const amp = (2 * Math.hypot(re, im)) / seg.length;
  const tonePower = (amp * amp) / 2;
  const totalPower = total / seg.length;
  // Clamped at the float noise floor so a perfect render reads as very quiet, not as -Infinity.
  return 10 * Math.log10(Math.max(totalPower - tonePower, 1e-20) / Math.max(tonePower, 1e-20));
}

function runSclang(dir, wavPath) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const outPath = path.join(dir, 'render.wav');
  // dur is what Node sends for this window: its natural length at speed 1 (see playSample), which
  // is what makes the def's step exactly FILE_SR/RENDER_SR frames per output sample.
  const spanFrames = FRAMES - 1 - START_FRAME;
  const dur = spanFrames / FILE_SR;
  const script = `(
var toStereo, sampleDef, songDef;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
toStereo = { |sig| sig ! 2 };
sampleDef = ${extractSampleDef().replace(/\bnc\b/g, '1')};
songDef = ${extractSongDef().replace(/\bnc\b/g, '1')};
("SAMPLEDEF-OK<" ++ sampleDef.name ++ ">").postln;
("SONGDEF-OK<" ++ songDef.name ++ ">").postln;
Score.recordNRT([
    [0.0, ["/d_recv", sampleDef.asBytes]],
    [0.0, ["/d_recv", songDef.asBytes]],
    [0.0, ["/b_allocRead", 0, ${JSON.stringify(wavPath)}]],
    // The sampler voice on channels 0/1, the song deck on 2/3 - one render, both readers.
    [0.05, ["/s_new", "poptart_sample_1", 1000, 0, 0,
        "out", 0, "buf", 0, "begin", ${BEGIN}, "end", 1.0, "rate", 1.0, "dur", ${dur}, "amp", 1.0]],
    [0.05, ["/s_new", "poptart_song_1", 1001, 0, 0,
        "out", 2, "buf", 0, "rate", 1.0, "t_seek", 1, "seekFrame", ${START_FRAME}]],
    [1.0, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${RENDER_SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(4), duration: 1.0,
    action: { "RENDER-DONE".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let out;
  try {
    out = execFileSync(sclang, [file], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { out, outPath };
}

test('a tone read from past the float32 phase cliff comes back as a tone, not aliasing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-bufprec-'));
  const wavPath = path.join(dir, 'tone.wav');
  try {
    toneFile(wavPath);
    const { out, outPath } = runSclang(dir, wavPath);
    if (!out.includes('Welcome to SuperCollider')) {
      t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
      return;
    }
    // Both graphs built at all - an undeclared var or a misused UGen throws before any render.
    assert.match(out, /SAMPLEDEF-OK<poptart_sample_1>/, out);
    assert.match(out, /SONGDEF-OK<poptart_song_1>/, out);
    if (!out.includes('RENDER-DONE')) {
      t.skip(`scsynth did not render here: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }
    const render = readWavRaw(outPath);
    assert.ok(render && render.channels === 4, `expected a 4-channel render, got ${render?.channels}`);

    // A window well past the 3ms attack and any spawn jitter, a whole number of tone periods long
    // (16 samples each at 48k) so the DFT sees no leakage.
    const from = Math.round(0.2 * RENDER_SR);
    const N = 16384;
    const channel = (c) => {
      const seg = new Float32Array(N);
      for (let i = 0; i < N; i++) seg[i] = render.data[(from + i) * render.channels + c];
      return seg;
    };

    for (const [name, c] of [['one-shot sampler', 0], ['song deck', 2]]) {
      const seg = channel(c);
      let peak = 0;
      for (const v of seg) peak = Math.max(peak, Math.abs(v));
      assert.ok(peak > 0.2, `${name}: read nothing at frame ${START_FRAME} (peak ${peak.toFixed(4)})`);
      const db = spuriousDb(seg);
      t.diagnostic(`${name}: ${db.toFixed(1)} dB non-tone energy at frame ${START_FRAME}`);
      // Measured on the graph this replaced: -3.2 dB - half the energy was aliasing, not a fifth
      // as the "repeats 8% of frames" arithmetic suggests, because a hold error is proportional to
      // the signal's slope and 3 kHz is steep. The fixed read measures -60 (the source's own
      // 16-bit floor plus cubic interpolation error). The gap is wide
      // enough that the threshold needs no tuning against a particular SC build.
      assert.ok(db < -40, `${name}: ${db.toFixed(1)} dB of non-tone energy reading from frame ${START_FRAME} - the buffer phase has lost its fraction (expected < -40 dB)`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
