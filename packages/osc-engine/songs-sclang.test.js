'use strict';

// The song decks' engine side (sc/poptart.scd): (1) the whole shipped file still COMPILES -
// the song OSCdefs and player def were spliced into it, and a syntax slip anywhere is
// otherwise only discovered by booting the engine; (2) the poptart_song_* player SynthDef
// BUILDS for both channel counts - building runs the UGen graph function client-side, which is
// where an undeclared var, a bad arg default, or a misused UGen throws.
//
// Like mixer-stage-sclang.test.js: the source under test is lifted out of (or is) the shipped
// poptart.scd, run in a real sclang, and skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

// Lift the song player SynthDef, minus its trailing `.add;` (there is no server here; the
// constructor alone builds the graph). Throws rather than silently testing nothing if it moves.
function extractSongDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^        SynthDef\(\("poptart_song_" \+\+ nc\)\.asSymbol, \{[\s\S]*?^        \}\)\.add;$/m);
  assert.ok(m, 'could not find the poptart_song_* SynthDef in sc/poptart.scd');
  return m[0].replace(/\.add;$/, '');
}

function runSclang() {
  const script = `(
var src = File.use(${JSON.stringify(SCD)}, "r", { |f| f.readAllString });
// String#compile parses without executing - nil means a syntax error somewhere in the file.
("COMPILE<" ++ src.compile.notNil ++ ">").postln;
[1, 2].do { |nc|
    var toStereo = { |sig| if (nc == 1) { sig ! 2 } { sig } };
    var def = ${extractSongDef()};
    ("SONGDEF-OK<" ++ def.name ++ ">").postln;
};
0.exit;
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-songdef-')), 'harness.scd');
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

test('poptart.scd compiles whole, and the song player def builds mono and stereo', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  // The whole-file compile needs the VSTPlugin classes; without the extension it fails to
  // compile for a reason that isn't ours. The song def itself uses only core UGens.
  if (/Class not defined/.test(out) && !out.includes('COMPILE<true>')) {
    t.skip('sclang has no VSTPlugin extension here, so the shipped file cannot compile');
    return;
  }
  assert.match(out, /^COMPILE<true>$/m, `sc/poptart.scd no longer parses:\n${out}`);
  assert.match(out, /^SONGDEF-OK<poptart_song_1>$/m, `the mono song def did not build:\n${out}`);
  assert.match(out, /^SONGDEF-OK<poptart_song_2>$/m, `the stereo song def did not build:\n${out}`);
});
