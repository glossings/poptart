'use strict';

// markSounding (sc/poptart.scd): what a slot is sounding, filed per note as it starts. The first
// note on a slot makes the slot's list - and must still be filed, and must not throw: the note-on
// handler it is called from would stop there and the note would be dropped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

test('the first note on a slot is filed as sounding, and so is the next', (t) => {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^markSounding = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'markSounding is not in poptart.scd any more');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-sounding-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, `(
var markSounding, track = (sounding: IdentityDictionary.new), later = Main.elapsedTime + 60;
${m[0]}
markSounding.(track, 2, 60, later);
markSounding.(track, 2, 64, later);
markSounding.(track, 3, 67, later);
("SLOT2<" ++ track[\\sounding][2].keys.asArray.sort.join(",") ++ ">").postln;
("SLOT3<" ++ track[\\sounding][3].keys.asArray.sort.join(",") ++ ">").postln;
0.exit;
)
`);
  let out;
  try {
    out = execFileSync(resolveSclangPath(), ['-u', '57337', file], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!out.includes('Welcome to SuperCollider')) { t.skip('sclang did not start here'); return; }
  assert.doesNotMatch(out, /ERROR/, out);
  assert.match(out, /^SLOT2<60,64>$/m);
  assert.match(out, /^SLOT3<67>$/m);
});
