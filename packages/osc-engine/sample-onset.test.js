'use strict';

// A sample voice starts on the sample it was scheduled for: the one-shot voice the engine boots
// with (synthdef/), rendered offline through a real scsynth at the engine's block size.
//
// The bug this pins (2026-09-22, a 16th-note hat line that crept early hit by hit): a voice spawned
// by a timestamped bundle starts computing at the start of its block, and Out put its first sample
// up to a block early. Every voice writes through OffsetOut, which delays its output by the bundle's
// sub-block offset - and still writes what it holds as the node goes, so the release runs out.
//
// The source is a file of constant 1.0, so the first nonzero output sample IS the onset. Three
// voices: on a block edge, 192 samples into a block, and on a block's last sample.
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

const SR = 48000;
const BLOCK = 256; // the engine's own block size (see poptartOptions in server/server.js)

const sampleDef = () => synthdef.defsFor(extensionFlags(locateServer().extensionsDir))
  .find((d) => d.name === 'poptart_sample_1').def;

test('a sample voice starts on its scheduled sample and its release runs out in full', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-onset-'));
  try {
    const wavPath = path.join(dir, 'dc.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: new Float32Array(SR).fill(1) });
    const onsets = [18 * BLOCK, 18 * BLOCK + 192, 30 * BLOCK + BLOCK - 1];
    const DUR = 0.05;
    const r = renderNRT([
      [0, ['/d_recv', sampleDef()]],
      [0, ['/b_allocRead', 0, wavPath]],
      ...onsets.map((at, i) => [at / SR, ['/s_new', 'poptart_sample_1', 1000 + i, 0, 0,
        'out', i * 2, 'buf', 0, 'begin', 0, 'end', 1.0, 'rate', 1.0, 'dur', DUR, 'amp', 1.0,
        'atk', 0, 'dec', 0, 'sus', 1, 'rel', 0.015]]),
    ], { duration: 0.4, outChannels: 6, extra: ['-z', String(BLOCK)] });
    if (!r.data) { t.skip(r.why); return; }

    onsets.forEach((scheduled, i) => {
      const ch = i * 2;
      let first = -1;
      let last = -1;
      for (let k = 0; k < r.frames; k++) {
        if (Math.abs(r.at(ch, k)) > 1e-6) {
          if (first < 0) first = k;
          last = k;
        }
      }
      // The envelope's first sample is its start level (0): the audio shows from the next sample.
      assert.strictEqual(first, scheduled + 1, `voice scheduled for sample ${scheduled} (${scheduled % BLOCK} into its block) first sounded at ${first}`);
      assert.ok(r.at(ch, scheduled + 1) > 0.999, `voice at ${scheduled} came out at ${r.at(ch, scheduled + 1).toFixed(4)} on its first sounding sample`);
      // Run out in full the last sample is the curve's last step (1e-4); a dropped tail is a step.
      assert.ok(Math.abs(r.at(ch, last)) < 1e-3, `voice at ${scheduled} ended on ${r.at(ch, last).toFixed(4)} at sample ${last} - its release was cut short`);
      const releaseStart = scheduled + Math.round(DUR * SR);
      assert.ok(last > releaseStart + 0.012 * SR, `voice at ${scheduled} went silent at sample ${last}, before its release could run`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
