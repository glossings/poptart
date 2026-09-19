// The granular voice's controls: .grain() is a per-event switch, the controls that tune it are
// channel controls a grain reads live, and a .begin() with no rhythm of its own is streamed beside
// them. Scheduler walk against a recording engine, no boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, mini, note, begin, grain, rand, saw, sine, irand, Signal, _shape, CHANNEL_DEFAULTS, GRAIN_CHANNELS } from './src/signal.mjs';
import { Scheduler, grainPosSig } from './src/scheduler.mjs';
import { parseShapePoints } from './src/shape.mjs';
import { isPatternPosition } from './src/locations.mjs';

function run(sig, { cps = 1 } = {}) {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const sch = new Scheduler(engine, { trackId: 't', cps });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, 1);
  return { sch, calls, cfgs: calls.filter((c) => c.method === 'playSample').map((c) => c.args[2]) };
}

const channelSets = (calls, name) => calls.filter((c) => c.method === 'setParam' && c.args[1] === -1 && c.args[2] === name);

test('.grain() is a per-event switch, bare means on, and it patterns', () => {
  assert.equal(run(s(mini('pad'))).cfgs[0].grain, undefined, 'off unless asked for');
  assert.equal(run(s(mini('pad')).grain()).cfgs[0].grain, 1);
  assert.deepEqual(run(s(mini('pad pad')).grain(mini('0 1'))).cfgs.map((c) => c.grain), [0, 1]);
});

test('grain() is a control operand like the rest', () => {
  const [cfg] = run(s(mini('pad')).set(grain(1))).cfgs;
  assert.equal(cfg.grain, 1);
});

test('a grain control turns the switch on, and leaves one already set alone', () => {
  assert.equal(run(s(mini('pad')).grainsize(0.05)).cfgs[0].grain, 1);
  assert.equal(run(s(mini('pad')).grainrate(30)).cfgs[0].grain, 1);
  assert.equal(run(s(mini('pad')).grainpan(0.5)).cfgs[0].grain, 1);
  assert.equal(run(s(mini('pad')).grainshape('pluck')).cfgs[0].grain, 1);
  assert.deepEqual(run(s(mini('pad pad')).grain(mini('0 1')).grainsize(0.05)).cfgs.map((c) => c.grain), [0, 1]);
});

test('grain controls written ahead of the source wait for it', () => {
  const [cfg] = run(note(mini('c3')).grainsize(0.05).grainshape('0,0 0.5,1 1,0').s(mini('pad'))).cfgs;
  assert.equal(cfg.grain, 1);
  assert.equal(cfg.grainSize, 0.05);
  assert.deepEqual(cfg.grainShape, parseShapePoints('0,0 0.5,1 1,0'));
});

test('size, rate and pan are channel controls, and the event carries their onset values', () => {
  const sig = s(mini('pad')).grainsize(0.05).grainrate(sine(0.5).range(10, 50)).grainpan(-0.25);
  assert.ok(sig.channel.grainsize && sig.channel.grainrate && sig.channel.grainpan);
  const [cfg] = run(sig).cfgs;
  assert.equal(cfg.grainSize, 0.05);
  assert.equal(cfg.grainPan, -0.25);
  assert.ok(cfg.grainRate >= 10 && cfg.grainRate <= 50, `rate sampled at the onset (${cfg.grainRate})`);
  // Unset ones stay off the event; the engine fills its own defaults.
  assert.equal(run(s(mini('pad')).grain()).cfgs[0].grainSize, undefined);
});

test('a plain event carries none of it', () => {
  const [cfg] = run(s(mini('pad pad')).grain(mini('0 1')).grainsize(0.05)).cfgs;
  assert.equal(cfg.grainSize, undefined);
  assert.equal(cfg.grainPosLive, undefined);
});

test('every grain channel has a default to snap back to', () => {
  for (const name of GRAIN_CHANNELS) assert.equal(typeof CHANNEL_DEFAULTS[name], 'number', name);
});

test('a continuous begin is streamed as grainpos; a constant or a gridded one is not', () => {
  assert.ok(grainPosSig(s(mini('pad')).grain().begin(saw(0.25).range(0.2, 0.6))), 'an LFO');
  assert.ok(grainPosSig(s(mini('pad')).grain().begin(0.4).add(begin(rand().mul(0.01)))), 'a constant plus rand()');
  assert.ok(grainPosSig(s(mini('pad')).grain().begin(saw(0.25).add(rand().mul(0.02)))), 'two signals summed');
  assert.equal(grainPosSig(s(mini('pad')).grain().begin(0.4)), null, 'a constant needs no stream');
  assert.equal(grainPosSig(s(mini('pad')).grain().begin(mini('0 0.5'))), null, 'a rhythm makes events');
  assert.equal(grainPosSig(s(mini('pad')).begin(saw(0.25))), null, 'not granular');
});

test('the order .begin() and .grain() are written in does not matter', () => {
  assert.ok(grainPosSig(s(mini('pad')).begin(saw(0.25)).grainsize(0.05)));
});

test('a streamed begin flags the event and is driven as a channel control', () => {
  const { sch, calls, cfgs } = run(s(mini('pad')).grain().begin(0.4).add(begin(rand().mul(0.01))));
  assert.equal(cfgs[0].grainPosLive, 1);
  assert.ok(cfgs[0].begin >= 0.4 && cfgs[0].begin <= 0.41, `the voice starts on the onset's own value (${cfgs[0].begin})`);
  // A constant plus a modulator is that modulator with moved bounds, so it runs natively.
  const native = calls.find((c) => c.method === 'setParamLFO' && c.args[1] === -1 && c.args[2] === 'grainpos');
  assert.ok(native, 'grainpos is driven by a native rand()');
  assert.ok(Math.abs(native.args[3].min - 0.4) < 1e-9 && Math.abs(native.args[3].max - 0.41) < 1e-9);
  assert.ok(native.args[3].rateHz >= 500, 'refreshed per grain');
});

test('a begin no single modulator can express is polled onto grainpos', () => {
  const { sch, calls } = run(s(mini('pad')).grain().begin(saw(0.25).range(0.2, 0.6).add(rand().mul(0.02))));
  calls.length = 0;
  sch._pollGenericParams(0);
  const sets = channelSets(calls, 'grainpos');
  assert.equal(sets.length, 1);
  assert.ok(sets[0].args[3] >= 0.2 && sets[0].args[3] <= 0.62, `value ${sets[0].args[3]}`);
});

test('a constant on either side of a modulator keeps it native', () => {
  for (const sig of [Signal(0.4).add(rand().mul(0.01)), rand().mul(0.01).add(0.4), rand().mul(0.01).add(Signal(0.4))]) {
    assert.equal(sig.lfoIR?.shape, 'rand');
    assert.ok(Math.abs(sig.lfoIR.min - 0.4) < 1e-9 && Math.abs(sig.lfoIR.max - 0.41) < 1e-9);
  }
  const inverted = Signal(1).sub(sine());
  assert.deepEqual([inverted.lfoIR.min, inverted.lfoIR.max], [1, 0], 'c - lfo is the lfo upside down');
  assert.ok(!Signal(2).div(sine()).lfoIR, 'c / lfo is not a straight line in the lfo');
  assert.ok(!mini('0.4 0.5').add(rand()).lfoIR, 'a pattern on the left is a pattern');
});

test('a gridded begin stays per event', () => {
  const { sch, calls, cfgs } = run(s(mini('pad')).grain().begin(mini('0.25 0.75')));
  assert.deepEqual(cfgs.map((c) => c.begin), [0.25, 0.75]);
  assert.equal(cfgs[0].grainPosLive, undefined);
  calls.length = 0; // a fresh track is sent every channel default once - not what is being asked here
  sch._pollGenericParams(0);
  assert.equal(channelSets(calls, 'grainpos').length, 0);
});

test('a native rand() on a grain control refreshes per grain, not per second', () => {
  const { calls } = run(s(mini('pad')).grainpan(rand().range(-0.6, 0.6)));
  const lfo = calls.find((c) => c.method === 'setParamLFO' && c.args[2] === 'grainpan');
  assert.ok(lfo, 'rand().range() runs natively');
  assert.equal(lfo.args[3].shape, 'rand');
  assert.ok(lfo.args[3].rateHz >= 500, `refresh ${lfo.args[3].rateHz} Hz`);
  assert.equal(lfo.args[3].min, -0.6);
  assert.equal(lfo.args[3].max, 0.6);
  // The same rand() on an ordinary control keeps the stock pace.
  const pan = run(s(mini('pad')).pan(rand().range(-0.6, 0.6))).calls.find((c) => c.method === 'setParamLFO');
  assert.ok(pan.args[3].rateHz < 500);
});

test('dropping a grain control snaps it back to its default', () => {
  const { sch, calls } = run(s(mini('pad')).grainsize(0.3).begin(saw(0.25)));
  calls.length = 0;
  sch.setPattern(s(mini('pad')).grain());
  for (const name of ['grainsize', 'grainpos']) {
    const reset = channelSets(calls, name);
    assert.equal(reset.length, 1, `${name} reset once`);
    assert.equal(reset[0].args[3], CHANNEL_DEFAULTS[name]);
  }
});

test('.grainshape() takes drawn points, a name, and a pattern of names', () => {
  const drawn = run(s(mini('pad')).grainshape('0,0 0.1,1,-4 1,0')).cfgs[0].grainShape;
  assert.deepEqual(drawn, parseShapePoints('0,0 0.1,1,-4 1,0'));
  assert.deepEqual(run(s(mini('pad')).grainshape('pluck')).cfgs[0].grainShape, parseShapePoints('pluck'));
  const swapped = run(s(mini('pad pad')).grainshape('<pluck swell>*2')).cfgs.map((c) => c.grainShape);
  assert.deepEqual(swapped, [parseShapePoints('pluck'), parseShapePoints('swell')]);
  // The editor's transpile hands a name pattern over as a Sig.
  assert.deepEqual(run(s(mini('pad')).grainshape(mini('swell'))).cfgs[0].grainShape, parseShapePoints('swell'));
});

test('a window adds no events of its own', () => {
  assert.equal(run(s(mini('pad')).grainshape('<pluck swell>*4')).cfgs.length, 1);
});

test('a shape defined BELOW the pattern that names it still resolves', () => {
  const sig = s(mini('pad')).grainshape('mine');
  _shape('mine', '0,1 1,0');
  assert.deepEqual(run(sig).cfgs[0].grainShape, parseShapePoints('0,1 1,0'));
});

test('bad drawn data fails the evaluation, not a scheduler tick', () => {
  assert.throws(() => s(mini('pad')).grainshape('0,0 1,notanumber'), /breakpoint/);
});

test('per-onset randomness in a gridded begin is untouched by .grain()', () => {
  const cfgs = run(s(mini('pad*4')).grain().begin(irand(8).div(8))).cfgs;
  assert.equal(cfgs.length, 4);
  for (const c of cfgs) assert.equal((c.begin * 8) % 1, 0, `an eighth of the file (${c.begin})`);
});

test('the transpile wraps a grainshape name but leaves drawn data alone', () => {
  assert.equal(isPatternPosition('x.grainshape(', ')', '<pluck swell>'), true);
  assert.equal(isPatternPosition('x.grainshape(', ')', '0,0 0.5,1 1,0'), false);
});
