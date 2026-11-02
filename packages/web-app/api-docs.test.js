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

const { API_DOCS, BUILDERS, METHODS, lookupDoc, OPTION_DOCS, optionContext, lookupOptionDoc } = require('./public/api-docs.js');

// The builder names server.js puts in every evaluated block's scope. Read out of the source (like
// param-mapping.test.js reads the scheduler) so adding a builder there is what drives this test.
function serverBuilderNames() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const decl = src.match(/const BUILDER_NAMES = \[([\s\S]*?)\];/);
  assert.ok(decl, 'BUILDER_NAMES not found in server.js - this test needs updating');
  const withoutComments = decl[1].replace(/\/\/[^\n]*/g, '');
  return [...withoutComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// The host's own builders (setbpm/setscale) and the macro knobs are bound alongside BUILDER_NAMES
// (see evalBlock / macroSigNames). The host ones are read out of server.js for the same reason
// BUILDER_NAMES is: adding one there is what should drive this test.
function serverHostBuilderNames() {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const decl = src.match(/const HOST_BUILDERS = \{([\s\S]*?)\};/);
  assert.ok(decl, 'HOST_BUILDERS not found in server.js - this test needs updating');
  return [...decl[1].matchAll(/([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

const HOST_BUILDERS = [...serverHostBuilderNames(), ...Array.from({ length: 8 }, (_, i) => `macro${i + 1}`)];

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

// ---------------------------------------------------------------- the keys of options objects

test('the caret where a key goes in a call\'s options object names that call', () => {
  const at = (code) => {
    const c = optionContext(code);
    return c && { call: c.call, key: c.key, method: c.method };
  };
  assert.deepEqual(at('n(sliders("0.1 8.8 6", 0, 12, { mutate: 0.1, de'), { call: 'sliders', key: 'de', method: false });
  assert.deepEqual(at('steps("x . x .", { '), { call: 'steps', key: '', method: false });
  assert.deepEqual(at('shiftreg("x . x x", 0.05, { wi'), { call: 'shiftreg', key: 'wi', method: false });
  assert.deepEqual(at('s(matrix({ bd: "x..." }, { mu'), { call: 'matrix', key: 'mu', method: false });
  assert.deepEqual(at('note("c2").record({ cycles: 8,\n  ta'), { call: 'record', key: 'ta', method: true });
  assert.deepEqual(at('gain(env({ attack: 0.01, re'), { call: 'env', key: 're', method: false });
  assert.deepEqual(at('lfo("<a b>", { rate: "<1 2>", mo'), { call: 'lfo', key: 'mo', method: false });
  // Brackets and commas inside strings and comments do not count.
  assert.deepEqual(at('steps("x } , (", /* { , */ { mu'), { call: 'steps', key: 'mu', method: false });
});

test('a value, a nested object, a block or an arrow body is not where an option key goes', () => {
  assert.equal(optionContext('steps("x", { mutate: knob(0.'), null);
  assert.equal(optionContext('steps("x", { mutate: 0'), null);
  assert.equal(optionContext('steps("x", { mutate: 0.1 }), sp'), null);
  assert.equal(optionContext('f(a, { b: { c'), null);
  assert.equal(optionContext('x.when(y => { s'), null);
  assert.equal(optionContext('drums: group() {\n  s'), null);
  assert.equal(optionContext('const o = { sp'), null);
  assert.equal(optionContext('s("bd").fast(2'), null);
});

test('an option key is described by the call it is written in, not by a function of its name', () => {
  // `attack` is the amp envelope method on its own, and the envelope's option inside env({ ... }).
  assert.match(lookupDoc('attack', 'method').desc, /Amp envelope/);
  assert.match(lookupOptionDoc('env', 'attack').desc, /each note/);
  const opt = lookupOptionDoc('sliders', 'deviation');
  assert.equal(opt.display, 'sliders({ deviation })');
  assert.match(opt.desc, /standard deviation/);
  assert.match(lookupOptionDoc('steps', 'mutate').desc, /cell switches/);
  assert.equal(lookupOptionDoc('record', 'cycles', true).display, '.record({ cycles })');
  // A key the call does not take has nothing to say - steps() has no deviation.
  assert.equal(lookupOptionDoc('steps', 'deviation'), null);
  for (const [call, keys] of Object.entries(OPTION_DOCS)) {
    for (const [key, desc] of Object.entries(keys)) {
      assert.ok(desc.length > 10 && desc.endsWith('.'), `${call}({ ${key} }) needs a sentence`);
    }
  }
});

test('the row widgets\' documented keys are the ones the evaluation reads, and only those', async () => {
  const core = await import('../pattern-core/src/index.mjs');
  assert.ok(core.DEVIATION_OPTION in OPTION_DOCS.sliders && core.MUTATE_OPTION in OPTION_DOCS.sliders);
  for (const kind of ['steps', 'matrix', 'shiftreg']) {
    assert.ok(core.MUTATE_OPTION in OPTION_DOCS[kind], kind);
    assert.ok(!(core.DEVIATION_OPTION in OPTION_DOCS[kind]), kind);
  }
  // Every key written into a call is taken without a word from the evaluation.
  const said = [];
  core.setPatternWarn((line) => said.push(line));
  try {
    for (const kind of ['steps', 'sliders', 'matrix', 'shiftreg']) {
      for (const key of Object.keys(OPTION_DOCS[kind])) {
        const cells = kind === 'matrix' ? { bd: 'x .' } : 'x .';
        core._input([0, -1], kind, cells, { [key]: 0.5 });
      }
    }
  } finally {
    core.setPatternWarn(null);
  }
  assert.deepEqual(said, []);
});

test('the keys already written in that object are named, so they are not offered again', () => {
  assert.deepEqual(optionContext('gain(env({ attack: 0.01, "x, y": 1, decay: f(1, { z: 2 }), re').written, ['attack', 'decay']);
  assert.deepEqual(optionContext('steps("x", { ').written, []);
  // A value that names a key-like word is not a key.
  assert.deepEqual(optionContext('n("0").scope({ width: height, ').written, ['width']);
});

test('every option-taking call\'s documented keys are ones its call takes', async () => {
  const core = await import('../pattern-core/src/index.mjs');
  const said = [];
  core.setPatternWarn((line) => said.push(line));
  try {
    for (const kind of ['scope', 'spectrum', 'waveform', 'punchcard', 'plot', 'meter', 'imager', 'chroma']) {
      for (const key of Object.keys(OPTION_DOCS[kind])) core.note('c3')._display(0, kind, { [key]: 1 });
    }
    for (const kind of ['slider', 'knob', 'toggle', 'button', 'xy']) {
      for (const key of Object.keys(OPTION_DOCS[kind])) core._input([0, -1], kind, 0.5, { [key]: key === 'curve' ? 'pow' : 1 });
    }
    for (const kind of ['sine', 'saw', 'isaw', 'tri', 'square', 'perlin']) core[kind](Object.fromEntries(Object.keys(OPTION_DOCS[kind]).map((k) => [k, 0.5])));
    core.rand({ seed: 1 });
  } finally {
    core.setPatternWarn(null);
  }
  assert.deepEqual(said, []);
});
