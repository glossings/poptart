'use strict';

// resolvePlugin (sc/poptart.scd) turns what you write - `.fx("Kickstart 2")`, `.fx("Serum 2.vst3")`,
// a literal path - into one of VSTPlugin's dict keys. The rule that matters is which build wins
// when a plugin is installed as BOTH VST2 and VST3: VSTPlugin keys the VST2 by its plain display
// name and the VST3 by "Name.vst3", so a naive exact-key lookup silently picks the VST2. That is
// not cosmetic - a VST2 folds its sidechain into extra channels on a single input bus, while
// buildTrackDef feeds every fx slot a second bus, so `.audio(...)` wires a route the plugin has no
// input for and the sidechain is silently dead.
//
// The logic is sclang, so the real closure is lifted out of poptart.scd and run against a mock
// plugin dict - the source under test is the shipped source, not a copy. Skipped (not failed) when
// sclang cannot run here, matching resolve-sclang.test.js's tolerance for a machine without a
// working SuperCollider.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

// Lift `resolvePlugin = { ... };` out of poptart.scd, from its assignment to the closing `};` at
// column 0. Throws rather than silently testing nothing if the closure is renamed or reindented.
function extractResolvePlugin() {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(/^resolvePlugin = \{[\s\S]*?^\};$/m);
  assert.ok(m, 'could not find the resolvePlugin closure in sc/poptart.scd');
  // The only edit: feed it a mock dict instead of asking a live server for one.
  const body = m[0].replace('VSTPlugin.plugins(server)', 'mock');
  assert.ok(body.includes('mock'), 'resolvePlugin no longer calls VSTPlugin.plugins(server)');
  return body;
}

// A plugin installed twice (VST2 + VST3) as VSTPlugin actually caches it: the VST2 owns the bare
// display name, the VST3 carries the extension, and each desc is reachable by its file path too.
// `key` is the desc's primary key - what resolvePlugin returns and what open() is given.
const MOCK_DICT = `
mock = IdentityDictionary.new;
~vst2 = (name: "Kickstart 2", key: 'Kickstart 2');
~vst3 = (name: "Kickstart 2", key: 'Kickstart 2.vst3');
mock['Kickstart 2'] = ~vst2;
mock['/Library/Audio/Plug-Ins/VST/Kickstart 2.vst'] = ~vst2;
mock['Kickstart 2.vst3'] = ~vst3;
mock['/Library/Audio/Plug-Ins/VST3/Kickstart 2.vst3'] = ~vst3;
mock['kHs Compressor.vst3'] = (name: "kHs Compressor", key: 'kHs Compressor.vst3');
mock['OnlyVst2'] = (name: "OnlyVst2", key: 'OnlyVst2');
`;

const CASES = [
  // The regression: a bare display name shadowed by a VST2 must still reach the VST3.
  ['Kickstart 2', 'Kickstart 2.vst3'],
  // Unambiguous keys keep working untouched.
  ['Kickstart 2.vst3', 'Kickstart 2.vst3'],
  ['kHs Compressor', 'kHs Compressor.vst3'],
  // A shadowed VST2 stays reachable - by its file path, since its bare key is the ambiguous one.
  ['/Library/Audio/Plug-Ins/VST/Kickstart 2.vst', 'Kickstart 2'],
  // No VST3 twin: the VST2 is what the name means, and still resolves.
  ['OnlyVst2', 'OnlyVst2'],
  // Unknown names pass straight through for VSTPlugin itself to complain about.
  ['NotInstalled', 'NotInstalled'],
];

function runSclang() {
  const script = `(
var mock, resolvePlugin;
${MOCK_DICT}
${extractResolvePlugin()}
${CASES.map(([input]) => `("RESULT<" ++ ${JSON.stringify(input)} ++ ">" ++ resolvePlugin.(${JSON.stringify(input)})).postln;`).join('\n')}
0.exit;
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-resolve-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), [file], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A crash still yields whatever it printed before dying - enough to tell "sclang never ran"
    // from "sclang ran and disagreed".
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('resolvePlugin prefers the VST3 when a VST2 shadows the display name', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here, so the rule went unchecked: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  for (const [input, expected] of CASES) {
    const m = out.match(new RegExp(`^RESULT<${input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>(.*)$`, 'm'));
    assert.ok(m, `sclang printed no result for ${JSON.stringify(input)}`);
    assert.strictEqual(m[1].trim(), expected, `resolvePlugin(${JSON.stringify(input)})`);
  }
});
