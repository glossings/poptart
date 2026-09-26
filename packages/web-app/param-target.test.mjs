// The editor's reading of `.param()` calls in both forms (public/client.js): which device a call
// aims at has to agree with Sig#_slotFor, or the params panel writes a value onto the wrong call
// and a capture deletes the wrong settings.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as labelsMod from '../pattern-core/src/labels.mjs';
import { n } from '../pattern-core/src/signal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', SRC.indexOf(')', at));
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

const names = ['matchParen', 'codeOnly', 'blockOwnCode', 'splitFirstArg', 'idLiteralValue', 'labeledBlocksFor',
  'chainBefore', 'paramSlotAt', 'paramCallArgs', 'findParamCall', 'presetTargetAt'];
const lib = new Function('labelsMod', `
  let presetBlocksCache = { code: null, blocks: [] };
  ${names.map(grab).join('\n\n')}
  return { ${names.join(', ')} };
`)(labelsMod);

const CODE = `lead: n("0*4").synth("FM")
  .fx("Filter", { label: "lo" }).param("Cutoff", 0.2)
  .fx("Delay")
  .fx("Filter")
  .param("Filter#1", "Resonance", 0.3)
  .param("Delay", "Feedback", 0.5)
  .param("lo", "Drive", 1)
  .param("Cutoff", 0.9)
`;

const calls = () => [...CODE.matchAll(/\.param\s*\(/g)].map((m) => {
  const open = m.index + m[0].length - 1;
  const close = lib.matchParen(CODE, open);
  return { at: m.index, args: lib.paramCallArgs(CODE, open, close) };
});

test('both forms of .param() are read, target and name apart', () => {
  const read = calls().map(({ args }) => [args.target, args.name, args.value]);
  assert.deepEqual(read, [
    [null, 'Cutoff', '0.2'],
    ['Filter#1', 'Resonance', '0.3'],
    ['Delay', 'Feedback', '0.5'],
    ['lo', 'Drive', '1'],
    [null, 'Cutoff', '0.9'],
  ]);
});

test('the editor aims each call at the slot the pattern does', () => {
  const editor = calls().map(({ at, args }) => `${lib.paramSlotAt(CODE, at, args.target)}:${args.name}`);
  const sig = n('0*4').synth('FM')
    .fx('Filter', { label: 'lo' }).param('Cutoff', 0.2)
    .fx('Delay')
    .fx('Filter')
    .param('Filter#1', 'Resonance', 0.3)
    .param('Delay', 'Feedback', 0.5)
    .param('lo', 'Drive', 1)
    .param('Cutoff', 0.9);
  assert.deepEqual([...editor].sort(), Object.keys(sig.paramSignals).sort());
});

test('a value written from the panel lands on the call for that slot', () => {
  const block = labelsMod.splitLabeledBlocks(CODE)[0];
  const on3 = lib.findParamCall(CODE, block, 'Cutoff', 3);
  assert.equal(CODE.slice(on3.valueStart, on3.valueEnd).trim(), '0.9');
  const on1 = lib.findParamCall(CODE, block, 'Cutoff', 1);
  assert.equal(CODE.slice(on1.valueStart, on1.valueEnd).trim(), '0.2');
  const drive = lib.findParamCall(CODE, block, 'Drive', 1);
  assert.equal(CODE.slice(drive.valueStart, drive.valueEnd).trim(), '1');
  assert.equal(lib.findParamCall(CODE, block, 'Drive', 3), null);
});

test('a preset still aims at the last device before it', () => {
  const at = CODE.indexOf('.fx("Delay")') - 1;
  assert.equal(lib.presetTargetAt(CODE, at).slot, 1);
  assert.equal(lib.presetTargetAt(CODE, CODE.length - 2).slot, 3);
});

// --- a device control playing a named shape (see shapeUsesOnControl) ----------------------------

const shapeLib = new Function('labelsMod', `
  let presetBlocksCache = { code: null, blocks: [] };
  ${[...names, 'idsNamedIn', 'shapeUsesOnControl', 'shapeRenameEdits'].filter((n, i, a) => a.indexOf(n) === i).map(grab).join('\n\n')}
  return { shapeUsesOnControl, shapeRenameEdits };
`)(labelsMod);

const SHAPES = `lead: n("0").synth("FM")
  .fx("Distort").param("Mode", "grit")
  .fx("Distort").param("Distort#2", "Mode", "<grit gritty soft>")
  .param("Drive", "grit")
// .param("Mode", "grit")
pad: n("0").synth("Granular").param("Window", "grit")
`;

const apply = (code, edits) => [...edits].sort((a, b) => b[0] - a[0]).reduce((c, [f, t, x]) => c.slice(0, f) + x + c.slice(t), code);

test('a shape played on a device control is found by name, in a pattern of names too', () => {
  const uses = shapeLib.shapeUsesOnControl(SHAPES, 'Mode', 'grit');
  assert.deepEqual(uses.map((u) => u.body), ['grit', '<grit gritty soft>'], 'not another control, not a comment, not another word');
  assert.equal(shapeLib.shapeUsesOnControl(SHAPES, 'Mode', 'gri').length, 0, 'whole names only');
});

test('a rename carries the device calls, and only the name itself', () => {
  const out = apply(SHAPES, shapeLib.shapeRenameEdits(SHAPES, 'Mode', 'grit', 'fuzzy'));
  assert.match(out, /\.param\("Mode", "fuzzy"\)/);
  assert.match(out, /"<fuzzy gritty soft>"/, 'gritty is another shape and keeps its name');
  assert.match(out, /\.param\("Drive", "grit"\)/, 'another control is left alone');
  assert.match(out, /\/\/ \.param\("Mode", "grit"\)/, 'a comment is left alone');
  assert.match(out, /\.param\("Window", "grit"\)/, 'another control name is left alone');
});
