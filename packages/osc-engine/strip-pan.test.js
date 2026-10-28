'use strict';

// The channel strip's pan law (poptart_track_shared in synthdef/defs.js): constant power,
// referenced to the center. A constant-power balance on its own is referenced to the hard-panned
// end, so every strip once turned a centered track down 3 dB (6 dB inside a group). Referenced to
// the center (x sqrt 2): 0 dB each side at center, +3.01 dB on the side a hard pan goes to,
// nothing on the other, and twice the input's power at every position. Rendered offline with DC
// 1.0 on the strip's input, so what comes out IS the gain.

const { test } = require('node:test');
const assert = require('node:assert');
const synthdef = require('./synthdef');
const U = require('./synthdef/ugens');
const { renderNRT, G } = require('./test-support/nrt');

const SR = 48000;
const POSITIONS = [0, -1, 1, -0.5, 0.25];

test('the strip is unity at center and constant-power everywhere', (t) => {
  const outs = POSITIONS.length * 2;
  const strip = synthdef.defsFor({ numOutputBusChannels: outs }).find((d) => d.name === 'poptart_track_shared');
  assert.ok(strip, 'no poptart_track_shared def');
  const dc = new G.SynthDef('poptart_dc', { out: 0 }, (c) => { U.Out.ar(c.out, [U.DC.ar(1), U.DC.ar(1)]); });
  const score = [[0, ['/d_recv', strip.def]], [0, ['/d_recv', dc]]];
  POSITIONS.forEach((pos, i) => {
    const inBus = 20 + i * 2;
    score.push([0, ['/s_new', 'poptart_dc', 1000 + i, 1, 0, 'out', inBus]]);
    score.push([0, ['/s_new', 'poptart_track_shared', 2000 + i, 1, 0,
      'in', inBus, 'post', 1000000, 'ctl', 8 + i * 6, 'out', i + 1, 'pairs', POSITIONS.length, 'pan', pos]]);
  });
  const r = renderNRT(score, { duration: 0.3, sampleRate: SR, outChannels: outs });
  if (!r.data) { t.skip(r.why); return; }
  const at = Math.round(0.25 * SR);
  const gains = POSITIONS.map((_, i) => [r.at(i * 2, at), r.at(i * 2 + 1, at)]);
  const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-3, `${what}: ${got.toFixed(5)}, expected ${want.toFixed(5)}`);
  near(gains[0][0], 1, 'center, left');
  near(gains[0][1], 1, 'center, right');
  near(gains[1][0], Math.SQRT2, 'hard left, left');
  near(gains[1][1], 0, 'hard left, right');
  near(gains[2][0], 0, 'hard right, left');
  near(gains[2][1], Math.SQRT2, 'hard right, right');
  POSITIONS.forEach((pos, i) => near(gains[i][0] ** 2 + gains[i][1] ** 2, 2, `total power at pan ${pos}`));
});
