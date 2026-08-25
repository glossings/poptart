// Named definitions - data kept under a name so a pattern can say the name instead of carrying
// the data: `roll(0, "60,0,4 …")` defines a piano roll and `pianoroll("<0 chorus>")` plays them in
// turn; `shape("swell", "0,0 0.7,1 1,0")` defines an LFO shape and `lfo("<swell pluck>")` runs them
// in turn; `_preset("wob", "Serum 2", "<blob>")` files a captured plugin STATE and
// .preset("<init wob>") swaps the plugin between them. The definitions are still ordinary code in
// the buffer (the editor folds them out of the way rather than hiding them), so export, snapshots
// and undo are untouched; these stores are only how a call finds what a name means at playback
// time. `_pack("kit", [...files])` files a hand-picked SAMPLE PACK the same way, and `sp("kit")`
// plays it by name the way `s("bd")` plays a folder.
//
// Like macros.mjs and midi.mjs this lives apart from signal.mjs so both stay dependency-free: the
// browser imports the same signal code against its own copy of the store.
//
// TWO LAYERS, because they have different lifetimes:
//
//   buffer   names defined by the editor buffer. Cleared at the top of every evaluation - one
//            whose definition you just deleted has to stop existing, exactly like a track whose
//            label disappeared (an accumulating registry would keep playing the old data).
//   prebake  names defined by ~/.poptart/prebake.js - a personal library shared by every patch.
//            Cleared only when prebake itself re-runs, so a buffer eval never drops it.
//
// The buffer shadows prebake on a shared name, which is the rule the evaluator already uses for
// prebake's `const` bindings.

/** One two-layer store. `what` names the kind in the "defined twice" warning. */
function makeStore(what) {
  const layers = { buffer: new Map(), prebake: new Map() };
  let current = 'buffer'; // which layer register writes to (the host sets this around prebake)
  let owner = 'a'; // which deck's evaluation buffer definitions belong to (see setOwner)
  const owners = new Map(); // buffer id -> the deck that defined it
  const pick = (layer) => layers[layer === 'prebake' ? 'prebake' : 'buffer'];

  return {
    /** Where subsequent definitions land. The host wraps its prebake run in this. */
    setLayer(layer) {
      current = layer === 'prebake' ? 'prebake' : 'buffer';
    },
    /**
     * Which performance deck subsequent buffer definitions belong to (see the host's decks).
     * Two decks share one registry - lookups don't care who defined a name - but each deck's
     * eval clears and refills only ITS OWN definitions, so evaluating one song can't silence
     * the rolls the other song is playing.
     */
    setOwner(deck) {
      owner = deck;
    },
    /** Re-attribute every buffer definition `from` owns to `to` (complete-mix - see adoptDefs). */
    adopt(from, to) {
      for (const [id, o] of owners) if (o === from) owners.set(id, to);
    },
    /**
     * Drops every name in one layer and hands back what was in it, so a host that clears the
     * buffer to rebuild it can put the old definitions back if the rebuild never finishes (see
     * restoreRolls).
     */
    clear(layer = 'buffer', only = null) {
      const store = pick(layer);
      if (only != null && layer !== 'prebake') {
        // Owner-scoped: drop only what `only`'s evaluations defined; the other deck's stand.
        const had = new Map();
        for (const [id, value] of store) if ((owners.get(id) ?? 'a') === only) had.set(id, value);
        for (const id of had.keys()) {
          store.delete(id);
          owners.delete(id);
        }
        return had;
      }
      const had = new Map(store);
      store.clear();
      if (layer !== 'prebake') owners.clear();
      return had;
    },
    /** Puts a layer back exactly as `had` (from clear) left it. */
    restore(had, layer = 'buffer', only = null) {
      const store = pick(layer);
      if (only != null && layer !== 'prebake') {
        // Undo an owner-scoped clear: drop whatever that owner registered since, put back its own.
        for (const [id, o] of [...owners]) {
          if (o === only) {
            store.delete(id);
            owners.delete(id);
          }
        }
        for (const [id, value] of had ?? []) {
          store.set(id, value);
          owners.set(id, only);
        }
        return;
      }
      store.clear();
      if (layer !== 'prebake') owners.clear();
      for (const [id, value] of had ?? []) store.set(id, value);
    },
    /**
     * Files `sig` under `id` in the current layer. Returns a warning string when the id was
     * already taken IN THIS LAYER and is being replaced - two definitions of one name in a buffer
     * means one of them silently never plays, which is worth a line on the console rather than a
     * throw.
     */
    register(id, sig) {
      const store = layers[current];
      const replaced = store.has(id);
      const prevOwner = current === 'prebake' ? null : owners.get(id);
      store.set(id, sig);
      if (current !== 'prebake') owners.set(id, owner);
      if (!replaced) return null;
      if (prevOwner != null && prevOwner !== owner) {
        return `[signal] ${what} ${JSON.stringify(id)} is defined by both decks - the later definition wins for both`;
      }
      return `[signal] ${what} ${JSON.stringify(id)} is defined twice - the later definition wins`;
    },
    /** What a name means, buffer first, or null if nothing defines it. */
    lookup(id) {
      return layers.buffer.get(id) ?? layers.prebake.get(id) ?? null;
    },
    /**
     * Every name currently defined, buffer first then prebake, each with the layer it came from.
     * This is what the editor's pickers list - it names what is actually playable right now, which
     * the code text alone can't say (prebake isn't in the buffer).
     */
    ids() {
      const out = [...layers.buffer.keys()].map((id) => ({ id, layer: 'buffer' }));
      for (const id of layers.prebake.keys()) if (!layers.buffer.has(id)) out.push({ id, layer: 'prebake' });
      return out;
    },
  };
}

const stores = { roll: makeStore('roll'), shape: makeStore('shape'), preset: makeStore('preset'), pack: makeStore('sample pack') };

/** Both stores, for the host passes that treat them alike (clearing per eval, listing). */
export const DEF_KINDS = Object.keys(stores);

export function setRollLayer(layer) {
  for (const store of Object.values(stores)) store.setLayer(layer);
}

/** Which deck's evaluations subsequent buffer definitions belong to ('a' at rest - see makeStore). */
export function setDefOwner(deck) {
  for (const store of Object.values(stores)) store.setOwner(deck);
}

/**
 * Re-attribute one deck's buffer definitions to another - the complete-mix promotion: the
 * incoming song's definitions become the main deck's, so its next eval AS the main deck clears
 * and refills them like its own (which they now are).
 */
export function adoptDefs(from, to) {
  for (const store of Object.values(stores)) store.adopt(from, to);
}

/**
 * Empties one layer of every store, and returns what was in them - hand that back to restoreRolls
 * to undo the clear.
 *
 * The host clears 'buffer' at the top of each evaluation and fills it from the buffer again, which
 * is what makes a definition you just deleted stop playing. But an evaluation that THROWS applies
 * nothing else - the tracks that were playing go on playing, out of the Sigs they were built with -
 * and those Sigs resolve their definitions BY NAME, lazily, every cycle (see rollPattern). So a
 * cleared registry the evaluation never got round to refilling is silence on every track that names
 * a roll: one typo below the last definition and the whole part drops out. Clearing is therefore a
 * transaction - the host restores what it took out when the evaluation building the replacement
 * doesn't reach the end.
 */
export function clearRolls(layer = 'buffer', only = null) {
  const had = {};
  for (const [kind, store] of Object.entries(stores)) had[kind] = store.clear(layer, only);
  return had;
}

/** Puts back what a clearRolls(layer, only) took out, definition for definition. */
export function restoreRolls(had, layer = 'buffer', only = null) {
  for (const [kind, store] of Object.entries(stores)) store.restore(had?.[kind], layer, only);
}

export const registerRoll = (id, sig) => stores.roll.register(id, sig);
export const lookupRoll = (id) => stores.roll.lookup(id);
export const rollIds = () => stores.roll.ids();

export const registerShape = (id, points) => stores.shape.register(id, points);
export const lookupShape = (id) => stores.shape.lookup(id);
export const shapeIds = () => stores.shape.ids();

// A preset's value is { plugin, state }, not a Sig: `state` is the plugin's own program (gzip +
// base64, often megabytes) or a "@id" handle standing for one the host has put away somewhere -
// either way an opaque string, resolved at the point it is loaded into a plugin. `plugin` is the
// name it was captured from. An empty `state` is a named-but-not-yet-captured
// preset - the editor writes those the moment a pattern says a name, and auto-pin fills them in.
//
// A preset is keyed by that PLUGIN as well as its name, because a program is only meaningful to
// the plugin that wrote it: `disco` on a delay and `disco` on a reverb are two unrelated sounds
// that happen to share a word, and keying them apart is what lets a chain of three effects each
// carry a preset called `disco` rather than disco1/disco2/disco3. The store underneath is the same
// two-layer one every kind uses - only the key is composite.
const PRESET_KEY_SEP = '\u0000'; // in neither a plugin name nor a preset id, so the split is exact
const presetKey = (plugin, id) => `${String(plugin ?? '').trim()}${PRESET_KEY_SEP}${id}`;

// The store's own "defined twice" line would name the composite key, separator and all. Only two
// definitions of the same name FOR THE SAME PLUGIN collide now, so the warning says which plugin.
export function registerPreset(id, entry) {
  if (!stores.preset.register(presetKey(entry?.plugin, id), entry)) return null;
  const plugin = String(entry?.plugin ?? '').trim();
  return `[signal] preset ${JSON.stringify(id)}${plugin ? ` (${plugin})` : ''} is defined twice - the later definition wins`;
}

/**
 * What `name` means in a slot holding `plugin`: the exact pair, or - failing that - the same name
 * with no plugin at all, which is a preset the editor has NAMED but nothing has been captured into
 * yet. That placeholder belongs to whichever slot captures into it first (see Sig#preset's
 * authoring loop), so until then it answers to any plugin that asks.
 *
 * With no plugin to go on - a slot past the end of the chain, a call the editor can't aim - any
 * preset of that name will do. Refusing there would break patches that worked before presets were
 * keyed this way, and the caller already has no way to tell whether the answer is right.
 */
export function lookupPreset(id, plugin = null) {
  const scoped = String(plugin ?? '').trim();
  if (scoped) return stores.preset.lookup(presetKey(scoped, id)) ?? stores.preset.lookup(presetKey('', id));
  return stores.preset.lookup(presetKey('', id)) ?? presetEntries().find((e) => e.id === id)?.entry ?? null;
}

/** Every preset, its name and the plugin it was captured from split back out of the key. */
function presetEntries() {
  return stores.preset.ids().map(({ id: key, layer }) => {
    const at = key.indexOf(PRESET_KEY_SEP);
    return { id: key.slice(at + 1), plugin: key.slice(0, at), layer, entry: stores.preset.lookup(key) };
  });
}

export const presetIds = () => presetEntries().map(({ id, plugin, layer }) => ({ id, plugin, layer }));

/**
 * Which plugins define a preset by this name - what turns "no preset called disco" into "there is
 * a disco, but it belongs to ValhallaDelay and this slot holds Serum 2", which is the difference
 * between a dead end and a fixable mistake.
 */
export const presetPluginsFor = (id) =>
  [...new Set(presetEntries().filter((e) => e.id === id && e.plugin).map((e) => e.plugin))];

// A named sample pack's value is { files }: the paths it was built from, in index order. Each is a
// file, or a folder standing for every audio file in it; a relative one is under the samples root,
// an absolute one is wherever it says. Plain data, not a Sig - the engine turns it into loaded
// buffers (see OscEngine#defineSamplePacks), and `sp("kit")` addresses it by name plus index the
// way `s("bd")` addresses a folder.
export const registerPack = (id, entry) => stores.pack.register(id, entry);
export const lookupPack = (id) => stores.pack.lookup(id);
export const packIds = () => stores.pack.ids();
