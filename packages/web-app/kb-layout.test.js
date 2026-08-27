'use strict';

// kbBuildScaleMap - the note layout behind the piano roll's ⌨ keyboard, for both the `piano` and
// the `in key` settings. There is only one rule and both layouts are it, differing only in the
// scale fed in: the home row is the scale's notes from its tonic, and the row above bends them by
// where it sits - the key up-and-right of a note sharpens it, the key up-and-left flattens it.
//
// What is pinned here is that the rule is TOTAL. Every upper key plays something in every scale,
// so no key is silent in one key and a note in another; the cost is that the two bends sometimes
// land on a note the home row already has, and those redundancies are asserted rather than merely
// tolerated. The rule's one blind spot is a scale that steps by four, which would leave a note no
// bend can reach - so the interval table is checked for that too, and fails here if one is added.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseScaleName } = require('@poptart/pattern-core');

// Lifted out of the browser script the way pane-resize.test.js lifts its subject: the builder is
// plain arithmetic over the two key rows, so it runs as-is once they come along with it.
function loadLayout() {
  const src = fs.readFileSync(path.join(__dirname, 'public/client.js'), 'utf8');
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `${needle} not found in public/client.js - this test needs updating`);
    return i;
  };
  const through = (needle) => src.indexOf('\n', at(needle));
  const rows = src.slice(at('const KB_HOME_KEYS'), through('const KB_PIANO_INTERVALS'));
  const semis = src.slice(at('const KB_SEMITONES'), through('const KB_SEMITONES'));
  const fn = src.slice(at('function kbBuildScaleMap('), src.indexOf('\n}\n', at('function kbBuildScaleMap(')) + 3);
  return new Function(`${rows}\n${semis}\n${fn}
    return { kbBuildScaleMap, KB_SEMITONES, KB_HOME_KEYS, KB_UPPER_KEYS, KB_PIANO_INTERVALS };`)();
}
const { kbBuildScaleMap, KB_SEMITONES, KB_HOME_KEYS, KB_UPPER_KEYS, KB_PIANO_INTERVALS } = loadLayout();

const mapFor = (name) => {
  const { rootMidi, intervals } = parseScaleName(name);
  return kbBuildScaleMap({ tonic: ((rootMidi % 12) + 12) % 12, intervals });
};

// Every scale the host will accept, by the name notes.mjs answers to.
const SCALES = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
  'harmonicminor', 'melodicminor', 'majpent', 'minpent', 'blues', 'chromatic'];

// The step from each home key to the next, which is what decides whether the two bends agree.
const steps = (map) => KB_HOME_KEYS.slice(0, -1).map((k, i) => map[KB_HOME_KEYS[i + 1]] - map[k]);

test('the piano layout is the rule applied to major, and still agrees with the old table', () => {
  const piano = kbBuildScaleMap({ tonic: 0, intervals: KB_PIANO_INTERVALS });
  for (const [key, semis] of Object.entries(KB_SEMITONES)) assert.equal(piano[key], semis, `key ${key}`);
  // What it adds are the three keys that table left out, and they are exactly the redundancies the
  // total rule buys: `r` is `f` over again, `i` is `k`, and `q` is the semitone below the root.
  assert.deepEqual(Object.keys(piano).filter((k) => !(k in KB_SEMITONES)).sort(), ['i', 'q', 'r']);
  assert.equal(piano.r, piano.f);
  assert.equal(piano.i, piano.k);
  assert.equal(piano.q, piano.a - 1);
});

test('no key is ever dead: every home and upper key plays in every scale', () => {
  for (const name of SCALES) {
    const map = mapFor(`c ${name}`);
    for (const key of [...KB_HOME_KEYS, ...KB_UPPER_KEYS]) {
      assert.ok(key in map, `${name} leaves "${key}" silent`);
      assert.ok(Number.isInteger(map[key]), `${name} gives "${key}" a non-integer`);
    }
  }
});

test('up-and-right sharpens the note below it, in every scale', () => {
  for (const name of SCALES) {
    const map = mapFor(`c ${name}`);
    KB_HOME_KEYS.forEach((home, i) => {
      assert.equal(map[KB_UPPER_KEYS[i + 1]], map[home] + 1, `${name}: ${KB_UPPER_KEYS[i + 1]} over ${home}`);
    });
    assert.equal(map.q, map.a - 1, `${name}: q`); // the one key with nothing below-left to sharpen
  }
});

test('up-and-left flattens the note above it, wherever that is a note of its own', () => {
  for (const name of SCALES) {
    const map = mapFor(`c ${name}`);
    const home = KB_HOME_KEYS.map((k) => map[k]);
    steps(map).forEach((step, i) => {
      const upper = map[KB_UPPER_KEYS[i + 1]];
      const flat = home[i + 1] - 1;
      // A whole-tone step - nearly every step of nearly every scale - is where both halves of the
      // heuristic are literally true at once: sharpening the note below and flattening the note
      // above name the same key and the same pitch.
      if (step === 2) assert.equal(upper, flat, `${name}: ${KB_UPPER_KEYS[i + 1]}`);
      // A step of three leaves TWO notes in one gap and one key over them: unshifted it is the
      // sharp one, and shift - which raises any key a semitone - reaches the flat one.
      else if (step === 3) assert.equal(upper + 1, flat, `${name}: shift+${KB_UPPER_KEYS[i + 1]}`);
      // A semitone step has no room between its notes, so the two readings disagree and BOTH are
      // notes the home row already has - the key is redundant whichever way it is read, which is
      // the price of the rule never going silent. (`r` in major sharpens `d` into `f`; reading it
      // as a flattened `f` would just give `d` back.)
      else {
        assert.equal(step, 1, `${name}: unexpected step of ${step}`);
        assert.ok(home.includes(upper) && home.includes(flat), `${name}: ${KB_UPPER_KEYS[i + 1]}`);
      }
    });
  }
});

test('the home row is the scale itself, root first, climbing past the octave', () => {
  // C minor: root, 2nd, b3… - `d` is the b3 the piano layout has no home-row key for.
  assert.deepEqual(KB_HOME_KEYS.map((k) => mapFor('c minor')[k]), [0, 2, 3, 5, 7, 8, 10, 12, 14]);
  // A five-note scale wraps sooner, so the same nine keys span nearly two octaves.
  assert.deepEqual(KB_HOME_KEYS.map((k) => mapFor('c minpent')[k]), [0, 3, 5, 7, 10, 12, 15, 17, 19]);
});

test('the layout moves with the key: F minor is C minor plus five semitones', () => {
  const c = mapFor('c minor');
  const f = mapFor('f minor');
  assert.deepEqual(Object.keys(f).sort(), Object.keys(c).sort());
  for (const k of Object.keys(c)) assert.equal(f[k], c[k] + 5, `key ${k}`);
});

test('with shift, the notes every scale SKIPS are still reachable', () => {
  // The scale's own notes are on the home row by construction (above); what has to be checked is
  // the chromaticism - that nothing a scale leaves out becomes unplayable by choosing this layout.
  for (const name of SCALES) {
    const map = mapFor(`c ${name}`);
    const inScale = new Set(parseScaleName(`c ${name}`).intervals.map((iv) => iv % 12));
    const reach = new Set();
    for (const key of [...KB_HOME_KEYS, ...KB_UPPER_KEYS]) {
      reach.add((((map[key] % 12) + 12) % 12)); // the key itself
      reach.add((((map[key] + 1) % 12 + 12) % 12)); // shift raises it a semitone
    }
    const missing = [...Array(12).keys()].filter((pc) => !inScale.has(pc) && !reach.has(pc));
    assert.deepEqual(missing, [], `${name} cannot reach pitch class(es) ${missing}`);
  }
});

test('no scale steps by more than three, which is what makes the above hold', () => {
  // The guard on the claim above: an upper key is the sharp one and shift takes it one further, so
  // a step of four would strand the note in its middle. Adding such a scale to notes.mjs means the
  // ⌨ needs another way to reach that note - fail here rather than silently drop it.
  for (const name of SCALES) {
    const { intervals } = parseScaleName(`c ${name}`);
    const all = intervals.map((iv, i) => (i + 1 < intervals.length ? intervals[i + 1] : 12) - iv);
    assert.ok(Math.max(...all) <= 3, `${name} steps by ${Math.max(...all)} semitones`);
  }
});
