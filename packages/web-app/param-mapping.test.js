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
