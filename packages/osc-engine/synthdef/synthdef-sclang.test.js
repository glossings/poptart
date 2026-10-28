'use strict';

// The Node SynthDef encoder against SuperCollider itself.
//
// 1. Byte for byte: sclang builds every def from the source LIFTED OUT of sc/poptart.scd
//    (synthdef/reference.js) and writes its asBytes; the Node build of the same def must be the
//    same bytes. Three engine configurations cover the options the defs depend on (the device and
//    pitch-shift extensions present or not, output and cue channels), plus a set of
//    param-expression trees that reach every operation, function, map curve and output kind.
//    The VSTPlugin/PoptartDevice slot indices must match sclang's metadata too.
// 2. Loading: scsynth, offline (-N), takes the /d_recv batches and the /d_load file
//    loadMessages makes for every def, and plays one of them.
//
// Needs SuperCollider (and runs sclang/scsynth outside the sandbox); skips without it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('../index.js');
const { userExtensionsDir } = require('../extensions.js');
const { readWavRaw } = require('../wav.js');
const D = require('./defs.js');
const X = require('./expr.js');
const S = require('./index.js');
const { renderReferences } = require('./reference.js');
const { decodeScgf, dumpDef } = require('./decode.js');

const ENGINE = path.join(__dirname, '..');

const IN = (i, rate) => ({ k: 'in', i, rate });
const C = (v) => ({ k: 'const', v });
const OP = (op, a, b) => ({ k: 'op', op, a: [a, b] });
const FN = (op, a) => ({ k: 'fn', op, a: [a] });
const EXPRS = [
  { tree: OP('add', IN(0), C(1)), outKind: 'channel' },
  { tree: OP('mul', IN(0, 'ar'), IN(1)), outKind: 'device' },
  { tree: OP('div', IN(0), C(2)), outKind: 'plugin' },
  { tree: OP('mod', IN(0, 'ar'), IN(1)), outKind: 'plugin' },
  { tree: OP('sub', OP('min', IN(0), C(3)), OP('max', IN(1), OP('pow', IN(0), C(2)))), outKind: 'channel' },
  {
    tree: OP('add', OP('gt', IN(0), C(0.5)), OP('add', OP('gte', IN(0), IN(1)), OP('add', OP('lt', IN(1), C(1)),
      OP('add', OP('lte', IN(0), C(2)), OP('add', OP('eq', IN(0), C(1)), OP('neq', IN(1), C(0))))))),
    outKind: 'channel',
  },
  { tree: { k: 'map', curve: 'lin', min: 0, max: 10, a: [IN(0)] }, outKind: 'plugin' },
  { tree: { k: 'map', curve: 'log', min: 20, max: 20000, a: [OP('mul', IN(0, 'ar'), C(100))] }, outKind: 'device' },
  {
    tree: OP('add', OP('add', FN('abs', IN(0)), FN('neg', IN(0))), OP('add', FN('round', IN(1)), OP('add', FN('floor', IN(0)), FN('ceil', IN(1))))),
    outKind: 'channel',
  },
  { tree: C(4), outKind: 'channel' },
  { tree: OP('mul', IN(0), IN(1)), outKind: 'device', rates: ['ar', 'kr'] },
  { tree: OP('add', OP('mul', IN(0), C(2)), C(1)), outKind: 'channel' },
  { tree: OP('add', OP('mul', IN(0, 'ar'), C(0.5)), C(0.5)), outKind: 'device' },
];
const MIX = Array.from({ length: 96 }, (_, i) => Math.round(30 * (17000 / 30) ** (i / 95)));
const CONFIGS = [
  { key: 'all', numOutputBusChannels: 2, cueOffset: null, nativeDevices: true, spectrum: true, pitchShift: true, mixFreqs: MIX, exprs: EXPRS },
  { key: 'none', numOutputBusChannels: 6, cueOffset: 2, nativeDevices: false, spectrum: false, pitchShift: false, mixFreqs: MIX, exprs: [] },
  { key: 'cue', numOutputBusChannels: 8, cueOffset: 4, nativeDevices: true, spectrum: true, pitchShift: true, mixFreqs: [200, 2000, 8000], exprs: [] },
];

// Trees of one shape share a def (the same name), so each name is compared once.
function nodeDefs(cfg) {
  const all = [
    ...D.fixedDefs(cfg),
    ...(cfg.mixFreqs ? D.mixDefs(cfg.mixFreqs, cfg) : []),
    ...cfg.exprs.map((e) => X.exprDef(e.tree, e).def),
  ];
  return all.filter((d, i) => all.findIndex((x) => x.name === d.name) === i);
}

function sclangOrSkip(t) {
  let sclang;
  try {
    sclang = resolveSclangPath();
  } catch {
    sclang = null;
  }
  if (!sclang || !fs.existsSync(sclang)) {
    t.skip('no sclang on this machine');
    return null;
  }
  return sclang;
}

test('every SynthDef built in Node is the bytes sclang builds from sc/poptart.scd', (t) => {
  const sclang = sclangOrSkip(t);
  if (!sclang) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-synthdef-'));
  const configs = CONFIGS.map((c) => ({ ...c, exprs: c.exprs.map((e) => ({ ...e, name: X.exprDef(e.tree, e).name })) }));
  const { text, slots } = renderReferences({ sclang, outDir: dir, configs, extensionsDir: userExtensionsDir() });
  if (!text.includes('Welcome to SuperCollider') && !text.includes('CONFIG-')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.ok(text.includes('ALL-DONE'), `sclang did not finish:\n${text.split('\n').slice(-20).join('\n')}`);
  const failures = [];
  let compared = 0;
  for (const cfg of CONFIGS) {
    assert.match(text, new RegExp(`^CONFIG-DONE<${cfg.key}\\|`, 'm'), `sclang failed config ${cfg.key}:\n${text.split('\n').filter((l) => /ERROR|FAILED/.test(l)).join('\n')}`);
    const mine = nodeDefs(cfg);
    const refDir = path.join(dir, cfg.key);
    const refNames = fs.readdirSync(refDir).map((f) => f.replace(/\.scsyndef$/, '')).sort();
    assert.deepStrictEqual(mine.map((d) => d.name).sort(), refNames, `config ${cfg.key}: a different set of defs`);
    for (const def of mine) {
      const ref = fs.readFileSync(path.join(refDir, `${def.name}.scsyndef`));
      const bytes = def.asBytes();
      compared++;
      if (Buffer.compare(ref, bytes) !== 0) {
        failures.push(`${cfg.key}/${def.name}:\n--- sclang\n${dumpDef(decodeScgf(ref)[0])}\n--- node\n${dumpDef(decodeScgf(bytes)[0])}`);
      }
      const meta = S.defMeta(def);
      const want = slots[cfg.key]?.[def.name] ?? {};
      assert.deepStrictEqual({ vstplugins: meta.vstplugins, poptartDevices: meta.poptartDevices },
        { vstplugins: want.vstplugins, poptartDevices: want.poptartDevices }, `${cfg.key}/${def.name}: slot indices differ`);
    }
  }
  assert.strictEqual(failures.length, 0, `${failures.length} of ${compared} defs differ:\n${failures.slice(0, 3).join('\n\n')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- a minimal OSC writer for the NRT score -----------------------------------------------------

const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const oscString = (s) => pad(Buffer.from(`${s}\0`, 'latin1'));
function oscMessage([address, ...args]) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (Buffer.isBuffer(a)) {
      tags += 'b';
      const n = Buffer.alloc(4);
      n.writeInt32BE(a.length);
      parts.push(n, pad(a));
    } else if (typeof a === 'number' && Number.isInteger(a)) {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a);
      parts.push(b);
    } else if (typeof a === 'number') {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a);
      parts.push(b);
    } else {
      tags += 's';
      parts.push(oscString(a));
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}
function oscBundle(seconds, messages) {
  const time = Buffer.alloc(8);
  time.writeUInt32BE(Math.floor(seconds));
  time.writeUInt32BE(Math.round((seconds % 1) * 2 ** 32) >>> 0, 4);
  const elems = messages.map((m) => {
    const body = oscMessage(m);
    const n = Buffer.alloc(4);
    n.writeInt32BE(body.length);
    return Buffer.concat([n, body]);
  });
  return Buffer.concat([oscString('#bundle'), time, ...elems]);
}
function score(bundles) {
  return Buffer.concat(bundles.map((b) => {
    const n = Buffer.alloc(4);
    n.writeInt32BE(b.length);
    return Buffer.concat([n, b]);
  }));
}

test('scsynth loads every def from loadMessages (batched /d_recv and /d_load) and plays one', (t) => {
  const sclang = sclangOrSkip(t);
  if (!sclang) return;
  const scsynth = [path.join(path.dirname(sclang), '..', 'Resources', 'scsynth'), path.join(path.dirname(sclang), 'scsynth')]
    .find((p) => fs.existsSync(p));
  if (!scsynth) {
    t.skip('no scsynth next to sclang');
    return;
  }
  const plugins = [
    path.join(path.dirname(scsynth), 'plugins'),
    path.join(ENGINE, 'native', 'devices', 'bin'),
    path.join(ENGINE, 'native', 'rubberband', 'bin'),
    path.join(userExtensionsDir(), 'VSTPlugin', 'plugins'),
  ].filter((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-synthdef-nrt-'));
  const defs = [...D.fixedDefs({}), ...D.mixDefs(MIX, { spectrum: false })];
  const { messages, files } = S.loadMessages(defs, { dir });
  assert.ok(messages.some((m) => m[0] === '/d_load'), 'the 96-band mixer bank should be too big for one datagram');
  assert.ok(messages.filter((m) => m[0] === '/d_recv').length < defs.length, 'small defs should travel together');
  const scoreFile = path.join(dir, 'score.osc');
  const wav = path.join(dir, 'out.wav');
  // A 10 Hz saw on both sides of output 0/1, from 0 to 1.
  fs.writeFileSync(scoreFile, score([
    ...messages.map((m) => oscBundle(0, [m])),
    oscBundle(0, [['/s_new', 'poptart_lfo_saw_ar', 1000, 0, 0, 'out', 0, 'freq', 10]]),
    oscBundle(0.25, [['/c_set', 0, 0]]),
  ]));
  let text;
  try {
    text = execFileSync(scsynth, ['-N', scoreFile, '_', wav, '48000', 'WAV', 'float', '-o', '2', '-i', '0', '-U', plugins.join(':')], {
      encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.doesNotMatch(text, /not installed|FAILURE|exceeded number of interconnect|GraphDef_Load|corrupt/i, `scsynth complained:\n${text}`);
  const out = readWavRaw(wav);
  assert.ok(out && out.channels === 2, `no render:\n${text}`);
  const at = (s) => out.data[Math.floor(s * 48000) * 2];
  assert.ok(Math.abs(at(0.05) - 0.5) < 0.01, `saw at 50 ms is ${at(0.05)}, expected 0.5`);
  assert.ok(Math.abs(at(0.12) - 0.2) < 0.01, `saw at 120 ms is ${at(0.12)}, expected 0.2`);
  for (const f of files) fs.rmSync(f, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
