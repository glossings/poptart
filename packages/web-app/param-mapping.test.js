'use strict';

// Guard against the whole class of "the wrapper forgot to forward a method" bug. The Scheduler
// never drives the raw OscEngine - it drives a MappedEngine (the alias + unit-conversion wrapper),
// which forwards each engine method by hand. Several routing/feature calls are feature-detected by
// the scheduler with `typeof this.engine.X === 'function'`, so a method that exists on OscEngine
// and is used by the scheduler but is missing on MappedEngine doesn't error - it silently no-ops.
// That is exactly what broke signal routing: injectMidi/injectAudio/setInputSource (+ their clears)
// were added to OscEngine and called by the scheduler, but never added to MappedEngine, so every
// route silently did nothing. These tests fail loudly if that ever recurs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MappedEngine } = require('./param-mapping.js');

// Every distinct `this.engine.<name>` the Scheduler references in its source. Read from the file
// (not hard-coded) so a newly added engine call is automatically covered by this guard.
function schedulerEngineCalls() {
  const schedulerPath = path.join(path.dirname(require.resolve('@poptart/pattern-core')), 'scheduler.mjs');
  const src = fs.readFileSync(schedulerPath, 'utf8');
  return [...new Set([...src.matchAll(/this\.engine\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
}

test('MappedEngine implements every engine method the Scheduler calls', () => {
  const calls = schedulerEngineCalls();
  assert.ok(calls.length > 0, 'sanity: found some this.engine.* calls in the scheduler');
  const missing = calls.filter((name) => typeof MappedEngine.prototype[name] !== 'function');
  assert.deepEqual(
    missing,
    [],
    `MappedEngine is missing method(s) the Scheduler calls: ${missing.join(', ')}. ` +
      'Add a forwarder in param-mapping.js (a plain pass-through unless the value needs mapping).',
  );
});

test('MappedEngine forwards each scheduler-called method to the underlying engine', () => {
  // A recording stand-in for the real engine: every access returns a spy that logs its name.
  const seen = [];
  const spyEngine = new Proxy(
    {},
    { get: (_t, prop) => (...args) => { seen.push(prop); return undefined; } },
  );
  const mapped = new MappedEngine(spyEngine);

  for (const name of schedulerEngineCalls()) {
    seen.length = 0;
    // getTime is a pure pass-through returning a value; the rest are fire-and-forget. Calling with
    // no/placeholder args is fine - the mapping wrapper tolerates unknown tracks/slots (no spec).
    try {
      mapped[name]('track', 0, 'param', 0, 0);
    } catch (err) {
      assert.fail(`MappedEngine.${name} threw before forwarding: ${err.message}`);
    }
    assert.ok(
      seen.includes(name),
      `MappedEngine.${name} did not forward to the underlying engine (called: ${seen.join(', ') || 'nothing'})`,
    );
  }
});

test('MappedEngine translates track references in routing names, and only those', () => {
  const calls = [];
  const spyEngine = new Proxy(
    {},
    { get: (_t, prop) => (...args) => { calls.push([prop, ...args]); } },
  );
  const mapped = new MappedEngine(spyEngine);

  // Without a resolver installed (mocks, tests), names pass through untouched.
  mapped.setInputSource('#1', 'audio', 'kick', 0);
  assert.deepEqual(calls.pop(), ['setInputSource', '#1', 'audio', 'kick', 0]);

  // The server's resolver: known labels become engine track ids, anything else passes verbatim.
  mapped.setTrackResolver((label) => (label === 'kick' ? '#7' : label));

  // A bare routing name is a track reference (track-first resolution, same as osc-engine's).
  mapped.setInputSource('#1', 'audio', 'kick', 0);
  assert.deepEqual(calls.pop(), ['setInputSource', '#1', 'audio', '#7', 0]);
  // "track:label" is the explicit form; the prefix survives, the label is resolved.
  mapped.injectAudio('#1', 2, 'track:kick', 1);
  assert.deepEqual(calls.pop(), ['injectAudio', '#1', 2, 'track:#7', 1]);
  // MIDI fan-out references a source track by name too.
  mapped.injectMidi('#1', 0, 'kick', 60);
  assert.deepEqual(calls.pop(), ['injectMidi', '#1', 0, '#7', 60]);
  // Devices and named buses are not tracks and pass through verbatim.
  mapped.setInputSource('#1', 'audio', 'dev:Scarlett', 0);
  assert.deepEqual(calls.pop(), ['setInputSource', '#1', 'audio', 'dev:Scarlett', 0]);
  mapped.injectAudio('#1', 2, 'bus:pads', 1);
  assert.deepEqual(calls.pop(), ['injectAudio', '#1', 2, 'bus:pads', 1]);
  // A label no eval has seen passes through verbatim - the engine warns about it, as ever.
  mapped.setInputSource('#1', 'audio', 'nope', 0);
  assert.deepEqual(calls.pop(), ['setInputSource', '#1', 'audio', 'nope', 0]);
});

test('MappedEngine hands the resolver the referencing track, so references scope per deck', () => {
  const calls = [];
  const spyEngine = new Proxy(
    {},
    { get: (_t, prop) => (...args) => { calls.push([prop, ...args]); } },
  );
  const mapped = new MappedEngine(spyEngine);
  // The server's real resolver scopes by the CALLER: a reference from a deck-b track resolves
  // within deck b first. Mimic that shape - what this pins is that the caller's id arrives.
  mapped.setTrackResolver((label, from) => (from === '#b1' ? `#b-${label}` : label));

  mapped.setInputSource('#b1', 'audio', 'kick', 0);
  assert.deepEqual(calls.pop(), ['setInputSource', '#b1', 'audio', '#b-kick', 0]);
  mapped.injectMidi('#a1', 0, 'kick', 60); // a caller outside deck b resolves unscoped
  assert.deepEqual(calls.pop(), ['injectMidi', '#a1', 0, 'kick', 60]);
  mapped.injectAudio('#b1', 2, 'track:kick', 1);
  assert.deepEqual(calls.pop(), ['injectAudio', '#b1', 2, 'track:#b-kick', 1]);
});

// ---- capabilities the engine underneath may not have -------------------------------------------

// The guards above drive the wrapper with a Proxy that answers every property with a function,
// which is the right stand-in for "did the forwarder get written" and the wrong one for "does the
// engine underneath actually have this". The scheduler feature-detects a few calls before making
// them, and for those the wrapper has to answer for the real engine rather than for itself.

/** Every engine call the scheduler asks about before making it, read from its source. */
function schedulerOptionalCalls() {
  const schedulerPath = path.join(path.dirname(require.resolve('@poptart/pattern-core')), 'scheduler.mjs');
  const src = fs.readFileSync(schedulerPath, 'utf8');
  const found = [...src.matchAll(/typeof this\.engine\.([A-Za-z0-9_]+) === 'function'/g)].map((m) => m[1]);
  return [...new Set(found)];
}

test('every call the scheduler feature-detects is one the desktop engine has, or is hidden', () => {
  // The point of the list is that it stays in step with the scheduler. A new feature-detected
  // call that OscEngine does not implement has to join OPTIONAL, or the wrapper will claim it.
  const oscSource = fs.readFileSync(path.join(__dirname, '..', 'osc-engine', 'index.js'), 'utf8');
  const unlisted = schedulerOptionalCalls().filter((name) => (
    !MappedEngine.OPTIONAL.includes(name) && !new RegExp(`^\\s{2}(async )?${name}\\(`, 'm').test(oscSource)
  ));
  assert.deepEqual(unlisted, [], 'a capability the desktop engine lacks must be hidden, not forwarded blindly');
});

test('a capability the engine lacks is not advertised by the wrapper', () => {
  // An engine with everything except the optional calls - the desktop's shape before it could
  // patch audio onto a parameter. Forwarding those unconditionally made `typeof
  // engine.connectParam === 'function'` true on the wrapper, so the scheduler wired the route and
  // the forward landed on undefined - a TypeError that took the evaluation down, where the
  // scheduler's own answer is to warn once and keep playing.
  const engine = {};
  for (const name of schedulerEngineCalls()) {
    if (!MappedEngine.OPTIONAL.includes(name)) engine[name] = () => {};
  }
  const mapped = new MappedEngine(engine);

  for (const name of MappedEngine.OPTIONAL) {
    assert.equal(typeof mapped[name], 'undefined', `${name} should not look available`);
  }
  // Everything else still forwards, so hiding one capability cannot quietly hide another.
  for (const name of schedulerEngineCalls()) {
    if (!MappedEngine.OPTIONAL.includes(name)) {
      assert.equal(typeof mapped[name], 'function', `${name} should still be forwarded`);
    }
  }
});

test('a capability the engine does have is forwarded as before', () => {
  const calls = [];
  const engine = {};
  for (const name of schedulerEngineCalls()) engine[name] = (...a) => { calls.push([name, ...a]); };
  const mapped = new MappedEngine(engine);

  assert.equal(typeof mapped.setParamExpr, 'function');
  mapped.setTrackResolver((label) => (label === 'mod' ? '#3' : label));
  const tree = { k: 'op', op: 'mul', a: [{ k: 'in', i: 0, rate: 'ar', source: 'mod' }, { k: 'const', v: 0.5 }] };
  mapped.setParamExpr('#1', 0, 'Osc 1 Phase', tree);
  assert.deepEqual(calls.pop(), ['setParamExpr', '#1', 0, 'Osc 1 Phase',
    { k: 'op', op: 'mul', a: [{ k: 'in', i: 0, rate: 'ar', source: '#3' }, { k: 'const', v: 0.5 }] }], 'sources are routing names');
  mapped.clearParamExpr('#1', 0, 'Osc 1 Phase');
  assert.deepEqual(calls.pop(), ['clearParamExpr', '#1', 0, 'Osc 1 Phase']);
});

test('an expression on a parameter a mapping gives real units is converted at its root', () => {
  const calls = [];
  const engine = { setParamExpr: (...a) => calls.push(a), paramExprs: () => new Map(calls.map((c) => [`${c[1]}:${c[2]}`, JSON.stringify(c[3])])) };
  const mapped = new MappedEngine(engine);
  mapped.mappings = new Map([['Serum 2', { params: { 'Filter 1 Freq': { min: 20, max: 20000, curve: 'log' } } }]]);
  mapped.chains.set('#1', ['Serum 2']);
  const tree = { k: 'op', op: 'add', a: [{ k: 'in', i: 0, rate: 'kr' }, { k: 'const', v: 400 }] };
  mapped.setParamExpr('#1', 0, 'Filter 1 Freq', tree);
  assert.deepEqual(calls[0][3], { k: 'map', min: 20, max: 20000, curve: 'log', a: [tree] });
  // What the engine holds comes back as the scheduler sent it, so it isn't sent again.
  assert.equal(mapped.paramExprs('#1').get('0:Filter 1 Freq'), JSON.stringify(tree));
});

test('a word on a MAPPED parameter is handed on as it stands, not converted into NaN', () => {
  // The scheduler passes strings through to device parameters now - an enum label, which the
  // browser build's devices take. A label that lands on a parameter serum2.json maps in Hz went
  // through the unit conversion and came back NaN, and NaN is typeof number, so it sailed past
  // the engine's own "a plugin parameter is a number" guard and was sent to sclang every poll.
  const calls = [];
  const engine = {};
  for (const name of schedulerEngineCalls()) engine[name] = (...a) => { calls.push([name, ...a]); };
  const mapped = new MappedEngine(engine);
  mapped.mappings = new Map([['Serum 2', { plugin: 'Serum 2', params: { 'Filter 1 Freq': { min: 20, max: 20000, curve: 'log' } } }]]);
  mapped.setChain('#1', ['Serum 2']);

  mapped.setParam('#1', 0, 'Filter 1 Freq', 'lowpass', 0);
  const [, , , , value] = calls.pop();
  assert.equal(value, 'lowpass', 'the word reaches the engine, for the engine to drop and name');

  // A number on the same parameter is still converted, which is the reason the mapping exists.
  mapped.setParam('#1', 0, 'Filter 1 Freq', 2000, 0);
  const [, , , , mappedValue] = calls.pop();
  assert.ok(mappedValue > 0 && mappedValue < 1, `a real value still maps: ${mappedValue}`);
});

test('a word on a plugin parameter is reported on the console once per evaluation', () => {
  // The desktop engine drops it (a VST parameter is a number), and dropping it without a word is
  // a line of the pattern that silently does nothing.
  const engine = {};
  for (const name of schedulerEngineCalls()) engine[name] = () => {};
  const mapped = new MappedEngine(engine);
  const lines = [];
  mapped.warn = (line) => lines.push(line);
  mapped.setChain('#1', ['Serum 2']);

  mapped.setParam('#1', 0, 'Filter Type', 'lowpass', 0);
  mapped.setParam('#1', 0, 'Filter Type', 'lowpass', 0.1);
  assert.equal(lines.length, 1, 'the scheduler resends a held value every step; it is said once');
  assert.match(lines[0], /"Filter Type" on Serum 2/);
  assert.match(lines[0], /"lowpass"/);

  mapped.setParam('#1', 0, 'Filter Type', 0.25, 0.2);
  assert.equal(lines.length, 1, 'a number says nothing');

  mapped.setChain('#1', ['Serum 2']); // the next evaluation
  mapped.setParam('#1', 0, 'Filter Type', 'lowpass', 0.3);
  assert.equal(lines.length, 2, 'still wrong after a re-evaluation, so said again');
});

// --- a parameter addressed by index ------------------------------------------------------------
//
// `.param(12, 0.5)` is a legal spelling: the engine resolves an index directly, without a name.
// The mappings are keyed by NAME, so there is nothing here for it - but the lookup called
// name.replace() unguarded, and only for a plugin that HAS a mapping file. So an index worked
// everywhere until it was pointed at a mapped plugin, and then threw on EVERY evaluate: a 500
// from /api/evaluate and nothing playing at all (hit live, 2026-10-05).

/** A MappedEngine over a Serum 2 mapping, with everything it sends recorded. */
function indexRig() {
  const calls = [];
  const engine = {};
  for (const name of schedulerEngineCalls()) engine[name] = (...a) => { calls.push([name, ...a]); };
  const mapped = new MappedEngine(engine);
  mapped.mappings = new Map([['Serum 2', { plugin: 'Serum 2', params: { 'Filter 1 Freq': { min: 20, max: 20000, curve: 'log' } } }]]);
  mapped.setChain('#1', ['Serum 2']);
  return { mapped, calls };
}

test('a numeric parameter index is passed through rather than looked up', () => {
  const { mapped, calls } = indexRig();
  mapped.setParam('#1', 0, 12, 0.5, 0);
  assert.deepEqual(calls.pop(), ['setParam', '#1', 0, 12, 0.5, 0],
    'an index must reach the engine untouched - there is nothing to convert it against');
});

test('...and it does not throw where the plugin has a mapping file', () => {
  // The whole bug: the lookup returns early for an UNMAPPED plugin, so this only ever appeared on
  // the plugins that have real units - which are the ones worth automating in the first place.
  const { mapped } = indexRig();
  assert.doesNotThrow(() => mapped.setParam('#1', 0, 12, 0.5, 0));
  assert.doesNotThrow(() => mapped.setParamLFO('#1', 0, 7, { min: 0, max: 1 }));
  assert.equal(mapped.specFor('#1', 0, 12), undefined, 'an index has no spec to find');
});

test('a named parameter on the same plugin still converts its units', () => {
  // ...and the guard must not have turned the mapping off for everything else.
  const { mapped, calls } = indexRig();
  mapped.setParam('#1', 0, 'Filter 1 Freq', 2000, 0);
  const [, , , , value] = calls.pop();
  assert.ok(value > 0 && value < 1, `a mapped name in Hz has to be normalized, got ${value}`);
});
