'use strict';

// The channel strip's pan law (sc/poptart.scd, buildTrackDef): constant power, referenced to the
// center.
//
// What this pins (2026-09-20): a track at default settings leaves its strip at the level it came in
// at. The pan stage is a constant-power balance, which on its own is referenced to the hard-panned
// end - 0 dB out there, -3 dB each side at center - so every strip turned a centered track down
// 3 dB, and a track inside a group(), which passes two strips, 6 dB. A sample came out quieter than
// its own file, and wrapping a part in a group changed its level. Referenced to the center instead
// (x sqrt 2) the curve is the same and the numbers are: 0 dB each side at center, +3.01 dB on the
// side a hard pan goes to, nothing on the other - and total power twice the input's at EVERY
// position, which is what "constant power" means and what a wrong factor would break.
//
// The real def is lifted out of the shipped file and rendered offline with DC 1.0 on its input bus,
// so what comes out IS the gain. Skipped (not failed) where sclang, scsynth or the VSTPlugin
// extension can't run, like mixer-stage-sclang.test.js.

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
const LANG_PORT = '57295'; // its own, like every sclang harness: only ten are tried from 57120 up
const POSITIONS = [0, -1, 1, -0.5, 0.25];
// Bus plan: outputs 0..9 (a pair per position), inputs 10-11, private from 12.
const TRASH = 60;
const SILENT = 62;

function extractBuildTrackDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^buildTrackDef = \{ \|key\|[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find buildTrackDef in sc/poptart.scd');
  return m[0];
}

test('the strip is unity at center and constant-power everywhere', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-strip-pan-'));
  try {
    const outPath = path.join(dir, 'render.wav');
    const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
    const parked = ['scSend', 'recOut', 'mixOut', 'busOut1', 'busOut2', 'busOut3', 'busOut4'].flatMap((k) => [k, TRASH]);
    const aux = Array.from({ length: 20 }, (_, i) => [`scBus${i + 1}`, SILENT]).flat();
    const strips = POSITIONS.map((pos, i) => {
      const inBus = 20 + i * 2;
      const args = ['inBus', inBus, 'out', i + 1, 'pan', pos, 'bendOut', 0, 'grainOut', 4, ...parked, ...aux];
      return `    [0.0, ["/s_new", "poptart_dc", ${1000 + i}, 1, 0, "out", ${inBus}]],
    [0.0, ${JSON.stringify(['/s_new', 'poptart_track_t', 2000 + i, 1, 0, ...args])}],`;
    }).join('\n');
    const script = `(
var playChannels = ${POSITIONS.length * 2}, server, maxSlots = 21, trackDefName, bendPollHz = 100, cueOffset, deckMeterBus, buildTrackDef;
var stripDef, dcDef;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
server = (options: (numOutputBusChannels: ${POSITIONS.length * 2}));
deckMeterBus = (index: 56);
trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };
${extractBuildTrackDef()}
stripDef = buildTrackDef.(\\t);
dcDef = SynthDef(\\poptart_dc, { |out| Out.ar(out, DC.ar(1) ! 2) });
("DEF-OK<" ++ stripDef.name ++ ">").postln;
Score.recordNRT([
    [0.0, ["/d_recv", stripDef.asBytes]],
    [0.0, ["/d_recv", dcDef.asBytes]],
${strips}
    [0.3, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(${POSITIONS.length * 2}), duration: 0.3,
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
    if (/Class not defined|Class extension for nonexistent class/.test(out) && !out.includes('DEF-OK')) {
      t.skip('sclang has no VSTPlugin extension here, so the def cannot build');
      return;
    }
    assert.match(out, /DEF-OK<poptart_track_t>/, `the track SynthDef did not build:\n${out}`);
    if (!out.includes('RENDER-DONE')) {
      t.skip(`scsynth did not render here: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }
    const r = readWavRaw(outPath);
    assert.ok(r, 'unreadable render');
    // Well past every control's lag (the longest on this path is 0.15s, and all of them start AT
    // their value - a Lag's first output is its first input).
    const at = Math.round(0.25 * SR);
    const gains = POSITIONS.map((_, i) => [r.data[at * r.channels + i * 2], r.data[at * r.channels + i * 2 + 1]]);
    const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-3, `${what}: ${got.toFixed(5)}, expected ${want.toFixed(5)}`);

    near(gains[0][0], 1, 'center, left');
    near(gains[0][1], 1, 'center, right');
    near(gains[1][0], Math.SQRT2, 'hard left, left');
    near(gains[1][1], 0, 'hard left, right');
    near(gains[2][0], 0, 'hard right, left');
    near(gains[2][1], Math.SQRT2, 'hard right, right');
    POSITIONS.forEach((pos, i) => near(gains[i][0] ** 2 + gains[i][1] ** 2, 2, `total power at pan ${pos}`));
    t.diagnostic(POSITIONS.map((pos, i) => `pan ${pos}: ${gains[i].map((g) => g.toFixed(4)).join(' / ')}`).join('   '));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
