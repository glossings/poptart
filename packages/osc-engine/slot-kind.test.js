'use strict';

// An effect slot (poptart_fx in synthdef/defs.js) carries a plugin half and a native-device half,
// exactly one of them loaded, and `native` picks which one is the slot's output. An empty VSTPlugin
// passes its input through, so summing the halves would play the dry signal under every native
// effect. Rendered offline: the slot with the Filter in it must equal the Filter alone, sample for
// sample, while a slot on its plugin half with nothing loaded passes the tone through.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const synthdef = require('./synthdef');
const U = require('./synthdef/ugens');
const { renderNRT, ugen, G } = require('./test-support/nrt');

const SR = 48000;
const { DEVICE_BINARY: SCX } = require('./extensions.js'); // this platform's build
const SinOsc = ugen('SinOsc', [440, 0]);

test('an effect slot with a native device in it plays the device and not the dry signal', (t) => {
  if (!fs.existsSync(SCX)) { t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs'); return; }
  const slot = synthdef.defsFor({}).find((d) => d.name === 'poptart_fx');
  const tone = new G.SynthDef('pt_tone', { out: 0 }, (c) => { const s = G.mul(SinOsc.ar(220, 0), 0.5); U.Out.ar(c.out, [s, s]); });
  const alone = new G.SynthDef('pt_slot_alone', { out: 0 }, (c) => {
    const s = G.mul(SinOsc.ar(220, 0), 0.5);
    U.Out.ar(c.out, U.PoptartDevice.ar([s, s], 2, 0, [U.DC.ar(0), U.DC.ar(0)], 'nslot1'));
  });
  const slotIndex = slot.meta.poptartDevices.nslot;
  const aloneIndex = synthdef.defMeta(alone).poptartDevices.nslot1;
  const r = renderNRT([
    [0, ['/d_recv', slot.def]],
    [0, ['/d_recv', alone]],
    [0, ['/d_recv', tone]],
    [0, ['/s_new', 'pt_tone', 999, 0, 0, 'out', 100]],
    [0, ['/s_new', 'poptart_fx', 1000, 1, 0, 'in', 100, 'out', 0, 'scBus', 1000000, 'active', 1, 'native', 1]],
    [0, ['/s_new', 'pt_slot_alone', 1001, 1, 0, 'out', 2]],
    [0, ['/s_new', 'poptart_fx', 1002, 1, 0, 'in', 100, 'out', 4, 'scBus', 1000000, 'active', 1, 'native', 0]],
    [0, ['/u_cmd', 1000, slotIndex, '/open', 'Filter']],
    [0, ['/u_cmd', 1001, aloneIndex, '/open', 'Filter']],
  ], { duration: 0.6, sampleRate: SR, outChannels: 6, extra: ['-a', '1024'] });
  if (!r.data) { t.skip(r.why); return; }
  assert.strictEqual(r.channels, 6);
  const from = Math.floor(0.1 * SR);
  const to = Math.floor(0.5 * SR);
  let deviceRms = 0;
  let passRms = 0;
  let worst = 0;
  for (let i = from; i < to; i++) {
    deviceRms += r.at(2, i) ** 2;
    passRms += r.at(4, i) ** 2;
    worst = Math.max(worst, Math.abs(r.at(0, i) - r.at(2, i)), Math.abs(r.at(1, i) - r.at(3, i)));
  }
  deviceRms = Math.sqrt(deviceRms / (to - from));
  passRms = Math.sqrt(passRms / (to - from));
  assert.ok(passRms > 0.3, `an empty VSTPlugin no longer passes its input (rms ${passRms.toFixed(3)})`);
  assert.ok(deviceRms > 0.05, `the Filter alone made no sound (rms ${deviceRms.toFixed(3)})`);
  assert.ok(worst < 1e-5, `the slot is not the device alone - off by up to ${worst.toFixed(4)} (the dry signal leaking through)`);
});
