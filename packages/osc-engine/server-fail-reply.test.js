'use strict';

// Does scsynth SEND the /fail the engine's repair hangs on - and does the engine's own responder
// (engine/notes.js) act on it?
//
// The repair of a polled control whose ramp node has gone is entirely the /fail listener: it drops
// the ramp entry so the next poll builds a fresh one. `FAILURE IN SERVER` is what scsynth PRINTS;
// whether it also answers the sender is a separate question, and poptart writes every polled value
// inside a TIMESTAMPED bundle, which the server performs on a different path from a bare message.
// So both are tried against a real scsynth, then the engine's responder is run on a real failure.
//
// Needs a real-time scsynth (an audio device): skipped, not failed, without one. Nothing sounds.

const { test } = require('node:test');
const assert = require('node:assert');
const { bootEngine, skipReason } = require('./test-support/scsynth');
const { Synth } = require('./server/objects');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'notes'];
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

test('scsynth answers a write to a node that is gone - bare AND bundled - and the engine drops the ramp', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const rig = await bootEngine({ port: 57475, sections: SECTIONS });
  const { S, E } = rig;
  try {
    const heard = [];
    S.on('/fail', (a) => heard.push(a));
    const synth = Synth.new(S, 'poptart_ramp', ['out', 0], null, 'addToHead');
    await S.sync();
    const dead = synth.nodeID;
    synth.free();
    await S.sync();
    await sleep(0.2);

    S.send(['/n_set', dead, 'target', 0]);
    await sleep(0.4);
    const bare = heard.filter((a) => a[0] === '/n_set' && String(a.slice(1).join(' ')).includes(String(dead)));
    assert.equal(bare.length, 1, `no /fail for a BARE write to freed node ${dead}`);

    // One track, one polled control pointed at that node, written as rampTo writes: bundled.
    E.tracks.set('kick', { key: 'kick', ramps: new Map([['slot0_Cutoff', { synth: Synth.basicNew('poptart_ramp', S, dead), bus: null, index: 3, slot: 0 }]]) });
    S.sendBundle(0.1, [['/n_set', dead, 'target', 0]]);
    await sleep(0.8);
    const bundled = heard.filter((a) => a[0] === '/n_set').length - bare.length;
    assert.equal(bundled, 1, 'a BUNDLED write is not reported - and every polled value is sent bundled');
    assert.ok(!E.tracks.get('kick').ramps.has('slot0_Cutoff'), 'the engine did not drop the stranded ramp');
    assert.match(rig.output, /FAILURE IN SERVER/, 'scsynth did not refuse the write: this is not a real failure');
    assert.match(rig.output, /kick's polled control slot0_Cutoff was writing to node/);
  } finally {
    await rig.quit();
  }
});
