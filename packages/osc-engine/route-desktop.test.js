'use strict';

// The desktop's chain layout (route-desktop.js): a routing plan, or none, turned into the row of
// nodes and private buses a track runs. What is pinned here is the layout - which node reads which
// bus, where each term rides, that everything is read after it is written - and that any tree the
// pattern can build is laid out without dropping a term. What it SOUNDS like is
// routing-sclang.test.js's business.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { desktopRouting, linearChain } = require('./route-desktop');

const core = () => import(path.join(__dirname, '..', 'pattern-core', 'src', 'index.mjs'));

/**
 * Every read comes after every write of what it reads: a bus is whole once its last writer has
 * run, and nothing reads it before then. Returns the problems, in words.
 */
function orderProblems(spec) {
  const writes = new Map(); // bus -> index of its last writer
  spec.steps.forEach((st, i) => {
    for (const b of [st.out, st.rest, st.ap]) if (b && b !== 'none') writes.set(b, i);
  });
  const problems = [];
  const check = (bus, at, what) => {
    if (!bus || bus === 'none' || bus === 'chain') return;
    const last = writes.get(bus);
    if (last === undefined) problems.push(`${what} reads ${bus}, which nothing writes`);
    else if (last >= at) problems.push(`${what} reads ${bus} before its writer at step ${last}`);
  };
  spec.steps.forEach((st, i) => {
    check(st.in, i, `step ${i}`);
    if (st.key) check(st.key, i, `step ${i}'s key`);
  });
  check(spec.out, spec.steps.length, 'the strip');
  for (const b of Object.keys(spec.buses)) if (!writes.has(b)) problems.push(`${b} is made and never written`);
  return problems;
}

test('no plan is the plain line of the track\'s effects, each reading the one before it', () => {
  assert.deepEqual(desktopRouting(null, { count: 0 }), { steps: [], out: 'chain', buses: {}, warnings: [] });
  const spec = desktopRouting(null, { count: 3 });
  assert.deepEqual(spec.steps, [
    { k: 'fx', slot: 1, in: 'chain', out: 'o:1' },
    { k: 'fx', slot: 2, in: 'o:1', out: 'o:2' },
    { k: 'fx', slot: 3, in: 'o:2', out: 'o:3' },
  ]);
  assert.equal(spec.out, 'o:3');
  assert.deepEqual(spec, { ...linearChain(3) });
});

test('the approved example: two gates and the clean signal summed, the reverb on the sum', async () => {
  const { note, env, routePlan } = await core();
  const sig = note('c2 eb2 g2').synth('Wavetable').split(
    (x) => x,
    (b) => b.fx('LPG').param('Decay', 0.08),
    (b) => b.fx('LPG').param('Decay', 0.6).param('Cutoff', env().range(0.2, 0.7)).pan(-0.5).postgain(0.7),
  ).fx('Reverb');
  const spec = desktopRouting(routePlan(sig).plan);
  assert.deepEqual(spec.warnings, []);
  const kinds = spec.steps.map((st) => (st.k === 'fx' ? `fx${st.slot}` : `${st.in}>${st.out}@${st.g}`));
  assert.deepEqual(kinds, ['fx1', 'fx2', 'chain>m:0@0', 'o:1>m:0@0', 'o:2>m:0@1', 'fx3']);
  assert.equal(spec.steps[0].in, 'chain');
  assert.equal(spec.steps[1].in, 'chain');
  assert.equal(spec.steps[5].in, 'm:0');
  assert.equal(spec.out, 'o:3');
  assert.deepEqual(orderProblems(spec), []);
});

test('bands: each crossover a node of its own, its key the sum of the bands below it', async () => {
  const { s, routePlan } = await core();
  const sig = s('x').bands([250, 2500], (l) => l.fx('Distort'), (m) => m.fx('Filter'), (h) => h.postgain(0.5));
  assert.deepEqual(sig.fxChain, ['Distort', 'Filter'], 'the crossovers are not the user\'s slots');
  const spec = desktopRouting(routePlan(sig).plan, { crossover: ['frequency', 'Frequency', 0.049] });
  assert.deepEqual(spec.warnings, []);
  const [x1, distort, , x2, filter] = spec.steps;
  assert.deepEqual(x1, { k: 'xover', id: 'x1', xo: 1, in: 'chain', key: 'none', out: 'o:x1', rest: 'r:x1', ap: 'a:x1' });
  assert.deepEqual(distort, { k: 'fx', slot: 1, in: 'o:x1', out: 'o:1' });
  assert.equal(x2.k, 'xover');
  assert.equal(x2.in, 'r:x1', 'the second crossover splits what is above the first');
  assert.equal(x2.key, 'm:1', 'its key is the low band, as processed');
  assert.equal(filter.in, 'o:x2');
  assert.deepEqual(spec.crossover, ['frequency', 'Frequency', 0.049]);
  assert.deepEqual(orderProblems(spec), []);
});

test('a .bands() at the end of a leveled branch is laid out like any: its all-pass at the level', async () => {
  const { note, routePlan } = await core();
  const sig = note('c2').synth('X').split((x) => x, (b) => b.bands([300], (l) => l.fx('A'), (h) => h).postgain(0.5));
  const spec = desktopRouting(routePlan(sig).plan);
  assert.deepEqual(spec.warnings, []);
  const terms = spec.steps.filter((st) => st.k === 'term');
  assert.ok(terms.some((t) => t.in === 'r:x1' && t.g > 0), 'the top band, at the branch\'s level');
  assert.deepEqual(orderProblems(spec), []);
});

test('any tree the pattern can build is laid out in order, without dropping a term', async () => {
  const { note, routePlan, setPatternWarn } = await core();
  setPatternWarn(() => {});
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let laid = 0;
  for (let trial = 0; trial < 500; trial++) {
    let budget = 30;
    const grow = (b, depth) => {
      let out = b;
      const n = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < n && budget > 0; i++) {
        const r = rand();
        if (r < 0.4) { out = out.fx('A'); budget--; }
        else if (r < 0.75 && depth < 5) {
          const k = 1 + Math.floor(rand() * 3);
          out = out.split(...Array.from({ length: k }, () => (x) => grow(x, depth + 1).postgain(0.5).pan(rand() - 0.5)));
        } else if (depth < 5) {
          const f = 1 + Math.floor(rand() * 3);
          out = out.bands(Array.from({ length: f }, (_, j) => 200 * (j + 1)), ...Array.from({ length: f + 1 }, () => (x) => grow(x, depth + 1)));
        }
      }
      return out;
    };
    const sig = grow(note('c2').synth('X'), 0);
    const r = routePlan(sig);
    if (!r) continue;
    const spec = desktopRouting(r.plan);
    assert.deepEqual(spec.warnings, [], `trial ${trial}`);
    assert.deepEqual(orderProblems(spec), [], `trial ${trial}: ${JSON.stringify(r.plan)}`);
    // Every user slot the pattern has is a node, once.
    const slots = spec.steps.filter((st) => st.k === 'fx').map((st) => st.slot).sort((a, b) => a - b);
    assert.deepEqual(slots, sig.fxChain.map((_, i) => i + 1), `trial ${trial}`);
    laid++;
  }
  setPatternWarn(null);
  assert.ok(laid > 300);
});

// -- the engine adapter -------------------------------------------------------------------------

function engine() {
  const { OscEngine } = require('./index.js');
  const e = new OscEngine({ sclangPath: '/usr/bin/false' });
  e.getTime = () => 0;
  e._packs.set('bd', { status: 'ready', files: [{ path: 'bd/a.wav', duration: 0.4, channels: 2 }] });
  const sent = [];
  e._send = (addr, args) => sent.push({ addr, args });
  return { e, sent };
}

test('the engine sends the layout as JSON - the plain line too, by the chain\'s length', async () => {
  const { s, routePlan } = await core();
  const { e, sent } = engine();
  e.setRouting('drums', routePlan(s('x').bands([300], (l) => l.fx('A'), (h) => h)).plan, 1);
  const wire = JSON.parse(sent.find((m) => m.addr === '/poptart/setRouting').args[1]);
  for (const k of ['steps', 'out', 'buses']) assert.ok(k in wire, `the layout has its ${k}`);
  assert.ok(!('warnings' in wire));
  assert.ok(wire.steps.some((st) => st.k === 'xover'));
  e.setRouting('drums', null, 2);
  assert.deepEqual(JSON.parse(sent.at(-1).args[1]).steps.map((st) => st.slot), [1, 2]);
});

test('a crossover adds no latency: nothing for the scheduler to play early', async () => {
  const { s, routePlan } = await core();
  const { e } = engine();
  e.setRouting('drums', routePlan(s('x').bands([300], (l) => l.fx('A'), (h) => h)).plan, 1);
  assert.ok(e.slotLatencies('drums').every((v) => v === 0));
});

test('notes routed into a device in a band arrive when the track\'s own do', async () => {
  const { note, routePlan } = await core();
  const { e, sent } = engine();
  e.setRouting('lead', routePlan(note('c2').synth('X').bands([300], (l) => l.fx('Ducker'), (h) => h)).plan, 1);
  e.injectMidi('lead', 1, 'kick');
  e.playSample('kick', 'bd', { vel: 1, secPerCycle: 2 }, 1, 1.5);
  const [on] = sent.filter((m) => m.addr === '/poptart/noteOnSlot');
  assert.ok(Math.abs(on.args[4] - 1) < 1e-9, `the note left at ${on.args[4]}`);
  assert.equal(on.args[1], 1, 'into the user\'s own slot 1');
});

test('effectSlots says how far a track\'s effects go, however far that is', () => {
  const { e } = engine();
  for (let slot = 1; slot <= 30; slot++) e.loadEffect('t', 'Filter', slot);
  assert.equal(e.effectSlots('t'), 30);
  e.unloadEffect('t', 30);
  assert.equal(e.effectSlots('t'), 29);
});
