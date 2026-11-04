'use strict';

// A seek on the desktop's plain song player (poptart_song_*) - a cue jump, a loop's wrap - is the
// browser's: the new read fades in over SONG_FADE_SEC as the old one fades out, linearly. Rendered
// offline through a real scsynth and compared with the browser's song reader over the same song
// and the same moments, sample for sample.
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

test('the plain song player crossfades a seek as the browser does', async (t) => {
  const defs = synthdef.defsFor(extensionFlags(locateServer().extensionsDir));
  const song = defs.find((d) => d.name === 'poptart_song_1').def;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-song-seek-'));
  try {
    // Two tones in 16-bit steps, so the browser's planes hold exactly what the buffer does; the
    // seek jumps to where they are in another phase, so a splice would be a step.
    const frames = 6 * SR;
    const src = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      src[i] = Math.round(16384 * (0.6 * Math.sin((2 * Math.PI * 330 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 1234 * i) / SR))) / 32768;
    }
    const wavPath = path.join(dir, 'song.wav');
    writeWav(wavPath, { sampleRate: SR, channels: 1, data: src });
    const rate = 0.9375;
    const start = 2176;
    const seekAt = 64 * 1000;
    const end = 64 * 1600;
    const seekFrame = 3 * SR + 17;
    const r = renderNRT([
      [0, ['/d_recv', song]],
      [0, ['/b_allocRead', 0, wavPath]],
      [start / SR, ['/s_new', 'poptart_song_1', 1000, 0, 0, 'out', 0, 'buf', 0, 'rate', rate, 't_seek', 1, 'seekFrame', SR]],
      [seekAt / SR, ['/n_set', 1000, 't_seek', 1, 'seekFrame', seekFrame]],
    ], { sampleRate: SR, duration: end / SR + 0.1, outChannels: 2 });
    if (!r.data) { t.skip(r.why); return; }

    const { SongReader, SONG_FADE_SEC } = await import('../web-engine/src/devices/song-reader.mjs');
    const reader = new SongReader(SR);
    reader.receive({ kind: 'load', planes: [Int16Array.from(src, (v) => Math.round(v * 32768))], frames });
    reader.receive({ kind: 'start', pos: 1, rate, time: start / SR });
    reader.receive({ kind: 'seek', pos: seekFrame / SR, time: seekAt / SR });
    const web = new Float32Array(end);
    const l = new Float32Array(64);
    const rr = new Float32Array(64);
    for (let at = 0; at < end; at += 64) {
      reader.process(l, rr, 64, at);
      web.set(l, at);
    }
    // Past the start's fade (the desktop's envelope is a control-rate ramp, the browser's per
    // sample), every sample, the crossfade included.
    let worst = 0;
    let worstAt = -1;
    for (let i = start + 512; i < end; i++) {
      const d = Math.abs(r.at(0, i) - web[i]);
      if (d > worst) { worst = d; worstAt = i; }
    }
    assert.ok(worst < 1e-4, `the desktop's seek differs from the browser's by ${worst.toExponential(2)} at frame ${worstAt} (seek at ${seekAt}, fade ${SONG_FADE_SEC * SR} frames)`);
    // And it is a crossfade: half way through it, both reads are in.
    const mid = seekAt + Math.round((SONG_FADE_SEC * SR) / 2);
    const old = src[Math.round(SR + (mid - start) * rate)] ?? 0;
    assert.ok(Math.abs(r.at(0, mid)) > 0 || old === 0, 'silence in the middle of the crossfade');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
