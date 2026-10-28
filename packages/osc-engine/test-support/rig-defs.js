'use strict';

// Small SynthDefs only tests use (a recorder of N channels, a step on a bus), built with
// ../synthdef like the engine's own and sent to a running test server.

const G = require('../synthdef/graph.js');
const U = require('../synthdef/ugens.js');
const { sendDefs } = require('../server/defs');

const entry = (def) => ({ name: def.name, def });

/** poptart_test_rec<n>: DiskOut of n channels from audio bus `bus` into `buf`. */
function recDef(n) {
  return new G.SynthDef(`poptart_test_rec${n}`, { bus: 0, buf: 0 }, (c) => {
    U.DiskOut.ar(c.buf, U.In.ar(c.bus, n));
  });
}

/** poptart_test_step: 1 on audio bus `out` while `target` is over 0.5, else 0. */
function stepDef() {
  return new G.SynthDef('poptart_test_step', { out: 0, target: 0 }, (c) => {
    U.Out.ar(c.out, U.Select.ar(G.gt(c.target, 0.5), [U.DC.ar(0), U.DC.ar(1)]));
  });
}

async function sendRigDefs(S, defs) {
  await sendDefs(S, defs.map(entry));
}

module.exports = { recDef, stepDef, sendRigDefs };
