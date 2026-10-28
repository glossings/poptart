// The editor's slot numbers through .split() and .bands() (public/client.js). Every place the
// editor maps code to a slot - the conf writer and auto-pin (findChainCall), .param()'s target
// (chainBefore / paramSlotAt), a device window from a name (findChainHandleAt), the DJ FX unit's
// windows (fxChainSlotAt), parameter completion (slotsIn) - counts the chain's calls in the order
// they are written. Branches keep that order, and a .bands() crossover takes no slot at all (it is
// the engine's, not the user's), so each of them is checked here against the slots the pattern
// itself gives the same code.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as labelsMod from '../pattern-core/src/labels.mjs';
import * as core from '../pattern-core/src/index.mjs';

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
  'firstStringLiteral', 'slotCalls', 'slotsIn', 'findChainCall', 'chainBefore', 'paramSlotAt', 'findChainHandleAt',
  'fxChainSlotAt'];
const lib = new Function('labelsMod', `
  let presetBlocksCache = { code: null, blocks: [] };
  ${names.map(grab).join('\n\n')}
  return { ${names.join(', ')} };
`)(labelsMod);

const CODE = `lead: note("c2 eb2 g2").synth("Wavetable")
  .split(
    (x) => x,
    (b) => b.fx("LPG").param("Decay", 0.08),
    (b) => b.fx("LPG").param("Decay", 0.6)
            .param("Cutoff", env().range(0.2, 0.7)).pan(-0.5).postgain(0.7),
  )
  .fx("Reverb").param("Mix", 0.3)
drums: s("x").bands([250, 2500],
    (low) => low.fx("Crush"),
    (mid) => mid.fx("Distort").param("Drive", 0.6).split((y) => y, (y) => y.fx("Delay")),
    (high) => high.fx("Filter").param("Cutoff", 0.4),
  )
  .fx("Limiter")
`;

// What the pattern makes of each block: the same text, evaluated.
function sigOf(block) {
  const body = CODE.slice(block.start, block.end).replace(/^\s*\w+\s*:\s*/, '');
  const scope = { ...core };
  return new Function(...Object.keys(scope), `return (${body});`)(...Object.values(scope));
}

const blocks = () => labelsMod.splitLabeledBlocks(CODE);
const block = (label) => blocks().find((b) => b.label === label);
const at = (needle, from = 0) => CODE.indexOf(needle, from);

test('each .param() aims at the slot the pattern gives it, through branches and bands', () => {
  for (const label of ['lead', 'drums']) {
    const b = block(label);
    const sig = sigOf(b);
    const re = /\.param\s*\(/g;
    re.lastIndex = b.start;
    const fromEditor = [];
    let m;
    while ((m = re.exec(CODE)) && m.index < b.end) fromEditor.push(lib.paramSlotAt(CODE, m.index, null));
    // The crossovers' own frequencies are set by .bands() itself, not by a .param() in the code.
    const fromPattern = Object.values(sig.paramSignals).filter((e) => sig.fxChain[e.slot - 1] !== 'Crossover').map((e) => e.slot);
    assert.deepEqual(fromEditor, fromPattern, `${label}: the editor and the pattern disagree`);
  }
});

test('findChainCall finds each device\'s call by its slot', () => {
  const b = block('drums');
  const sig = sigOf(b);
  assert.ok(!sig.fxChain.includes('Crossover'), 'a crossover is never one of the chain\'s slots');
  sig.fxChain.forEach((device, i) => {
    assert.equal(lib.findChainCall(CODE, b, i + 1)?.plugin, device, `slot ${i + 1} should be ${device}`);
  });
  const lead = block('lead');
  assert.equal(lib.findChainCall(CODE, lead, 3).plugin, 'Reverb');
});

test('a device window opens on the slot of the name clicked, the crossovers counting for nothing', () => {
  assert.equal(lib.findChainHandleAt(CODE, at('fx("Crush"') + 1).slot, 1);
  assert.equal(lib.findChainHandleAt(CODE, at('fx("Distort"') + 1).slot, 2);
  assert.equal(lib.findChainHandleAt(CODE, at('fx("Delay"') + 1).slot, 3);
  assert.equal(lib.findChainHandleAt(CODE, at('fx("Limiter"') + 1).slot, 5);
  assert.equal(lib.findChainHandleAt(CODE, at('fx("LPG"', at('fx("LPG"') + 1) + 1).slot, 2);
});

test('the user\'s slot numbers are the same with and without .bands() - completion and the FX unit too', () => {
  const banded = CODE.slice(block('drums').start, at('.param("Drive"'));
  const split = banded.replace('.bands([250, 2500],', '.split(');
  assert.equal(lib.slotsIn(banded), 2);
  assert.equal(lib.slotsIn(split), 2);
  const unit = 'fx1: audio("in").bands([500], (l) => l.fx("Crush"), (h) => h).fx("Delay")';
  assert.equal(lib.fxChainSlotAt(unit, unit.indexOf('fx("Crush"')), 1);
  assert.equal(lib.fxChainSlotAt(unit, unit.indexOf('fx("Delay"')), 2);
});
