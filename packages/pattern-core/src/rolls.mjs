// Named definitions - data kept under a name so a pattern can say the name instead of carrying
// the data: `roll(0, "60,0,4 …")` defines a piano roll and `pianoroll("<0 chorus>")` plays them in
// turn; `shape("swell", "0,0 0.7,1 1,0")` defines an LFO shape and `lfo("<swell pluck>")` runs them
// in turn; `_preset("wob", "Serum 2", "<blob>")` files a captured plugin STATE and
// .preset("<init wob>") swaps the plugin between them. The definitions are still ordinary code in
// the buffer (the editor folds them out of the way rather than hiding them), so export, snapshots
// and undo are untouched; these stores are only how a call finds what a name means at playback
// time.
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
  const pick = (layer) => layers[layer === 'prebake' ? 'prebake' : 'buffer'];

  return {
    /** Where subsequent definitions land. The host wraps its prebake run in this. */
    setLayer(layer) {
      current = layer === 'prebake' ? 'prebake' : 'buffer';
    },
    /**
     * Drops every name in one layer and hands back what was in it, so a host that clears the
     * buffer to rebuild it can put the old definitions back if the rebuild never finishes (see
     * restoreRolls).
     */
    clear(layer = 'buffer') {
      const store = pick(layer);
      const had = new Map(store);
      store.clear();
      return had;
    },
    /** Puts a layer back exactly as `had` (from clear) left it. */
    restore(had, layer = 'buffer') {
      const store = pick(layer);
      store.clear();
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
      store.set(id, sig);
      return replaced ? `[signal] ${what} ${JSON.stringify(id)} is defined twice - the later definition wins` : null;
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

const stores = { roll: makeStore('roll'), shape: makeStore('shape'), preset: makeStore('preset') };

/** Both stores, for the host passes that treat them alike (clearing per eval, listing). */
export const DEF_KINDS = Object.keys(stores);

export function setRollLayer(layer) {
  for (const store of Object.values(stores)) store.setLayer(layer);
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
export function clearRolls(layer = 'buffer') {
  const had = {};
  for (const [kind, store] of Object.entries(stores)) had[kind] = store.clear(layer);
  return had;
}

/** Puts back what a clearRolls(layer) took out, definition for definition. */
export function restoreRolls(had, layer = 'buffer') {
  for (const [kind, store] of Object.entries(stores)) store.restore(had?.[kind], layer);
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
// name it was captured from, which is what lets a swap refuse to push a Serum program into a Diva. An empty `state` is a named-but-not-yet-captured
// preset - the editor writes those the moment a pattern says a name, and auto-pin fills them in.
export const registerPreset = (id, entry) => stores.preset.register(id, entry);
export const lookupPreset = (id) => stores.preset.lookup(id);
export const presetIds = () => stores.preset.ids();
