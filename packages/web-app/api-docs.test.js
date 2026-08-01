'use strict';

// Guard the editor's API reference (public/api-docs.js) against drift. It is the single source of
// the autocomplete word lists AND of the doc panel / ctrl-hover tooltip text, so a name that isn't
// in it is a name the editor won't offer, and a name in it that no longer exists is a tooltip
// describing something you can't call. Both directions are checked here against the real API
// surface: server.js's BUILDER_NAMES (what evaluated code actually has in scope) and
// pattern-core's Sig.prototype (what a chain actually responds to).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { API_DOCS, BUILDERS, METHODS, lookupDoc } = require('./public/api-docs.js');

// The builder names server.js puts in every evaluated block's scope. Read out of the source (like
// param-mapping.test.js reads the scheduler) so adding a builder there is what drives this test.
function serverBuilderNames() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const decl = src.match(/const BUILDER_NAMES = \[([\s\S]*?)\];/);
  assert.ok(decl, 'BUILDER_NAMES not found in server.js - this test needs updating');
  const withoutComments = decl[1].replace(/\/\/[^\n]*/g, '');
  return [...withoutComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// setbpm and the macro knobs are bound alongside BUILDER_NAMES (see evalBlock / macroSigNames).
const HOST_BUILDERS = ['setbpm', ...Array.from({ length: 8 }, (_, i) => `macro${i + 1}`)];

test('every builder in scope is documented', () => {
  for (const name of [...serverBuilderNames(), ...HOST_BUILDERS]) {
    const doc = lookupDoc(name, 'builder');
    assert.ok(doc, `${name}() is in scope in evaluated code but has no api-docs.js entry`);
    assert.equal(doc.context, 'builder', `${name} is a top-level builder but is documented as a method only`);
    assert.ok(BUILDERS.includes(name), `${name} is missing from the builder completion list`);
  }
});

test('no documented builder has gone away', () => {
  const real = new Set([...serverBuilderNames(), ...HOST_BUILDERS]);
  for (const name of BUILDERS) {
    assert.ok(real.has(name), `api-docs.js documents ${name}() as a builder, but nothing binds that name`);
  }
});

test('every documented method exists on Sig.prototype', async () => {
  const core = await import('../pattern-core/src/index.mjs');
  for (const name of METHODS) {
    assert.equal(
      typeof core.Sig.prototype[name],
      'function',
      `api-docs.js documents .${name}(), but Sig.prototype has no such method`,
    );
  }
});

test('entries are well formed', () => {
  for (const [name, doc] of Object.entries(API_DOCS)) {
    assert.ok(['builder', 'method', 'both'].includes(doc.kind), `${name}: kind must be builder, method or both`);
    assert.ok(doc.sig.startsWith(name), `${name}: signature "${doc.sig}" should start with the name`);
    assert.ok(doc.desc && doc.desc.length > 20, `${name}: needs a real one-sentence description`);
    assert.ok(doc.desc.endsWith('.'), `${name}: description should read as a sentence`);
    // A call signature has parens; a value (macro1..8) is marked as such so completing it doesn't
    // type an opening paren after it.
    assert.equal(doc.sig.includes('('), doc.call !== false, `${name}: call/signature disagree`);
  }
});

test('method docs render with a leading dot, builders without', () => {
  assert.equal(lookupDoc('fast', 'method').display, '.fast(factor)');
  assert.equal(lookupDoc('speed', 'method').display, '.speed(rate)');
  assert.equal(lookupDoc('speed', 'builder').display, 'speed(rate)');
  // A name documented for only one context still resolves in the other (hovering `.fast` must say
  // something), reported in the context it really belongs to.
  assert.equal(lookupDoc('fast', 'builder').display, '.fast(factor)');
  assert.equal(lookupDoc('nope', 'builder'), null);
});
