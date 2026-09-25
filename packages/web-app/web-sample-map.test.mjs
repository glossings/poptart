// The sample map in the browser build: the desktop's maths over every pack the page knows.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from '../osc-engine/sample-map-core.mjs';
import { createWebSampleMap, monoHead, splitPoint, ROOT } from './public/web/sample-map.mjs';
import { memoryStore } from './public/web/kv.mjs';

const SR = 22050;

/** A decoded file: a decaying sine (a "kick") or decaying noise (a "hat"), each a little different. */
function sound(kind, n) {
  const len = Math.round(SR * (kind === 'kick' ? 0.5 : 0.15));
  const data = new Float32Array(len);
  let seed = 7 + n;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    data[i] = kind === 'kick'
      ? Math.sin(2 * Math.PI * (50 + n * 3) * t) * Math.exp(-t * (8 + n))
      : noise() * Math.exp(-t * (40 + n * 2));
  }
  return { sampleRate: SR, length: len, numberOfChannels: 1, getChannelData: () => data };
}

const PACKS = [
  { id: 'kicks', description: 'test', files: Array.from({ length: 6 }, (_, i) => ({ file: `kick${i}.wav` })) },
  { id: 'hats', description: 'test', files: Array.from({ length: 6 }, (_, i) => ({ file: `Closed/hat${i}.wav` })) },
  { id: 'wt', files: [{ file: 'saw.wav' }] },
];

function rig({ store = memoryStore(), packs = PACKS, unreadable = new Set() } = {}) {
  const analyzed = [];
  const map = createWebSampleMap({
    core,
    store,
    packs: () => packs,
    bytesOf: async (pack, index) => (unreadable.has(`${pack}:${index}`) ? null : { slice: () => ({ pack, index }) }),
    decode: async ({ pack, index }) => sound(pack === 'kicks' ? 'kick' : 'hat', index),
    analyze: async (heads) => { analyzed.push(heads.length); return heads.map((h) => (h ? { features: core.extractFeatures(h.samples, h.sampleRate, h.totalSeconds), seconds: h.totalSeconds } : null)); },
    derive: async (vectors, paths, opts) => core.deriveMap(vectors, paths, opts),
  });
  return { map, analyzed, store };
}

test('a point is named as the pack panel names a file, and either spelling finds it', () => {
  assert.deepEqual(splitPoint(`${ROOT}/hats/Closed/hat1.wav`), { pack: 'hats', file: 'Closed/hat1.wav' });
  assert.deepEqual(splitPoint('hats/Closed/hat1.wav'), { pack: 'hats', file: 'Closed/hat1.wav' });
  assert.equal(splitPoint('/Users/someone/x.wav'), null);
  const head = monoHead({ sampleRate: 10, length: 100, numberOfChannels: 2, getChannelData: (c) => new Float32Array(100).fill(c ? 1 : 0) }, 4);
  assert.equal(head.samples.length, 40);
  assert.equal(head.samples[0], 0.5, 'the channels averaged');
  assert.equal(head.totalSeconds, 10, 'the whole length, though only the head is read');
});

test('every pack is on the map by default, and like sits near like', async () => {
  const { map } = rig();
  assert.deepEqual(map.sources(), [ROOT]);
  await map.refresh();
  const snap = map.snapshot();
  assert.equal(snap.points.length, 12, 'the wavetable folder is not a kit\'s worth of sounds');
  assert.ok(snap.points.every((p) => p.path.startsWith(`${ROOT}/`)));
  const near = map.neighbors('kicks/kick0.wav', 5).map((n) => splitPoint(n.path).pack);
  assert.deepEqual(near, ['kicks', 'kicks', 'kicks', 'kicks', 'kicks'], `a kick's neighbors are kicks (${near})`);
  assert.equal(map.pointOf(`${ROOT}/hats/Closed/hat2.wav`).label, 'hat', 'labeled from its name');
  const far = map.unique(['kicks/kick0.wav'], { typical: false });
  assert.equal(splitPoint(far).pack, 'hats', 'the most different sound from a kick is a hat');
  const shuffled = map.reshuffle(['kicks/kick0.wav', 'hats/Closed/hat0.wav'], { rng: () => 0 });
  assert.equal(splitPoint(shuffled[0]).pack, 'kicks');
  assert.notEqual(shuffled[0], `${ROOT}/kicks/kick0.wav`);
});

test('a map is kept: a fresh page reads it back and analyzes nothing', async () => {
  const store = memoryStore();
  await rig({ store }).map.refresh();
  const again = rig({ store });
  const status = await again.map.ensure();
  assert.equal(status.building, false, 'nothing is behind, so nothing is built');
  assert.equal(again.map.snapshot().points.length, 12);
  assert.deepEqual(again.analyzed, []);
});

test('the sources narrow the map, and only what is under the root is taken', async () => {
  const { map } = rig();
  await map.setSources([`${ROOT}/hats/`, '/Users/someone/Samples', `${ROOT}/hats`]);
  assert.deepEqual(map.sources(), [`${ROOT}/hats`]);
  await map.refresh();
  assert.ok(map.snapshot().points.every((p) => p.path.startsWith(`${ROOT}/hats/`)));
  await map.setSources([]);
  assert.deepEqual(map.snapshot().points, []);
});

test('a file that cannot be read is tried again next time, not remembered as bad', async () => {
  const store = memoryStore();
  const first = rig({ store, unreadable: new Set(['kicks:3']) });
  await first.map.refresh();
  assert.equal(first.map.pointOf('kicks/kick3.wav'), null);
  const later = rig({ store });
  await later.map.ensure();
  await later.map.refresh();
  assert.ok(later.map.pointOf('kicks/kick3.wav'), 'read the second time');
  assert.deepEqual(later.analyzed, [1], 'and only it');
});

test('a build stops asking a server that has stopped answering, and builds from what it read', async () => {
  const many = { id: 'lib', description: 'cdn', files: Array.from({ length: 40 }, (_, i) => ({ file: `hit${i}.wav` })) };
  const asked = [];
  const map = createWebSampleMap({
    core,
    packs: () => [PACKS[0], many],
    bytesOf: async (pack, index) => { asked.push(`${pack}:${index}`); return pack === 'lib' ? null : { slice: () => ({ pack, index }) }; },
    decode: async ({ index }) => sound('kick', index),
  });
  await map.refresh();
  assert.equal(asked.filter((a) => a.startsWith('lib')).length, 8, 'eight refusals in a row, then no more asking');
  assert.equal(map.snapshot().points.length, 6, 'the kicks that did read are on the map');
  assert.equal(map.status().unread, 40, 'and the rest are counted for the next build');
});

test('a repository\'s pack is placed by where its files live, so a same-named pack stays apart', async () => {
  const sha = 'b'.repeat(40);
  const base = `https://raw.githubusercontent.com/someone/kit/${sha}/`;
  const local = { id: 'kicks', description: 'my folder', files: Array.from({ length: 3 }, (_, i) => ({ file: `kick${i}.wav` })) };
  const remote = { id: 'kicks', description: 'someone/kit', cachePrefix: `remote/${base}`, base, files: Array.from({ length: 3 }, (_, i) => ({ file: `kick${i}.wav` })) };
  const { map } = rig({ packs: [local, remote] });
  await map.refresh();
  const paths = map.snapshot().points.map((p) => p.path).sort();
  assert.equal(paths.length, 6, 'two packs called kicks are six sounds, not three');
  assert.ok(paths.includes(`${ROOT}/kicks/kick0.wav`));
  assert.ok(paths.includes(`${ROOT}/github:someone/kit@${sha}/kick0.wav`), paths.join('\n'));
  // ...and a point added to a kit is found again by the same name.
  assert.ok(map.pointOf(`github:someone/kit@${sha}/kick1.wav`));
});
