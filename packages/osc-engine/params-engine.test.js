'use strict';

// The parameter and modulator handlers on a real scsynth (engine/params.js, engine/expr.js), driven
// by '/poptart/*' messages as OscEngine sends them: a polled channel control rides a ramp to its
// value, an LFO and a drawn shape write their bus, an envelope is born gated by the held count,
// an expression's def is built and loaded on the fly and its output reaches the control, and every
// one comes off again leaving nothing the server complains about.
//
// Needs scsynth and an audio device; skipped without them. Nothing sounds (tracks are born dry 0).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { bootEngine, skipReason } = require('./test-support/scsynth');
const { OscEngine } = require('./index.js');

const SECTIONS = ['tracks', 'routing', 'loads', 'ids', 'params', 'expr'];
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function trackOf(E, key) {
  for (let i = 0; i < 100; i++) {
    const t = E.tracks.get(key);
    if (E.isTrack(t)) return t;
    await wait(0.02);
  }
  throw new Error(`track ${key} was never built`);
}

async function until(fn, what, sec = 3) {
  for (let i = 0; i < sec * 50; i++) {
    const v = fn();
    if (v) return v;
    await wait(0.02);
  }
  throw new Error(`${what} never happened`);
}

const busValue = async (bus) => (await bus.get())[0];
const nodeExists = async (S, id) => {
  const reply = await Promise.race([
    S.request(['/n_query', id], '/n_info', (a) => a[0] === id).then(() => true),
    new Promise((r) => { const off = S.on('/fail', (a) => { if (a[0] === '/n_query') { off(); r(false); } }); }),
  ]);
  return reply;
};

test('params and modulators drive their buses on a real server and come off cleanly', async (t) => {
  const why = skipReason();
  if (why) { t.skip(why); return; }
  const { S, E, quit, output } = await bootEngine({ port: 57450, sections: SECTIONS });
  try {
    E.dispatch('/poptart/createTrack', ['t', 'dry', 0]);
    const track = await trackOf(E, 't');
    await S.sync();

    // A polled channel control: a ramp born at its value, mapped onto the head's gain.
    E.dispatch('/poptart/setParam', ['t', -1, 'gain', 0.5, 0]);
    const ramp = await until(() => track.ramps.get('slot-1_gain'), 'the ramp');
    await wait(0.1);
    assert.ok(Math.abs((await busValue(ramp.bus)) - 0.5) < 1e-6, 'the ramp holds its first value');
    E.dispatch('/poptart/setParam', ['t', -1, 'gain', 0.8, 0]);
    await wait(0.15);
    assert.ok(Math.abs((await busValue(ramp.bus)) - 0.8) < 1e-6, 'the ramp glides to the next value');

    // An LFO on gain takes the ramp's place - at the sample rate, on an audio bus the head reads
    // per sample (gainAr), as the browser drives a channel control.
    E.dispatch('/poptart/setParamLFO', ['t', -1, 'gain', 'square', 1, 0, 0.3, 0.3]);
    const lfo = await until(() => track.lfos.get('slot-1_gain'), 'the lfo');
    assert.ok(!track.ramps.has('slot-1_gain'), 'the native modulator took over from the ramp');
    assert.strictEqual(lfo.audio, true, 'a channel control is driven at the sample rate');
    assert.strictEqual(track.chanAr?.get('gain'), lfo.bus.index, 'the head reads the lfo\'s audio bus');

    // A drawn shape on pan, from the table files the engine writes: a flat line at 0.6.
    const engineLike = { _shapeKeys: new Map(), _shapeFileSerial: 9000 };
    const [, paths] = OscEngine.prototype._shapeTables.call(engineLike, 't', -1, 'pan', [[{ x: 0, y: 0.6 }, { x: 1, y: 0.6 }]]);
    E.dispatch('/poptart/setParamShapeLFO', ['t', -1, 'pan', 'free', 1, 0, 0, 1, 'k1', paths]);
    const shape = await until(() => track.lfos.get('slot-1_pan'), 'the shape lfo');
    await wait(0.15);
    assert.strictEqual(shape.audio, true);
    // A driven pan is read through a pan-law node of its own, made for the driver.
    assert.ok(track.panLaw && await nodeExists(S, track.panLaw.node.nodeID), 'the pan law node runs');
    assert.strictEqual(track.chanAr?.get('pan'), shape.bus.index);
    for (const p of JSON.parse(paths)) assert.ok(!fs.existsSync(p), 'the table files are read and deleted');

    // An envelope on width, born closed (nothing held): at 0.
    E.dispatch('/poptart/setParamEnv', ['t', -1, 'width', 0.01, 0.1, 0.7, 0.2, -4, 0, 1]);
    const env = await until(() => track.envs.get('slot-1_width'), 'the env');
    assert.ok(await nodeExists(S, env.synth.nodeID));
    await wait(0.05);
    assert.strictEqual(env.audio, true);
    assert.strictEqual(track.chanAr?.get('width'), env.bus.index);

    // An expression on postgain: its def is built and loaded on the fly, its output is the constant.
    E.dispatch('/poptart/setParamExpr', ['t', -1, 'postgain', JSON.stringify({ k: 'op', op: 'add', a: [{ k: 'const', v: 0.25 }, { k: 'const', v: 0.5 }] })]);
    const expr = await until(() => E.exprsOf(track).get('slot-1_postgain'), 'the expression');
    await wait(0.1);
    assert.ok(Math.abs((await busValue(expr.out)) - 0.75) < 1e-6, `the expression's output: ${await busValue(expr.out)}`);
    // Numbers only: the same synth, a new value.
    E.dispatch('/poptart/setParamExpr', ['t', -1, 'postgain', JSON.stringify({ k: 'op', op: 'add', a: [{ k: 'const', v: 0.1 }, { k: 'const', v: 0.2 }] })]);
    await wait(0.15);
    assert.strictEqual(E.exprsOf(track).get('slot-1_postgain').synth, expr.synth);
    assert.ok(Math.abs((await busValue(expr.out)) - 0.3) < 1e-6);

    // Everything off; the deferred frees run; the server never failed a command.
    E.dispatch('/poptart/clearParamLFO', ['t', -1, 'gain']);
    E.dispatch('/poptart/clearParamLFO', ['t', -1, 'pan']);
    E.dispatch('/poptart/clearParamEnv', ['t', -1, 'width']);
    E.dispatch('/poptart/clearParamExpr', ['t', -1, 'postgain']);
    await wait(0.6);
    for (const n of [lfo.synth, shape.synth, env.synth, expr.synth]) assert.ok(!(await nodeExists(S, n.nodeID)), `node ${n.nodeID} was freed`);
    assert.ok(!track.panLaw && !track.chanAr.size, 'every channel control is back on its control');
    await wait(2.2);
    assert.ok(!E.defs.has(expr.def), "the expression's def went once nothing used it");
    assert.ok(!/FAILURE IN SERVER/.test(output), `the server failed a command:\n${output.split('\n').filter((l) => /FAILURE/.test(l)).join('\n')}`);
    assert.ok(!/ERROR/.test(output), `the engine raised:\n${output.split('\n').filter((l) => /ERROR/.test(l)).join('\n')}`);
  } finally {
    await quit();
  }
});
