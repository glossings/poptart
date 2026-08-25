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
