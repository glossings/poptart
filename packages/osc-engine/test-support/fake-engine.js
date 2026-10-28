'use strict';

// The engine with no scsynth behind it: a real Engine and real Server object whose datagrams are
// decoded into `sent` instead of going anywhere. For the engine's own bookkeeping (node order,
// route tables, what a handler sends) - nothing here can tell whether the server would agree.

const osc = require('osc');
const { Server, poptartOptions } = require('../server/server');
const { Group } = require('../server/objects');
const { DefRegistry } = require('../server/defs');
const { Engine } = require('../engine/core');
const { installSections } = require('../engine/boot');

// The controller ids the track defs carry (see defs.json): enough for the factories to resolve.
const META = {
  poptart_head: { vstplugins: { slot0: 18 }, poptartDevices: { nslot0: 10 } },
  poptart_fx: { vstplugins: { slot: 3 }, poptartDevices: { nslot: 7 } },
  poptart_xover: { poptartDevices: { nslot: 2 } },
};

function flatten(packet, out) {
  if (packet.packets) { for (const p of packet.packets) flatten(p, out); return; }
  out.push([packet.address, ...(packet.args ?? [])]);
}

/** { E, S, sent, told, output }: sent is every message as [address, ...args], in order. */
function fakeEngine({ sections = ['tracks', 'routing', 'loads', 'ids'], config = {}, meta = META } = {}) {
  const S = new Server({ options: poptartOptions({ port: 57999, ...config.server }) });
  const sent = [];
  S.sendRaw = (bytes) => flatten(osc.readPacket(bytes, { metadata: false }), sent);
  S.sync = async () => true;
  const told = [];
  let output = '';
  const E = new Engine({
    server: S, config: { nodePort: 0, ...config }, defs: new DefRegistry(meta),
    tell: (address, args) => told.push({ address, args }),
    output: (t) => { output += t; },
  });
  S.defaultGroup = Group.basicNew(S, 1);
  installSections(E, sections);
  const { Bus } = require('../server/objects');
  E.unityGainBus = Bus.control(S, 2);
  E.silentBus = Bus.audio(S, 2);
  E.trashBus = Bus.audio(S, 2);
  E.deckMeterBus = Bus.audio(S, 4);
  E.recGroup = Group.new(S, null, 'addToTail');
  E.levelGroups = [Group.new(S, null, 'addToHead')];
  sent.length = 0;
  return { E, S, sent, told, get output() { return output; } };
}

module.exports = { fakeEngine, META };
