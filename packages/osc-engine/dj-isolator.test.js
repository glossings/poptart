'use strict';

// The DJ stage's 3-band EQ (djIsolator in synthdef/defs.js), rendered offline through a real
// scsynth: a sine at each test frequency goes through the isolator at each knob setting, and the
// level that comes out is measured against the level that went in.
//
// What this guards is the EQ doing what its knobs say. The isolator it replaced built the mid
// band by subtraction (`in - low - high`), which was exact at neutral and wrong everywhere else:
// with the low knob at 0, 50 Hz came out only -5 dB, 80 Hz -1 dB, and 150-300 Hz came out
// BOOSTED by +4 dB - turning the bass all the way down kept the kick and added boom. So the
// assertions are on kills being kills and on nothing ever coming out louder than asked for.

const { test } = require('node:test');
const assert = require('node:assert');
const { djIsolator } = require('./synthdef/defs');
const U = require('./synthdef/ugens');
const { renderNRT, ugen, G } = require('./test-support/nrt');

const SinOsc = ugen('SinOsc', [440, 0]);
const SR = 48000;

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

function render() {
  const probe = new G.SynthDef('iso_probe', { out: 0, freq: 100, lo: 1, mid: 1, hi: 1 }, (c) => {
    U.Out.ar(c.out, djIsolator(G.mul(SinOsc.ar(c.freq), 0.5), c.lo, c.mid, c.hi));
  });
  const score = [[0, ['/d_recv', probe]]];
  SETTINGS.forEach(([, lo, mid, hi], s) => {
    FREQS.forEach((f, k) => {
      const ch = s * FREQS.length + k;
      score.push([0, ['/s_new', 'iso_probe', 1000 + ch, 0, 0, 'out', ch, 'freq', f, 'lo', lo, 'mid', mid, 'hi', hi]]);
    });
  });
  return renderNRT(score, { duration: 1.0, sampleRate: SR, outChannels: SETTINGS.length * FREQS.length });
}

test('the DJ EQ kills what it kills, and never boosts what it was not asked to', (t) => {
  const wav = render();
  if (!wav.data) { t.skip(wav.why); return; }
  {
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
  }
});
