// samples("user/repo"): sample packs from a public GitHub repository.
//
// Pointing at a repository is the whole job. The repository is listed once, and its audio files
// become packs by folder, the way a samples folder on the desktop does: `kicks/808.wav` and
// `kicks/909.wav` are s("kicks:0") and s("kicks:1"), in name order, with numbers compared as
// numbers so "kick2" comes before "kick10". Files at the top of the repository are a pack named
// after the repository. Two folders that would take the same name (`808/kicks`, `909/kicks`) are
// told apart by as much of their path as it takes: `808_kicks`, `909_kicks`.
//
// A repository that already describes its packs in a `strudel.json` at its top is read that way
// instead - its names, its files, its base URL - because somebody wrote that file to say exactly
// what their packs are.
//
// What can follow the name:
//   samples("user/repo")                  the default branch, as it is now
//   samples("user/repo@v2")               a branch, tag or commit
//   samples("user/repo/drums/808")        only what is under that folder
//   samples("github:user/repo"), samples("https://github.com/user/repo/tree/main/drums")
// and a URL ending in .json is read as a strudel.json wherever it is served from.
//
// Pinned to the commit it resolved to. Every file is fetched by commit, never by branch, so a
// pack cannot change underneath a song halfway through loading, and a file once downloaded is
// kept for good (samples.mjs caches the bytes; a commit's files never change). The listing is
// two requests to GitHub's API, which allows sixty an hour to a visitor who is not signed in, so
// it is kept too: reused for LISTING_TTL_MS for a branch, and for ever for a commit id. When the
// API refuses, a listing kept from before is used however old it is.

export const LISTING_TTL_MS = 30 * 60 * 1000;
export const MAX_FILES = 5000;

/** The file types a pack is made of. */
export const AUDIO = /\.(wav|wave|aif|aiff|flac|mp3|ogg|oga|opus|m4a)$/i;
const SHA = /^[0-9a-f]{40}$/i;
/** Pack names poptart's own packs have, which a folder read in from somewhere else may not take. */
export const RESERVED = new Set(['files', 'wt', 'rec']);
export const isReservedPack = (id) => RESERVED.has(id) || id.startsWith('pt_');

/**
 * What a samples() argument points at, or null when it is not something this can read:
 * { kind: 'github', owner, repo, ref, path } or { kind: 'json', url }.
 */
export function parseSource(text) {
  const raw = String(text ?? '').trim();
  if (/^https?:\/\/\S+\.json(\?\S*)?$/i.test(raw) && !/^https?:\/\/(www\.)?github\.com\//i.test(raw)) {
    return { kind: 'json', url: raw.replace(/^http:/i, 'https:') };
  }
  let rest = raw.replace(/^github:/i, '');
  const web = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/\s]+)(?:\/([^\s#?]*))?)?\/?$/i.exec(raw);
  if (web) {
    const [, owner, repo, ref, sub] = web;
    return clean({ owner, repo: repo.replace(/\.git$/i, ''), ref: ref ?? null, path: sub ?? '' });
  }
  if (/^[a-z]+:/i.test(rest)) return null;
  // owner/repo[@ref][/path…] - the ref may also come after the path, as it reads naturally.
  let ref = null;
  const at = /@([^/\s]+)/.exec(rest);
  if (at) {
    ref = at[1];
    rest = rest.slice(0, at.index) + rest.slice(at.index + at[0].length);
  }
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...sub] = parts;
  return clean({ owner, repo, ref, path: sub.join('/') });
}

function clean({ owner, repo, ref, path }) {
  const name = /^[A-Za-z0-9_.-]+$/;
  if (!name.test(owner) || !name.test(repo)) return null;
  if (ref !== null && !/^[A-Za-z0-9_.\-/]+$/.test(ref)) return null;
  const segments = String(path).split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return { kind: 'github', owner, repo, ref, path: segments.join('/') };
}

/** One name for a source, whichever way it was written - what listings are kept under. */
export function sourceKey(src) {
  if (src.kind === 'json') return `json:${src.url}`;
  return `github:${src.owner}/${src.repo}@${src.ref ?? ''}/${src.path}`.toLowerCase();
}

/** A listing key back as something samples() takes, for a listing kept before it kept its source. */
function sourceText(key) {
  if (key.startsWith('json:')) return key.slice(5);
  const m = /^github:([^/]+)\/([^@]+)@([^/]*)\/(.*)$/.exec(key);
  if (!m) return key;
  return `${m[1]}/${m[2]}${m[4] ? `/${m[4]}` : ''}${m[3] ? `@${m[3]}` : ''}`;
}

/** A folder or key as a pack name: lower case, and only what mini-notation reads as one word. */
export function packName(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'samples';
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Scientific pitch, c4 = 60 - how a strudel.json names the note a sample was recorded at. */
export function noteNameToMidi(name) {
  const m = /^([a-g])(#|s|b|f)?(-?\d+)$/i.exec(String(name).trim());
  if (!m) return null;
  const pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const acc = m[2] === '#' || m[2]?.toLowerCase() === 's' ? 1 : m[2] ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + pc + acc;
  return midi >= 0 && midi <= 127 ? midi : null;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * A repository's files, by folder, as packs: [{ name, files: [path…] }], paths relative to the
 * repository. `under` keeps only what is below that folder, and names relative to it; `rootName`
 * names the files that sit directly in it.
 */
export function packsFromTree(paths, { under = '', rootName }) {
  const prefix = under ? `${under.replace(/\/+$/, '')}/` : '';
  const byDir = new Map();
  for (const p of paths) {
    if (!AUDIO.test(p) || (prefix && !p.startsWith(prefix))) continue;
    const rel = p.slice(prefix.length);
    const segs = rel.split('/');
    if (segs.some((s) => s.startsWith('.') || s === '__MACOSX')) continue;
    const dir = segs.slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(p);
  }
  // Each folder takes the shortest tail of its path that no other folder shares.
  const dirs = [...byDir.keys()];
  const tails = (dir) => {
    const segs = dir ? dir.split('/') : [];
    return segs.length ? segs.map((_, i) => packName(segs.slice(segs.length - 1 - i).join('_'))) : [packName(rootName)];
  };
  const names = new Map();
  for (const dir of dirs) {
    const mine = tails(dir);
    const clash = (name) => dirs.some((other) => other !== dir && tails(other).includes(name));
    names.set(dir, mine.find((n) => !clash(n)) ?? packName(dir || rootName));
  }
  return dirs
    .map((dir) => ({ name: names.get(dir), files: byDir.get(dir).sort(natural.compare) }))
    .sort((a, b) => natural.compare(a.name, b.name));
}

/**
 * A strudel.json's packs: [{ name, files: [{ file, rootNote }] }], each file as written (relative
 * to the base, or a URL of its own), and the base the relative ones hang off.
 */
export function packsFromStrudelJson(data, jsonUrl) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the strudel.json is not an object of packs');
  const base = typeof data._base === 'string' && data._base ? data._base : jsonUrl.replace(/[^/]*$/, '');
  const packs = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue;
    let files = [];
    if (typeof value === 'string') files = [{ file: value, rootNote: null }];
    else if (Array.isArray(value)) files = value.filter((v) => typeof v === 'string').map((file) => ({ file, rootNote: null }));
    else if (value && typeof value === 'object') {
      // A pitched set: note name -> the file recorded at that note, lowest first.
      files = Object.entries(value)
        .filter(([, v]) => typeof v === 'string')
        .map(([note, file]) => ({ file, rootNote: noteNameToMidi(note) }))
        .sort((a, b) => (a.rootNote ?? 0) - (b.rootNote ?? 0));
    }
    if (files.length) packs.push({ name: packName(key), files });
  }
  return { base, packs };
}

/** A strudel.json's base, as an https URL - a `github:` one resolved, a branch pinned to `sha`. */
export function resolveBase(base, { owner, repo, sha } = {}) {
  let url = String(base);
  const gh = /^github:([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(url);
  if (gh) {
    const [, o, r, rest = ''] = gh;
    const segs = rest.split('/').filter(Boolean);
    const ref = segs.length ? segs.shift() : 'HEAD';
    url = `https://raw.githubusercontent.com/${o}/${r}/${ref}/${segs.join('/')}`;
  }
  url = url.replace(/^http:/i, 'https:');
  if (!/^https:\/\//i.test(url)) throw new Error(`the strudel.json's _base is not a web address (${base})`);
  if (!url.endsWith('/')) url += '/';
  // The same repository by branch: by commit instead, so the files are the listing's files.
  if (owner && sha) {
    const same = new RegExp(`^https://raw\\.githubusercontent\\.com/${owner}/${repo}/[^/]+/`, 'i');
    url = url.replace(same, `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/`);
  }
  return url;
}

// ---- reading a source ---------------------------------------------------------------------------

async function getJson(fetchImpl, url, what) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Error(`could not reach ${what} (${err?.message ?? err})`);
  }
  if (res.status === 404) throw new Error(`${what} was not found`);
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub is refusing more requests from this address for now (it allows 60 an hour without signing in) - try again later`);
  }
  if (!res.ok) throw new Error(`${what} answered ${res.status}`);
  return res.json();
}

/**
 * Reads one source into a listing: { key, sha, packs: [{ name, base, files: [{ file, rootNote }] }] }.
 * Plain data, so it can be kept and read back.
 */
export async function readSource(src, { fetchImpl }) {
  if (src.kind === 'json') {
    const data = await getJson(fetchImpl, src.url, src.url);
    const { base, packs } = packsFromStrudelJson(data, src.url);
    const resolved = resolveBase(base);
    return { key: sourceKey(src), sha: null, packs: packs.map((p) => ({ ...p, base: resolved })) };
  }
  const { owner, repo, path } = src;
  const label = `${owner}/${repo}`;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const commit = await getJson(fetchImpl, `${api}/commits/${encodeURIComponent(src.ref ?? 'HEAD')}`, src.ref ? `${label}@${src.ref}` : label);
  const sha = commit?.sha;
  const treeSha = commit?.commit?.tree?.sha;
  if (!SHA.test(sha ?? '') || !treeSha) throw new Error(`GitHub did not say which commit ${label} is at`);
  const tree = await getJson(fetchImpl, `${api}/git/trees/${treeSha}?recursive=1`, `${label}'s file list`);
  const paths = (tree?.tree ?? []).filter((e) => e.type === 'blob' && typeof e.path === 'string').map((e) => e.path);
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/`;

  const jsonPath = path ? `${path}/strudel.json` : 'strudel.json';
  if (paths.includes(jsonPath)) {
    const jsonUrl = raw + encodePath(jsonPath);
    const data = await getJson(fetchImpl, jsonUrl, `${label}'s strudel.json`);
    const { base, packs } = packsFromStrudelJson(data, jsonUrl);
    const resolved = resolveBase(base, { owner, repo, sha });
    return { key: sourceKey(src), sha, packs: packs.map((p) => ({ ...p, base: resolved })), truncated: !!tree.truncated };
  }

  const found = packsFromTree(paths, { under: path, rootName: path ? path.split('/').pop() : repo });
  if (!found.length) throw new Error(`there are no audio files in ${label}${path ? `/${path}` : ''}`);
  let count = 0;
  const packs = [];
  for (const p of found) {
    if (count >= MAX_FILES) break;
    const files = p.files.slice(0, MAX_FILES - count).map((file) => ({ file, rootNote: null }));
    count += files.length;
    packs.push({ name: p.name, base: raw, files });
  }
  const total = found.reduce((n, p) => n + p.files.length, 0);
  return { key: sourceKey(src), sha, packs, truncated: !!tree.truncated || total > MAX_FILES, total };
}

/** A listing's packs as sample-store manifests, and the one function that finds their files. */
export function manifestsOf(listing, { title }) {
  const manifests = listing.packs.map((p) => ({
    id: p.name,
    title: `${p.name} - ${title}`,
    description: title,
    kind: p.files.some((f) => Number.isFinite(f.rootNote)) ? 'melodic' : 'drums',
    // Kept under the base it is read from, so the same folder name in two repositories is two
    // sets of bytes (samples.mjs, cacheKeyOf).
    cachePrefix: `remote/${p.base}`,
    base: p.base,
    files: p.files.map((f) => ({
      file: f.file,
      name: String(f.file).split('/').pop().replace(/\.[^.]+$/, ''),
      rootNote: Number.isFinite(f.rootNote) ? f.rootNote : null,
      loop: null,
    })),
  }));
  return manifests;
}

// ---- a file by where it lives ------------------------------------------------------------------
//
// A kit entry or a point on the sample map names a file of a samples() pack by its ORIGIN rather
// than by its pack's name: `github:owner/repo@<commit>/path/in/repo.wav`, or the file's own URL for a
// source that is not a GitHub repository. A pack name is only what one session's samples() lines
// made it - two repositories both have a "bd", and a buffer without the line has none - while an
// origin is the same file wherever it is read, pinned to its commit. The bytes are cached under the
// same key samples() uses for the file (see parseOrigin), so the two share one download.

const RAW = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.*)$/i;
const ORIGIN = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([0-9a-f]{40})\/(.+)$/i;

/** The origin of `file` in a pack read from `base` (a manifest's base URL), or null. */
export function originOf(base, file) {
  const m = RAW.exec(String(base ?? ''));
  if (m) return `github:${m[1]}/${m[2]}@${m[3]}/${m[4]}${file}`;
  return /^https:\/\//i.test(String(base ?? '')) ? `${base}${encodePath(String(file))}` : null;
}

/** An origin back as { base, file } - the base a samples() pack of that repository has - or null. */
export function parseOrigin(text) {
  const t = String(text ?? '');
  const m = ORIGIN.exec(t);
  if (m) return { base: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/`, file: m[4] };
  return /^https:\/\/[^\s]+\.(wav|wave|aif|aiff|flac|mp3|ogg|oga|opus|m4a)$/i.test(t) ? { base: '', file: t } : null;
}

/** A short prefix for a source's packs: the first word of the repository's name ("dirt"). */
export function suggestPrefix(text) {
  const src = parseSource(text);
  const name = src?.kind === 'github' ? src.repo : 'samples';
  const word = name.toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 2) ?? 'lib';
  return packName(word);
}

const urlFor = (manifests) => {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  // Paths are kept as the repository names them and made into a URL only here, so a file called
  // "100% kick.wav" is fetched as that file rather than read as an escape.
  return (id, file) => (/^https:\/\//i.test(file) ? file : `${byId.get(id)?.base ?? ''}${encodePath(file)}`);
};

// ---- finding samples() in code ------------------------------------------------------------------

/**
 * Every samples("…") call in `code` that is not commented out, as { source, prefix } - the prefix
 * being the optional second string: samples("tidalcycles/dirt-samples", "dirt").
 */
export function sourcesIn(code) {
  const text = String(code ?? '');
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && next === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    const call = /^samples\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1(?:\s*,\s*(["'`])((?:\\.|(?!\3)[^\\\n])*)\3)?/.exec(text.slice(i, i + 600));
    if (call && !/[\w$.]/.test(text[i - 1] ?? '')) {
      out.push({ source: call[2], prefix: call[4] ?? null });
      i += call[0].length;
      continue;
    }
    i += 1;
  }
  return out;
}

// ---- the page's side ----------------------------------------------------------------------------

/**
 * The samples() machinery for one page: resolves sources, keeps their listings, and files their
 * packs with the sample store (so a note can load one) and with the language (so sp() and the
 * roll list know the names).
 */
export function createRemotePacks({ fetchImpl, store = null, samples, onPacks = () => {}, warn = () => {}, say = () => {}, note = null, now = () => Date.now() }) {
  // A line that can carry a fix the editor offers beside it (see client.js's logLine); a host that
  // takes only text gets the text.
  const tell = note ?? ((m) => (m.level === 'warn' ? warn : say)(m.text));
  const resolved = new Map();   // source key -> Promise<manifests | null>
  const active = new Map();     // pack id -> { manifest, urlFor, source }

  async function keptListing(key) {
    if (!store) return null;
    return store.get(`remote/listing/${key}`).catch(() => null);
  }

  async function listing(src, text) {
    const key = sourceKey(src);
    const kept = await keptListing(key);
    const pinned = src.kind === 'github' && SHA.test(src.ref ?? '');
    if (kept?.listing && (pinned || now() - kept.at < LISTING_TTL_MS)) return kept.listing;
    try {
      const fresh = await readSource(src, { fetchImpl });
      // `source` is the call's own spelling, so the settings row can write the line back.
      if (store) await store.put(`remote/listing/${key}`, { at: now(), listing: fresh, source: kept?.source ?? text }).catch(() => {});
      return fresh;
    } catch (err) {
      if (kept?.listing) {
        warn(`[samples] ${err.message} - using the list of files read earlier`);
        return kept.listing;
      }
      throw err;
    }
  }

  const warned = new Set();      // "loser|winner" source keys already said, so a re-evaluate is quiet

  /**
   * A source's packs, read but not yet handed out: { key, title, text, pre, manifests, find,
   * truncated }, or null (said why). Cached per source and prefix, so re-evaluating reads nothing.
   */
  function load(text, prefix = null) {
    const src = parseSource(text);
    if (!src) {
      warn(`[samples] "${text}" is not a repository - write samples("user/repo"), optionally with @branch and a folder`);
      return Promise.resolve(null);
    }
    const pre = prefix == null || String(prefix).trim() === '' ? null : packName(prefix);
    // The same repository under two prefixes is two sets of names over one listing.
    const key = `${sourceKey(src)}|${pre ?? ''}`;
    if (resolved.has(key)) return resolved.get(key);
    const title = src.kind === 'json' ? src.url : `${src.owner}/${src.repo}${src.path ? `/${src.path}` : ''}`;
    const work = listing(src, text)
      .then((l) => {
        const manifests = manifestsOf(l, { title });
        if (pre) for (const m of manifests) m.id = packName(`${pre}_${m.id}`);
        // poptart's own packs keep their names: a folder that has one goes by the repository's
        // name in front of it.
        for (const m of manifests) {
          if (!isReservedPack(m.id)) continue;
          const renamed = packName(`${src.kind === 'github' ? src.repo : 'samples'}_${m.id}`);
          say(`samples: ${title}'s "${m.id}" is the name of one of poptart's own packs - it is "${renamed}" here`);
          m.id = renamed;
        }
        return { key, title, text, pre, manifests, find: urlFor(manifests), truncated: l.truncated };
      })
      .catch((err) => {
        resolved.delete(key); // a failure can be tried again on the next evaluate
        warn(`[samples] ${title}: ${err.message ?? err}`);
        return null;
      });
    resolved.set(key, work);
    return work;
  }

  /**
   * Hands out a loaded source's names. `wins(id)` says whether this source is the one a name
   * belongs to (the last line naming it, in prepare); a name it already holds is left alone, so
   * re-evaluating the same buffer reloads nothing.
   */
  function activate(e, wins = () => true) {
    const changed = [];
    const taken = new Map(); // the source whose names these take -> the names
    for (const m of e.manifests) {
      if (!wins(m.id)) continue;
      const held = active.get(m.id);
      if (held?.source === e.key) continue;
      if (held) {
        const from = held.manifest.description;
        taken.set(from, [...(taken.get(from) ?? []), m.id]);
        samples.forget?.(m.id);
      }
      active.set(m.id, { manifest: m, urlFor: e.find, source: e.key });
      changed.push(m);
    }
    if (!changed.length) return;
    samples.register(changed, e.find);
    onPacks(changed);
    const files = changed.reduce((n, m) => n + m.files.length, 0);
    say(`samples: ${e.title} - ${changed.length} pack${changed.length === 1 ? '' : 's'}, ${files} files (${changed.slice(0, 8).map((m) => m.id).join(', ')}${changed.length > 8 ? ', …' : ''})`);
    if (e.truncated) warn(`[samples] ${e.title} is larger than one listing holds - only the first ${files} files are in its packs`);
    for (const [from, names] of taken) sayTaken(e, from, names);
  }

  // Said once per pair of sources, with the fix beside it: the later line wins, as it plays, and a
  // prefix keeps both.
  function sayTaken(e, from, names) {
    if (warned.has(`${from}|${e.key}`)) return;
    warned.add(`${from}|${e.key}`);
    const list = `${names.slice(0, 6).join(', ')}${names.length > 6 ? `, and ${names.length - 6} more` : ''}`;
    tell({
      level: 'warn',
      text: `[samples] ${list} from ${e.title} replace${names.length === 1 ? 's' : ''} the one${names.length === 1 ? '' : 's'} from ${from}`,
      fix: e.pre ? null : { kind: 'samples-prefix', label: 'prefix them', source: e.text, prefix: suggestPrefix(e.text) },
    });
  }

  /**
   * Resolves every samples() source in `code` before it is evaluated, so the first evaluate of a
   * pattern already knows its packs' names. The lists are read side by side, but names are handed
   * out in the order the lines are written - a name two sources share belongs to the later line,
   * however the downloads happen to finish. Waits at most `waitMs`: a slow network lets the pattern
   * start, and the packs join when they arrive - a note on a pack that is not in yet is the
   * ordinary "source not ready".
   */
  async function prepare(code, { waitMs = 6000 } = {}) {
    const calls = sourcesIn(code);
    if (!calls.length) return;
    const loads = calls.map(({ source, prefix }) => load(source, prefix));
    const settle = (async () => {
      const entries = (await Promise.all(loads)).filter(Boolean);
      const owner = new Map(); // pack name -> the last line naming it
      const shared = new Map(); // winner -> (loser's title -> names): the lines' own collisions
      for (const e of entries) {
        for (const m of e.manifests) {
          const before = owner.get(m.id);
          if (before && before.key !== e.key) {
            const byLoser = shared.get(e) ?? new Map();
            byLoser.set(before.title, [...(byLoser.get(before.title) ?? []), m.id]);
            shared.set(e, byLoser);
          }
          owner.set(m.id, e);
        }
      }
      for (const e of entries) activate(e, (id) => owner.get(id) === e);
      for (const [e, byLoser] of shared) for (const [from, names] of byLoser) sayTaken(e, from, names);
    })();
    await Promise.race([settle, new Promise((r) => setTimeout(r, waitMs))]);
  }

  return {
    prepare,
    /** What the language's samples() calls: starts a source that prepare() did not see. */
    // Only names nobody holds: prepare() has already handed out the buffer's names in line order,
    // and this runs again for every call as the buffer evaluates - taking names here would undo it.
    use(text, prefix = null) {
      return load(String(text ?? ''), prefix).then((e) => {
        if (e) activate(e, (id) => !active.has(id));
        return e?.manifests ?? null;
      });
    },
    /**
     * Every repository this browser has kept a list of files for: { key, source, bases } - the
     * call's own spelling, and the base URLs its files are cached under (see manifestsOf).
     */
    async kept() {
      if (!store?.keys) return [];
      const out = [];
      for (const k of await store.keys('remote/listing/')) {
        const held = await store.get(k).catch(() => null);
        const l = held?.listing;
        if (!l) continue;
        const key = k.slice('remote/listing/'.length);
        out.push({ key, source: held.source ?? sourceText(key), bases: [...new Set((l.packs ?? []).map((p) => p.base))] });
      }
      return out;
    },
    /** Lets one repository's list of files go (its downloaded files are the sample store's). */
    async forgetListing(key) {
      await store?.delete?.(`remote/listing/${key}`).catch(() => {});
    },
    /** Every pack a samples() call has added, as the host lists packs. */
    packs: () => [...active.values()].map(({ manifest, urlFor: u }) => ({ manifest, urlFor: u })),
  };
}
