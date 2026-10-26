'use strict';

// The headphone section in sc/poptart.scd (\poptart_headphones): the node after the master meter
// that turns the summed cue sends into what the headphones play - the cue/main blend and the level.
//
// What this guards: (1) the def still builds - poptart.scd only reloads on a restart, so a graph
// error fails silently mid-session; (2) it reads the main mix from every output BUT the cue pair,
// plus the cue pair itself; (3) it writes once, replacing the cue pair - adding to it instead
// would play the cue twice, and writing anywhere else would put the headphones in the room.
//
// Like the other *-sclang tests: the source is lifted out of the shipped file, run in a real
// sclang, and skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57298'; // its own, so a package run's sclangs don't race for one

function extractDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  // The whole guarded block: the def is only built on an engine booted with a cue pair.
  const m = src.match(/^ {4}cueOffset !\? \{\n {8}SynthDef\(\\poptart_headphones, \{[\s\S]*?^ {8}\}\)\.add;\n {4}\};$/m);
  assert.ok(m, 'could not find the \\poptart_headphones def in sc/poptart.scd');
  return m[0];
}

function build(outputs, cueOffset) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-phones-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, `(
var server = (options: (numOutputBusChannels: ${outputs}));
var cueOffset = ${cueOffset};
var def, ins, outs;
${extractDef()}
("BUILT<" ++ SynthDescLib.global[\\poptart_headphones].notNil ++ ">").postln;
def = SynthDescLib.global[\\poptart_headphones] !? (_.def);
def !? {
ins = def.children.select { |u| u.isKindOf(In) };
("READS<" ++ ins.collect { |u| u.inputs[0].asInteger.asString ++ "x" ++ u.channels.size }.sort.join(",") ++ ">").postln;
outs = def.children.select { |u| u.isKindOf(AbstractOut) };
("WRITES<" ++ outs.collect { |u| u.class.name.asString ++ "@" ++ u.inputs[0].asInteger ++ "x" ++ (u.inputs.size - 1) }.join(",") ++ ">").postln;
("CONTROLS<" ++ def.allControlNames.collect(_.name).join(",") ++ ">").postln;
};
0.exit;
)
`);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the headphones read the main outputs and the cue pair, and replace only the cue pair', (t) => {
  const out = build(6, 2);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  // Outputs 1-2 and 5-6 are the main mix, one channel each; 3-4 the cue sum, read as a pair.
  assert.match(out, /^READS<0x1,1x1,2x2,4x1,5x1>$/m, `unexpected reads:\n${out}`);
  assert.match(out, /^WRITES<ReplaceOut@2x2>$/m, `the headphones must replace the cue pair and write nothing else:\n${out}`);
  assert.match(out, /^CONTROLS<level,mix>$/m, `unexpected controls:\n${out}`);
});

test('an engine with no cue pair builds no headphones, and does not crash building them', (t) => {
  // cueOffset nil is every engine without a headphone output picked. The def used to be built
  // anyway and died on `nil + 1` at boot (2026-10-25).
  const out = build(2, 'nil');
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.doesNotMatch(out, /ERROR/, `building with no cue pair errored:\n${out}`);
  assert.match(out, /^BUILT<false>$/m, `the headphones were built with no cue pair:\n${out}`);
});
