'use strict';

// The master meter in sc/poptart.scd (\poptart_master): the last node in the tree, which sums
// every hardware output to one stereo pair and reports the peak of that - the whole song's level.
//
// What this guards: (1) the def still builds - poptart.scd only reloads on a restart, so a graph
// error in it fails silently mid-session; (2) it only listens: it must never write to an output,
// because it sits after every sound the engine makes; (3) it reads every output, and leaves the
// headphone cue pair out.
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
const LANG_PORT = '57297'; // its own, so a package run's sclangs don't race for one

/** The shipped def, whole. */
function extractDef() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^ {4}SynthDef\(\\poptart_master, \{[\s\S]*?^ {4}\}\)\.add;$/m);
  assert.ok(m, 'could not find the \\poptart_master def in sc/poptart.scd');
  return m[0];
}

function build(outputs, cueOffset) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-master-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, `(
var server = (options: (numOutputBusChannels: ${outputs}));
var cueOffset = ${cueOffset ?? 'nil'};
var def;
${extractDef()}
def = SynthDescLib.global[\\poptart_master].def;
("READS<" ++ def.children.select { |u| u.isKindOf(In) }.collect { |u| u.inputs[0].asInteger }.sort.join(",") ++ ">").postln;
("WRITES<" ++ def.children.count { |u| u.isKindOf(AbstractOut) } ++ ">").postln;
("FEED<" ++ def.children.count { |u| u.isKindOf(SendPeakRMS) } ++ ">").postln;
// SendPeakRMS's inputs are [reply rate, peak lag, replyID, channel count, ...channels, name...].
("SIDES<" ++ def.children.detect { |u| u.isKindOf(SendPeakRMS) }.inputs[3].asInteger ++ ">").postln;
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

test('the master meter reads every output and writes to none', (t) => {
  const out = build(4, null);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^READS<0,1,2,3>$/m, `the meter should read all four outputs:\n${out}`);
  assert.match(out, /^WRITES<0>$/m, 'the meter writes to an output - it must only listen');
  assert.match(out, /^FEED<1>$/m, 'the meter should send one peak feed');
  assert.match(out, /^SIDES<2>$/m, `four outputs should be measured as ONE summed stereo pair, not four channels:\n${out}`);
});

test('the headphone cue pair is not part of the master', (t) => {
  const out = build(4, 2);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^READS<0,1>$/m, `with the cue on outputs 3-4 the meter should read 1-2 only:\n${out}`);
});
