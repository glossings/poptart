// The roll registry - drawn piano rolls kept under an id so a pattern can name them instead of
// carrying their notes inline: `roll(0, "60,0,4 …")` defines one, `pianoroll("<0 chorus>")` plays
// them in turn. The definitions are still ordinary code in the buffer (the editor folds them out
// of the way rather than hiding them), so export, snapshots and undo are untouched; this store is
// only how a call finds the roll an id names at playback time.
//
// Like macros.mjs and midi.mjs this lives apart from signal.mjs so both stay dependency-free: the
// browser imports the same signal code against its own copy of the store.
//
// TWO LAYERS, because they have different lifetimes:
//
//   buffer   ids defined by the editor buffer. Cleared at the top of every evaluation - a roll
//            whose definition you just deleted has to stop existing, exactly like a track whose
//            label disappeared (an accumulating registry would keep playing the old notes).
//   prebake  ids defined by ~/.poptart/prebake.js - a personal library shared by every patch.
//            Cleared only when prebake itself re-runs, so a buffer eval never drops it.
//
// The buffer shadows prebake on a shared id, which is the rule the evaluator already uses for
// prebake's `const` bindings.

const layers = { buffer: new Map(), prebake: new Map() };

let current = 'buffer'; // which layer registerRoll writes to (the host sets this around prebake)

/** Where subsequent roll() definitions land. The host wraps its prebake run in this. */
export function setRollLayer(layer) {
  current = layer === 'prebake' ? 'prebake' : 'buffer';
}

/** Drops every id in one layer. The host calls this for 'buffer' at the top of each evaluation. */
export function clearRolls(layer = 'buffer') {
  layers[layer === 'prebake' ? 'prebake' : 'buffer'].clear();
}

/**
 * Files a roll under `id` in the current layer. Returns a warning string when the id was already
 * taken IN THIS LAYER and is being replaced - two roll(0, …) definitions in one buffer means one
 * of them silently never plays, which is worth a line on the console rather than a throw.
 */
export function registerRoll(id, sig) {
  const store = layers[current];
  const replaced = store.has(id);
  store.set(id, sig);
  return replaced ? `[signal] roll ${JSON.stringify(id)} is defined twice - the later definition wins` : null;
}

/** The roll an id names, buffer first, or null if nothing defines it. */
export function lookupRoll(id) {
  return layers.buffer.get(id) ?? layers.prebake.get(id) ?? null;
}

/**
 * Every id currently defined, buffer first then prebake, each with the layer it came from. This is
 * what the editor's roll picker lists - it names what is actually playable right now, which the
 * code text alone can't say (prebake isn't in the buffer).
 */
export function rollIds() {
  const out = [...layers.buffer.keys()].map((id) => ({ id, layer: 'buffer' }));
  for (const id of layers.prebake.keys()) if (!layers.buffer.has(id)) out.push({ id, layer: 'prebake' });
  return out;
}
