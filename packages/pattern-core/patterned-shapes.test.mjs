// Patterned lfo() shapes: lfo("<pluck swell>") compiles every named shape up front and swaps
// which one is playing on the pattern's own grid. Testable here: what the IR carries, when a swap
// is scheduled, and that the phase anchor follows the swap rather than absolute time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, synth, lfo, sine, _shape, setPatternWarn, lfoRateHz, lfoShapes, lfoPoints } from './src/signal.mjs';
import { clearRolls, setRollLayer, shapeIds } from './src/rolls.mjs';
import { injectLocations } from './src/locations.mjs';
import { mini } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine(now = 0) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => now },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, argsTo: (m) => calls.filter((c) => c.method === m).map((c) => c.args) };
}

const withLfo = (l) => note('c').synth('X').param('Cutoff', l);

test('one drawn shape is not a pattern', () => {
  const ir = lfo('0,0 0.5,1 1,0').lfoIR;
  assert.equal(lfoShapes(ir).length, 1);
  assert.equal(ir.shapePattern, null);
});

test('a preset name is a shape', () => {
  assert.deepEqual(lfoPoints(lfo('pluck').lfoIR), lfoPoints(lfo('0,1,-4 1,0').lfoIR));
});

test('grouping names several shapes, in order', () => {
  const ir = lfo('<pluck swell>').lfoIR;
  assert.deepEqual(ir.shapeNames, ['pluck', 'swell']);
  assert.equal(lfoShapes(ir).length, 2);
  assert.ok(ir.shapePattern);
  assert.deepEqual(lfoPoints(ir), lfoShapes(ir)[0]); // it starts on the first one
});

test('a drawn shape inside a pattern is quoted, and commas stay breakpoints', () => {
  const ir = lfo("<'0,0 1,1' pluck>").lfoIR;
  assert.deepEqual(lfoShapes(ir)[0], [{ x: 0, y: 0, c: 0 }, { x: 1, y: 1, c: 0 }]);
  assert.equal(lfoShapes(ir).length, 2);
  // A bare breakpoint list is full of commas and is still one shape.
  assert.equal(lfoShapes(lfo('0,0 0.5,1 1,0').lfoIR).length, 1);
});

test('glide is carried as a fraction of a period, and defaults to a jump', () => {
  assert.equal(lfo('<pluck swell>', { glide: 0.25 }).lfoIR.glide, 0.25);
  assert.equal(lfo('<pluck swell>').lfoIR.glide, 0);
});

test('rate and range still rewrite the same IR', () => {
  const ir = lfo('<pluck swell>').rate(4).range(200, 5000).lfoIR;
  assert.equal(ir.rateCycles, 4);
  assert.equal(ir.min, 200);
  assert.deepEqual(ir.shapeNames, ['pluck', 'swell']); // the shapes survive the rewrite
});

test('the swap is scheduled on the shape pattern grid', () => {
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(withLfo(lfo('<pluck swell>')));
  for (let c = 0; c < 3; c++) sch._scheduleShapeSwaps(c, c + 1);
  // The first step asserts the shape rather than assuming it: after a re-eval the engine may be
  // holding any _shape(an unchanged spec keeps the running synth), and a scheduler that assumed
  // shape 0 would skip the message that puts it right. The engine no-ops when it already agrees.
  assert.deepEqual(argsTo('setParamShape'), [
    ['t', 0, 'Cutoff', 0, 0],
    ['t', 0, 'Cutoff', 1, 1],
    ['t', 0, 'Cutoff', 0, 2],
  ]);
});

test('a shape held across steps is not re-sent', () => {
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(withLfo(lfo('[pluck pluck swell]')));
  sch._scheduleShapeSwaps(0, 1);
  assert.deepEqual(argsTo('setParamShape'), [
    ['t', 0, 'Cutoff', 0, 0], // the opening assertion; the repeat of pluck at 1/3 is not re-sent
    ['t', 0, 'Cutoff', 1, 2 / 3],
  ]);
});

test('an unpatterned lfo schedules nothing', () => {
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(withLfo(lfo('pluck')));
  sch._scheduleShapeSwaps(0, 8);
  assert.deepEqual(argsTo('setParamShape'), []);
});

test('the phase anchor counts from the last swap, not from time zero', () => {
  const { engine, argsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(withLfo(lfo('<pluck swell>', { rate: 2 })));

  // Before any swap: the absolute formula, phase = (t * rate) % 1.
  sch._anchorLFOs(10);
  assert.equal(argsTo('anchorParamLFO')[0][3], ((10.15 * 2) % 1 + 1) % 1);

  // The swap at cycle 1 restarts the shape, so the phase is measured from there.
  sch._scheduleShapeSwaps(0, 2);
  for (const m of sch._activeModulators.values()) m.anchoredAtSec = null; // due again
  sch._anchorLFOs(10);
  assert.equal(argsTo('anchorParamLFO')[1][3], (((10.15 - 1) * 2) % 1 + 1) % 1);
});

// ---------------------------------------------------------------------------------------------
// Named shapes - _shape("swell", "…"), the LFO's half of the definition registry
// ---------------------------------------------------------------------------------------------

test('a defined shape is what a pattern naming it plays', () => {
  clearRolls('buffer');
  _shape('swell2', '0,0,2 0.7,1 1,0');
  const ir = lfo('<swell2 pluck>').lfoIR;
  assert.deepEqual(ir.shapeNames, ['swell2', 'pluck']);
  assert.deepEqual(lfoShapes(ir)[0], [{ x: 0, y: 0, c: 2 }, { x: 0.7, y: 1, c: 0 }, { x: 1, y: 0, c: 0 }]);
});

test('a definition shadows the built-in preset of the same name', () => {
  clearRolls('buffer');
  const stock = lfoPoints(lfo('pluck').lfoIR);
  _shape('pluck', '0,0 1,1');
  assert.deepEqual(lfoPoints(lfo('pluck').lfoIR), [{ x: 0, y: 0, c: 0 }, { x: 1, y: 1, c: 0 }]);
  clearRolls('buffer');
  assert.deepEqual(lfoPoints(lfo('pluck').lfoIR), stock, 'and the preset is back once the buffer clears');
});

test('a definition is marked so a definitions block is never played as a track', () => {
  clearRolls('buffer');
  assert.equal(_shape('swell2', '0,0 1,1').isDef, 'swell2');
  assert.equal(lfo('swell2').isDef, undefined, 'a pattern naming shapes is a track like any other');
});

test('a shape id has to be writable inside a pattern', () => {
  assert.throws(() => _shape('two words', '0,0 1,1'), /one plain word/);
  assert.throws(() => _shape('<a>', '0,0 1,1'), /one plain word/);
});

test('bad breakpoints are reported against the definition, not against every lfo() naming it', () => {
  assert.throws(() => _shape('bad', 'not,breakpoints x'), /\[shape\]/);
});

test('defining one twice warns rather than throwing - the later one wins', () => {
  clearRolls('buffer');
  const seen = [];
  setPatternWarn((m) => seen.push(m));
  try {
    _shape('dup', '0,0 1,1');
    _shape('dup', '0,1 1,0');
  } finally { setPatternWarn(null); }
  assert.match(seen[0], /defined twice/);
  assert.deepEqual(lfoPoints(lfo('dup').lfoIR), [{ x: 0, y: 1, c: 0 }, { x: 1, y: 0, c: 0 }]);
});

test('shapeIds lists what is playable, buffer first', () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('prebake');
  _shape('library', '0,0 1,1');
  setRollLayer('buffer');
  _shape('mine', '0,0 1,1');
  assert.deepEqual(shapeIds(), [
    { id: 'mine', layer: 'buffer' },
    { id: 'library', layer: 'prebake' },
  ]);
  clearRolls('prebake');
});

test('the editor hands lfo() a tagged pattern, and the names keep their source spans', () => {
  clearRolls('buffer');
  _shape('a', '0,0 1,1');
  _shape('b', '0,1 1,0');
  const src = 'lfo("<a b>")';
  const ir = new Function('lfo', 'mini', `return (${injectLocations(src, 0)})`)(lfo, mini).lfoIR;
  assert.ok(ir.shapePattern, 'the tagged mini() is the shape pattern');
  // Which is what lets the editor light the name that is running - the spans point at the source.
  assert.deepEqual(ir.shapePattern.stepsForCycle(0)[0].loc, [6, 7]);
  assert.deepEqual(ir.shapePattern.stepsForCycle(1)[0].loc, [8, 9]);
});

test('a name nothing defines warns and plays the default rather than throwing', () => {
  clearRolls('buffer');
  const seen = [];
  setPatternWarn((m) => seen.push(m));
  // The name is looked up when the shape is first READ, not when lfo() was built - so that is
  // where the warning comes from too, and by then the whole buffer has had its chance to define it.
  const ir = lfo('<gone missing>').lfoIR;
  assert.deepEqual(seen, [], 'nothing said yet - the definition could still be two lines further down');
  let points;
  try { points = lfoPoints(ir); } finally { setPatternWarn(null); }
  assert.match(seen[0], /no shape called "gone"/);
  assert.deepEqual(points, lfoPoints(lfo('triangle').lfoIR), 'it plays the default shape');
});

test('malformed breakpoints still report as breakpoints, not as a missing name', () => {
  // At BUILD time, though the lookup of a name is deferred: data is wrong where it is written, and
  // a bad breakpoint surfacing later would surface from inside a scheduler tick (see lfoShapes).
  assert.throws(() => lfo('0,0 1,notanumber'), /\[shape\] bad breakpoint/);
  assert.throws(() => lfo("<'0,0 1,notanumber' pluck>"), /\[shape\] bad breakpoint/);
});

// ---------------------------------------------------------------------------------------------
// Rate: cycles by default, Hz when you ask for it
// ---------------------------------------------------------------------------------------------

test('a bare rate is cycles - one pass per cycle, whatever the tempo', () => {
  const ir = lfo('pluck').lfoIR;
  assert.equal(ir.rateCycles, 1);
  assert.equal(ir.rateHz, undefined);
  assert.equal(lfoRateHz(ir, 0.5), 0.5, 'at 120bpm a cycle is 2s, so one pass per cycle is 0.5Hz');
  assert.equal(lfoRateHz(ir, 1), 1);
});

test('a rate with the unit on it is free-running, and ignores the tempo', () => {
  const ir = lfo('pluck', { rate: '0.5hz' }).lfoIR;
  assert.equal(ir.rateHz, 0.5);
  assert.equal(ir.rateCycles, undefined);
  for (const cps of [0.25, 0.5, 2]) assert.equal(lfoRateHz(ir, cps), 0.5);
});

test('both spellings survive .rate(), .fast() and the shape builders', () => {
  assert.equal(sine(2).lfoIR.rateCycles, 2);
  assert.equal(sine('3hz').lfoIR.rateHz, 3);
  assert.equal(lfo('pluck').rate('2hz').lfoIR.rateHz, 2);
  assert.equal(lfo('pluck').rate('2hz').lfoIR.rateCycles, undefined, 'setting one clears the other');
  assert.equal(lfo('pluck', { rate: '2hz' }).fast(2).lfoIR.rateHz, 4, 'faster scales whichever unit is in force');
  assert.equal(lfo('pluck', { rate: 2 }).fast(2).lfoIR.rateCycles, 4);
});

test('a nonsense rate says what the two spellings are', () => {
  assert.throws(() => lfo('pluck', { rate: 'quickly' }), /number of cycles, or a string with the unit/);
});

test('a synced modulator is re-sent when the tempo moves; a free one is not', () => {
  for (const [rate, resent] of [[1, true], ['0.5hz', false]]) {
    const calls = [];
    const engine = new Proxy({ getTime: () => 0 },
      { get: (t, p) => (p in t ? t[p] : (...a) => { calls.push({ method: p, args: a }); }) });
    const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
    sch.setPattern(note('c').synth('X').param('Cutoff', lfo('pluck', { rate })));
    const sent = () => calls.filter((c) => c.method === 'setParamLFO').map((c) => c.args[3].rateHz);
    assert.deepEqual(sent(), [rate === 1 ? 1 : 0.5], 'the first send resolves the rate against the tempo');
    sch.transport.cps = 0.5; // setbpm
    for (const m of sch._activeModulators.values()) sch._sendModulator(m, 0);
    assert.deepEqual(sent(), resent ? [1, 0.5] : [0.5], `rate ${JSON.stringify(rate)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// A name is resolved LATE - the ordering the editor's buffer layout actually has
// ---------------------------------------------------------------------------------------------

// The editor writes `_shape(...)` definitions in a block at the FOOT of the buffer, below the
// patterns that name them, and the host evaluates blocks in document order against a registry it
// clears each time. So a name is looked up while nothing defines it yet, and everything downstream
// has to wait rather than settle for the fallback. These pin the order, since getting it wrong is
// silent: the LFO simply plays the default triangle for ever.

const TRIANGLE = '0,0 0.5,1 1,0'; // DEFAULT_LFO_SHAPE - what an unresolved name used to fall back to
const asPoints = (pts) => pts.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)]);

test('a shape defined AFTER the pattern that names it still plays', () => {
  clearRolls();
  setRollLayer('buffer');
  const said = [];
  setPatternWarn((line) => said.push(line));
  try {
    // 1. the `pluck:` block builds, naming a shape nothing has defined yet
    const track = withLfo(lfo('pluck2'));
    // 2. ...and only now does the definition block at the foot of the buffer run
    _shape('pluck2', '0,1,-4 1,0');
    // 3. the engine is handed the drawn shape, not the fallback
    const { engine, argsTo } = mockEngine();
    const sch = new Scheduler(engine, { trackId: 'lead', cps: 0.5 });
    sch.setPattern(track);
    const [args] = argsTo('setParamLFO');
    assert.ok(args, 'the modulator was sent');
    const ir = args[3];
    assert.deepEqual(asPoints(ir.points), [[0, 1], [1, 0]], 'the pluck, not the triangle');
    assert.deepEqual(asPoints(ir.shapes[0]), asPoints(ir.points));
    assert.deepEqual(said, [], 'and nothing was warned about, because nothing was missing');
  } finally {
    setPatternWarn(null);
    clearRolls();
  }
});

test('a name nothing ever defines still warns, once, and still plays', () => {
  clearRolls();
  setRollLayer('buffer');
  const said = [];
  setPatternWarn((line) => said.push(line));
  try {
    const track = withLfo(lfo('nosuchshape'));
    const { engine, argsTo } = mockEngine();
    const sch = new Scheduler(engine, { trackId: 'lead', cps: 0.5 });
    sch.setPattern(track);
    const ir = argsTo('setParamLFO')[0][3];
    assert.deepEqual(asPoints(ir.points), asPoints(lfoPoints(lfo(TRIANGLE).lfoIR)), 'falls back rather than going silent');
    assert.equal(said.length, 1, 'said once, at the point it was actually looked for');
    assert.match(said[0], /no shape called "nosuchshape"/);
  } finally {
    setPatternWarn(null);
    clearRolls();
  }
});

test('a patterned name resolves late too, and keeps its order', () => {
  clearRolls();
  setRollLayer('buffer');
  try {
    const track = withLfo(lfo(mini('<a b>')));
    _shape('a', '0,1 1,0');   // saw down
    _shape('b', '0,0 1,1');   // ramp up
    const { engine, argsTo } = mockEngine();
    const sch = new Scheduler(engine, { trackId: 'lead', cps: 0.5 });
    sch.setPattern(track);
    const ir = argsTo('setParamLFO')[0][3];
    assert.deepEqual(ir.shapes.map(asPoints), [[[0, 1], [1, 0]], [[0, 0], [1, 1]]], 'in the order the pattern names them');
    assert.deepEqual(asPoints(ir.points), [[0, 1], [1, 0]], 'starting on the first');
  } finally {
    clearRolls();
  }
});

test('the resolved shapes are read once, not per sample', () => {
  clearRolls();
  setRollLayer('buffer');
  try {
    const l = lfo('memo');
    _shape('memo', '0,1 1,0');
    const first = lfoShapes(l.lfoIR);
    assert.strictEqual(lfoShapes(l.lfoIR), first, 'the same array back, not a fresh lookup');
  } finally {
    clearRolls();
  }
});
