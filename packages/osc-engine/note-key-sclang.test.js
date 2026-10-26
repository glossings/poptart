'use strict';

// noteKey in sc/poptart.scd: the note an instrument slot is handed. poptart's own devices take a
// fractional note exactly (a tuning, a fractional degree); a plugin takes MIDI, so it gets the
// nearest key. Lifted out of the shipped file and run in a real sclang; skipped where sclang
// can't run, and the device half skipped where the PoptartDevice extension isn't installed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57286'; // its own, like every sclang harness: only ten are tried from 57120 up

function extract() {
  const m = fs.readFileSync(SCD, 'utf8').match(/^noteKey = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find noteKey in sc/poptart.scd');
  return m[0];
}

test('noteKey hands a device the exact note and a plugin the nearest key', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-notekey-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, `(
var noteKey, plugin, device;
${extract()}
plugin = (midi: (kind: \\vst));
("PLUGIN<" ++ [noteKey.(plugin, 62.4), noteKey.(plugin, 62.6), noteKey.(plugin, 60)].collect({ |v| v.class.name ++ ":" ++ v }).join(",") ++ ">").postln;
\\PoptartDeviceMIDIProxy.asClass !? { |c|
    device = (midi: c.new(nil));
    ("DEVICE<" ++ [noteKey.(device, 62.4), noteKey.(device, 60)].collect({ |v| v.class.name ++ ":" ++ v }).join(",") ++ ">").postln;
};
0.exit;
)
`);
  let out;
  try {
    out = execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^PLUGIN<Integer:62,Integer:63,Integer:60>$/m, `a plugin must get whole keys:\n${out}`);
  if (out.includes('DEVICE<')) {
    assert.match(out, /^DEVICE<Float:62\.4,Float:60\.0>$/m, `a device must get the note as written:\n${out}`);
  }
});
