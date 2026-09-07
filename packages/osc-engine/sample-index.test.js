'use strict';

// The sample index against a synthetic two-folder library: what gets analyzed when, what the
// map says about it, how the kit queries answer, and that all of it survives a round trip
// through the cache file. The analyzer is injected (the real one is the worker), running the
// same sample-map functions synchronously.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sm = require('./sample-map');
const { SampleIndex } = require('./sample-index');
const { encodeWav } = require('./wav');

const SR = 44100;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-sample-index-'));
const KICKS = path.join(TMP, 'lib', 'kicks');
const HATS = path.join(TMP, 'lib', 'hats');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function kick(freq, seed) {
  const n = Math.round(0.4 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * Math.exp((-7 * i) / SR) * (0.9 + 0.01 * seed);
  return out;
}
function hat(decay, seed) {
  const rng = sm.mulberry32(seed);
  const n = Math.round(0.3 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * Math.exp((-decay * i) / SR);
  return out;
}
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeWav({ sampleRate: SR, channels: 1, data }));
};

let analyzeCalls = [];
const analyze = async (paths) => {
  analyzeCalls.push(paths);
  return paths.map((p) => {
    const head = sm.readAudioHead(p);
    return head && { features: sm.extractFeatures(head.samples, head.sampleRate, head.totalSeconds), seconds: head.totalSeconds };
  });
};
const toWavCalls = [];
// An "aiff" that is really a wav under another name, so the conversion hook can be exercised.
const toWav = async (file) => { toWavCalls.push(file); return file.replace(/\.aif$/, '.decoded.wav'); };

const fresh = (name = 'index.json') => new SampleIndex({ cacheFile: path.join(TMP, name), analyze, toWav });

before(() => {
  for (let i = 0; i < 6; i++) write(path.join(KICKS, `kick0${i}.wav`), kick(45 + i * 6, i));
  for (let i = 0; i < 6; i++) write(path.join(HATS, `hat0${i}.wav`), hat(20 + i * 8, i));
  write(path.join(HATS, 'extra.decoded.wav'), hat(30, 99));
  fs.copyFileSync(path.join(HATS, 'extra.decoded.wav'), path.join(HATS, 'extra.aif'));
  fs.writeFileSync(path.join(HATS, 'broken.wav'), 'not a wav at all');
});

test('refresh: indexes every file under the sources, labels by folder, converts non-wav', async () => {
  const ix = fresh();
  ix.setSources([KICKS, HATS]);
  const phases = [];
  const r = await ix.refresh({ onProgress: (s) => phases.push(s.phase) });
  // 6 kicks + 6 hats + extra.decoded.wav + extra.aif; broken.wav is scanned but has no vector.
  assert.strictEqual(r.analyzed, 14);
  assert.strictEqual(r.total, 14);
  assert.ok(toWavCalls.some((f) => f.endsWith('extra.aif')), 'the aiff went through the conversion hook');
  assert.deepStrictEqual([...new Set(phases)], ['scan', 'analyze', 'place', 'done']);
  assert.strictEqual(ix.status.building, false);

  const snap = ix.snapshot();
  assert.strictEqual(snap.points.length, 14);
  assert.ok(snap.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  for (const p of snap.points) {
    if (p.path.startsWith(KICKS)) { assert.strictEqual(p.label, 'kick', p.path); assert.strictEqual(p.source, 0); }
    if (p.path.startsWith(HATS)) { assert.strictEqual(p.label, 'hat', p.path); assert.strictEqual(p.source, 1); }
  }
  assert.strictEqual(ix.pointOf(path.join(HATS, 'broken.wav')), null, 'an unreadable file is not on the map');
});

test('refresh: a second pass analyzes nothing; a changed file is re-analyzed; a new one added', async () => {
  const ix = fresh();
  ix.setSources([KICKS, HATS]);
  await ix.refresh();
  analyzeCalls = [];
  let r = await ix.refresh();
  assert.strictEqual(r.analyzed, 0);
  assert.strictEqual(analyzeCalls.length, 0, 'not even the broken file is retried');

  const f = path.join(KICKS, 'kick00.wav');
  write(f, kick(80, 0));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  r = await ix.refresh();
  assert.strictEqual(r.analyzed, 1);

  write(path.join(KICKS, 'kick06.wav'), kick(50, 6));
  r = await ix.refresh();
  assert.strictEqual(r.analyzed, 1);
  assert.strictEqual(r.total, 15);
  fs.rmSync(path.join(KICKS, 'kick06.wav'));
  r = await ix.refresh();
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(r.total, 14);
});

test('neighbors, unique and reshuffle answer from feature space', async () => {
  const ix = fresh();
  ix.setSources([KICKS, HATS]);
  await ix.refresh();
  const k0 = path.join(KICKS, 'kick01.wav');
  const nn = ix.neighbors(k0, 3);
  assert.strictEqual(nn.length, 3);
  assert.ok(nn.every((n) => n.path.startsWith(KICKS)), `a kick's neighbors are kicks: ${nn.map((n) => path.basename(n.path))}`);
  assert.ok(nn[0].dist <= nn[1].dist);
  assert.deepStrictEqual(ix.neighbors(path.join(TMP, 'nowhere.wav')), [], 'unknown file has no neighbors');

  const u = ix.unique([k0]);
  assert.ok(u.startsWith(HATS), `farthest from a kick is a hat, got ${u}`);
  assert.ok(ix.unique([k0], { types: ['kick'] }).startsWith(KICKS), 'type filter honored');
  assert.ok(ix.unique([k0], { sources: [0] }).startsWith(KICKS), 'source filter honored');
  assert.strictEqual(ix.unique([k0], { types: ['nothing'] }), null);
  assert.ok(ix.unique([]) !== null, 'an empty kit still gets a first pick');
  const two = [k0, ix.unique([k0])];
  assert.ok(!two.includes(ix.unique(two)), 'kit members never come back');

  const kit = [k0, path.join(HATS, 'hat02.wav')];
  const shuffled = ix.reshuffle(kit, { rng: () => 0.5 });
  assert.strictEqual(shuffled.length, 2);
  assert.ok(shuffled[0].startsWith(KICKS) && shuffled[0] !== k0, 'the kick slot hopped to another kick');
  assert.ok(shuffled[1].startsWith(HATS) && shuffled[1] !== kit[1], 'the hat slot hopped to another hat');
  assert.deepStrictEqual(ix.reshuffle(['/no/such.wav']), ['/no/such.wav'], 'unknown slots keep their file');
});

test('unique: prefers a typical sound over the library\'s one oddity', async () => {
  const WEIRD = path.join(TMP, 'weird');
  const chirp = new Float32Array(SR);
  for (let i = 0; i < SR; i++) chirp[i] = Math.sin(2 * Math.PI * (200 + 7800 * (i / SR) ** 2) * (i / SR));
  write(path.join(WEIRD, 'chirp.wav'), chirp);
  const ix = fresh('weird.json');
  ix.setSources([KICKS, HATS, WEIRD]);
  await ix.refresh();
  const k0 = path.join(KICKS, 'kick01.wav');
  assert.ok(ix.unique([k0], { typical: false }).startsWith(WEIRD), 'raw farthest-point lands on the outlier');
  assert.ok(ix.unique([k0]).startsWith(HATS), 'the default answer is a hat');
});

test('sources: removing one drops its points but keeps its vectors; re-adding is free', async () => {
  const ix = fresh();
  ix.setSources([KICKS, HATS]);
  await ix.refresh();
  ix.setSources([HATS]);
  let r = await ix.refresh();
  assert.strictEqual(r.analyzed, 0);
  assert.ok(ix.snapshot().points.every((p) => p.path.startsWith(HATS)));
  assert.ok([...ix.entries.keys()].some((p) => p.startsWith(KICKS)), 'kick vectors kept');
  ix.setSources([HATS, KICKS]);
  r = await ix.refresh();
  assert.strictEqual(r.analyzed, 0, 'nothing re-analyzed');
  assert.strictEqual(ix.snapshot().points.length, 14);
  assert.strictEqual(ix.snapshot().points.find((p) => p.path.startsWith(KICKS)).source, 1, 'source index follows the new order');
});

test('sources: a parent folder added over a child keeps the child\'s vectors', async () => {
  const ix = fresh();
  ix.setSources([KICKS]);
  await ix.refresh();
  ix.setSources([path.join(TMP, 'lib')]);
  const r = await ix.refresh();
  assert.strictEqual(r.analyzed, 8, 'only the hats folder is new');
  assert.strictEqual(ix.snapshot().points.length, 14);
});

test('cache: a fresh instance loads the map without analyzing; an old feature version re-analyzes', async () => {
  const ix = fresh('roundtrip.json');
  ix.setSources([KICKS, HATS]);
  await ix.refresh();
  const before_ = ix.snapshot();

  const again = fresh('roundtrip.json');
  assert.strictEqual(again.load(), true);
  assert.deepStrictEqual(again.sources, [KICKS, HATS]);
  assert.deepStrictEqual(again.snapshot(), before_);
  assert.deepStrictEqual(again.neighbors(path.join(KICKS, 'kick01.wav'), 2), ix.neighbors(path.join(KICKS, 'kick01.wav'), 2));
  analyzeCalls = [];
  const r = await again.refresh();
  assert.strictEqual(r.analyzed, 0);

  for (const e of again.entries.values()) e.version = sm.FEATURE_VERSION - 1;
  const r2 = await again.refresh();
  assert.strictEqual(r2.analyzed, 14, 'every readable file re-analyzed under the new definition');

  assert.strictEqual(fresh('missing.json').load(), false);
});

test('refresh: concurrent calls share one run', async () => {
  const ix = fresh('shared.json');
  ix.setSources([KICKS]);
  const a = ix.refresh();
  const b = ix.refresh();
  assert.strictEqual(a, b);
  await a;
});
