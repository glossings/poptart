'use strict';

// The DJ stage's 3-band EQ (djIsolator in sc/poptart.scd), rendered offline through a real
// scsynth: a sine at each test frequency goes through the isolator at each knob setting, and the
// level that comes out is measured against the level that went in.
//
// What this guards is the EQ doing what its knobs say. The isolator it replaced built the mid
// band by subtraction (`in - low - high`), which was exact at neutral and wrong everywhere else:
// with the low knob at 0, 50 Hz came out only -5 dB, 80 Hz -1 dB, and 150-300 Hz came out
// BOOSTED by +4 dB - turning the bass all the way down kept the kick and added boom. So the
// assertions are on kills being kills and on nothing ever coming out louder than asked for.
//
// Like the other *-sclang tests: the closure is lifted out of the shipped file, and the test is
// skipped (not failed) where sclang or scsynth can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SR = 48000;
const LANG_PORT = '57288'; // its own, like every sclang harness: only ten are tried from 57120 up
const FREQS = [40, 60, 80, 120, 250, 1000, 2500, 5000, 10000];
// [label, lo, mid, hi]
const SETTINGS = [
  ['neutral', 1, 1, 1],
  ['lowkill', 0, 1, 1],
  ['lowhalf', 0.5, 1, 1],
  ['lowboost', 2, 1, 1],
  ['midkill', 1, 0, 1],
  ['highkill', 1, 1, 0],
  ['nearneutral', 0.99, 1, 1],
];

function extractDjIsolator() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^djIsolator = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the djIsolator closure in sc/poptart.scd');
  return m[0];
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const outPath = path.join(dir, 'iso.wav');
  const channels = SETTINGS.length * FREQS.length;
  const notes = [];
  SETTINGS.forEach(([, lo, mid, hi], s) => {
    FREQS.forEach((f, k) => {
      const ch = s * FREQS.length + k;
      notes.push(`[0.0, ["/s_new", "iso_probe", ${1000 + ch}, 0, 0, "out", ${ch}, "freq", ${f}, "lo", ${lo}, "mid", ${mid}, "hi", ${hi}]]`);
    });
  });
  const script = `(
var djIsolator, def;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
${extractDjIsolator()}
def = SynthDef(\\iso_probe, { |out, freq = 100, lo = 1, mid = 1, hi = 1|
    Out.ar(out, djIsolator.(SinOsc.ar(freq) * 0.5, lo, mid, hi));
});
Score.recordNRT([
    [0.0, ["/d_recv", def.asBytes]],
    ${notes.join(',\n    ')},
    [1.0, ["/c_set", 0, 0]]
], ${JSON.stringify(outPath + '.osc')}, ${JSON.stringify(outPath)}, sampleRate: ${SR}, headerFormat: "WAV",
    sampleFormat: "float", options: ServerOptions.new.numOutputBusChannels_(${channels}), duration: 1.0,
    action: { "RENDER-DONE".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let out;
  try {
    out = execFileSync(sclang, ['-u', LANG_PORT, file], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { out, outPath };
}

test('the DJ EQ kills what it kills, and never boosts what it was not asked to', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-djiso-'));
  try {
    const { out, outPath } = render(dir);
    if (!out.includes('Welcome to SuperCollider')) {
      t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
      return;
    }
    if (!out.includes('RENDER-DONE') || !fs.existsSync(outPath)) {
      t.skip(`scsynth could not render offline here:\n${out.trim().split('\n').slice(-5).join('\n')}`);
      return;
    }
    const wav = readWavRaw(outPath);
    assert.ok(wav, 'unreadable render');
    // dB re the input sine, over the second half of the render (past every filter's settling).
    const level = {};
    SETTINGS.forEach(([label], s) => {
      level[label] = {};
      FREQS.forEach((f, k) => {
        const ch = s * FREQS.length + k;
        let pow = 0;
        let n = 0;
        for (let i = Math.floor(wav.frames / 2); i < wav.frames; i++, n++) pow += wav.data[i * wav.channels + ch] ** 2;
        level[label][f] = 10 * Math.log10(pow / n / (0.5 ** 2 / 2));
      });
    });
    const at = (label, f) => level[label][f];
    const show = (label) => FREQS.map((f) => `${f}:${at(label, f).toFixed(1)}`).join(' ');

    // Neutral is the input, untouched (crossfaded out - bit-exact in fact, but RMS is the check).
    for (const f of FREQS) assert.ok(Math.abs(at('neutral', f)) < 0.01, `neutral is not flat: ${show('neutral')}`);
    // Just off neutral the crossover tree is in, and it is flat too - the LR4 bands sum back.
    for (const f of FREQS) {
      if (f >= 1000) assert.ok(Math.abs(at('nearneutral', f)) < 0.2, `the crossover tree is not flat: ${show('nearneutral')}`);
    }

    // Low at 0: the kick and the sub are GONE, and nothing comes out louder than it went in.
    assert.ok(at('lowkill', 40) < -45, `low kill leaves 40 Hz at ${at('lowkill', 40).toFixed(1)} dB`);
    assert.ok(at('lowkill', 60) < -40, `low kill leaves 60 Hz at ${at('lowkill', 60).toFixed(1)} dB`);
    assert.ok(at('lowkill', 80) < -30, `low kill leaves 80 Hz at ${at('lowkill', 80).toFixed(1)} dB`);
    assert.ok(at('lowkill', 120) < -20, `low kill leaves 120 Hz at ${at('lowkill', 120).toFixed(1)} dB`);
    for (const f of [1000, 2500, 5000, 10000]) assert.ok(Math.abs(at('lowkill', f)) < 0.3, `low kill moved ${f} Hz: ${show('lowkill')}`);

    // Half and double are -6 / +6 dB down in the band.
    assert.ok(Math.abs(at('lowhalf', 40) + 6.02) < 0.3, `low at 0.5 is not -6 dB at 40 Hz: ${show('lowhalf')}`);
    assert.ok(Math.abs(at('lowboost', 40) - 6.02) < 0.3, `low at 2 is not +6 dB at 40 Hz: ${show('lowboost')}`);

    // Mid and high kills.
    assert.ok(at('midkill', 1000) < -25, `mid kill leaves 1 kHz at ${at('midkill', 1000).toFixed(1)} dB`);
    assert.ok(at('highkill', 10000) < -40, `high kill leaves 10 kHz at ${at('highkill', 10000).toFixed(1)} dB`);
    assert.ok(at('highkill', 5000) < -20, `high kill leaves 5 kHz at ${at('highkill', 5000).toFixed(1)} dB`);

    // The bug this replaced: cutting a band boosted its neighbors by up to +4 dB. With every gain
    // at or under 1, no frequency may come out louder than it went in; with low at 2, nothing may
    // exceed the +6 dB asked for.
    for (const [label, lo, mid, hi] of SETTINGS) {
      const ceiling = Math.max(lo, mid, hi) > 1 ? 6.3 : 0.1;
      for (const f of FREQS) assert.ok(at(label, f) < ceiling, `${label} boosts ${f} Hz to ${at(label, f).toFixed(1)} dB: ${show(label)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
