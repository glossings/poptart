// samples("user/repo"): a repository read into packs, against a stand-in for GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './public/web/kv.mjs';
import {
  parseSource, packsFromTree, packsFromStrudelJson, resolveBase, noteNameToMidi, sourcesIn,
  readSource, createRemotePacks, LISTING_TTL_MS,
} from './public/web/remote-packs.mjs';

const SHA = 'a'.repeat(40);

/** A repository as GitHub's API and raw host would serve it: path -> contents (object = JSON). */
function fakeGitHub(files, { owner = 'someone', repo = 'kit' } = {}) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, statusText: '', json: async () => body });
  const fetchImpl = async (url) => {
    calls.push(url);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    if (url.startsWith(`${api}/commits/`)) return json({ sha: SHA, commit: { tree: { sha: 'tree1' } } });
    if (url.startsWith(`${api}/git/trees/tree1`)) {
      return json({ tree: Object.keys(files).map((path) => ({ path, type: 'blob' })), truncated: false });
    }
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${SHA}/`;
    if (url.startsWith(raw)) {
      const path = decodeURIComponent(url.slice(raw.length));
      if (path in files) return json(files[path]);
    }
    return json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, calls };
}

test('the ways of naming a repository', () => {
  const gh = (owner, repo, ref = null, path = '') => ({ kind: 'github', owner, repo, ref, path });
  assert.deepEqual(parseSource('someone/kit'), gh('someone', 'kit'));
  assert.deepEqual(parseSource('github:someone/kit'), gh('someone', 'kit'));
  assert.deepEqual(parseSource('someone/kit@v2'), gh('someone', 'kit', 'v2'));
  assert.deepEqual(parseSource('someone/kit/drums/808'), gh('someone', 'kit', null, 'drums/808'));
  assert.deepEqual(parseSource('someone/kit@dev/drums'), gh('someone', 'kit', 'dev', 'drums'));
  assert.deepEqual(parseSource('someone/kit/drums@dev'), gh('someone', 'kit', 'dev', 'drums'));
  assert.deepEqual(parseSource('https://github.com/someone/kit'), gh('someone', 'kit'));
  assert.deepEqual(parseSource('https://github.com/someone/kit.git'), gh('someone', 'kit'));
  assert.deepEqual(parseSource('https://github.com/someone/kit/tree/main/drums'), gh('someone', 'kit', 'main', 'drums'));
  assert.deepEqual(parseSource('https://example.com/packs/strudel.json'), { kind: 'json', url: 'https://example.com/packs/strudel.json' });
  for (const bad of ['', 'kit', 'someone/kit/../x', 'ftp://x/y', 'some one/kit']) assert.equal(parseSource(bad), null, bad);
});

test('folders become packs, named by the shortest path tail that is theirs alone', () => {
  const packs = packsFromTree([
    'README.md',
    'one-shot.wav',
    '808/Kicks/kick10.wav', '808/Kicks/kick2.wav', '808/Snare Drums/sd1.wav',
    '909/Kicks/k.wav',
    'loops/break.flac',
    '.hidden/x.wav', '__MACOSX/loops/._break.flac',
  ], { rootName: 'Kit' });
  assert.deepEqual(packs, [
    { name: '808_kicks', files: ['808/Kicks/kick2.wav', '808/Kicks/kick10.wav'] },
    { name: '909_kicks', files: ['909/Kicks/k.wav'] },
    { name: 'kit', files: ['one-shot.wav'] },
    { name: 'loops', files: ['loops/break.flac'] },
    { name: 'snare_drums', files: ['808/Snare Drums/sd1.wav'] },
  ]);
});

test('a folder keeps only what is under it, named relative to it', () => {
  const packs = packsFromTree(['drums/bd/1.wav', 'drums/2.wav', 'keys/p.wav'], { under: 'drums', rootName: 'drums' });
  assert.deepEqual(packs, [{ name: 'bd', files: ['drums/bd/1.wav'] }, { name: 'drums', files: ['drums/2.wav'] }]);
});

test('a strudel.json is read as written: lists, single files, pitched maps', () => {
  const { base, packs } = packsFromStrudelJson({
    _base: 'https://example.com/s/',
    bd: ['bd/1.wav', 'bd/2.wav'],
    stab: 'stab.wav',
    Piano: { c4: 'p/c4.mp3', a2: 'p/a2.mp3', 'f#3': 'p/fs3.mp3' },
  }, 'https://example.com/strudel.json');
  assert.equal(base, 'https://example.com/s/');
  assert.deepEqual(packs, [
    { name: 'bd', files: [{ file: 'bd/1.wav', rootNote: null }, { file: 'bd/2.wav', rootNote: null }] },
    { name: 'stab', files: [{ file: 'stab.wav', rootNote: null }] },
    { name: 'piano', files: [{ file: 'p/a2.mp3', rootNote: 45 }, { file: 'p/fs3.mp3', rootNote: 54 }, { file: 'p/c4.mp3', rootNote: 60 }] },
  ]);
  assert.equal(noteNameToMidi('cs4'), 61);
  assert.equal(noteNameToMidi('eb2'), 39);
  assert.equal(noteNameToMidi('h2'), null);
});

test('a strudel.json base: github: resolved, the same repository pinned to the commit, http refused', () => {
  assert.equal(resolveBase('github:someone/kit/main/samples'), 'https://raw.githubusercontent.com/someone/kit/main/samples/');
  assert.equal(
    resolveBase('https://raw.githubusercontent.com/someone/kit/main/', { owner: 'someone', repo: 'kit', sha: SHA }),
    `https://raw.githubusercontent.com/someone/kit/${SHA}/`,
  );
  assert.equal(resolveBase('https://raw.githubusercontent.com/other/kit/main/', { owner: 'someone', repo: 'kit', sha: SHA }), 'https://raw.githubusercontent.com/other/kit/main/');
  assert.throws(() => resolveBase('/relative/'), /not a web address/);
});

test('samples() calls are found in code, not in comments or strings', () => {
  const code = [
    'samples("someone/kit")',
    "samples( 'other/kit@v1' )",
    '// samples("commented/out")',
    '/* samples("block/comment") */',
    'const s = "samples(\\"in/a/string\\")"',
    'x.samples("a/method")',
    'mysamples("not/this")',
    'samples(`tpl/repo`)',
  ].join('\n');
  assert.deepEqual(sourcesIn(code), [{ source: 'someone/kit', prefix: null }, { source: 'other/kit@v1', prefix: null }, { source: 'tpl/repo', prefix: null }]);
});

test('a repository without a strudel.json is read by folder, pinned to its commit', async () => {
  const { fetchImpl } = fakeGitHub({ 'bd/a b.wav': '', 'bd/b.wav': '', 'notes.txt': '' });
  const listing = await readSource(parseSource('someone/kit'), { fetchImpl });
  assert.equal(listing.sha, SHA);
  assert.deepEqual(listing.packs, [{
    name: 'bd',
    base: `https://raw.githubusercontent.com/someone/kit/${SHA}/`,
    files: [{ file: 'bd/a b.wav', rootNote: null }, { file: 'bd/b.wav', rootNote: null }],
  }]);
  const [manifest] = (await import('./public/web/remote-packs.mjs')).manifestsOf(listing, { title: 't' });
  assert.equal(manifest.files[0].name, 'a b');
});

test('a file is fetched by its name, whatever characters are in it', async () => {
  const { r } = remote({ files: { 'bd/100% kick #1.wav': '' } });
  await r.prepare('samples("someone/kit")');
  const { manifest, urlFor } = r.packs()[0];
  assert.equal(manifest.files[0].name, '100% kick #1');
  assert.equal(urlFor('bd', manifest.files[0].file), `https://raw.githubusercontent.com/someone/kit/${SHA}/bd/100%25%20kick%20%231.wav`);
});

test('a repository with a strudel.json is read from it', async () => {
  const { fetchImpl } = fakeGitHub({
    'strudel.json': { _base: 'https://raw.githubusercontent.com/someone/kit/main/', hh: ['h/1.wav'] },
    'h/1.wav': '',
    'other/2.wav': '',
  });
  const listing = await readSource(parseSource('someone/kit'), { fetchImpl });
  assert.deepEqual(listing.packs, [{ name: 'hh', base: `https://raw.githubusercontent.com/someone/kit/${SHA}/`, files: [{ file: 'h/1.wav', rootNote: null }] }]);
});

function remote({ files, store = memoryStore(), now = () => 0 }) {
  const gh = fakeGitHub(files);
  const registered = [];
  const forgotten = [];
  const lines = [];
  const samples = { register: (list) => registered.push(...list.map((m) => m.id)), forget: (id) => forgotten.push(id) };
  const r = createRemotePacks({ fetchImpl: gh.fetchImpl, store, samples, warn: (l) => lines.push(l), say: (l) => lines.push(l), now });
  return { r, gh, registered, forgotten, lines, store };
}

test('prepare reads each source once, registers its packs, and lists them for the host', async () => {
  const { r, gh, registered } = remote({ files: { 'bd/1.wav': '', 'sd/1.wav': '' } });
  await r.prepare('samples("someone/kit")\nkick: s("bd")');
  await r.prepare('samples("someone/kit")\nkick: s("bd sd")');
  assert.deepEqual(registered, ['bd', 'sd']);
  assert.equal(gh.calls.length, 2, 'the commit and the tree, once');
  assert.deepEqual(r.packs().map((p) => p.manifest.id), ['bd', 'sd']);
  const { manifest, urlFor } = r.packs()[0];
  assert.equal(urlFor('bd', manifest.files[0].file), `https://raw.githubusercontent.com/someone/kit/${SHA}/bd/1.wav`);
  assert.equal(manifest.cachePrefix, `remote/https://raw.githubusercontent.com/someone/kit/${SHA}/`);
});

test('a listing is kept: reused within the hour, and when GitHub refuses', async () => {
  const store = memoryStore();
  let t = 0;
  const first = remote({ files: { 'bd/1.wav': '' }, store, now: () => t });
  await first.r.prepare('samples("someone/kit")');
  const again = remote({ files: { 'bd/1.wav': '' }, store, now: () => t });
  await again.r.prepare('samples("someone/kit")');
  assert.equal(again.gh.calls.length, 0, 'a fresh page reuses the kept listing');
  t = LISTING_TTL_MS + 1;
  const stale = remote({ files: {}, store, now: () => t });
  stale.gh.fetchImpl = null;
  const refusing = createRemotePacks({
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    store,
    samples: { register() {} },
    warn: (l) => stale.lines.push(l),
    now: () => t,
  });
  await refusing.prepare('samples("someone/kit")');
  assert.deepEqual(refusing.packs().map((p) => p.manifest.id), ['bd']);
  assert.ok(stale.lines.some((l) => /refusing more requests.*using the list of files read earlier/.test(l)));
});

test('a folder named like one of poptart\'s own packs is renamed, not allowed to shadow it', async () => {
  const { r } = remote({ files: { 'pt_kit/1.wav': '', 'files/2.wav': '' } });
  await r.prepare('samples("someone/kit")');
  assert.deepEqual(r.packs().map((p) => p.manifest.id).sort(), ['kit_files', 'kit_pt_kit']);
});

test('what is not a repository, or has no audio, is one line and no packs', async () => {
  const { r, lines } = remote({ files: { 'README.md': '' } });
  await r.prepare('samples("nope")\nsamples("someone/kit")');
  assert.deepEqual(r.packs(), []);
  assert.ok(lines.some((l) => /"nope" is not a repository/.test(l)));
  assert.ok(lines.some((l) => /no audio files/.test(l)));
});

test('a prefix goes in front of every pack name, so two repositories can both have a "bd"', async () => {
  const { sourcesIn: find } = await import('./public/web/remote-packs.mjs');
  assert.deepEqual(find('samples("someone/kit", "dirt")'), [{ source: 'someone/kit', prefix: 'dirt' }]);
  const { r, registered } = remote({ files: { 'bd/1.wav': '', 'sn/1.wav': '' } });
  await r.prepare('samples("someone/kit", "dirt")');
  assert.deepEqual(registered, ['dirt_bd', 'dirt_sn']);
});

test('a collision is said once per source, with the prefix that keeps both as its fix', async () => {
  const notes = [];
  const gh = fakeGitHub({ 'bd/1.wav': '' });
  const r = createRemotePacks({ fetchImpl: gh.fetchImpl, store: memoryStore(), samples: { register() {}, forget() {} }, note: (m) => notes.push(m) });
  // the same repository read twice under different spellings of one source would not collide, so
  // two sources: the plain one and one with a folder that holds the same pack name
  await r.prepare('samples("someone/kit")');
  await r.prepare('samples("someone/kit@v2")');
  const clash = notes.find((m) => m.fix);
  assert.ok(clash, JSON.stringify(notes));
  assert.match(clash.text, /bd from someone\/kit replaces the one from someone\/kit/);
  assert.deepEqual(clash.fix, { kind: 'samples-prefix', label: 'prefix them', source: 'someone/kit@v2', prefix: 'kit' });
  assert.equal(clash.level, 'warn');
});

test('a file named by where it lives comes back as the base samples() caches it under', async () => {
  const { originOf, parseOrigin, suggestPrefix } = await import('./public/web/remote-packs.mjs');
  const base = `https://raw.githubusercontent.com/tidalcycles/dirt-samples/${SHA}/`;
  const origin = originOf(base, 'bd/BT0A0A7.wav');
  assert.equal(origin, `github:tidalcycles/dirt-samples@${SHA}/bd/BT0A0A7.wav`);
  assert.deepEqual(parseOrigin(origin), { base, file: 'bd/BT0A0A7.wav' });
  assert.equal(parseOrigin('bd/BT0A0A7.wav'), null, 'a pack/file entry is not an origin');
  assert.equal(suggestPrefix('tidalcycles/dirt-samples'), 'dirt');
});

test('each repository kept here is listed with the call that reads it and where its files are', async () => {
  const { r, store } = remote({ files: { 'bd/1.wav': '' } });
  await r.prepare('samples("someone/kit@main")');
  const kept = await r.kept();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, 'someone/kit@main', 'as it was written');
  assert.deepEqual(kept[0].bases, [`https://raw.githubusercontent.com/someone/kit/${SHA}/`]);
  await r.forgetListing(kept[0].key);
  assert.deepEqual(await r.kept(), []);
  assert.deepEqual(await store.keys('remote/listing/'), []);
});

test('a shared name belongs to the later line, however the downloads finish, and re-evaluating is quiet', async () => {
  const slow = fakeGitHub({ 'bd/1.wav': '' }, { owner: 'someone', repo: 'kit' });
  const fast = fakeGitHub({ 'bd/2.wav': '' }, { owner: 'other', repo: 'kit' });
  const fetchImpl = async (url) => {
    if (url.includes('/other/')) return fast.fetchImpl(url);
    await new Promise((r) => setTimeout(r, 30)); // the first line's source answers last
    return slow.fetchImpl(url);
  };
  const notes = [];
  const registered = [];
  const r = createRemotePacks({
    fetchImpl,
    store: memoryStore(),
    samples: { register: (list) => registered.push(...list.map((m) => `${m.id}<${m.description}`)), forget() {} },
    note: (m) => notes.push(m),
  });
  const code = 'samples("someone/kit")\nsamples("other/kit")';
  await r.prepare(code);
  assert.equal(r.packs().find((p) => p.manifest.id === 'bd').manifest.description, 'other/kit', 'the later line');
  const said = notes.filter((m) => m.fix).length;
  const before = registered.length;
  await r.prepare(code);
  assert.equal(registered.length, before, 'nothing is registered again');
  assert.equal(notes.filter((m) => m.fix).length, said, 'and the collision is not said again');
});
