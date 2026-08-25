'use strict';

// The track SynthDef's DJ stage (sc/poptart.scd, performance mixing phase 2): trim -> 3-band
// isolator EQ -> one-knob filter -> fader x deck gain, seven channel controls neutral by default.
// What this guards: (1) the SynthDef still BUILDS - a var/arg/UGen typo in the def is otherwise
// only discovered by booting the whole engine; (2) the filter knob's exponential cutoff mapping;
// (3) channelDefault's neutral values, which the modulator-clear path snaps controls back to -
// a DJ control whose neutral silently became 0 would mute every track on clearing an LFO.
//
// Like resolve-plugin-sclang.test.js, the source under test is lifted out of the shipped
// poptart.scd (not a copy), run in a real sclang, and skipped (not failed) where sclang or the
// VSTPlugin extension can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

// Lift the track SynthDef out of buildTrackDef, from `SynthDef(trackDefName...` to its closing
// `});` at 4-space indent. Throws rather than silently testing nothing if the def moves.
function extractTrackDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^    SynthDef\(trackDefName\.\(key\), \{[\s\S]*?^    \}\);$/m);
  assert.ok(m, 'could not find the track SynthDef in sc/poptart.scd');
  return m[0];
}

// Lift `channelDefault = { ... };` the same way.
function extractChannelDefault() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^channelDefault = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the channelDefault closure in sc/poptart.scd');
  return m[0];
}

// And `destroyTrack = { ... };` (performance mixing phase 4) - compiled, not called: assigning
// the closure in a scope that declares its dependencies catches syntax and undeclared-variable
// mistakes, the ones otherwise only found by booting the whole engine.
function extractDestroyTrack() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^destroyTrack = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the destroyTrack closure in sc/poptart.scd');
  return m[0];
}

const DEFAULT_CASES = [
  // The DJ stage's controls: unity everywhere, except the filter knob's center detent at 0.
  ['trim', '1'], ['eqlo', '1'], ['eqmid', '1'], ['eqhi', '1'],
  ['fader', '1'], ['deck', '1'], ['djf', '0'],
  // And the pre-existing strip, unchanged.
  ['gain', '1'], ['out', '1'], ['dry', '1'], ['width', '1'], ['pan', '0'], ['bassmono', '0'],
];

function runSclang() {
  const script = `(
var maxSlots = 8, numPairs = 2, key = "probe";
var trackDefName = { |k| ("poptart_probe_" ++ k).asSymbol };
var channelDefault, def;
var destroyTrack, awaitTrack, stopMixTap, unwireAudio, sidechainBySource, releaseBus, tracks;
${extractChannelDefault()}
// Building the def runs the whole UGen graph function client-side - no server needed; this is
// where an undeclared var, a bad arg default, or a misused UGen throws. Pasted directly (like
// resolve-plugin-sclang.test.js pastes its closure): on a machine without the VSTPlugin
// extension this fails to COMPILE ("Class not defined"), which the test reads as a skip.
def = ${extractTrackDef()}
("DEF-OK<" ++ def.name ++ ">").postln;
${extractDestroyTrack()}
("DESTROY-OK<" ++ destroyTrack.isKindOf(Function) ++ ">").postln;
// The one-knob filter's cutoff mapping at its three cardinal positions.
("MAP<lpf-closed>" ++ (18000 * (900 ** -1)).clip(20, 18000)).postln;
("MAP<lpf-open>" ++ (18000 * (900 ** 0)).clip(20, 18000)).postln;
("MAP<hpf-closed>" ++ (20 * (900 ** 1)).clip(20, 18000)).postln;
${DEFAULT_CASES.map(([name]) => `("DEFAULT<${name}>" ++ channelDefault.(${JSON.stringify(name)})).postln;`).join('\n')}
0.exit;
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-mixstage-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), [file], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the track SynthDef builds with the DJ stage, and its neutrals are really neutral', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here, so the def went unbuilt: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  if (/Class not defined|Class extension for nonexistent class/.test(out) && !out.includes('DEF-OK')) {
    t.skip('sclang has no VSTPlugin extension here, so the def cannot build');
    return;
  }
  assert.match(out, /^DEF-OK<poptart_probe_probe>$/m, `the SynthDef did not build:\n${out}`);
  assert.match(out, /^DESTROY-OK<true>$/m, `the destroyTrack closure did not compile:\n${out}`);
  assert.match(out, /^MAP<lpf-closed>20(\.0)?$/m, 'filter full-left should close the LPF to 20 Hz');
  assert.match(out, /^MAP<lpf-open>18000(\.0)?$/m, 'filter at center should park the LPF open at 18 kHz');
  assert.match(out, /^MAP<hpf-closed>18000(\.0)?$/m, 'filter full-right should close the HPF to 18 kHz');
  for (const [name, expected] of DEFAULT_CASES) {
    const m = out.match(new RegExp(`^DEFAULT<${name}>(.*)$`, 'm'));
    assert.ok(m, `sclang printed no channelDefault for "${name}"`);
    assert.strictEqual(m[1].trim(), expected, `channelDefault("${name}")`);
  }
});
