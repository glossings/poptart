'use strict';

// The slice editor's fit control (public/client.js): saying how many cycles a sample is fitted to,
// and reading the `.fit(...)` on the chain that overrides it.
//
// The panel writes fit into the SET, beside that sample's markers - it is a fact about the file,
// and four breaks under one name want four answers. What it must never do is write onto the chain:
// a `.fit()` there is the pattern's, and the pattern wins.
//
// The arithmetic is playSample's, duplicated across the package boundary because the engine is
// CommonJS and the panel is a browser file - so the test runs BOTH and asserts they agree. If the
// engine's fit rule ever changes, this is what says the readout has started lying.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { OscEngine } = require('./../osc-engine/index.js');

let labelsMod;
test.before(async () => {
  const dir = path.dirname(require.resolve('@poptart/pattern-core'));
  labelsMod = await import(require('node:url').pathToFileURL(path.join(dir, 'labels.mjs')).href);
});

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

const bodies = ['codeOnly', 'blockOwnCode', 'matchParen', 'sliceSourceCallAt', 'sliceFitChain', 'sliceFitCall', 'sliceFitCycles', 'prFitCycles']
  .map(grab)
  .join('\n\n');

/**
 * The panel's fit functions, over a fixed buffer of code. `sliceState`/`cm`/`transport` are the
 * globals they read; the panel is looking at the end of the buffer, as it would be having been
 * opened from the `.slices(...)` there.
 */
function panel(code, { duration = 4.8, cps = 0.5 } = {}) {
  const cm = { getValue: () => code, indexFromPos: (i) => i, posFromIndex: (i) => i };
  const sliceState = { at: code.length - 1, source: null, buffer: duration ? { duration } : null };
  // eslint-disable-next-line no-new-func
  return new Function('labelsMod', 'cm', 'sliceState', 'transport', 'sliceAtNow', `
    ${bodies}
    return { sliceFitCall, sliceFitCycles, sliceFitChain, prFitCycles };
  `)(labelsMod, cm, sliceState, { cps }, () => sliceState.at);
}

/** What the engine makes of the same file at the same tempo - the number the panel has to match. */
function engineCycles(duration, cps, fit) {
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  engine.getTime = () => 0;
  engine._packs.set('breaks', { status: 'ready', files: [{ path: 'breaks/a.wav', duration, channels: 2 }] });
  const sent = [];
  engine._send = (addr, args) => sent.push({ addr, args });
  engine.playSample('t1', 'breaks', { fit, secPerCycle: 1 / cps }, 0, 1);
  const speed = sent.pop().args[6]; // ARG.speed
  // The file lasts duration/speed seconds, which is that many cycles at this tempo.
  return (duration / speed) * cps;
}

test('the readout is the number of cycles the engine actually fits to', () => {
  for (const [duration, cps] of [[4.8, 0.5], [2, 0.5], [7.9, 0.5], [1.9, 1], [0.4, 0.5], [30, 0.5]]) {
    const shown = panel('b: s("breaks").fit().slice("0 1")', { duration, cps }).sliceFitCycles('auto');
    const played = engineCycles(duration, cps, 'auto');
    assert.ok(Math.abs(shown - played) < 1e-9, `${duration}s at ${cps}cps: panel says ${shown}, engine plays ${played}`);
  }
});

test('an explicit fit is its own answer, and the engine agrees', () => {
  const p = panel('b: s("breaks").fit(4).slice("0 1")', { duration: 4.8 });
  assert.equal(p.sliceFitCall().value, 4);
  assert.equal(p.sliceFitCycles(4), 4);
  assert.ok(Math.abs(engineCycles(4.8, 0.5, 4) - 4) < 1e-9);
});

test('a bare .fit() reads as auto, and no .fit() at all reads as nothing', () => {
  assert.equal(panel('b: s("breaks").fit().slice("0 1")').sliceFitCall().value, 'auto');
  assert.equal(panel('b: s("breaks").slice("0 1")').sliceFitCall(), null);
  // A commented-out one is not the chain's, and neither is another track's.
  assert.equal(panel('b: s("breaks") // .fit(2)\n  .slice("0 1")').sliceFitCall(), null);
});

test('a patterned fit is reported, not touched', () => {
  const call = panel('b: s("breaks").fit("<2 4>").slice("0 1")').sliceFitCall();
  assert.equal(call.value, '"<2 4>"');
  assert.equal(panel('b: s("breaks").fit("<2 4>").slice("0 1")').sliceFitCycles(call.value), null);
});

test('the cycle count waits for the sample rather than guessing', () => {
  assert.equal(panel('b: s("breaks").fit().slice("0 1")', { duration: 0 }).sliceFitCycles('auto'), null);
  assert.equal(panel('b: s("breaks").fit().slice("0 1")', { cps: 0 }).sliceFitCycles('auto'), null);
});

test('the panel has no way to write a .fit() onto the chain', () => {
  // Not an oversight - the whole point of the change. The only place the panel puts a fit is the
  // set entry (sliceWriteFit), so nothing here can rewrite someone's pattern.
  assert.ok(!/function sliceFitInsertAt\b/.test(SRC), 'the chain-insert path should be gone');
  assert.ok(!/sliceWriteFit[\s\S]{0,600}?\.fit\(\$\{/.test(SRC), 'sliceWriteFit must not build a .fit() call');
});

test('a set entry carries the fit, and the two spellings mean the same thing', async () => {
  const dir = path.dirname(require.resolve('@poptart/pattern-core'));
  const slices = await import(require('node:url').pathToFileURL(path.join(dir, 'slices.mjs')).href);
  // What the panel holds while it is open, and what it files.
  const filed = slices.normalizeSliceEntry({ fit: 4, marks: [0, 0.5] });
  assert.deepEqual(filed, { fit: 4, marks: [0, 0.5] });
  assert.equal(slices.sliceEntryFor({ 'a.wav': filed }, 'a.wav').fit, 4);
  // Fit turned off leaves a plain list of markers - one spelling per meaning.
  assert.deepEqual(slices.normalizeSliceEntry({ fit: null, marks: [0, 0.5] }), [0, 0.5]);
  // ...and a fit with no markers is a real entry: this sample is fitted, and chops on its own
  // transients ("different fits / not fits per sample").
  assert.deepEqual(slices.normalizeSliceEntry({ fit: 'auto', marks: [] }), { fit: 'auto' });
});

test('no fit at all is the file\'s own length - what the roll lays its chops against', () => {
  // "slice to notes" has to answer for a sample the pattern never fitted, and the honest answer is
  // how long it actually plays for: speed 1, so duration seconds is duration*cps cycles. The engine
  // is asked the same question with no fit in the config at all.
  for (const [duration, cps] of [[4.8, 0.5], [2, 0.5], [1.9, 1], [0.4, 0.5]]) {
    const shown = panel('b: s("breaks").slice("0 1")', { duration, cps }).prFitCycles(null, duration);
    const played = engineCycles(duration, cps, undefined);
    assert.ok(Math.abs(shown - played) < 1e-9, `${duration}s at ${cps}cps: panel says ${shown}, engine plays ${played}`);
  }
  // A fit, on the other hand, is the panel's own reading - and a patterned one has no single answer.
  const p = panel('b: s("breaks").slice("0 1")', { duration: 4.8, cps: 0.5 });
  assert.equal(p.prFitCycles(4, 4.8), 4);
  assert.equal(p.prFitCycles('auto', 4.8), 2);
  assert.equal(p.prFitCycles('"<2 4>"', 4.8), null);
  assert.equal(p.prFitCycles(null, 0), null); // still decoding: no answer rather than a wrong one
});
