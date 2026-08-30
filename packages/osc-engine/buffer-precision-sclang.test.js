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
// The fix, everywhere, is the same idiom: the running phase lives in PlayBuf's internal double;
// wires carry only small relative values or rarely-latched coarse anchors (a frame of rounding
// once per pass/grain is a nudge, not per-sample jitter). Two proofs here:
//
//  - test 1, tone purity: render a pure tone from past the cliff through the one-shot sampler
//    and the song player; what comes back must still be a pure tone (DFT energy outside the
//    fundamental). The old graph measured -3.2 dB of non-tone energy; the fixed one -60.
//  - test 2, position decoding: the source is a sawtooth of the frame number (frame % 1024 /
//    1024), so each rendered sample SAYS which frame it read, to ~0.02 frames. The loop def's
//    four modes and the SOLA keylock are rendered from past the cliff and the decoded playhead
//    checked sample by sample: steps of exactly +-brs, junctions landing where the loop bounds
//    say, ping-pong actually reversing.
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
const BRS = FILE_SR / RENDER_SR; // 0.91875 frames per output sample - the step nothing float32 can hold
// 9.6M frames = 218s. The cliff is at 2^23 = 8,388,608 frames; everything below reads well past it,
// so the whole render happens where a float32 phase cannot hold a fraction.
const FRAMES = 9600000;
const BEGIN = 0.9;
const START_FRAME = BEGIN * FRAMES; // 8,640,000 - comfortably over the cliff
const TONE_HZ = 3000; // an exact 16 samples per period at 48k, so the DFT below has no leakage

/** Lift one SynthDef out of the shipped file, minus its `.add;` (no server here - the constructor
 * alone builds the graph). Throws rather than silently testing nothing if it moves. */
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
const extractLoopDef = () =>
  extractDef(/^        SynthDef\(\("poptart_sample_loop_" \+\+ nc\)\.asSymbol, \{[\s\S]*?^        \}\)\.add;$/m, 'loop voice');
// The SOLA keylock is told apart from the pitch-shifter variant by its exact argument list (the
// shifter's ends `..., delay = 0, window = 0`); renamed so it can build beside the installed one.
const extractSolaDef = () =>
  extractDef(/^            SynthDef\(\("poptart_songwarp_" \+\+ nc\)\.asSymbol, \{ \|out, buf, rate = 1, run = 1, amp = 1, gate = 1, t_seek = 0, seekFrame = 0\|[\s\S]*?^            \}\)\.add;$/m, 'SOLA keylock')
    .replace('"poptart_songwarp_"', '"test_sola_"');

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

// ---------------------------------------------------------------------------------------------
// Position decoding (test 2): the file is a sawtooth of the frame number, so a rendered sample IS
// the read position mod RAMP_P. Cubic interpolation reproduces a straight ramp exactly, except
// within a couple of frames of the sawtooth's wrap - those decodes are discarded (x too near 0 or
// 1) rather than trusted. 16-bit source quantization leaves ~0.02 frames of decode noise.
// ---------------------------------------------------------------------------------------------

const RAMP_P = 1024;

function rampFile(filePath, frames) {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = (i % RAMP_P) / RAMP_P;
  writeWav(filePath, { sampleRate: FILE_SR, channels: 1, data });
}

/** A delta into (-P/2, P/2] - the sawtooth can't distinguish jumps a whole period apart. */
const wrapHalf = (d, P = RAMP_P) => ((((d + P / 2) % P) + P) % P) - P / 2;

/**
 * Walks a decoded render and reports how the playhead moved.
 *  - cleanFrac: fraction of per-sample deltas whose magnitude is the expected step (+-0.05 frames).
 *  - corners: samples where the position jumped (a loop wrap), with the jump value.
 *  - flips: direction reversals among clean steps (ping-pong bounces).
 */
function analyzeRamp(seg, step) {
  const P = RAMP_P;
  const margin = 4 / P;
  const pos = new Array(seg.length).fill(null);
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] > margin && seg[i] < 1 - margin) pos[i] = seg[i] * P;
  }
  const deltas = [];
  for (let i = 1; i < seg.length; i++) {
    if (pos[i] == null || pos[i - 1] == null) continue;
    deltas.push({ i, d: wrapHalf(pos[i] - pos[i - 1]) });
  }
  let clean = 0;
  const corners = [];
  let flips = 0;
  let prevSign = 0;
  for (const { i, d } of deltas) {
    if (Math.abs(Math.abs(d) - step) < 0.05) {
      clean++;
      const sg = Math.sign(d);
      if (prevSign !== 0 && sg !== prevSign) flips++;
      prevSign = sg;
    } else if (Math.abs(d) > 3) {
      // A jump is only a loop wrap if the TRACK moves. When the playhead crosses the sawtooth's
      // own 0<->1 edge, cubic interpolation across the discontinuity emits a few wild samples
      // (measured: 1.07, 0.35, -0.06 in a row) - and the mid-range ones decode as plausible
      // positions, sometimes two in a row, so neither side of a big delta can be trusted by
      // itself. Anchor instead on the nearest CLEAN step on each side of the zone and test
      // reachability: at |step| frames a sample, the track can only have moved gap*step +- a
      // little between the anchors. A decode glitch (and a ping-pong fold, and any mix of the
      // two) stays inside that reach; a real wrap jumps by the span mod the sawtooth - hundreds
      // of frames, an order of magnitude beyond it.
      const cleanAt = (k) =>
        pos[k] != null && pos[k - 1] != null && Math.abs(Math.abs(wrapHalf(pos[k] - pos[k - 1])) - step) < 0.3;
      let j0 = null;
      for (let k = i - 1; k >= i - 14 && k > 0; k--) if (cleanAt(k)) { j0 = k; break; }
      let j1 = null;
      for (let k = i + 1; k <= i + 14 && k < pos.length; k++) if (cleanAt(k)) { j1 = k; break; }
      if (j0 == null || j1 == null) continue; // no trustworthy anchors - unusable, count nothing
      const moved = Math.abs(wrapHalf(pos[j1] - pos[j0]));
      if (moved > (j1 - j0) * step + 2.5) corners.push({ i, d });
    }
  }
  return { cleanFrac: clean / Math.max(1, deltas.length), corners, flips, total: deltas.length };
}

/** Corner-to-corner spacing against the ideal loop period, tolerating a missed detection. */
function maxSpacingError(corners, periodSamples) {
  let worst = 0;
  for (let k = 1; k < corners.length; k++) {
    const m = (corners[k].i - corners[k - 1].i) % periodSamples;
    worst = Math.max(worst, Math.min(m, periodSamples - m));
  }
  return worst;
}

function sclangRun(script, dir) {
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), [file], { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const scoreProgram = () => {
  const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
  return fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : '';
};

/** Channel `c` of a render from `fromSec` to `toSec`, or null if the file is unreadable. */
function channelSlice(wavPath, c, fromSec, toSec) {
  const r = readWavRaw(wavPath);
  if (!r) return null;
  const from = Math.round(fromSec * RENDER_SR);
  const to = Math.min(Math.round(toSec * RENDER_SR), r.frames);
  const seg = new Float32Array(Math.max(0, to - from));
  for (let i = 0; i < seg.length; i++) seg[i] = r.data[(from + i) * r.channels + c];
  return seg;
}

test('a tone read from past the float32 phase cliff comes back as a tone, not aliasing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-bufprec-'));
  try {
    const wavPath = path.join(dir, 'tone.wav');
    toneFile(wavPath);
    const outPath = path.join(dir, 'render.wav');
    // dur is what Node sends for this window: its natural length at speed 1 (see playSample),
    // which is what makes the def's step exactly FILE_SR/RENDER_SR frames per output sample.
    const dur = (FRAMES - 1 - START_FRAME) / FILE_SR;
    const script = `(
var toStereo, sampleDef, songDef;
${scoreProgram()}
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
    const out = sclangRun(script, dir);
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
    // A window well past the 3ms attack and any spawn jitter, a whole number of tone periods long
    // (16 samples each at 48k) so the DFT sees no leakage.
    const N = 16384;
    for (const [name, c] of [['one-shot sampler', 0], ['song deck', 2]]) {
      const seg = channelSlice(outPath, c, 0.2, 0.2 + N / RENDER_SR);
      assert.ok(seg && seg.length === N, `${name}: unreadable render`);
      let peak = 0;
      for (const v of seg) peak = Math.max(peak, Math.abs(v));
      assert.ok(peak > 0.2, `${name}: read nothing at frame ${START_FRAME} (peak ${peak.toFixed(4)})`);
      const db = spuriousDb(seg);
      t.diagnostic(`${name}: ${db.toFixed(1)} dB non-tone energy at frame ${START_FRAME}`);
      // Measured on the graph this replaced: -3.2 dB - half the energy was aliasing, not a fifth
      // as the "repeats 8% of frames" arithmetic suggests, because a hold error is proportional to
      // the signal's slope and 3 kHz is steep. The fixed read measures -60 (the source's own
      // 16-bit floor plus cubic interpolation error). The gap is wide enough that the threshold
      // needs no tuning against a particular SC build.
      assert.ok(db < -40, `${name}: ${db.toFixed(1)} dB of non-tone energy reading from frame ${START_FRAME} - the buffer phase has lost its fraction (expected < -40 dB)`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loop voices and the SOLA keylock track the playhead exactly past the cliff', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-bufprec-loop-'));
  try {
    const rampLong = path.join(dir, 'rampLong.wav');
    const rampShort = path.join(dir, 'rampShort.wav');
    const toneLong = path.join(dir, 'toneLong.wav');
    rampFile(rampLong, FRAMES);
    rampFile(rampShort, 300000);
    toneFile(toneLong);

    // The loop cases. Window bounds land the whole read past the cliff on the long file; the
    // short-file case guards the machinery where BufRd was already exact - the everyday .slice()
    // loop must not have been traded away for the long-file fix.
    const winLo = 0.897;
    const winHi = 0.903;
    const spanLong = (winHi * FRAMES - 1) - Math.max(winLo * FRAMES + 1, winLo * FRAMES); // def's own bound math
    const spanShort = (0.36 * 300000 - 1) - 0.3 * 300000;
    const cases = {
      filefwd: { buf: rampLong, dur: 2.5, args: `"rate", 1.0, "loopLo", 0.0, "loopHi", 1.0, "entry", ${BEGIN}, "pingpong", 0` },
      winfwd: { buf: rampLong, dur: 6.1, span: spanLong, args: `"rate", 1.0, "loopLo", ${winLo}, "loopHi", ${winHi}, "entry", 0.9, "pingpong", 0` },
      winping: { buf: rampLong, dur: 6.1, span: spanLong, ping: true, args: `"rate", 1.0, "loopLo", ${winLo}, "loopHi", ${winHi}, "entry", 0.9, "pingpong", 1` },
      winrev: { buf: rampLong, dur: 6.1, span: spanLong, dir: -1, args: `"rate", -1.0, "loopLo", ${winLo}, "loopHi", ${winHi}, "entry", ${winHi}, "pingpong", 0` },
      short: { buf: rampShort, dur: 3.1, span: spanShort, short: true, args: `"rate", 1.0, "loopLo", 0.3, "loopHi", 0.36, "entry", 0.33, "pingpong", 0` },
    };
    const renders = Object.entries(cases).map(([name, c]) => {
      const outPath = path.join(dir, `${name}.wav`);
      c.out = outPath;
      return `Score.recordNRT([
    [0.0, ["/d_recv", loopDef.asBytes]],
    [0.0, ["/b_allocRead", 0, ${JSON.stringify(c.buf)}]],
    [0.05, ["/s_new", "poptart_sample_loop_1", 1000, 0, 0, "out", 0, "buf", 0, "dur", 1.0, "amp", 1.0, ${c.args}]],
    [${c.dur}, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${RENDER_SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(2), duration: ${c.dur}, action: done);`;
    });
    const solaOut = path.join(dir, 'sola.wav');
    const script = `(
var toStereo, loopDef, solaDef, done, pending = ${renders.length + 1};
${scoreProgram()}
toStereo = { |sig| sig ! 2 };
loopDef = ${extractLoopDef().replace(/\bnc\b/g, '1')};
solaDef = ${extractSolaDef().replace(/\bnc\b/g, '1')};
("LOOPDEF-OK<" ++ loopDef.name ++ ">").postln;
("SOLADEF-OK<" ++ solaDef.name ++ ">").postln;
done = { pending = pending - 1; if (pending == 0) { "RENDER-DONE".postln; 0.exit } };
${renders.join('\n')}
Score.recordNRT([
    [0.0, ["/d_recv", solaDef.asBytes]],
    [0.0, ["/b_allocRead", 0, ${JSON.stringify(toneLong)}]],
    [0.05, ["/s_new", "test_sola_1", 1000, 0, 0, "out", 0, "buf", 0, "rate", 1.0, "t_seek", 1, "seekFrame", ${START_FRAME}]],
    [1.45, ["/c_set", 0, 0]]
], ${JSON.stringify(`${solaOut}.osc`)}, ${JSON.stringify(solaOut)}, sampleRate: ${RENDER_SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(2), duration: 1.45, action: done);
)
`;
    const out = sclangRun(script, dir);
    if (!out.includes('Welcome to SuperCollider')) {
      t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
      return;
    }
    assert.match(out, /LOOPDEF-OK<poptart_sample_loop_1>/, out);
    assert.match(out, /SOLADEF-OK<test_sola_1>/, out);
    if (!out.includes('RENDER-DONE')) {
      t.skip(`scsynth did not render here: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }

    for (const [name, c] of Object.entries(cases)) {
      const seg = channelSlice(c.out, 0, 0.3, c.dur - 0.1);
      assert.ok(seg && seg.length > RENDER_SR, `${name}: unreadable render`);
      const r = analyzeRamp(seg, BRS);
      t.diagnostic(`${name}: clean ${(r.cleanFrac * 100).toFixed(2)}% of ${r.total}, ${r.corners.length} corner(s), ${r.flips} flip(s)`);
      // The heart of it: virtually every sample advanced by exactly +-brs. The old graph's deltas
      // were 0s and 1s - under 1% of them within 0.05 of 0.91875 - so this is night and day.
      assert.ok(r.cleanFrac > 0.98, `${name}: only ${(r.cleanFrac * 100).toFixed(1)}% of playhead steps are the exact rate - the read is quantizing (expected > 98%)`);
      if (c.ping) {
        // A bounce reverses without jumping, so ping-pong shows flips and no corners.
        assert.equal(r.corners.length, 0, `${name}: a ping-pong loop jumped (${r.corners.map((x) => x.d.toFixed(1))}) - a bounce must reverse in place`);
        const bounces = (seg.length / (c.span / BRS));
        assert.ok(Math.abs(r.flips - bounces) <= 1.5, `${name}: ${r.flips} direction flips, expected ~${bounces.toFixed(1)}`);
      } else if (c.span) {
        // A wrap jumps by exactly the span (mod the sawtooth) - LESS the one normal step the
        // playhead takes while wrapping - lands within the anchor's frame of rounding, and
        // arrives on the loop's own period.
        const period = c.span / BRS;
        const expected = (seg.length / period);
        assert.ok(Math.abs(r.corners.length - expected) <= 1.5, `${name}: ${r.corners.length} wraps, expected ~${expected.toFixed(1)}`);
        const expJ = wrapHalf((c.dir ?? 1) * (BRS - c.span));
        const jumpTol = c.short ? 0.5 : 1.5;
        for (const { d } of r.corners) {
          assert.ok(Math.abs(d - expJ) <= jumpTol, `${name}: wrap jumped ${d.toFixed(2)} (mod ${RAMP_P}), expected ${expJ.toFixed(2)} +-${jumpTol} - the loop is not landing on its bounds`);
        }
        const spacingErr = maxSpacingError(r.corners, period);
        t.diagnostic(`${name}: worst wrap-spacing error ${spacingErr.toFixed(1)} samples of a ${period.toFixed(0)}-sample period`);
        assert.ok(spacingErr <= 6, `${name}: wraps drift by ${spacingErr.toFixed(1)} samples against the loop period`);
        assert.equal(r.flips, 0, `${name}: a plain loop reversed direction`);
      }
    }

    // SOLA: two yardsticks, because its two error mechanisms live in different places. Past the
    // cliff its grain ANCHORS round to the nearest frame (positions ride float32 wires, and only
    // have to be right at their triggers) - a random +-half-frame per hop, whose crossfade ripple
    // is broadband noise around the tone, measured ~-18 dB at 3 kHz (scales with frequency; the
    // graph this replaced had the identical anchor rounding underneath its aliasing). Stock UGens
    // cannot do better - sub-frame anchors would need a custom reader, or a coarse+fine split
    // with fractional delays. What the PlayBuf swap DOES remove is the per-sample read
    // quantization, which concentrates at hop-harmonic offsets from the carrier here (the two
    // staggered readers sample the same staircase): measured -19.8 dB on the old graph, -32.8 on
    // this one. So the total is asserted loosely as the floor, and the hop-grid component
    // tightly as the regression discriminator.
    const seg = channelSlice(solaOut, 0, 0.3, 0.3 + 16384 / RENDER_SR);
    assert.ok(seg && seg.length === 16384, 'sola: unreadable render');
    let peak = 0;
    for (const v of seg) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.1, `sola: read nothing at frame ${START_FRAME} (peak ${peak.toFixed(4)})`);
    const db = spuriousDb(seg);
    // Hop-harmonic sidebands: with 16384 samples at 48k the tone sits exactly on bin 1024 and
    // the 2048-sample hop is exactly 8 bins, so the grid is a bin comb around the carrier.
    const N = 16384;
    const binPow = (k) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < N; i++) {
        const a = (2 * Math.PI * k * i) / N;
        re += seg[i] * Math.cos(a);
        im += seg[i] * Math.sin(a);
      }
      return (re * re + im * im) / (N * N);
    };
    const tonePow = 2 * binPow(1024);
    let sb = 0;
    for (let k = 8; k <= 8192; k += 8) {
      for (const o of [-1, 0, 1]) {
        for (const b of [1024 - k + o, 1024 + k + o]) if (b > 1 && b < N / 2) sb += 2 * binPow(b);
      }
    }
    const sbDb = 10 * Math.log10(Math.max(sb, 1e-20) / Math.max(tonePow, 1e-20));
    t.diagnostic(`sola: ${db.toFixed(1)} dB non-tone energy, ${sbDb.toFixed(1)} dB hop-grid sidebands at frame ${START_FRAME}`);
    assert.ok(db < -15, `sola: ${db.toFixed(1)} dB of non-tone energy reading from frame ${START_FRAME} (expected < -15 dB)`);
    assert.ok(sbDb < -25, `sola: ${sbDb.toFixed(1)} dB of hop-grid sidebands reading from frame ${START_FRAME} - the grain reads are quantizing per sample again (expected < -25 dB)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
