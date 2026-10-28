'use strict';

// The view tap (sc/poptart.scd's view-tap section, \poptart_view_tap and \poptart_view_fft - what the
// editor's inline .scope()/.spectrum()/... read): the defs as shipped, rendered offline against a known signal, and
// the result read back the way view-taps.js reads it. What this guards: that the ring unrolled
// from the head the tap reports is one continuous stretch of signal - the seam where the oldest
// frame meets the newest is exactly where the reader puts it - and that the FFT frame puts a sine
// in its bin at the level the display's scale says. Also that the reconcile closures compile.
//
// Like the other *-sclang tests, the source is lifted out of the shipped poptart.scd, run in a real
// sclang, and skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { fftDecibels } = require('./view-taps.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function extract(re, what) {
  const m = fs.readFileSync(SCD, 'utf8').match(re);
  assert.ok(m, `could not find ${what} in sc/poptart.scd`);
  return m[0];
}

// The whole section: one statement that fills the `viewTap` event (see the var's declaration).
const section = () => extract(/^\{\nviewTap = \([\s\S]*?^\}\.value;$/m, 'the view-tap section');

// sclang's own port, from the range these harnesses are given, so it never races another one.
const LANG_PORT = '57610';

const SR = 48000;
// Not a whole number of periods in the ring, or a seam put in the wrong place would line up by luck.
const HZ = 700;

function runSclang(dir) {
  const out = (f) => JSON.stringify(path.join(dir, f));
  const script = `(
var score, opts, tap, fft, viewTap, stripTap = { |...args| args.postln };
var tracks = IdentityDictionary.new, server = Server.default, recGroup, nodeAddr, scsynthPort = 57110;
${section()}
viewTap[\\buildDefs].();
("CLOSURES-OK<" ++ [\\buildDefs, \\makeDefs, \\start, \\stop, \\reconcile].every { |k| viewTap[k].isKindOf(Function) } ++ ">").postln;
tap = SynthDescLib.global[\\poptart_view_tap].def;
fft = SynthDescLib.global[\\poptart_view_fft].def;
score = Score.new;
score.add([0, [\\d_recv, tap.asBytes]]);
score.add([0, [\\d_recv, fft.asBytes]]);
// The signal: a sine on the left, half of it on the right, on a private bus.
score.add([0, [\\d_recv, SynthDef(\\src, { |bus| var s = SinOsc.ar(${HZ}); Out.ar(bus, [s, s * 0.5]) }).asBytes]]);
// What the reader asks with /c_get, written somewhere a render can keep it.
score.add([0, [\\d_recv, SynthDef(\\head, { |head, buf| BufWr.kr(In.kr(head), buf, 0) }).asBytes]]);
score.add([0, [\\b_alloc, 0, 1024, 2]]);
score.add([0, [\\b_alloc, 1, 1, 1]]);
score.add([0, [\\b_alloc, 2, 2048, 1]]);
score.add([0.01, [\\s_new, \\src, 1000, 0, 0, \\bus, 16]]);
score.add([0.01, [\\s_new, \\poptart_view_tap, 1001, 1, 0, \\bus, 16, \\ring, 0, \\head, 5, \\frames, 1024, \\decim, 2]]);
score.add([0.01, [\\s_new, \\poptart_view_fft, 1002, 1, 0, \\bus, 16, \\buf, 2]]);
score.add([0.01, [\\s_new, \\head, 1003, 1, 0, \\head, 5, \\buf, 1]]);
// Late enough that the ring has wrapped many times, and at a block whose head is mid-ring (frame
// ~224), so the seam is somewhere other than the end of the buffer.
score.add([0.4455, [\\b_write, 0, ${out('ring.wav')}, "wav", "float"], [\\b_write, 1, ${out('head.wav')}, "wav", "float"], [\\b_write, 2, ${out('fft.wav')}, "wav", "float"]]);
score.add([0.5, [\\c_set, 0, 0]]);
opts = ServerOptions.new.blockSize_(64).numOutputBusChannels_(2);
score.recordNRT(${out('a.osc')}, ${out('a.wav')}, nil, ${SR}, "WAV", "int16", opts, action: { "NRT-DONE".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the view tap keeps a ring the reader can unroll, and a spectrum frame on the display\'s scale', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-viewtap-'));
  const out = runSclang(dir);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^CLOSURES-OK<true>$/m, `the view-tap closures did not compile:\n${out}`);
  if (!out.includes('NRT-DONE') || !fs.existsSync(path.join(dir, 'ring.wav'))) {
    t.skip(`scsynth did not render here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.doesNotMatch(out, /SynthDef not found|exception in GraphDef_Recv/, out);

  const ring = readWavRaw(path.join(dir, 'ring.wav'));
  const head = readWavRaw(path.join(dir, 'head.wav')).data[0];
  const frames = ring.frames;
  assert.equal(frames, 1024);
  // view-taps.js's unroll: oldest is just after the newest frame written.
  const newest = ((Math.floor(head) % frames) + frames) % frames;
  assert.ok(newest > 16 && newest < frames - 16, `the head landed at ${head}; the render should catch it mid-ring`);
  const l = [];
  const r = [];
  for (let i = 0; i < frames; i++) {
    const at = (newest + 1 + i) % frames;
    l.push(ring.data[at * 2]);
    r.push(ring.data[at * 2 + 1]);
  }
  // A sine obeys x[i-1] + x[i+1] = 2cos(w) x[i] at every point, w being its step per frame - and a
  // seam in the wrong place breaks that wherever it lands, even where the two sides happen to be
  // close in value (a max-step test passed with the seam nine frames off).
  const w = (2 * Math.PI * HZ) / (SR / 2);
  let worst = 0;
  for (let i = 1; i < frames - 1; i++) worst = Math.max(worst, Math.abs(l[i - 1] + l[i + 1] - 2 * Math.cos(w) * l[i]));
  assert.ok(worst < 1e-3, `the unrolled ring is not one stretch of the sine (worst residual ${worst.toFixed(4)})`);
  assert.ok(Math.max(...l.map(Math.abs)) > 0.95, 'the ring holds the signal');
  for (let i = 0; i < frames; i++) assert.ok(Math.abs(r[i] - l[i] * 0.5) < 1e-4, 'the right side is the right channel');

  const db = fftDecibels(readWavRaw(path.join(dir, 'fft.wav')).data);
  const bin = HZ / (SR / 2048);
  let peak = 0;
  for (let k = 1; k < db.length; k++) if (db[k] > db[peak]) peak = k;
  assert.ok(Math.abs(peak - bin) <= 1, `the sine landed in bin ${peak}, not ${bin}`);
  // The mono sum is 0.75 of full scale: about -2.5 dB on the display's scale.
  assert.ok(db[peak] > -4 && db[peak] < -1, `the sine reads ${db[peak]} dB`);
});
