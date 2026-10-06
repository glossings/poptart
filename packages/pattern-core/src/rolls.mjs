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

// EACH DECK HAS ITS OWN BUFFER LAYER. Two songs on the desk are two buffers, and songs name
// their definitions the same way - nearly every one has a Serum preset called `bass` - so one
// shared namespace meant evaluating the incoming song re-filed the playing song's `bass` with the
// incoming one's program, and the playing deck's next cycle pushed that program into its live
// plugin: a state reload mid-set, voices killed and the plugin suspended while it chewed the blob
// (heard as the whole deck freezing on every load; 2026-10-06), and same-named piano rolls
// trading notes between decks.
//
// A deck's buffer definitions live under its SCOPE: an opaque token, replaced wholesale at the top
// of each evaluation (clearRolls) and put back if the evaluation fails (restoreRolls). Anything
// built during an evaluation that looks a name up LATER - a pianoroll() selector, clips(), auto(),
// .slices() - captures the scope it was built under (defScope) and reads only that. A scheduler
// reads by its deck (defScopeOf). Complete-mix hands the incoming deck's scope to the main deck
// whole (adoptDefs), so every Sig it promotes keeps reading exactly what it was built against.
let scopes = { a: {}, b: {} };
let owner = 'a'; // which deck's evaluation buffer definitions belong to (see setDefOwner)
let layerNow = 'buffer'; // which layer register writes to (the host sets this around prebake)
let lookupDeck = null; // the deck a running scheduler is building for (see withDefDeck)
const deckOf = (d) => (d === 'b' ? 'b' : 'a');
const otherDeck = (d) => (d === 'a' ? 'b' : 'a');

/**
 * Which buffers an uncaptured lookup reads. Inside a scheduler's own work it is that deck's alone.
 * Elsewhere (host listings, an evaluation's own pass) it is the deck being evaluated, then the
 * other - a name only one deck defines is still found by a caller with no deck in hand.
 */
function scopesFor(scope) {
  if (scope) return [scope];
  if (lookupDeck) return [scopes[lookupDeck]];
  if (scope === null) return [scopes[owner]]; // built during prebake: whoever is asking now
  return [scopes[owner], scopes[otherDeck(owner)]];
}

/** One store: a buffer map per scope, plus the shared prebake layer. */
function makeStore(what) {
  const buffers = new WeakMap(); // scope -> Map; a scope nothing holds any more is collected
  let prebake = new Map();
  const bufferOf = (scope, make = false) => {
    let m = buffers.get(scope);
    if (!m && make) {
      m = new Map();
      buffers.set(scope, m);
    }
    return m ?? null;
  };
  return {
    clearPrebake() {
      const had = prebake;
      prebake = new Map();
      return had;
    },
    restorePrebake(had) {
      prebake = new Map(had ?? []);
    },
    /**
     * Files `value` under `id` in the current layer - the prebake library, or the evaluating
     * deck's scope. Returns a warning string when the id was already taken THERE - two
     * definitions of one name in a buffer means one of them silently never plays, which is worth
     * a line on the console rather than a throw. The other deck defining the same name is not a
     * clash: it is the other song's.
     */
    register(id, value) {
      const store = layerNow === 'prebake' ? prebake : bufferOf(scopes[owner], true);
      const replaced = store.has(id);
      store.set(id, value);
      return replaced ? `[signal] ${what} ${JSON.stringify(id)} is defined twice - the later definition wins` : null;
    },
    /**
     * What a name means, buffer first, or null if nothing defines it. `layer` asks one layer
     * alone - 'prebake' is how a host reads the LIBRARY's copy of a name some buffer also
     * defines. `scope` is the deck scope a caller captured (see scopesFor for the rest).
     */
    lookup(id, layer = null, scope = undefined) {
      if (layer === 'prebake') return prebake.get(id) ?? null;
      for (const sc of scopesFor(scope)) {
        const m = bufferOf(sc);
        if (m?.has(id)) return m.get(id);
      }
      return layer === 'buffer' ? null : (prebake.get(id) ?? null);
    },
    /**
     * Every name currently defined, buffer first then prebake, each with the layer it came from -
     * both decks' buffers, each name once. This is what the editor's pickers list - it names
     * what is actually playable right now, which the code text alone can't say (prebake isn't in
     * the buffer).
     *
     * `layer` is where the name resolves; `library` is whether prebake defines it AT ALL, which is
     * a different question the moment a buffer carries its own copy of a library name. The editor
     * needs the second one: it decides what a bare `sp("hats")` in a new buffer means by asking
     * whether the library has a "hats", and a list that forgot the library's copy whenever some
     * song shadowed it had the editor writing an empty definition over it (2026-09-20).
     */
    ids() {
      const inBuffer = new Set();
      for (const d of [owner, otherDeck(owner)]) for (const id of bufferOf(scopes[d])?.keys() ?? []) inBuffer.add(id);
      const out = [...inBuffer].map((id) => ({ id, layer: 'buffer', library: prebake.has(id) }));
      for (const id of prebake.keys()) if (!inBuffer.has(id)) out.push({ id, layer: 'prebake', library: true });
      return out;
    },
  };
}

const stores = {
  roll: makeStore('roll'),
  shape: makeStore('shape'),
  preset: makeStore('preset'),
  pack: makeStore('sample pack'),
  slices: makeStore('slice set'),
  auto: makeStore('automation'),
  groove: makeStore('groove'),
};

/** Every kind, for the host passes that treat them alike (clearing per eval, listing). */
export const DEF_KINDS = Object.keys(stores);

export function setRollLayer(layer) {
  layerNow = layer === 'prebake' ? 'prebake' : 'buffer';
}

/** Which deck's evaluations subsequent buffer definitions belong to ('a' at rest). */
export function setDefOwner(deck) {
  owner = deckOf(deck);
}

/**
 * The scope a definition made right now would be filed under - what a lazily-resolving Sig
 * captures when it is built, so it reads its own deck's names however late it asks. Null during
 * prebake, whose patterns belong to no deck.
 */
export function defScope() {
  return layerNow === 'prebake' ? null : scopes[owner];
}

/** A deck's current scope - for a reader that knows its deck but captured nothing (a scheduler). */
export function defScopeOf(deck) {
  return scopes[deckOf(deck)];
}

/** Runs `fn` with uncaptured lookups reading `deck`'s definitions alone (a scheduler's own work). */
export function withDefDeck(deck, fn) {
  const prev = lookupDeck;
  lookupDeck = deck == null ? null : deckOf(deck);
  try {
    return fn();
  } finally {
    lookupDeck = prev;
  }
}

/**
 * The incoming deck's definitions become the main deck's - the complete-mix promotion. The scope
 * itself moves, so the promoted Sigs, which captured it, keep reading their own definitions, and
 * the main deck's next eval clears and refills them like its own (which they now are). The
 * incoming deck starts empty.
 */
export function adoptDefs(from, to) {
  scopes = { ...scopes, [deckOf(to)]: scopes[deckOf(from)], [deckOf(from)]: {} };
}

/**
 * Empties one layer, and returns what was in it - hand that back to restoreRolls to undo the
 * clear. For 'buffer', `only` names the deck (both when null); the deck gets a fresh scope.
 *
 * The host clears a deck's buffer at the top of each evaluation and fills it from the buffer
 * again, which is what makes a definition you just deleted stop playing. But an evaluation that
 * THROWS applies nothing else - the tracks that were playing go on playing, out of the Sigs they
 * were built with - and those Sigs resolve their definitions BY NAME, lazily, every cycle (see
 * rollPattern). So the clear is a transaction - the host restores what it took out when the
 * evaluation building the replacement doesn't reach the end. (Those playing Sigs read their own
 * captured scope, which a clear never empties - the restore is for the scheduler-side readers.)
 */
export function clearRolls(layer = 'buffer', only = null) {
  if (layer === 'prebake') {
    const had = {};
    for (const [kind, store] of Object.entries(stores)) had[kind] = store.clearPrebake();
    return { prebake: had };
  }
  const decks = only != null ? [deckOf(only)] : ['a', 'b'];
  const had = { scopes: {} };
  for (const d of decks) had.scopes[d] = scopes[d];
  const fresh = { ...scopes };
  for (const d of decks) fresh[d] = {};
  scopes = fresh;
  return had;
}

/** Puts back what a clearRolls(layer, only) took out, definition for definition. */
export function restoreRolls(had, layer = 'buffer') {
  if (layer === 'prebake') {
    for (const [kind, store] of Object.entries(stores)) store.restorePrebake(had?.prebake?.[kind]);
    return;
  }
  if (had?.scopes) scopes = { ...scopes, ...had.scopes };
}

export const registerRoll = (id, sig) => stores.roll.register(id, sig);
export const lookupRoll = (id, scope) => stores.roll.lookup(id, null, scope);
export const rollIds = () => stores.roll.ids();

export const registerShape = (id, points) => stores.shape.register(id, points);
export const lookupShape = (id, scope) => stores.shape.lookup(id, null, scope);
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
export function lookupPreset(id, plugin = null, scope = undefined) {
  const scoped = String(plugin ?? '').trim();
  const at = (key) => stores.preset.lookup(key, null, scope);
  if (scoped) return at(presetKey(scoped, id)) ?? at(presetKey('', id));
  return at(presetKey('', id)) ?? presetEntries().find((e) => e.id === id)?.entry ?? null;
}

/** Every preset, its name and the plugin it was captured from split back out of the key. */
function presetEntries() {
  return stores.preset.ids().map(({ id: key, layer, library }) => {
    const at = key.indexOf(PRESET_KEY_SEP);
    return { id: key.slice(at + 1), plugin: key.slice(0, at), layer, library, entry: stores.preset.lookup(key) };
  });
}

export const presetIds = () => presetEntries().map(({ id, plugin, layer, library }) => ({ id, plugin, layer, library }));

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
export const lookupPack = (id, layer = null, scope = undefined) => stores.pack.lookup(id, layer, scope);
export const packIds = () => stores.pack.ids();

// A named slice set's value is the set itself - normalized (0..1) start points in ascending order,
// one per slice, exactly what the engine's own transient analysis produces, keyed by the file they
// were drawn on (see slices.mjs). Plain data like a pack's file list, not a Sig: `.slices("break")`
// looks the name up at emit time and puts the set on the event, the engine picks the entry for the
// file it resolved, and `.slice(n)` indexes into that (see Sig#slices).
export const registerSlices = (id, set) => stores.slices.register(id, set);
export const lookupSlices = (id, layer = null, scope = undefined) => stores.slices.lookup(id, layer, scope);
export const sliceSetIds = () => stores.slices.ids();

// A named automation's value is its breakpoint list ({x: bar, y: value, c: curve}, ascending x -
// see shape.mjs parseAutoPoints). Plain data like a shape's points: `auto("intro")` samples the
// list by name at read time, so a lane drag re-registering the id is heard without a re-eval.
export const registerAuto = (id, points) => stores.auto.register(id, points);
export const lookupAuto = (id, layer = null, scope = undefined) => stores.auto.lookup(id, layer, scope);
export const autoIds = () => stores.auto.ids();

// A named groove's value is its table ({ steps, time, vel } - see groove.mjs), frozen plain data
// like a shape's points. `.swing(1, "samba")` looks the name up at read time (resolveGroove), so a
// drag in the groove lane is heard without a re-eval, and a groove defined here shadows a built-in
// preset of the same name - the buffer-shadows-library rule, one step further out.
export const registerGroove = (id, table) => stores.groove.register(id, table);
export const lookupGroove = (id, layer = null, scope = undefined) => stores.groove.lookup(id, layer, scope);
export const grooveIds = () => stores.groove.ids();
