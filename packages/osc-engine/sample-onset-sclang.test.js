'use strict';

// A sample voice starts on the sample it was scheduled for (sc/poptart.scd).
//
// The bug this pins (2026-09-22, a 16th-note hat line that crept early hit by hit and then jumped
// forward once a bar): the sampler voices wrote through Out, and a synth spawned by a timestamped
// bundle starts computing at the START of the block its time falls in - so Out put its first sample
// up to a block early, by however far into the block the onset fell. The engine runs a 256-sample
// block, which is 5.3ms at 48k, and a grid step is almost never a whole number of blocks, so the
// error walked through the block a little further each event and wrapped. Every voice now writes
// through OffsetOut, which delays its output by the bundle's sub-block offset.
//
// OffsetOut holds each block's last `offset` samples back for the following block, and doneAction
// frees the node the instant the envelope ends - the second half of this test is that the release
// still runs out to nothing rather than being cut where the node went (OffsetOut writes what it
// holds as it is destroyed; measured 2026-09-22: the tail ends at 1e-4, the -4 curve's last step).
//
// The source is a file of constant 1.0, so the first nonzero output sample IS the onset. Three
// voices in one render, each on its own channel pair: on a block edge, 192 samples into a block,
// and on the block's last sample - the largest offset there is.
//
// Like sample-attack-sclang.test.js: the def is lifted out of the shipped file, rendered offline
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
const BLOCK = 256; // the engine's own block size (see POPTART_BLOCK_SIZE in sc/poptart.scd)
const LANG_PORT = '57297'; // its own, like every sclang harness: only ten are tried from 57120 up

function lift(re, what) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(re);
  assert.ok(m, `could not find the ${what} in sc/poptart.scd`);
  return m[0];
}
const extractSampleDef = () =>
  lift(/^        SynthDef\(\("poptart_sample_" \+\+ nc\)\.asSymbol, \{[\s\S]*?^        \}\)\.add;$/m, 'one-shot sampler SynthDef')
    .replace(/\.add;$/, '').replace(/\bnc\b/g, '1');

test('a sample voice starts on its scheduled sample and its release runs out in full', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-onset-'));
  try {
    const wavPath = path.join(dir, 'dc.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: new Float32Array(SR).fill(1) });
    const outPath = path.join(dir, 'render.wav');
    const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
    // Onsets in samples: a block edge, part way into a block, and a block's last sample.
    const onsets = [18 * BLOCK, 18 * BLOCK + 192, 30 * BLOCK + BLOCK - 1];
    const DUR = 0.05;
    const voice = (id, out, at) => `[${at / SR}, ["/s_new", "poptart_sample_1", ${id}, 0, 0,
        "out", ${out}, "buf", 0, "begin", 0, "end", 1.0, "rate", 1.0, "dur", ${DUR}, "amp", 1.0,
        "atk", 0, "dec", 0, "sus", 1, "rel", 0.015]]`;
    const script = `(
var toStereo, sampleDef;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
toStereo = { |sig| sig ! 2 };
sampleDef = ${extractSampleDef()};
("SAMPLEDEF-OK<" ++ sampleDef.name ++ ">").postln;
Score.recordNRT([
    [0.0, ["/d_recv", sampleDef.asBytes]],
    [0.0, ["/b_allocRead", 0, ${JSON.stringify(wavPath)}]],
    ${onsets.map((at, i) => voice(1000 + i, i * 2, at)).join(',\n    ')},
    [0.4, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(6).blockSize_(${BLOCK}), duration: 0.4,
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
    const frames = r.data.length / r.channels;
    const at = (channel, i) => r.data[i * r.channels + channel];

    onsets.forEach((scheduled, i) => {
      const ch = i * 2;
      let first = -1;
      let last = -1;
      for (let k = 0; k < frames; k++) {
        if (Math.abs(at(ch, k)) > 1e-6) {
          if (first < 0) first = k;
          last = k;
        }
      }
      // The envelope's first sample is its start level (0), so the audio shows from the sample
      // after the scheduled one - and is at full level there, from the file's own first frame.
      assert.strictEqual(first, scheduled + 1, `voice scheduled for sample ${scheduled} (${scheduled % BLOCK} into its block) first sounded at ${first}: ${first - scheduled - 1} samples off`);
      assert.ok(at(ch, scheduled + 1) > 0.999, `voice at ${scheduled} came out at ${at(ch, scheduled + 1).toFixed(4)} on its first sounding sample`);
      // The gate closes at `dur` and the 15ms release follows; the node's last sample is the
      // level the release was cut at. Run out in full that is the curve's last step (1e-4); a
      // tail dropped with the node would leave a step of up to -29 dB.
      assert.ok(Math.abs(at(ch, last)) < 1e-3, `voice at ${scheduled} ended on ${at(ch, last).toFixed(4)} at sample ${last} - its release was cut short`);
      const releaseStart = scheduled + Math.round(DUR * SR);
      assert.ok(last > releaseStart + 0.012 * SR, `voice at ${scheduled} went silent at sample ${last}, before its release could run`);
      t.diagnostic(`voice at ${scheduled} (+${scheduled % BLOCK}): first sounding sample ${first}, last ${last} at ${at(ch, last).toExponential(2)}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
