'use strict';

// The /api/sampleMap routes over a fake index: what each one returns, what gets persisted, and
// which calls start a build.

const { test } = require('node:test');
const assert = require('node:assert');

const { createSampleMapApi } = require('./sample-map-api');

function fakeIndex() {
  const calls = [];
  const ix = {
    sources: [],
    status: { building: false, phase: 'idle', done: 0, total: 0, count: 2, error: null },
    map: { paths: ['/a/kick.wav', '/b/hat.wav'] },
    load() { calls.push(['load']); return true; },
    save() { calls.push(['save']); },
    setSources(s) { calls.push(['setSources', s]); ix.sources = s; },
    refresh(opts) { calls.push(['refresh', opts]); return Promise.resolve({ analyzed: 1, removed: 0, total: 2 }); },
    snapshot() { return { sources: ix.sources, clusterLabels: ['kick'], points: [{ path: '/a/kick.wav', x: 0, y: 0, label: 'kick', cluster: 0, seconds: 0.4, source: 0 }] }; },
    pointOf(p) { return p === '/a/kick.wav' ? { path: p, label: 'kick', cluster: 0, seconds: 0.4, source: '/a' } : null; },
    neighbors(p, k) { calls.push(['neighbors', p, k]); return [{ path: '/b/hat.wav', dist: 1.5, label: 'hat' }]; },
    unique(kit, opts) { calls.push(['unique', kit, opts]); return kit.length ? '/a/kick.wav' : null; },
    reshuffle(kit) { calls.push(['reshuffle', kit]); return kit.map(() => '/a/kick.wav'); },
  };
  return { ix, calls };
}

function api(settings = {}) {
  const { ix, calls } = fakeIndex();
  const saves = [];
  const logs = [];
  const a = createSampleMapApi({ settings, saveSettings: () => saves.push({ ...settings }), index: ix, log: (m) => logs.push(m) });
  return { ...a, ix, calls, saves, logs, settings };
}

test('start: loads the cache, applies the saved sources, refreshes in the background', async () => {
  const a = api({ mapSources: ['/a', '/b'] });
  const p = a.start();
  assert.deepStrictEqual(a.calls.slice(0, 2), [['load'], ['setSources', ['/a', '/b']]]);
  assert.deepStrictEqual(a.calls[2], ['refresh', { force: false }]);
  await p;
  assert.match(a.logs[0], /2 samples \(1 analyzed/);
});

test('start: with no saved sources nothing is analyzed', () => {
  const a = api({});
  assert.strictEqual(a.start(), null);
  assert.ok(!a.calls.some((c) => c[0] === 'refresh'));
});

test('GET /api/sampleMap returns the snapshot plus status', async () => {
  const a = api({ mapSources: ['/a'] });
  a.ix.sources = ['/a'];
  const { status, body } = await a.routes['GET /api/sampleMap']({});
  assert.strictEqual(status, 200);
  assert.strictEqual(body.points.length, 1);
  assert.deepStrictEqual(body.status.sources, ['/a']);
  assert.strictEqual(body.status.count, 2);
});

test('POST /api/sampleMap/sources persists, applies and rebuilds; empty clears the map', async () => {
  const a = api({});
  let r = await a.routes['POST /api/sampleMap/sources']({ sources: [' /x ', '', '/y'] });
  assert.deepStrictEqual(a.settings.mapSources, ['/x', '/y']);
  assert.strictEqual(a.saves.length, 1);
  assert.deepStrictEqual(a.calls.filter((c) => c[0] === 'setSources').pop(), ['setSources', ['/x', '/y']]);
  assert.ok(a.calls.some((c) => c[0] === 'refresh'));
  assert.deepStrictEqual(r.body.sources, ['/x', '/y']);

  const before = a.calls.filter((c) => c[0] === 'refresh').length;
  r = await a.routes['POST /api/sampleMap/sources']({ sources: [] });
  assert.deepStrictEqual(a.settings.mapSources, []);
  assert.strictEqual(a.ix.map, null, 'no sources, no map');
  assert.strictEqual(a.calls.filter((c) => c[0] === 'refresh').length, before, 'nothing to build');
  assert.ok(a.calls.some((c) => c[0] === 'save'));
  assert.strictEqual(r.body.count, 0);
});

test('GET /api/sampleMap/sources suggests the samples root without including it', async () => {
  const a = api({});
  const { body } = await a.routes['GET /api/sampleMap/sources']({});
  assert.deepStrictEqual(body.sources, []);
  assert.ok(typeof body.suggested === 'string' && body.suggested.length > 0);
});

test('POST /api/sampleMap/rebuild passes force through', async () => {
  const a = api({ mapSources: ['/a'] });
  await a.routes['POST /api/sampleMap/rebuild']({ force: true });
  assert.deepStrictEqual(a.calls.pop(), ['refresh', { force: true }]);
  await a.routes['POST /api/sampleMap/rebuild']({});
  assert.deepStrictEqual(a.calls.pop(), ['refresh', { force: false }]);
});

test('neighbors and point routes say when a file is not indexed', async () => {
  const a = api({});
  let r = await a.routes['GET /api/sampleMap/neighbors']({ path: '/a/kick.wav', k: '3' });
  assert.strictEqual(r.body.indexed, true);
  assert.strictEqual(r.body.point.label, 'kick');
  assert.deepStrictEqual(r.body.neighbors, [{ path: '/b/hat.wav', dist: 1.5, label: 'hat' }]);
  assert.deepStrictEqual(a.calls.pop(), ['neighbors', '/a/kick.wav', 3]);

  r = await a.routes['GET /api/sampleMap/neighbors']({ path: '/nope.wav' });
  assert.deepStrictEqual(r.body, { indexed: false, point: null, neighbors: [] });
  assert.ok(a.calls.every((c) => c[0] !== 'neighbors' || c[1] !== '/nope.wav'), 'no lookup for an unknown file');

  r = await a.routes['GET /api/sampleMap/neighbors']({ path: '/a/kick.wav', k: '999' });
  assert.strictEqual(a.calls.pop()[2], 50, 'k is capped');

  r = await a.routes['GET /api/sampleMap/point']({ path: '/nope.wav' });
  assert.deepStrictEqual(r.body, { point: null });
});

test('unique and reshuffle forward the kit and filters', async () => {
  const a = api({});
  let r = await a.routes['POST /api/sampleMap/unique']({ kit: ['/b/hat.wav'], types: ['kick'], sources: ['0'], exclude: ['/c.wav'], typical: false });
  assert.deepStrictEqual(a.calls.pop(), ['unique', ['/b/hat.wav'], { types: ['kick'], sources: [0], exclude: ['/c.wav'], typical: false }]);
  assert.strictEqual(r.body.path, '/a/kick.wav');
  assert.strictEqual(r.body.point.label, 'kick');

  r = await a.routes['POST /api/sampleMap/unique']({ kit: [] });
  assert.deepStrictEqual(a.calls.pop(), ['unique', [], {}]);
  assert.deepStrictEqual(r.body, { path: null, point: null });

  r = await a.routes['POST /api/sampleMap/reshuffle']({ kit: ['/b/hat.wav', '/z.wav'] });
  assert.deepStrictEqual(a.calls.pop(), ['reshuffle', ['/b/hat.wav', '/z.wav']]);
  assert.deepStrictEqual(r.body.kit, ['/a/kick.wav', '/a/kick.wav']);
  assert.strictEqual(r.body.points[0].label, 'kick');
});
