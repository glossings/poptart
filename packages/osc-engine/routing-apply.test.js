'use strict';

// routeApply (engine/routing.js): a change of a track's chain structure - a line into a .split(),
// a .split() into .bands(), back to a line - moves and rewires the track's effect nodes and never
// recreates one, so no plugin reloads and no program is lost. A crossover is the engine's own
// device, made once per id and freed when the chain no longer has it. Also where each channel
// control lives (channelTarget) and what it rests at (channelDefault).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { fakeEngine } = require('./test-support/fake-engine');
const { Synth, Group } = require('./server/objects');
const { desktopRouting } = require('./route-desktop');

async function layouts() {
  const { s, routePlan } = await import(path.join(__dirname, '..', 'pattern-core', 'src', 'index.mjs'));
  const xover = ['frequency', 'Frequency', 0.049];
  const of = (sig) => desktopRouting(routePlan(sig).plan, { count: sig.fxChain.length, crossover: xover });
  return {
    split: of(s('x').split((b) => b.fx('A'), (b) => b.fx('B').postgain(0.5)).fx('C')),
    bands: of(s('x').bands([300], (l) => l.fx('A'), (h) => h.fx('B')).fx('C')),
    line: desktopRouting(null, { count: 3 }),
  };
}

test("a change of structure moves and rewires a track's effects and never recreates one", async () => {
  const { E, S, sent } = fakeEngine();
  const opened = [];
  E.deviceController = (node, id, def) => ({
    node, id, def,
    open(name, params, action) { opened.push([name, params]); action(this, true); },
    map(i, bus) { opened.push(['map', i, bus.index]); },
  });
  E.sched = () => ({ cancel() {} }); // the old buses' release, a moment later - not under test here
  const track = {
    key: 't', synth: Synth.basicNew('poptart_track_shared', S, 5000), head: Synth.basicNew('poptart_head', S, 4999),
    chain: Group.basicNew(S, 4000), krGroup: Group.basicNew(S, 4001), chainIn: { index: 90 },
    nodes: new Map(), xovers: new Map(), terms: [], gains: new Map(), xos: new Map(), scBus: new Map(), wet: new Map(),
    controllers: new Map(), loaded: new Map(),
  };
  const { split, bands, line } = await layouts();
  const made = (def) => sent.filter((m) => m[0] === '/s_new' && m[1] === def);
  const ids = () => [...track.nodes.keys()].sort().map((k) => `${k}=${track.nodes.get(k).nodeID}`).join(',');

  E.routeApply('t', track, JSON.parse(JSON.stringify(split)));
  assert.equal(made('poptart_fx').length, 3);
  assert.ok(made('poptart_term').length >= 2, "the split's sum is made of terms");
  assert.ok(sent.some((m) => m[0] === '/n_before'), 'and each is placed in signal order');
  const nodes = ids();
  assert.match(nodes, /^1=\d+,2=\d+,3=\d+$/);
  sent.length = 0;

  E.routeApply('t', track, JSON.parse(JSON.stringify(bands)));
  assert.deepEqual(made('poptart_fx'), [], 'an effect node was made again');
  assert.equal(ids(), nodes, 'an effect node changed');
  const freed = sent.filter((m) => m[0] === '/n_free').map((m) => m[1]);
  for (const n of track.nodes.values()) assert.ok(!freed.includes(n.nodeID), `effect node ${n.nodeID} was freed`);
  assert.equal(made('poptart_xover').length, 1, "the crossover is made, the engine's own");
  assert.equal(track.xovers.size, 1);
  assert.ok(sent.some((m) => m[0] === '/n_before'));
  assert.ok(sent.some((m) => m[0] === '/n_set' && m.includes('in') && m.includes('out')), 'and rewired');
  // The crossover opens the Crossover device and its control is mapped onto the track's xo<k>.
  assert.equal(opened[0][0], 'Crossover');
  assert.deepEqual(opened[0][1], [{ id: 'frequency', name: 'Frequency', default: 0.049 }]);
  assert.equal(opened[1][0], 'map');
  const xoBus = [...track.xos.values()][0].bus.index;
  assert.equal(opened[1][2], xoBus);
  sent.length = 0;

  E.routeApply('t', track, JSON.parse(JSON.stringify(line)));
  assert.deepEqual(made('poptart_fx'), []);
  assert.equal(ids(), nodes);
  assert.equal(track.xovers.size, 0, 'the crossover goes with the bands');

  const at = (n) => { const a = E.channelTarget(track, n); return a ? `${a[0].nodeID}:${a[1]}` : 'nil'; };
  assert.match(at('rl2'), /:level$/);
  assert.match(at('xo1'), /:value$/);
  assert.equal(at('wet2'), `${track.nodes.get(2).nodeID}:wet`);
  assert.equal(at('wet9'), 'nil', 'a wet with no effect yet has nowhere to go');
  assert.equal(at('gain'), '4999:gain');
  assert.equal(at('postgain'), '5000:postgain');
  assert.deepEqual([E.channelDefault('rl5'), E.channelDefault('rp5'), Math.round(E.channelDefault('xo3') * 1e4) / 1e4,
    E.channelDefault('wet2'), E.channelDefault('pan'), E.channelDefault('bendrange'), E.channelDefault('grainrate')],
  [1, 0, 0.049, 1, 0, 2, 20]);
});

test('a send written inside the chain has its tap read the layout\'s bus, and the strip again when the layout goes', async () => {
  const { E, S, sent } = fakeEngine();
  E.sched = () => ({ cancel() {} });
  E.stripPost = () => ({ index: 77 });
  const tap = Synth.basicNew('poptart_tap', S, 6000);
  const track = {
    key: 't', synth: Synth.basicNew('poptart_track_shared', S, 5000), chainIn: { index: 90 }, krGroup: Group.basicNew(S, 4001),
    nodes: new Map(), xovers: new Map(), terms: [], gains: new Map(), xos: new Map(), scBus: new Map(), wet: new Map(),
    taps: new Map([['bus0', tap]]), busSends: ['feedback'], busSendIdx: [0], sendIns: new Map(),
  };
  const { s, routePlan } = await import(path.join(__dirname, '..', 'pattern-core', 'src', 'index.mjs'));
  const sig = s('x').fx('Delay').bus('feedback').fx('Reverb');
  const spec = desktopRouting(routePlan(sig).plan, { count: 2 });
  const setsOn = (id) => sent.filter((m) => m[0] === '/n_set' && m[1] === id).map((m) => m.slice(2));
  E.routeApply('t', track, JSON.parse(JSON.stringify(spec)));
  const delayOut = track.route.index.get('o:1');
  assert.ok(delayOut != null);
  assert.equal(track.sendIns.get(0), delayOut);
  assert.ok(setsOn(6000).some((a) => a[a.indexOf('in') + 1] === delayOut), 'the tap reads the delay\'s output');
  sent.length = 0;
  E.routeApply('t', track, desktopRouting(null, { count: 2 }));
  assert.equal(track.sendIns.size, 0);
  assert.ok(setsOn(6000).some((a) => a[a.indexOf('in') + 1] === 77), 'back to the strip\'s output');
  assert.equal(E.sendInput(track, 0), null);
});

test('the old wiring buses go back a moment after the new wiring lands', async () => {
  const { E, S } = fakeEngine();
  const later = [];
  E.sched = (sec, fn) => { later.push([sec, fn]); return { cancel() {} }; };
  const track = {
    key: 't', synth: Synth.basicNew('poptart_track_shared', S, 5000), chainIn: { index: 90 }, krGroup: Group.basicNew(S, 4001),
    nodes: new Map(), xovers: new Map(), terms: [], gains: new Map(), xos: new Map(), scBus: new Map(), wet: new Map(),
  };
  const { split } = await layouts();
  E.routeApply('t', track, split);
  const first = track.route.buses.map((b) => b.index);
  assert.ok(first.length > 0);
  E.routeApply('t', track, split);
  assert.equal(later.length, 1);
  assert.equal(later[0][0], 0.2);
  assert.ok(first.every((i) => S.audioBuses.isUsed(i)), 'still held until the release');
  later[0][1]();
  assert.ok(first.every((i) => !S.audioBuses.isUsed(i) || track.route.buses.some((b) => b.index === i)));
});

test('a chain in a Delay\'s loop: the Delay sends on its loop bus and reads the chain\'s end back on ret', async () => {
  const { E, S, sent } = fakeEngine();
  E.sched = () => ({ cancel() {} });
  const track = {
    key: 't', synth: Synth.basicNew('poptart_track_shared', S, 5000), chainIn: { index: 90 }, krGroup: Group.basicNew(S, 4001),
    nodes: new Map(), xovers: new Map(), terms: [], gains: new Map(), xos: new Map(), scBus: new Map(), wet: new Map(),
    taps: new Map(), sendIns: new Map(), controllers: new Map(), loopSec: new Map(),
  };
  const { s, routePlan } = await import(path.join(__dirname, '..', 'pattern-core', 'src', 'index.mjs'));
  const sig = s('x').fx('Delay', (x) => x.fx('Filter')).fx('Reverb');
  E.routeApply('t', track, JSON.parse(JSON.stringify(desktopRouting(routePlan(sig).plan, { count: 3 }))));
  const delay = track.nodes.get(2).nodeID;
  const filter = track.nodes.get(1).nodeID;
  const lastSet = (id, name) => {
    const sets = sent.filter((m) => m[0] === '/n_set' && m[1] === id && m.includes(name));
    const m = sets.at(-1);
    return m?.[m.indexOf(name) + 1];
  };
  const loopBus = track.route.index.get('l:2');
  assert.ok(loopBus != null);
  assert.equal(lastSet(delay, 'loop'), loopBus, 'the Delay sends its repeats on the loop bus');
  assert.equal(lastSet(filter, 'in'), loopBus, 'the chain reads them');
  assert.equal(lastSet(delay, 'ret'), track.route.index.get('o:1'), 'and the Delay reads the chain\'s end back');
  assert.equal(lastSet(filter, 'ret'), E.silentBus.index, 'nothing else reads a return');
  // The loop goes: back to the line, the Delay reading nothing back and sending nowhere.
  E.routeApply('t', track, desktopRouting(null, { count: 2 }));
  assert.equal(lastSet(delay, 'ret'), E.silentBus.index);
  assert.equal(lastSet(delay, 'loop'), E.routeNowhere);
});

test('how late the loop is reaches the device in the slot, now and when one opens', () => {
  const { E } = fakeEngine();
  const told = [];
  const track = { loopSec: new Map([[2, 0.05]]), controllers: new Map([[2, { loopLatency: (sec) => told.push(sec) }]]) };
  E.tellLoop(track, 2);
  track.loopSec.delete(2);
  E.tellLoop(track, 2);
  E.tellLoop(track, 1); // no controller: nothing to tell
  assert.deepEqual(told, [0.05, -1]);
});
