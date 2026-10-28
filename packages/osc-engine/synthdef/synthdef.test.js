'use strict';

// The Node SynthDef encoder on its own (no SuperCollider): the file layout, the graph rewrites
// sclang makes, loading, expression defs. synthdef-sclang.test.js holds the bytes to sclang's.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const G = require('./graph.js');
const U = require('./ugens.js');
const S = require('./index.js');
const { decodeScgf } = require('./decode.js');

const one = (def) => decodeScgf(def.asBytes())[0];
const names = (d) => d.ugens.map((u) => u.name);

test('an SCgf v2 file: header, constants, controls with names, UGen specs', () => {
  const def = new G.SynthDef('t_basic', { out: 0, amp: 0.5, t_go: 0 }, (c) => {
    U.Out.ar(c.out, G.mul(U.Impulse.ar(10), c.amp));
  });
  const bytes = def.asBytes();
  assert.strictEqual(bytes.toString('latin1', 0, 4), 'SCgf');
  assert.strictEqual(bytes.readInt32BE(4), 2);
  assert.strictEqual(bytes.readInt16BE(8), 1);
  const d = one(def);
  // the trigger control comes first, then the control-rate ones, each named in argument order
  assert.deepStrictEqual(d.params, [0, 0, 0.5]);
  assert.deepStrictEqual(d.paramNames, [{ name: 'out', index: 1 }, { name: 'amp', index: 2 }, { name: 't_go', index: 0 }]);
  assert.deepStrictEqual(names(d), ['TrigControl', 'Control', 'Impulse', 'BinaryOpUGen', 'Out']);
  assert.deepStrictEqual(d.constants, [10, 0]);
  const out = d.ugens[4];
  assert.strictEqual(out.rate, 2);
  assert.deepStrictEqual(out.outputs, []);
  assert.deepStrictEqual(out.inputs[0], { u: 1, o: 0 });
});

test('sclang rewrites: MulAdd, Sum3/Sum4, a + b.neg, dead code', () => {
  const muladd = one(new G.SynthDef('t_muladd', { a: 0, b: 0 }, (c) => {
    U.Out.ar(0, G.add(G.mul(U.Impulse.ar(c.a), c.b), 1));
  }));
  assert.deepStrictEqual(names(muladd), ['Control', 'Impulse', 'MulAdd', 'Out']);

  const sum4 = one(new G.SynthDef('t_sum', { a: 0 }, (c) => {
    const x = U.In.ar(c.a, 4);
    U.Out.ar(0, G.add(G.add(G.add(x[0], x[1]), x[2]), x[3]));
  }));
  assert.ok(names(sum4).includes('Sum4') && !names(sum4).includes('BinaryOpUGen'), names(sum4).join(' '));

  const negSub = one(new G.SynthDef('t_neg', { a: 0 }, (c) => {
    const x = U.In.ar(c.a, 2);
    U.Out.ar(0, G.add(x[0], G.neg(x[1])));
  }));
  const ops = negSub.ugens.filter((u) => u.name === 'BinaryOpUGen' || u.name === 'UnaryOpUGen');
  assert.deepStrictEqual(ops.map((u) => [u.name, u.special]), [['BinaryOpUGen', 1]]);

  const dead = one(new G.SynthDef('t_dead', { a: 0 }, (c) => {
    G.gt(G.abs(c.a), 0); // unused: dropped
    U.Out.kr(0, c.a);
  }));
  assert.deepStrictEqual(names(dead), ['Control', 'Out']);
});

test('numbers fold and degenerate operations vanish', () => {
  const d = one(new G.SynthDef('t_fold', { a: 0 }, (c) => {
    U.Out.kr(0, G.add(G.mul(c.a, 1), G.mul(2, 3)));
  }));
  assert.deepStrictEqual(names(d), ['Control', 'BinaryOpUGen', 'Out']);
  assert.ok(d.constants.includes(6));
});

test('every fixed def builds, under a name scsynth takes, for each option set', () => {
  for (const options of [{}, { nativeDevices: false, pitchShift: false, spectrum: false }, { cueOffset: 2, numOutputBusChannels: 6 }]) {
    const defs = S.defsFor(options);
    assert.strictEqual(new Set(defs.map((d) => d.name)).size, defs.length);
    for (const d of defs) {
      assert.ok(d.name.length <= 31, `${d.name} is longer than scsynth's 31`);
      assert.strictEqual(decodeScgf(d.bytes)[0].name, d.name);
    }
    assert.strictEqual(defs.some((d) => d.name === 'poptart_headphones'), options.cueOffset != null);
    assert.strictEqual(defs.some((d) => d.name === 'poptart_rbprobe'), options.pitchShift !== false);
  }
});

test('meta: slot indices point at the VSTPlugin and PoptartDevice UGens', () => {
  for (const options of [{}, { nativeDevices: false }]) {
    for (const d of S.defsFor(options)) {
      const ugens = decodeScgf(d.bytes)[0].ugens;
      for (const [id, i] of Object.entries(d.meta.vstplugins ?? {})) assert.strictEqual(ugens[i].name, 'VSTPlugin', `${d.name} ${id}`);
      for (const [id, i] of Object.entries(d.meta.poptartDevices ?? {})) assert.strictEqual(ugens[i].name, 'PoptartDevice', `${d.name} ${id}`);
    }
  }
  const head = S.defsFor().find((d) => d.name === 'poptart_head');
  assert.deepStrictEqual(Object.keys(head.meta.vstplugins), ['slot0']);
  assert.deepStrictEqual(Object.keys(head.meta.poptartDevices), ['nslot0']);
  assert.strictEqual(head.meta.controls[0], 'inBus');
  assert.strictEqual(S.defsFor({ nativeDevices: false }).find((d) => d.name === 'poptart_head').meta.poptartDevices, undefined);
});

test('loadMessages batches small defs under the datagram limit and files the big ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-defload-'));
  const freqs = Array.from({ length: 96 }, (_, i) => 30 + i * 100);
  const defs = [...S.defsFor().map((d) => d.def), ...S.mixDefsFor(freqs, { spectrum: false }).map((d) => d.def)];
  const { messages, files } = S.loadMessages(defs, { dir });
  let loaded = 0;
  for (const [address, arg] of messages) {
    if (address === '/d_recv') {
      assert.ok(16 + arg.length + 20 <= S.MAX_DATAGRAM, `a /d_recv of ${arg.length} bytes`);
      loaded += decodeScgf(arg).length;
    } else {
      assert.strictEqual(address, '/d_load');
      assert.ok(fs.existsSync(arg));
      loaded += decodeScgf(fs.readFileSync(arg)).length;
    }
  }
  assert.strictEqual(loaded, defs.length);
  assert.deepStrictEqual(files.map((f) => path.basename(f)), ['poptart_mix_analysis.scsyndef']);
  assert.throws(() => S.loadMessages(defs), /needs a directory/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeDefsDir writes the files and a defs.json in the shape the controllers read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-defdir-'));
  const defs = S.defsFor().map((d) => d.def);
  S.writeDefsDir(dir, defs);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'defs.json'), 'utf8'));
  assert.strictEqual(Object.keys(meta).length, defs.length);
  assert.deepStrictEqual(meta.poptart_fx.vstplugins, { slot: 3 });
  assert.ok(fs.existsSync(path.join(dir, 'poptart_fx.scsyndef')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('expression defs: one per shape, constants and inputs in walk order', () => {
  const tree = (k) => ({ k: 'op', op: 'add', a: [{ k: 'in', i: 1 }, { k: 'map', curve: 'lin', min: 0, max: k, a: [{ k: 'const', v: k }] }] });
  const a = S.exprDef(tree(5), { outKind: 'plugin' });
  const b = S.exprDef(tree(7), { outKind: 'plugin' });
  assert.strictEqual(a.name, b.name);
  assert.ok(a.bytes.equals(b.bytes));
  assert.notStrictEqual(S.exprDef(tree(5), { outKind: 'channel' }).name, a.name);
  assert.deepStrictEqual(b.consts, [0, 7, 7]);
  assert.deepStrictEqual(b.inputs, [{ i: 1, source: null, rate: null }]);
  assert.deepStrictEqual(b.rates, ['kr', 'kr']);
  assert.strictEqual(b.shape, 'add(i1,map:lin(c))|plugin|kr,kr');
  assert.deepStrictEqual(b.meta.controls, ['out', 'k1', 'c0', 'c1', 'c2']);
  assert.ok(a.name.length <= 31);
  // an audio driver already on input 0 reads it at audio rate
  assert.deepStrictEqual(S.exprRates({ k: 'in', i: 0 }, (i) => i === 0), ['ar']);
  assert.deepStrictEqual(S.exprRates({ k: 'in', i: 0, rate: 'ar' }), ['ar']);
  const warned = [];
  S.exprDef({ k: 'op', op: 'nope', a: [{ k: 'const', v: 1 }, { k: 'const', v: 2 }] }, { warn: (m) => warned.push(m) });
  assert.strictEqual(warned.length, 1);
});
