// Turning a block of somebody's code into a pattern - the browser's half.
//
// This is the same job server.js does for the desktop, and the two have to stay the same job:
// the names bound in an evaluated block ARE the language, so a builder that exists on one side
// and not the other is a pattern that runs in one build and throws in the other. They are not
// one piece of code yet - the desktop's is wired into module state that does not exist here -
// so instead a test reads the lists out of server.js's source and fails if they have drifted.
// That is the same guard the engine wrapper has, and it exists for the same reason: the failure
// it catches is silent and only shows up in somebody else's browser.
//
// The two tricks that make a buffer behave like one script, both inherited from the desktop:
//
//   - Top-level `const`/`let` are rewritten to `var`, because declarations inside a direct eval
//     are scoped to that eval alone and would not be visible to the block below.
//   - What each block declared is harvested out and re-injected as parameters into every later
//     block, which is what lets `const kick = …` at the top of a buffer be used at the bottom.

/**
 * Every name pattern-core provides to an evaluated block.
 *
 * Kept as data rather than derived from the module, because it is also what autocomplete and the
 * documentation are built from: a name being importable is not the same as it being part of the
 * language, and the difference is the whole reason this list is written out.
 */
export const BUILDER_NAMES = Object.freeze(['Signal', 'n', 'note', 'mini', 's', 'se', 'sr', 'sp', 'synth', 'sine', 'saw', 'isaw', 'tri', 'square', 'rand', 'perlin', 'lfo', 'env', 'dur', 'midicc', 'midikeys', 'osc', 'macro', 'choose', 'cat', 'seq', 'irand', 'midi', 'audio', 'input', 'group', 'copy', 'pcopy', 'pianoroll', 'clips', 'auto',
  'i', 'begin', 'end', 'loop', 'loopwrap', 'loopdir', 'speed', 'flip', 'stretch', 'fit', 'slice', 'splice', 'splicemode', 'attack', 'decay', 'sustain', 'release', 'envscale', 'grain', 'vel', 'clip', 'nudge', 'swing', 'swinggrid',
  'add', 'sub', 'mul', 'div', 'mod', 'set',
  'noteToMidi', 'degreeToMidi', 'parseScaleName']);

/** Builders the editor writes and nobody types: the calls behind a drawn roll, a shape, a pack. */
export const INTERNAL_BUILDERS = Object.freeze(['_roll', '_shape', '_preset', '_pack', '_slices', '_auto', '_arrange']);

/** What a `setbpm(...)` block evaluates to, so a tempo-only block is not mistaken for a pattern. */
export const TEMPO_BLOCK = Object.freeze({ poptartTempoBlock: true });

/** The same, for `setscale(...)`. */
export const SCALE_BLOCK = Object.freeze({ poptartScaleBlock: true });

/**
 * Pure helpers a prebake file may call.
 *
 * In the browser the editor's own API - hotkey, the editor handle, prompt - is real and comes
 * from the page, so it is not shimmed here. What IS here is the handful of utilities that are
 * meaningful anywhere and would otherwise be a ReferenceError inside a shared prebake file.
 */
export const PREBAKE_UTILS = Object.freeze({
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  rotate: (arr, n) => {
    const len = arr.length;
    if (!len) return arr.slice();
    const k = ((n % len) + len) % len;
    return arr.slice(k).concat(arr.slice(0, k));
  },
  bjorklund: (pulses, steps) => {
    pulses = Math.max(0, Math.min(Math.floor(pulses), Math.floor(steps)));
    steps = Math.max(0, Math.floor(steps));
    if (steps === 0) return [];
    if (pulses === 0) return new Array(steps).fill(false);
    let groups = Array.from({ length: pulses }, () => [true]);
    let rem = Array.from({ length: steps - pulses }, () => [false]);
    while (rem.length > 1) {
      const n = Math.min(groups.length, rem.length);
      const ng = [];
      const nr = [];
      for (let i = 0; i < n; i++) ng.push(groups[i].concat(rem[i]));
      if (groups.length > n) for (let i = n; i < groups.length; i++) nr.push(groups[i]);
      else for (let i = n; i < rem.length; i++) nr.push(rem[i]);
      groups = ng;
      rem = nr;
    }
    return groups.concat(rem).flat();
  },
});

/**
 * Mirrors userland language extensions onto bare strings.
 *
 * A method somebody adds to Signal's prototype works on a mini string too - `"bd*4".co()` - by
 * wrapping the string in mini() first. Never shadows a real String method, because `.slice()`
 * meaning two different things depending on what is in scope is not a feature.
 */
export function syncUserStringMethods(patternCore, builtins) {
  for (const m of Object.getOwnPropertyNames(patternCore.Sig.prototype)) {
    if (builtins.has(m) || m in String.prototype) continue;
    if (typeof patternCore.Sig.prototype[m] !== 'function') continue;
    Object.defineProperty(String.prototype, m, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(...args) {
        return patternCore.mini(String(this))[m](...args);
      },
    });
  }
}

/** The method names Signal had before any userland block ran. */
export function builtinSigMethods(patternCore) {
  return new Set(Object.getOwnPropertyNames(patternCore.Sig.prototype));
}

/**
 * Builds the function that evaluates one block.
 *
 * `defs` accumulates down the buffer and is seeded from the prebake, so a binding made once is
 * in scope everywhere below it. `hostBuilders` is what the HOST provides rather than the
 * language - setbpm and setscale, which need a transport and a global key to act on.
 */
export function createBlockEvaluator(patternCore, {
  defs = new Map(),
  hostBuilders = {},
  utils = PREBAKE_UTILS,
  builtins = null,
} = {}) {
  const known = builtins ?? builtinSigMethods(patternCore);
  const macroNames = Array.from({ length: patternCore.MACRO_COUNT }, (_, i) => `macro${i + 1}`);

  const evalBlock = function evalBlock(code, locBase) {
    const declNames = [
      ...new Set([...code.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])),
    ];
    // Playback-highlight source locations: a real editor block carries its document offset, so
    // pattern-position string literals are wrapped in mini("…", OFFSET) and the steps they emit
    // can be traced back to the characters that made them. A prebake block passes none.
    const located = typeof locBase === 'number' ? patternCore.injectLocations(code, locBase) : code;
    const body = located.replace(/^([ \t]*)(?:const|let)(\s+)/gm, '$1var$2');

    const baseNames = [...BUILDER_NAMES, ...INTERNAL_BUILDERS, ...macroNames, ...Object.keys(hostBuilders)]
      .filter((n) => !defs.has(n));      // a userland definition may shadow a builder
    const baseValues = baseNames.map((n) => {
      if (n in hostBuilders) return hostBuilders[n];
      if (macroNames.includes(n)) return patternCore.macro(Number(n.slice(5)));
      return patternCore[n];
    });
    const utilNames = Object.keys(utils).filter((n) => !defs.has(n) && !baseNames.includes(n));
    const utilValues = utilNames.map((n) => utils[n]);

    const harvest = declNames
      .map((n) => `${JSON.stringify(n)}: (typeof ${n} === 'undefined' ? undefined : ${n})`)
      .join(', ');
    // eslint-disable-next-line no-new-func
    const build = new Function(
      ...baseNames,
      ...utilNames,
      ...defs.keys(),
      '__blockCode',
      `var __value = eval(__blockCode); return { __value: __value, __defs: { ${harvest} } };`,
    );
    const { __value, __defs } = build(...baseValues, ...utilValues, ...defs.values(), body);
    for (const [n, v] of Object.entries(__defs)) if (v !== undefined) defs.set(n, v);
    syncUserStringMethods(patternCore, known);   // the block may have extended Signal's prototype
    return __value;
  };
  evalBlock.defs = defs;
  return evalBlock;
}
