'use strict';

// The mixer's analysis defs (poptart_mix_analysis / poptart_mix_meter, synthdef/defs.js mixDefs),
// built for the band centers the engine ships (MIX_BAND_FREQS) and run offline through scsynth.
//
// With poptart's own devices the analyzer is one PoptartSpectrum unit. Without them it is a
// bandpass bank of close to a thousand UGens, and that one has a sort hazard: built anywhere but
// first, the frame clock sinks under the filters and every filtered signal is live at once - past
// scsynth's default 64 wire buffers, so the def silently fails to load. So: the clock comes first,
// the peak live wire count stays small, and both kinds load and run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const synthdef = require('./synthdef');
const { decodeScgf } = require('./synthdef/decode');
const { MIX_BAND_FREQS } = require('./index.js');
const { renderNRT, ugen, G } = require('./test-support/nrt');
const U = require('./synthdef/ugens');

const SCX = path.join(__dirname, 'native', 'devices', 'bin', 'PoptartDevices.scx');
const PinkNoise = ugen('PinkNoise', [], G.UGen);

const defs = (spectrum) => synthdef.mixDefsFor(MIX_BAND_FREQS, { nativeDevices: spectrum, spectrum });

/** The most audio wires live at once in the def's sorted order (scsynth's wire-buffer count). */
function maxWires(d) {
  const consumers = new Map();
  for (const u of d.ugens) {
    for (const x of u.inputs) if ('u' in x && d.ugens[x.u].rate === 2) consumers.set(x.u, (consumers.get(x.u) ?? 0) + 1);
  }
  let live = 0;
  let peak = 0;
  for (const u of d.ugens) {
    if (u.rate === 2) { live += u.outputs.length; peak = Math.max(peak, live); }
    const seen = new Set();
    for (const x of u.inputs) {
      if (!('u' in x) || d.ugens[x.u].rate !== 2 || seen.has(x.u)) continue;
      seen.add(x.u);
      consumers.set(x.u, consumers.get(x.u) - 1);
      if (consumers.get(x.u) === 0) live -= d.ugens[x.u].outputs.length;
    }
  }
  return peak;
}

function run(entries) {
  const src = new G.SynthDef('src', { bus: 0 }, (c) => { U.Out.ar(c.bus, G.mul([PinkNoise.ar(), PinkNoise.ar()], 0.3)); });
  return renderNRT([
    ...entries.map((e) => [0, ['/d_recv', e.def]]),
    [0, ['/d_recv', src]],
    [0.01, ['/s_new', 'src', 1000, 0, 0, 'bus', 16]],
    [0.01, ['/s_new', 'poptart_mix_analysis', 1001, 1, 0, 'bus', 16]],
    [0.01, ['/s_new', 'poptart_mix_meter', 1002, 1, 0, 'bus', 16]],
  ], { duration: 0.5, extra: ['-z', '256'] });
}

test('the mixer analyzer is the native spectrum unit where it is installed, and it loads and runs', (t) => {
  if (!fs.existsSync(SCX)) { t.skip('no PoptartDevices.scx in this checkout'); return; }
  const e = defs(true);
  const analysis = decodeScgf(e[0].bytes)[0];
  assert.ok(analysis.ugens.length < 20, `analysis def has ${analysis.ugens.length} UGens - expected the one unit, not the filter bank`);
  assert.ok(analysis.ugens.some((u) => u.name === 'PoptartSpectrum'));
  const r = run(e);
  if (!r.data) { t.skip(r.why); return; }
  assert.doesNotMatch(r.text, /not installed|SynthDef not found|exception in GraphDef_Recv|UGen '.*' not installed/, `the analyzer did not load:\n${r.text}`);
});

test("without poptart's own devices, the filter-bank analyzer builds, sorts within the default wire buffers, and loads", (t) => {
  const e = defs(false);
  const analysis = decodeScgf(e[0].bytes)[0];
  const meter = decodeScgf(e[1].bytes)[0];
  assert.ok(analysis.ugens.length > 900, `analysis def has ${analysis.ugens.length} UGens - expected the full bank`);
  assert.ok(meter.ugens.length < 10, `meter def has ${meter.ugens.length} UGens - expected a bare SendPeakRMS`);
  const firstReal = analysis.ugens.find((u) => u.name !== 'Control' && u.name !== 'AudioControl' && u.name !== 'TrigControl');
  assert.strictEqual(firstReal.name, 'Impulse', 'the frame clock must be the first UGen built (see the def comment)');
  const wires = maxWires(analysis);
  assert.ok(wires <= 16, `${wires} audio wires live at once - the sort has lost its interleave (limit 64)`);
  const r = run(e);
  if (!r.data) { t.skip(r.why); return; }
  assert.doesNotMatch(r.text, /exceeded number of interconnect buffers/, 'the analyzer overran the default wire buffers');
  assert.doesNotMatch(r.text, /SynthDef not found/, 'the analyzer did not load into scsynth');
});
