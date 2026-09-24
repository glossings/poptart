// Sample pack manifests: what a shipped pack has to say about itself before it can ship.
//
// poptart's web build serves its own default sounds, which means redistributing audio - and
// redistributing audio is the part of this project most likely to go quietly wrong. The usual
// free drum pack says "use it in your music", which is permission to USE and not permission to
// PUBLISH a copy, and the difference does not show up until somebody notices. Half the sets
// that circulate as "free" have no stated terms at all.
//
// So every file in a shipped pack carries its own provenance, the build refuses a pack with a
// file that does not, and the licenses are printed into the About screen from the manifests
// rather than from a hand-written list that would drift. A missing license is a build failure,
// not a warning, because a warning would be ignored exactly once and that would be enough.

/** Licenses a shipped pack may use. Anything else has to be argued for, file by file. */
export const ALLOWED_LICENSES = Object.freeze([
  'CC0-1.0',        // public domain dedication - the default, and what poptart renders itself
  'CC-BY-4.0',      // attribution required; the About screen carries it
  'CC-BY-3.0',
  'public-domain',
]);

/**
 * The `pt_` prefix every shipped pack wears.
 *
 * Shipped packs share a namespace with the packs somebody makes themselves, and a built-in
 * called `kit` would take the most obvious name in the language away from the person using it.
 * The prefix is short, sorts together in the picker, and reads as "the one that came with it".
 */
export const PACK_PREFIX = 'pt_';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validates one manifest and returns it frozen. Throws on anything a shipped pack may not do,
 * naming the file at fault - this runs in the build, where a clear failure costs a minute and a
 * silent pass costs a takedown.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('[packs] a manifest must be an object');
  const id = String(manifest.id ?? '').trim();
  if (!id) throw new Error('[packs] a manifest needs an id');
  if (!id.startsWith(PACK_PREFIX)) {
    throw new Error(`[packs] "${id}" must start with "${PACK_PREFIX}" so it cannot take a name somebody wants for their own pack`);
  }
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`[packs] "${id}" must be lowercase letters, digits and underscores - it has to be typeable inside sp("…")`);
  }
  if (!isNonEmptyString(manifest.title)) throw new Error(`[packs] "${id}" needs a title`);

  const files = Array.isArray(manifest.files) ? manifest.files : null;
  if (!files || files.length === 0) throw new Error(`[packs] "${id}" has no files`);

  const seen = new Set();
  const checked = files.map((entry, index) => {
    const where = `"${id}" file ${index}`;
    if (!entry || typeof entry !== 'object') throw new Error(`[packs] ${where} is not an entry`);
    const file = String(entry.file ?? '').trim();
    if (!file) throw new Error(`[packs] ${where} has no filename`);
    if (file.includes('..') || file.startsWith('/')) throw new Error(`[packs] ${where} must be a plain relative name`);
    if (seen.has(file)) throw new Error(`[packs] "${id}" lists ${file} twice - the order of this list IS the sample index`);
    seen.add(file);

    const license = String(entry.license ?? '').trim();
    if (!license) throw new Error(`[packs] ${where} (${file}) has no license, so it cannot be shipped`);
    if (!ALLOWED_LICENSES.includes(license)) {
      throw new Error(`[packs] ${where} (${file}) is ${license}, which is not one poptart redistributes. Allowed: ${ALLOWED_LICENSES.join(', ')}`);
    }
    const source = String(entry.source ?? '').trim();
    if (!source) throw new Error(`[packs] ${where} (${file}) has no source, so nobody could check its license`);
    // Attribution licenses need somebody to attribute.
    if (license.startsWith('CC-BY') && !isNonEmptyString(entry.by)) {
      throw new Error(`[packs] ${where} (${file}) is ${license} and has nobody to credit`);
    }

    // The note the recording was actually made at, as a MIDI number.
    //
    // A drum has no pitch worth naming and leaves this out. A melodic sample needs it or it
    // plays in the wrong key: the sampler repitches around a fixed anchor, so a glockenspiel
    // recorded at G4 and played as though it were middle C is out by a fifth and an octave -
    // wrong in a way that sounds like a mistake in the music rather than a mistake in the pack.
    let rootNote = null;
    if (entry.rootNote !== undefined && entry.rootNote !== null) {
      const n = Number(entry.rootNote);
      if (!Number.isInteger(n) || n < 0 || n > 127) {
        throw new Error(`[packs] ${where} (${file}) has rootNote ${entry.rootNote}, which is not a MIDI note`);
      }
      rootNote = n;
    }

    // Loop points in frames, for a recording that was cut as a sustained note rather than as a
    // one-shot. Nothing reads them yet; they are kept because the alternative to carrying them
    // now is rebuilding every pack later, and a rebuilt pack is a changed pack.
    let loop = null;
    if (entry.loop) {
      const start = Number(entry.loop.start);
      const end = Number(entry.loop.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
        throw new Error(`[packs] ${where} (${file}) has a loop that does not run forwards`);
      }
      loop = Object.freeze({ start, end });
    }

    return Object.freeze({
      file,
      name: String(entry.name ?? '').trim() || file.replace(/\.[^.]+$/, ''),
      license,
      source,
      by: String(entry.by ?? '').trim() || null,
      rootNote,
      loop,
    });
  });

  return Object.freeze({
    id,
    title: String(manifest.title).trim(),
    description: String(manifest.description ?? '').trim() || null,
    kind: manifest.kind === 'melodic' ? 'melodic' : 'drums',
    files: Object.freeze(checked),
  });
}

/**
 * The definition line a shipped pack becomes in the built-in library.
 *
 * It is spelled exactly as the ★ library spells a pinned pack - one `_pack(id, [files])` per
 * line - because the built-in library IS a prebake source, read by the same parser, and a
 * format that is nearly the same would be worse than one that is identical.
 *
 * The order of the list is the sample index, so `sp("pt_kit:2")` is the third file here.
 */
export function packDefinition(manifest, base = 'packs') {
  const files = manifest.files.map((f) => `${base}/${manifest.id}/${f.file}`);
  return `_pack(${JSON.stringify(manifest.id)}, ${JSON.stringify(files)})`;
}

/** The whole built-in library file, given every shipped manifest. */
export function builtInLibrary(manifests, base = 'packs') {
  const header = [
    "// poptart's built-in sample packs. Generated - do not edit.",
    '// One definition per line, like the star library, and read by the same parser. Every name',
    `// starts with "${PACK_PREFIX}" so that nothing here takes a name you might want for your own.`,
    '',
  ];
  return `${[...header, ...manifests.map((m) => packDefinition(m, base))].join('\n')}\n`;
}

/**
 * The credits every shipped file needs, grouped so a page can show them. Files under a public
 * domain dedication still appear: knowing where a sound came from is worth something even when
 * nothing is legally required.
 */
export function packCredits(manifests) {
  return manifests.map((m) => ({
    id: m.id,
    title: m.title,
    files: m.files.map((f) => ({ file: f.file, license: f.license, source: f.source, by: f.by })),
    licenses: [...new Set(m.files.map((f) => f.license))].sort(),
  }));
}
