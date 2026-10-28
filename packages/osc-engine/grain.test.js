'use strict';

// The granular sampler voice (Sig#grain) as the engine has it: the defs it boots with (synthdef/)
// and its helpers (engine/sampler.js). That the graphs are built as described: the voice at both
// channel counts, and the head with the four grain controls it republishes for its voices to map.
// That the helpers hand back what an event can meet before and after a read. And that the voice
// SOUNDS as described - rendered offline through a real scsynth and measured: a stereo file keeps
// its sides, pan moves them, a mono file sits in the middle, size and rate are seconds and grains
// per second, the window buffer is the grain's envelope, the gate releases the voice, and a
// 44.1 kHz file plays at its own pitch. Renders are skipped, not failed, where scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const synthdef = require('./synthdef');
const { renderNRT } = require('./test-support/nrt');
const { fakeEngine } = require('./test-support/fake-engine');
const { Buffer: ScBuffer } = require('./server/objects');
const { writeWav } = require('./wav.js');
const { locateServer } = require('./server/locate');
const { extensionFlags } = require('./server/defs');

const SR = 48000;
const DEFS = synthdef.defsFor(extensionFlags(locateServer().extensionsDir));
const defOf = (name) => DEFS.find((d) => d.name === name).def;
const grainDef = (nc) => defOf(`poptart_sample_grain_${nc}`);
const kind = (u) => u.name || u.constructor.name;

test('the granular voice builds at both channel counts, one GrainBuf per side', () => {
  for (const nc of [1, 2]) {
    const def = grainDef(nc);
    const ctl = (n) => def.allControlNames.find((c) => c.name === n);
    // GrainBuf reads one channel: a stereo file is a GrainBuf per side, off the same trigger.
    assert.equal(def.children.filter((u) => u && kind(u) === 'GrainBuf').length, nc, `${nc} side(s)`);
    assert.ok(def.children.some((u) => u && kind(u) === 'Impulse' && u.rate === 'audio'), 'grains start on their sample, not their block');
    for (const n of ['bufL', 'bufR', 'begin', 'rate', 'gate', 'bend', 'grainpos', 'grainsize', 'grainrate', 'grainpan', 'posLive', 'win']) {
      assert.ok(ctl(n), `the control ${n}, which the playSample handler sets or maps`);
    }
    assert.equal(ctl('win').defaultValue, -1, 'no window means the built-in bell');
  }
});

test("the track's head carries the four grain controls and republishes them", () => {
  const def = defOf('poptart_head');
  const { E } = fakeEngine();
  // The synth's own default, and what a cleared modulator leaves behind (channelDefault) - both
  // have to be pattern-core's CHANNEL_DEFAULTS, or a granular voice is left reading 0 grains a second.
  for (const [name, dflt] of [['grainpos', 0], ['grainsize', 0.08], ['grainrate', 20], ['grainpan', 0]]) {
    const c = def.allControlNames.find((k) => k.name === name);
    assert.ok(c, name);
    assert.ok(Math.abs(c.defaultValue - dflt) < 1e-6, `${name} defaults to ${dflt} (got ${c.defaultValue})`);
    assert.ok(Math.abs(E.channelDefault(name) - dflt) < 1e-6, `${name} clears to ${dflt} (got ${E.channelDefault(name)})`);
  }
  assert.ok(def.allControlNames.some((k) => k.name === 'grainOut'));
  assert.ok(def.children.some((u) => u && kind(u) === 'ReplaceOut' && u.rate === 'control' && u.inputs.length === 5),
    'one four-wide ReplaceOut (bus index + four values)');
  assert.ok(!def.children.some((u) => u && kind(u) === 'Out' && u.rate === 'control'), 'a control bus written with Out would accumulate');
});

test('the stepped channel controls include every grain control', () => {
  const { E } = fakeEngine();
  for (const name of ['grainpos', 'grainsize', 'grainrate', 'grainpan']) {
    assert.ok(E.steppedChannelControls.includes(name), `${name} must be set outright: a ramp smears a per-grain rand() into a drift`);
  }
});

test('the side and window helpers run: what they hand back before and after a read', () => {
  // No server behind it: allocation is local bookkeeping, every message goes nowhere and no read
  // ever completes - which is exactly the "not yet" half of both helpers, the half an event meets.
  const { E, S } = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'notes', 'sampler'] });
  const mono = new ScBuffer(S);
  mono.numChannels = 1;
  const stereo = new ScBuffer(S);
  stereo.numChannels = 2;
  stereo.path = '/nowhere/stereo.wav';
  const pair = E.grainSidesFor(mono);
  assert.ok(pair[0] === mono && pair[1] === mono, 'a mono file is both of its own sides');
  assert.equal(E.grainSidesFor(stereo), null, 'a stereo file is "not yet" until both reads land');
  assert.equal(E.grainSides.get(stereo.bufnum), 'loading');
  assert.equal(E.grainSidesFor(stereo), null, 'and is only read once');
  E.freeGrainSides(stereo);
  assert.equal(E.grainSides.has(stereo.bufnum), false, 'a reloaded pack takes its side copies with it');
  assert.equal(E.grainWindowFor(''), -1, 'no window is the built-in bell');
  const window = '[{"x":0,"y":0,"c":0},{"x":0.1,"y":1,"c":-4},{"x":1,"y":0,"c":0}]';
  assert.equal(E.grainWindowFor(window), -1, 'a window still being sent plays the bell');
  assert.equal(E.grainWindowFor(window), -1);
  assert.equal(E.grainWindows.size, 1, 'and is only sent once');
  // Past the cap, entries nothing has asked for in a while go - and ones just asked for stay.
  for (let i = 0; i < 60; i++) E.grainWindowFor(`[{"x":0,"y":${i / 100}},{"x":1,"y":0}]`);
  assert.equal(E.grainWindows.size, 61, 'nothing recently asked for is evicted, however many there are');
  for (const e of E.grainWindows.values()) e.used -= 60;
  E.grainWindowFor(window);
  E.grainWindowFor('[{"x":0,"y":1},{"x":1,"y":0.5}]');
  assert.equal(E.grainWindows.size, 2, 'stale windows go');
  assert.ok(E.grainWindows.has(window), 'the one just asked for stays');
});

const rms = (seg) => Math.sqrt(seg.reduce((a, v) => a + v * v, 0) / Math.max(1, seg.length));

function channel(render, c, fromSec, toSec) {
  const from = Math.round(fromSec * SR);
  const to = Math.min(Math.round(toSec * SR), render.frames);
  const seg = new Float32Array(Math.max(0, to - from));
  for (let i = 0; i < seg.length; i++) seg[i] = render.at(c, from + i);
  return seg;
}

test('rendered: sides, pan, size and rate, the window, and the gate', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-grain-nrt-'));
  try {
    const tone = new Float32Array(SR * 2);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const tonePath = path.join(dir, 'tone.wav');
    const silentPath = path.join(dir, 'silent.wav');
    writeWav(tonePath, { sampleRate: SR, channels: 1, data: tone });
    writeWav(silentPath, { sampleRate: SR, channels: 1, data: new Float32Array(SR * 2) });
    // Voices, two output channels each. bufL 0 is a tone and bufR 1 is silence - a "stereo file"
    // whose sides are as different as two sides can be.
    //   0/1   stereo, pan 0: the file as recorded - tone left, nothing right
    //   2/3   stereo, pan 1: both sides carried to the right edge
    //   4/5   mono, pan 0: the same level on both sides
    //   6/7   mono, 10ms grains at 20 a second: sound a fifth of the time, not all of it
    //   8/9   mono, through an all-zero window: silence, so the window IS the grain's envelope
    //   10/11 mono, gate closed at 0.5s with a 50ms release: gone by 0.7s
    const voice = (id, def, out, extra) => [0.05, ['/s_new', def, id, 0, 0, 'out', out, 'bufL', 0, 'bufR', 1,
      'begin', 0.25, 'rate', 1.0, 'amp', 1.0, 'grainsize', 0.1, 'grainrate', 40, ...extra]];
    const render = renderNRT([
      [0, ['/d_recv', grainDef(1)]],
      [0, ['/d_recv', grainDef(2)]],
      [0, ['/b_allocRead', 0, tonePath]],
      [0, ['/b_allocRead', 1, silentPath]],
      [0, ['/b_alloc', 2, 1024, 1]],
      voice(1000, 'poptart_sample_grain_2', 0, ['grainpan', 0]),
      voice(1001, 'poptart_sample_grain_2', 2, ['grainpan', 1]),
      voice(1002, 'poptart_sample_grain_1', 4, ['grainpan', 0]),
      voice(1003, 'poptart_sample_grain_1', 6, ['grainsize', 0.01, 'grainrate', 20]),
      voice(1004, 'poptart_sample_grain_1', 8, ['win', 2]),
      voice(1005, 'poptart_sample_grain_1', 10, ['rel', 0.05]),
      [0.5, ['/n_set', 1005, 'gate', 0]],
    ], { duration: 1.2, outChannels: 12 });
    if (!render.data) { t.skip(render.why); return; }
    assert.ok(render.channels === 12, 'unreadable render');
    const level = (c, from = 0.3, to = 1.0) => rms(channel(render, c, from, to));
    const floor = 1e-4;

    assert.ok(level(0) > 0.05, `stereo, pan 0: the left side sounds (${level(0).toFixed(4)})`);
    assert.ok(level(1) < floor, `stereo, pan 0: and stays out of the right (${level(1).toFixed(6)})`);

    assert.ok(level(2) < floor, `stereo, pan 1: nothing left on the left (${level(2).toFixed(6)})`);
    assert.ok(level(3) > 0.05, `stereo, pan 1: the left side has travelled right (${level(3).toFixed(4)})`);

    assert.ok(level(4) > 0.05, 'mono, pan 0: sounds');
    assert.ok(Math.abs(level(4) - level(5)) / level(4) < 0.01, `mono, pan 0: centered (${level(4).toFixed(4)} / ${level(5).toFixed(4)})`);
    // The mono voice gets back the 3 dB an equal-power pan takes at center, so a side of it sits
    // where the same material does as one side of a stereo pair.
    assert.ok(Math.abs(level(4) - level(0)) / level(0) < 0.05, `mono at center matches a stereo side (${level(4).toFixed(4)} vs ${level(0).toFixed(4)})`);

    // 10ms grains, 20 a second: a fifth of the second has a grain in it. A bell is quiet at its
    // edges, so "sounding" is measured well under the peak and lands a little below that fifth.
    const sparse = channel(render, 6, 0.1, 1.1);
    const sounding = sparse.reduce((n, v) => n + (Math.abs(v) > 0.01 ? 1 : 0), 0) / sparse.length;
    t.diagnostic(`10ms grains at 20/s sound ${(sounding * 100).toFixed(1)}% of the time`);
    assert.ok(sounding > 0.08 && sounding < 0.22, `size is seconds and rate is grains a second (${sounding.toFixed(3)})`);

    assert.ok(level(8) < floor, `an all-zero window silences the grain (${level(8).toFixed(6)})`);

    assert.ok(level(10, 0.1, 0.45) > 0.05, 'gated voice: sounds while its gate is open');
    assert.ok(level(10, 0.7, 1.1) < floor, `gated voice: released and gone (${level(10, 0.7, 1.1).toFixed(6)})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a grain plays a 44.1 kHz file at its own pitch on a 48 kHz server', (t) => {
  // GrainBuf plays a buffer at the buffer's own rate already, so the voice must not scale by
  // BufRateScale on top: that played a 44.1 kHz file 2.9 semitones flat (441 Hz came out at 405).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-grain-pitch-'));
  try {
    const file = path.join(dir, 'tone441.wav');
    const SR_FILE = 44100;
    writeWav(file, { sampleRate: SR_FILE, channels: 1, frames: SR_FILE,
      data: Float32Array.from({ length: SR_FILE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 441 * i) / SR_FILE)) });
    const wav = renderNRT([
      [0, ['/d_recv', grainDef(1)]],
      [0, ['/b_allocRead', 0, file]],
      [0.05, ['/s_new', 'poptart_sample_grain_1', 1000, 0, 0, 'out', 0, 'bufL', 0, 'bufR', 0, 'begin', 0.5, 'rate', 1,
        'gate', 1, 'amp', 1, 'grainsize', 0.1, 'grainrate', 20]],
    ], { duration: 1.0, outChannels: 2 });
    if (!wav.data) { t.skip(wav.why); return; }
    const from = Math.round(0.3 * SR);
    const n = Math.round(0.6 * SR);
    const amp = (hz) => {
      let c = 0; let q = 0;
      for (let i = from; i < from + n; i++) {
        const x = wav.at(0, i);
        const w = (2 * Math.PI * hz * i) / SR;
        c += x * Math.cos(w); q += x * Math.sin(w);
      }
      return (2 * Math.hypot(c, q)) / n;
    };
    const right = amp(441);
    const flat = amp(441 * 2 ** (-2.9 / 12));
    assert.ok(right > 0.05, `nothing at 441 Hz (${right.toFixed(4)})`);
    assert.ok(right > 10 * flat, `the grains are not at the file's pitch: 441 Hz ${right.toFixed(4)}, 2.9 st flat ${flat.toFixed(4)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
