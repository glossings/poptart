'use strict';

// A sample's first milliseconds come out as recorded: the one-shot voice the engine boots with
// (synthdef/), rendered offline through a real scsynth (test-support/nrt.js).
//
// The bug this pins (2026-09-20, a 909 kick that lost its click): a control-rate envelope under a
// 3ms attack floor held a voice silent for its first block and short of full level for ~4ms. The
// source is a file of constant 1.0, so a render IS the gain each of the file's first frames got:
//
//  - from the file's first frame: no fade at all, full level from the second output sample;
//  - from mid-file, where a declick has a job: half a millisecond, and no more.
//
// A third voice reads noise at speed 1 and must match the file sample for sample - a read step
// taken from a span one frame short of `dur`'s steps between samples, through the interpolator.
//
// Skipped, not failed, where scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderNRT } = require('./test-support/nrt');
const synthdef = require('./synthdef');
const { writeWav, readWavRaw } = require('./wav.js');
const { locateServer } = require('./server/locate');
const { extensionFlags } = require('./server/defs');

const SR = 48000;
// 4800 samples in = 75 whole blocks of 64, so the voices start exactly on a block edge.
const START = 0.1;

const sampleDef = () => synthdef.defsFor(extensionFlags(locateServer().extensionsDir))
  .find((d) => d.name === 'poptart_sample_1').def;

test('a sample voice does not fade in over the transient', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-attack-'));
  try {
    const wavPath = path.join(dir, 'dc.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: new Float32Array(SR).fill(1) });
    // Deterministic noise, float-exact on disk (the writer is 24-bit, so the values are too).
    const NOISE_FRAMES = 12000;
    const noise = new Float32Array(NOISE_FRAMES);
    let seed = 12345;
    for (let i = 0; i < NOISE_FRAMES; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      noise[i] = Math.round((seed / 2147483648 - 0.5) * 0x7fffff) / 0x800000;
    }
    const noisePath = path.join(dir, 'noise.wav');
    writeWav(noisePath, { sampleRate: SR, channels: 1, data: noise });
    // What Node sends for an event with no envelope set: attack 0, and the 50ms default release.
    const voice = (id, out, buf, begin, dur) => [START, ['/s_new', 'poptart_sample_1', id, 0, 0,
      'out', out, 'buf', buf, 'begin', begin, 'end', 1.0, 'rate', 1.0, 'dur', dur, 'amp', 1.0,
      'atk', 0, 'dec', 0, 'sus', 1, 'rel', 0.05]];
    const r = renderNRT([
      [0, ['/d_recv', sampleDef()]],
      [0, ['/b_allocRead', 0, wavPath]],
      [0, ['/b_allocRead', 1, noisePath]],
      // The file's first frame on channels 0/1, its middle on 2/3, the noise whole on 4/5.
      voice(1000, 0, 0, 0, 1),
      voice(1001, 2, 0, 0.5, 0.5),
      voice(1002, 4, 1, 0, NOISE_FRAMES / SR),
    ], { duration: 0.3, outChannels: 6 });
    if (!r.data) { t.skip(r.why); return; }
    const s0 = Math.round(START * SR);
    const gain = (channel, i) => r.at(channel, s0 + i);

    for (const i of [1, 2, 8, 32, 63, 64, 96]) {
      assert.ok(gain(0, i) > 0.999, `from the file's start, sample ${i} came out at ${gain(0, i).toFixed(4)} - the voice is fading in over the transient`);
    }
    assert.ok(gain(2, 2) < 0.6, `from mid-file, sample 2 is already at ${gain(2, 2).toFixed(4)} - no declick fade`);
    assert.ok(gain(2, 26) > 0.999, `from mid-file, sample 26 is still at ${gain(2, 26).toFixed(4)} - the declick outlasts half a millisecond`);
    // From the second sample (the envelope's first is its start level) to a block short of the end
    // (the gate closes on a block edge, so the release may begin up to one block early).
    const stored = readWavRaw(noisePath);
    let worst = 0;
    let worstAt = 0;
    for (let i = 1; i < NOISE_FRAMES - 128; i++) {
      const err = Math.abs(gain(4, i) - stored.data[i]);
      if (err > worst) { worst = err; worstAt = i; }
    }
    t.diagnostic(`noise: worst difference from the file ${worst.toExponential(2)} at frame ${worstAt}`);
    assert.ok(worst < 1e-5, `frame ${worstAt} of the noise file came out ${worst.toExponential(2)} off - the read is stepping between samples, not on them`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
