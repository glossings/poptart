// Groups: the track tree. A block whose head is `group()` is a mixdown - it makes no sound of its
// own, it reads a bus, and the tracks that BELONG to it send into that bus and stop playing
// directly. A group can belong to another group, so the tree nests as deep as a song needs:
//
//   drums: group().fx("Pro-C 2")     // a supergroup: kick, snare and hats mixed and compressed
//   kick:  group()                   // a group of kick tracks
//   kickMain: s("mbd*4")             // ...its members, ordinary tracks in every other respect
//   kickFill: s("mbd*4").i(3)
//
//   _groups({ drums: ["kick", "snare", "hats"], kick: ["kickMain", "kickFill"] })
//
// MEMBERSHIP IS DATA, not indentation. `_groups(...)` is a definition the editor writes, the way
// `_arrange(...)` and `_roll(...)` are - grouping is a gesture (cmd+G over a selection), and the
// call is where the gesture is recorded. Indentation was the obvious alternative and is worse for
// exactly one reason: it makes whitespace load-bearing in a language where a chain is routinely
// re-indented by hand, so a stray space would silently re-parent a track. Nothing here can be
// broken by reformatting the code.
//
// What a member does NOT inherit is anything about its sound. A group shares a BUS, so the .fx(),
// .postgain() and .pan() written on the group are shared by everything under it, and nothing else
// is: two tracks in one group are two ordinary tracks that happen to mix together. Config a person
// wants shared between them is shared the way any JS is - a `const` above them both.
//
// The whole tree is READ off `_groups` once per evaluation, and the routing is a consequence of it:
// there is no `.bus("kick")` written onto each member to fall out of step when a member is copied,
// renamed or moved.
//
// Kept dependency-free on purpose, like arrange.mjs and pianoroll.mjs: the browser imports this
// file directly (served as ESM by web-app/server.js) to draw the arrangement's rows, the mixer's
// strips and the editor's folds from the same tree the host routes by.

/**
 * The root of the tree: the group everything reaches in the end. `main` is a name, not a mechanism -
 * write `main: group().fx("Pro-L 2")` and every track that belongs to no other group sends into it,
 * which is what makes it the place a mastering chain goes. Write no `main:` block and there is no
 * root: tracks play straight out, exactly as they did before groups existed. So the master costs
 * nothing until it is asked for, and asking for it is one line.
 */
export const GROUP_ROOT = 'main';

const isName = (s) => typeof s === 'string' && s.length > 0;

/**
 * The tree as the builder and the editor both read it: a Map of parent -> ordered child names,
 * with everything unusable dropped. Flat rather than nested objects - a child that is itself a key
 * is a subgroup - because every edit here is local: regrouping one track rewrites one entry, and a
 * tree deep enough to need it is still one line per group.
 *
 * What is dropped, and why each is dropped rather than thrown on (a half-typed tree should cost a
 * grouping, never the buffer):
 *   - a child named twice: the FIRST parent keeps it. A track is in one group; the alternative is
 *     an audio path that sums itself, which is a bug wearing a feature's clothes.
 *   - a group that contains itself, directly or through its subgroups: the edge that closes the
 *     cycle is dropped, so the rest of the tree still stands. (The engine survives a cycle - it
 *     drops the edge too, one block late - but a cycle here is always a mistake, never a patch.)
 *   - `main` as a child of anything: the root is the root.
 */
export function normalizeGroupTree(tree) {
  const src = tree instanceof Map ? tree : new Map(Object.entries(tree && typeof tree === 'object' ? tree : {}));
  const out = new Map();
  const parent = new Map(); // child -> parent, as it is built, for the cycle check
  const wouldCycle = (child, of) => {
    // Walking UP from `of` must never arrive back at `child`: that is the edge closing a loop.
    for (let at = of, guard = 0; at != null && guard < 1000; at = parent.get(at), guard++) {
      if (at === child) return true;
    }
    return false;
  };
  for (const [rawParent, rawKids] of src) {
    if (!isName(rawParent) || !Array.isArray(rawKids)) continue;
    const kids = [];
    for (const kid of rawKids) {
      if (!isName(kid) || kid === rawParent || kid === GROUP_ROOT) continue;
      if (parent.has(kid) || kids.includes(kid)) continue;
      if (wouldCycle(kid, rawParent)) continue;
      kids.push(kid);
      parent.set(kid, rawParent);
    }
    if (kids.length) out.set(rawParent, kids);
  }
  return out;
}

/**
 * child -> parent, off a normalized tree. The inverse index every other question here is asked in
 * terms of, computed once per evaluation and passed around.
 */
export function parentsOf(tree) {
  const parents = new Map();
  for (const [parent, kids] of normalizeGroupTree(tree)) {
    for (const kid of kids) if (!parents.has(kid)) parents.set(kid, parent);
  }
  return parents;
}

/**
 * Every group between `label` and the root, nearest first. What a solo needs: a soloed track is
 * heard THROUGH its groups, so each of them has to play too (see the host's solo handling).
 */
export function ancestorsOf(label, parents) {
  const out = [];
  const seen = new Set([label]);
  for (let at = parents.get(label); at != null && !seen.has(at); at = parents.get(at)) {
    out.push(at);
    seen.add(at);
  }
  return out;
}

/**
 * Everything under `label`, at any depth, in display order. What a solo on a GROUP needs: soloing
 * `drums` means the drums, which is every track that mixes into it.
 */
export function descendantsOf(label, tree) {
  const t = tree instanceof Map ? tree : normalizeGroupTree(tree);
  const out = [];
  const seen = new Set([label]);
  const walk = (at) => {
    for (const kid of t.get(at) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      walk(kid);
    }
  };
  walk(label);
  return out;
}

/**
 * The tracks in TREE order with their depth: a group immediately followed by everything under it,
 * groups before loose tracks, and anything the tree doesn't mention in the order it was given
 * (which is the buffer's order - the rows follow the code, as they always have).
 *
 * One list drives the arrangement's rows, the mixer's strips and the editor's folds, so those three
 * can never disagree about what is under what.
 *
 * @param {string[]} labels every track in the buffer, in document order
 * @returns {Array<{ label: string, depth: number, parent: string|null }>}
 */
export function groupOrder(labels, tree) {
  const t = normalizeGroupTree(tree);
  const parents = parentsOf(t);
  const known = new Set(labels);
  const out = [];
  const placed = new Set();
  const emit = (label, depth, parent) => {
    if (placed.has(label) || !known.has(label)) return;
    placed.add(label);
    out.push({ label, depth, parent });
    // Children in the tree's order, not the buffer's: the group's own list is what the person
    // arranged, and it is the one place order is theirs to choose.
    for (const kid of t.get(label) ?? []) emit(kid, depth + 1, label);
  };
  // A member whose group is not in the buffer is NOT hidden - it is a track like any other, at the
  // top level, which is also how it is routed (see routeGroups). Losing a group must never lose
  // what was in it.
  const rooted = (label) => {
    const parent = parents.get(label);
    return parent == null || !known.has(parent);
  };
  for (const label of labels) if (rooted(label)) emit(label, 0, null);
  // Anything left is inside a cycle the normalizer couldn't reach from a root; place it flat rather
  // than dropping it.
  for (const label of labels) emit(label, 0, null);
  return out;
}

/** Whether a Sig was headed by group(). Duck-typed so this file needs no import. */
export function isGroupSig(sig) {
  return !!(sig && typeof sig === 'object' && sig.inputSource && sig.inputSource.group);
}

/**
 * Apply the tree's routing to the blocks of one evaluation. Each block is `{ label, sig }`
 * (labels.mjs's fields plus the evaluated Sig); `busOf(label)` names the bus a group reads - the
 * engine's key for the block, so two decks' `kick` groups don't share a bus. The blocks' `sig`s are
 * replaced in place; returns which labels are groups and which are members of one.
 *
 * Two rules, and every part of the hierarchy falls out of them:
 *   - a group block reads the bus named after itself;
 *   - a block whose parent is a group sends into that group's bus and plays nothing directly
 *     (an explicit `.dry()` of its own is respected).
 * A SUBGROUP is both at once - it reads its own bus and sends into its parent's - which is the
 * whole of what nesting is. A block whose parent isn't a group in this buffer is left alone and
 * plays directly, so deleting a group frees its members rather than silencing them.
 *
 * Node order engine-side needs nothing from us: scsynth's track ordering is computed from who
 * writes the buses each track reads (see reorderTracks in sc/poptart.scd), so a subgroup lands
 * between its members and its parent on its own.
 */
export function routeGroups(blocks, busOf = (label) => label, tree = new Map()) {
  const t = normalizeGroupTree(tree);
  const parents = parentsOf(t);
  const groups = new Set();
  const members = new Set();
  for (const b of blocks) {
    if (!isGroupSig(b.sig)) continue;
    groups.add(b.label);
    b.sig = b.sig._clone({ inputSource: { io: 'audio', name: `bus:${busOf(b.label)}` } });
  }
  // The root takes everything that belongs to nobody else - but only if a `main:` group is actually
  // in the buffer. No root block, no root routing.
  const hasRoot = groups.has(GROUP_ROOT);
  const parentOf = (label) => {
    const parent = parents.get(label);
    if (parent != null && groups.has(parent)) return parent;
    if (hasRoot && label !== GROUP_ROOT && (parent == null || !groups.has(parent))) return GROUP_ROOT;
    return null;
  };
  // Who each track actually ended up under, the implicit root included - which is not the same as
  // the tree's `parents` and is what the desk asks: a track under a real group is not its own
  // channel (its group is), but one that merely reaches the root still is.
  const routedParents = new Map();
  for (const b of blocks) {
    if (!b.sig || typeof b.sig.bus !== 'function') continue;
    const parent = parentOf(b.label);
    if (parent == null) continue;
    members.add(b.label);
    routedParents.set(b.label, parent);
    const bus = busOf(parent);
    let sig = b.sig;
    if (!sig.busSends.some((s) => s.name === bus)) sig = sig.bus(bus);
    if (sig.channel.dry == null) sig = sig.dry(0);
    b.sig = sig;
  }
  return { groups, members, tree: t, parents, routedParents };
}

/**
 * The `_groups(...)` definition: editor-owned data, like `_arrange(...)`. Returns a plain marker
 * object rather than a Sig - the line is a definition, not a voice, and the host reads the tree off
 * it before anything is routed.
 */
export function _groups(tree) {
  return { poptartGroupsBlock: true, tree: normalizeGroupTree(tree) };
}

/**
 * The tree as the source text carries it: a plain object literal, keys in the order given, values
 * arrays of names. An object rather than the packed string `_arrange` uses because a tree is read
 * far more often than it is typed, and `{ drums: ["kick", "snare"] }` needs no legend.
 */
export function serializeGroupTree(tree) {
  const t = normalizeGroupTree(tree);
  if (!t.size) return '{}';
  const entries = [...t].map(([parent, kids]) => `${JSON.stringify(parent)}: [${kids.map((k) => JSON.stringify(k)).join(', ')}]`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * Drop what the buffer no longer has, for the editor's write-back: a group with no block, and any
 * member with no block. Membership survives a track being COMMENTED OUT the same way the
 * arrangement's does - the label is gone from the buffer either way, so this is only ever called
 * with the labels of a successful evaluation, from the gesture that rewrites the call.
 */
export function pruneGroupTree(tree, labels) {
  const known = new Set(labels);
  const out = new Map();
  for (const [parent, kids] of normalizeGroupTree(tree)) {
    if (!known.has(parent)) continue;
    const kept = kids.filter((k) => known.has(k));
    if (kept.length) out.set(parent, kept);
  }
  return out;
}
