'use strict';

// Every track runs the same defs (engine/tracks.js, sharedTrackDef): nothing in them depends on the
// key, so they are built once with the rest (synthdef/) and loaded at boot, and a song's worth
// of tracks created together builds nothing at all. What is checked: every track asks for the one
// set, and every def it names is one the compiled set holds.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeEngine } = require('./test-support/fake-engine');
const { skipReason, testDefs } = require('./test-support/scsynth');

test("a song's tracks share the one set of track defs, all of them compiled", async (t) => {
  const { E } = fakeEngine();
  const defs = [E.sharedTrackDef(), E.sharedTrackDef(), E.sharedTrackDef()];
  assert.ok(defs.every((d) => d === defs[0]), 'one set, not one per track');
  assert.deepEqual(Object.keys(defs[0]).sort(), ['bassmono', 'dj', 'fx', 'head', 'strip', 'tap', 'xover']);
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { meta } = await testDefs();
  for (const [role, d] of Object.entries(defs[0])) assert.ok(meta[d.name], `the ${role} def '${d.name}' is not compiled`);
  assert.ok(meta.poptart_head.vstplugins.slot0 != null && meta.poptart_fx.vstplugins.slot != null,
    'the plugin UGens the controllers address are where the loads expect them');
});
