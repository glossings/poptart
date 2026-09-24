// Turning a pack plan into a list of files to fetch - the part worth testing.
//
// The downloading itself is uninteresting and untestable without a network; choosing WHICH
// recording stands for an instrument is neither. It is the step that decides whether a
// glockenspiel plays in tune, whether a rebuilt pack still sounds like the one a song was
// written against, and whether the index a browser reads says anything true about where its
// audio came from. So the choosing lives here, as plain functions over data, and fetch-packs.mjs
// does nothing but carry bytes.

import { chooseRegion, parseSfz, regionRoot, samplePath } from './sfz.mjs';

/** The extension a served file keeps, lowercased; upstream is inconsistent about case. */
export function extensionOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path));
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * What a file is called once it is in a pack.
 *
 * Renamed from upstream on purpose. The upstream names encode a dial position or a velocity
 * layer in a scheme that means nothing outside its own library, and the name here is what
 * somebody reads in the sample browser - so it says what the sound IS. The order of the list is
 * still what `sp("pt_x:3")` indexes; the name is for people.
 */
export function servedName(name, sourcePath) {
  return `${String(name).toLowerCase().replace(/[^a-z0-9_]+/g, '')}${extensionOf(sourcePath)}`;
}

/** One entry of a manifest, with the provenance carried down from its source. */
export function entryFor({ name, sourcePath, source, sourceRef, rootNote = null, extra = {} }) {
  return {
    file: servedName(name, sourcePath),
    name,
    license: source.license,
    by: source.by,
    // The source is a URL that a person can open to check the claim. A repository name alone
    // would not be: the point of recording it is that somebody else can verify the license
    // without taking this file's word for it.
    source: sourceRef ? `${source.homepage}/blob/${sourceRef}/${sourcePath}` : source.homepage,
    from: sourcePath,
    ...(Number.isFinite(rootNote) ? { rootNote } : {}),
    ...extra,
  };
}

/**
 * Finds the SFZ in a repository tree that describes one instrument folder.
 *
 * The libraries put an instrument's SFZ one level ABOVE its recordings, named after the folder,
 * and add " - <articulation>" when an instrument was sampled more than one way. `prefer` picks
 * between those; with nothing preferred the shortest name wins, which is the plain articulation
 * rather than the keyswitched combination of all of them.
 */
export function findSfz(paths, instrumentDir, prefer = null) {
  const at = instrumentDir.lastIndexOf('/');
  const parent = at === -1 ? '' : instrumentDir.slice(0, at);
  const leaf = at === -1 ? instrumentDir : instrumentDir.slice(at + 1);
  const candidates = paths.filter((p) => {
    if (!p.toLowerCase().endsWith('.sfz')) return false;
    const dir = p.slice(0, p.lastIndexOf('/'));
    if (dir !== parent) return false;
    const base = p.slice(p.lastIndexOf('/') + 1, -4);
    return base === leaf || base.startsWith(`${leaf} - `);
  });
  if (candidates.length === 0) return null;
  if (prefer) {
    const wanted = candidates.find((p) => p.endsWith(` - ${prefer}.sfz`));
    if (wanted) return wanted;
  }
  // Two articulations are never what "one recording of this instrument" means. A keyswitch file
  // stacks every articulation behind one key range, and a releases file holds only the tails -
  // the sound a key makes on the way UP, which on its own is a click and a decay rather than the
  // instrument. Both sort early by name, so leaving them in would make them the default.
  const plain = candidates.filter((p) => !/ - (Keyswitch|Releases?)\.sfz$/i.test(p));
  return (plain.length ? plain : candidates).sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
}

/**
 * Reads an instrument's SFZ and says which single recording to take and what pitch it is.
 *
 * Returns null when the SFZ names nothing usable, which the caller reports and carries on from:
 * one instrument missing is a pack with one fewer sound, and a build that stopped for it would
 * be a build nobody could run.
 */
export function chooseFromSfz(sfzPath, sfzText, { note = 60, velocity = 100 } = {}) {
  const { control, regions } = parseSfz(sfzText);
  const chosen = chooseRegion(regions, { note, velocity });
  if (!chosen) return null;
  const relative = samplePath(chosen.region, control);
  if (!relative) return null;
  const dir = sfzPath.slice(0, sfzPath.lastIndexOf('/'));
  const path = dir ? `${dir}/${relative}` : relative;
  const loopStart = Number(chosen.region.loop_start);
  const loopEnd = Number(chosen.region.loop_end);
  return {
    path,
    rootNote: regionRoot(chosen.region),
    // Carried but unused: these banks are sustained and looped upstream, and a sampler that
    // learns to loop can honor them without the packs being rebuilt.
    ...(Number.isFinite(loopStart) && Number.isFinite(loopEnd) && loopEnd > loopStart
      ? { loop: { start: loopStart, end: loopEnd } }
      : {}),
  };
}

/**
 * The plan for a pack whose files are named outright - the drum machine ones.
 *
 * Every path is known in advance, so this is a rename and a provenance stamp and nothing else.
 */
export function planNamedFiles(plan, source, ref) {
  return {
    id: plan.id,
    title: plan.title,
    kind: plan.kind,
    description: plan.description,
    files: plan.files.map((f) => entryFor({ name: f.name, sourcePath: f.path, source, sourceRef: ref })),
  };
}

/**
 * The plan for a pack drawn from a sampled library, given the repository tree and a way to read
 * an SFZ. `readSfz` is passed in so this can be tested against fixtures rather than a network.
 */
export async function planInstruments(plan, source, refs, paths, readSfz) {
  const files = [];
  const problems = [];
  for (const instrument of plan.instruments) {
    const sfzPath = findSfz(paths, instrument.dir, instrument.prefer);
    if (!sfzPath) {
      problems.push(`${plan.id}: no description found for ${instrument.dir}`);
      continue;
    }
    let chosen = null;
    try {
      chosen = chooseFromSfz(sfzPath, await readSfz(sfzPath), { note: plan.note });
    } catch (err) {
      problems.push(`${plan.id}: ${instrument.dir} could not be read - ${err.message}`);
      continue;
    }
    if (!chosen) {
      problems.push(`${plan.id}: ${instrument.dir} names no recording with a pitch`);
      continue;
    }
    files.push(entryFor({
      name: instrument.name,
      sourcePath: chosen.path,
      source,
      sourceRef: refs.audio,
      rootNote: chosen.rootNote,
      extra: chosen.loop ? { loop: chosen.loop } : {},
    }));
  }
  return {
    manifest: {
      id: plan.id, title: plan.title, kind: plan.kind, description: plan.description, files,
    },
    problems,
  };
}
