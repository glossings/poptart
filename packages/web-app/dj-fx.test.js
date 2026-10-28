'use strict';

// The DJ FX unit's server side, minus the engine: which decks the unit is switched in on, and
// how a plugin's captured settings are pinned back into the CHAIN'S OWN CODE.
//
// The pinning is the part worth a test of its own. A chain's plugins are not in any buffer, so
// the editor's auto-pin writer cannot reach them (it only ever writes the main CodeMirror) - the
// server rewrites the chain's code instead, matching captures to `.fx()` calls in chain order.
// It is pure string work, it is invisible until a session is reopened and the sound is wrong,
// and the spacing of real code is nothing like the spacing of an example.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// server.js spawns an engine on require, so the functions are read out of the source and given
// their own dependencies - the same trick dj-midi.test.js and arrange-end.test.js use.
//
// Cut at the closing brace in COLUMN ZERO rather than by counting braces: fxWriteStates holds a
// regex literal whose own `\{…\}` are not code, and a counter reads them as one, stopping the
// slice halfway through the function (which fails as a syntax error, loudly but confusingly).
// Every function read here is top-level, so its end is the first `}` on a line of its own.
function grabFn(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in server.js - this test needs updating`);
  const end = SRC.indexOf('\n}\n', at);
  assert.ok(end > at, `could not find the end of ${name} in server.js`);
  return SRC.slice(at, end + 3);
}

// eslint-disable-next-line no-new-func
const makeFx = new Function('mixState', `
  ${grabFn('fxWriteStates')}
  ${grabFn('fxSendLevels')}
  const fxSounding = () => !!mixState.fx.chain && (mixState.fx.on || mixState.fx.held);
  return { fxWriteStates, fxSendLevels };
`);

const fxRig = (fx = {}) => makeFx({ fx: { chain: 'sweep', on: false, held: false, knob: 0, assign: 'ab', ...fx } });

// --- which decks the unit is switched in on ---

test('the unit is switched in only where it is assigned, and only while a pad is down', () => {
  // Nothing pressed: the decks' direct paths stay open.
  assert.deepEqual(fxRig().fxSendLevels(), { a: 0, b: 0 });
  // Latched, on both decks.
  assert.deepEqual(fxRig({ on: true }).fxSendLevels(), { a: 1, b: 1 });
  // Held (the momentary pad) counts exactly as much as latched.
  assert.deepEqual(fxRig({ held: true }).fxSendLevels(), { a: 1, b: 1 });
  // Assigned to one deck: the other is untouched, which is what makes the assign switch safe to
  // flip mid-set - it is routing, not a plugin load.
  assert.deepEqual(fxRig({ on: true, assign: 'a' }).fxSendLevels(), { a: 1, b: 0 });
  assert.deepEqual(fxRig({ on: true, assign: 'b' }).fxSendLevels(), { a: 0, b: 1 });
  // No chain loaded: a pad press does nothing at all rather than inserting silence.
  assert.deepEqual(fxRig({ chain: null, on: true }).fxSendLevels(), { a: 0, b: 0 });
});

test('it is all-or-nothing per deck: the knob is the chain\'s, not the send\'s', () => {
  // The send is a path crossfade against the deck's direct output (see the track def), so a
  // partial send would mean half the deck going nowhere. The dry/wet is inside the chain.
  for (const knob of [0, 0.3, 1]) {
    assert.deepEqual(fxRig({ on: true, knob }).fxSendLevels(), { a: 1, b: 1 });
  }
});

// --- pinning captured plugin settings into the chain's code ---

test('each capture lands on its own .fx() call, in chain order', () => {
  const { fxWriteStates } = fxRig();
  const code = '.fx("Pro-C 2").param("Threshold", fx1).fx("kHs Comb Filter").param("Cutoff", fx1)';
  const out = fxWriteStates(code, ['@aaaaaaaaaaaa', '@bbbbbbbbbbbb']);
  assert.equal(out, '.fx("Pro-C 2", { state: "@aaaaaaaaaaaa" }).param("Threshold", fx1)'
    + '.fx("kHs Comb Filter", { state: "@bbbbbbbbbbbb" }).param("Cutoff", fx1)');
});

test('a capture that came back empty leaves its call exactly as it was', () => {
  const { fxWriteStates } = fxRig();
  const code = '.fx("A").fx("B")';
  // Slot 1 reported nothing (a plugin with no state to give); slot 2 did.
  assert.equal(fxWriteStates(code, [null, '@bbbbbbbbbbbb']),
    '.fx("A").fx("B", { state: "@bbbbbbbbbbbb" })');
  // Nothing captured at all: the code is untouched, which is what stops a pointless rewrite
  // (and the save, and the rebuild) from happening at all.
  assert.equal(fxWriteStates(code, [null, null]), code);
  assert.equal(fxWriteStates(code, []), code);
});

test('a state already pinned is REPLACED, not stacked beside the old one', () => {
  const { fxWriteStates } = fxRig();
  const code = '.fx("A", { state: "@old0old0old0" }).fx("B")';
  assert.equal(fxWriteStates(code, ['@new1new1new1', null]),
    '.fx("A", { state: "@new1new1new1" }).fx("B")');
});

test('real spacing, single quotes and a wrapped chain all still match', () => {
  const { fxWriteStates } = fxRig();
  const code = [
    ".fx('Pro-C 2')",
    '  .param("Threshold", fx1)',
    '  .fx( "kHs Comb Filter" )',
    '  .param("Cutoff", fx1.range(0.2, 0.4))',
  ].join('\n');
  const out = fxWriteStates(code, ['@aaaaaaaaaaaa', '@bbbbbbbbbbbb']);
  assert.match(out, /\.fx\('Pro-C 2', \{ state: "@aaaaaaaaaaaa" \}\)/, 'single quotes are kept as written');
  assert.match(out, /\.fx\("kHs Comb Filter", \{ state: "@bbbbbbbbbbbb" \}\)/);
  assert.equal(out.split('\n').length, 4, 'the chain keeps its own layout');
});

test('a plugin name holding a dot or a paren does not split the call', () => {
  const { fxWriteStates } = fxRig();
  const code = '.fx("Reverb (Hall) 2.0")';
  assert.equal(fxWriteStates(code, ['@aaaaaaaaaaaa']), '.fx("Reverb (Hall) 2.0", { state: "@aaaaaaaaaaaa" })');
});

test('.param() calls naming a plugin are not mistaken for .fx() calls', () => {
  // The capture list is indexed by chain slot, so anything else that looks like a call must not
  // consume one: a chain whose second capture landed on a .param() would pin the wrong plugin.
  const { fxWriteStates } = fxRig();
  const code = '.fx("A").param("Mix", fx1).wet(fx1).fx("B")';
  assert.equal(fxWriteStates(code, ['@aaaaaaaaaaaa', '@bbbbbbbbbbbb']),
    '.fx("A", { state: "@aaaaaaaaaaaa" }).param("Mix", fx1).wet(fx1).fx("B", { state: "@bbbbbbbbbbbb" })');
});

// --- the chain code's one shape rule, as the save route states it ---

test('a chain continues `song`, so its code starts with a dot', () => {
  // The guard lives in the save route; what is pinned here is that it exists and says so, since
  // the alternative is a chain that compiles to something that is not a chain at all.
  const route = SRC.slice(SRC.indexOf("'POST /api/mix/fxchain'"));
  const body = route.slice(0, route.indexOf('\n  },'));
  assert.match(body, /code\.startsWith\('\.'\)/);
  assert.match(body, /fxBuildSig\(/, 'a save compiles the chain before it is allowed into settings');
  assert.match(body, /knobWet \? `\$\{hydrated\}\.wet\(fx1\)` : hydrated/,
    'and compiles what the unit will actually build, dry/wet included');
});

// --- which effect a click in the chain editor is on -------------------------------------------
//
// The editor's double-click opens a plugin's own window BY SLOT, and the slots it counts have to
// be the slots the evaluated chain has - the same numbering fxWriteStates pins captures by, and
// the one /api/mix/fx bounds against the built chain. Off by one and the gesture opens the wrong
// plugin, or (on the first effect) nothing at all, which is how it shipped for one build.

const CLIENT = fs.readFileSync(path.join(__dirname, 'public/client.js'), 'utf8');

// The real mask behind codeOnly - pattern-core's own lexer, so "is this offset code?" is
// answered here exactly as the browser answers it. Loaded in a hook because it is ESM.
let fxChainSlotAt;
test.before(async () => {
  const { codeMask } = await import(url.pathToFileURL(path.join(__dirname, '../pattern-core/src/labels.mjs')).href);
  // fxChainSlotAt, and the chain scan it counts slots with.
  const body = (name) => {
    const at = CLIENT.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} not found in public/client.js - this test needs updating`);
    return CLIENT.slice(at, CLIENT.indexOf('\n}\n', at) + 3);
  };
  // eslint-disable-next-line no-new-func
  fxChainSlotAt = new Function('codeMask', `
    ${['matchParen', 'slotCalls', 'fxChainSlotAt'].map(body).join('\n')}
    const codeOnly = (code) => { const mask = codeMask(code); return (i) => mask[i] === 1; };
    return fxChainSlotAt;
  `)(codeMask);
});

/** The slot a double-click on the nth `fx` NAME in `code` resolves to - commented ones and all. */
function slotOfName(code, nth) {
  const hit = [...code.matchAll(/\bfx\s*\(/g)][nth];
  assert.ok(hit, `no fx #${nth} in ${code}`);
  return fxChainSlotAt(code, hit.index);
}

test('the first effect in a chain is slot 1, not slot 0', () => {
  const code = '.fx("Pro-C 2").fx("kHs Comb Filter")';
  assert.equal(slotOfName(code, 0), 1);
  assert.equal(slotOfName(code, 1), 2);
});

test('the name is the handle, and its arguments are not', () => {
  const code = '.fx("Pro-C 2").param("Threshold", fx1)';
  assert.equal(fxChainSlotAt(code, code.indexOf('fx(')), 1, 'on the f');
  assert.equal(fxChainSlotAt(code, code.indexOf('fx(') + 1), 1, 'on the x');
  assert.equal(fxChainSlotAt(code, code.indexOf('fx(') + 2), 1, 'the end of the name counts');
  assert.equal(fxChainSlotAt(code, code.indexOf('Pro-C')), 0, 'inside the plugin name: ordinary code');
  assert.equal(fxChainSlotAt(code, code.indexOf('param')), 0, 'another call entirely');
  assert.equal(fxChainSlotAt(code, code.length - 1), 0, 'past the end of the chain');
});

test('however the chain is spaced or wrapped, the slots are the same', () => {
  const code = '.fx ("A")\n  .wet(fx1)\n  .fx(\n    "B",\n    { state: "@aaaaaaaaaaaa" })';
  assert.equal(slotOfName(code, 0), 1);
  assert.equal(slotOfName(code, 1), 2);
});

test('a commented-out effect holds no slot, because the engine never built one', () => {
  // The numbering has to agree with the chain the server compiled, and a call behind a // is not
  // in it - so the live effect below is still the FIRST one.
  const code = '// .fx("A")\n.fx("B")';
  assert.equal(slotOfName(code, 1), 1);
  assert.equal(fxChainSlotAt(code, code.indexOf('fx(')), 0, 'the commented one is not a handle');
});

test('a plugin NAMED fx is a string, not a call', () => {
  const code = '.fx("fx (the plugin)")';
  assert.equal(fxChainSlotAt(code, code.indexOf('fx (the')), 0);
  assert.equal(slotOfName(code, 0), 1);
});
