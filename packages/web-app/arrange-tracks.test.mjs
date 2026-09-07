// The arrangement painter's track model (public/client.js): one row per labelled block, the
// migration off the old `$: arrange(…)` call, and the fill that makes "a row with no clips is
// silent" a safe rule to have.
//
// None of it can be seen going wrong in the UI until it already has: a track that joins the song
// unfilled is a part that stops playing, and a migration that misses a call is a song that opens
// empty. All three are ordinary list/string work, so they are lifted out of the shipped client.js
// rather than copied - this fails if they drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as arrangeMod from '../pattern-core/src/arrange.mjs';
import * as labelsMod from '../pattern-core/src/labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'public', 'client.js'), 'utf8');

/**
 * One function's source, out of the shipped client.js. Counts braces past strings, comments and
 * regex literals rather than through them - `text.startsWith('{')` is a real line in here, and a
 * counter that took it for an open brace would swallow the rest of the file.
 */
function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  const start = SRC.indexOf('{', at);
  for (let i = start; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '/' && SRC[i + 1] === '/') { i = SRC.indexOf('\n', i); continue; }
    if (c === '/' && SRC[i + 1] === '*') { i = SRC.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < SRC.length && SRC[i] !== c; i++) if (SRC[i] === '\\') i++;
      continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*]\s*$/.test(SRC.slice(Math.max(0, i - 40), i))) {
      // a regex literal, not a division: run to its unescaped close
      for (i++; i < SRC.length && SRC[i] !== '/'; i++) {
        if (SRC[i] === '\\') i++;
        else if (SRC[i] === '[') for (i++; i < SRC.length && SRC[i] !== ']'; i++) if (SRC[i] === '\\') i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`${name} did not close - the grab helper needs updating`);
}

function grabConst(name) {
  const m = new RegExp(`^const ${name} = [^\\n]*;$`, 'm').exec(SRC);
  assert.ok(m, `${name} not found in client.js`);
  return m[0];
}

/** A CodeMirror stand-in over a plain string: index/position round trips and range replacement. */
function fakeCm(text) {
  const cm = {
    text,
    getValue: () => cm.text,
    posFromIndex: (i) => ({ i }),
    indexFromPos: (p) => p.i,
    replaceRange(str, from, to) {
      cm.text = cm.text.slice(0, from.i) + str + cm.text.slice((to ?? from).i);
    },
  };
  return cm;
}

const LIFTED = ['matchParen', 'codeOnly', 'arFindDef', 'arMigrateLegacy', 'arMigrateOneLegacy', 'arReadDef', 'parseArrangeCall',
  'arCallOpts', 'serializeArrangeCall', 'arRefreshRows', 'arLabels', 'arTrackLabels',
  'arReconcileTracks', 'arWriteDefText']
  .map(grab)
  .concat([grabConst('arRowLabel'), grabConst('arRowOfLabel'), grabConst('arFillClip')])
  .join('\n\n');

/** The lifted functions over a fake editor and (optionally) a fake open panel. */
function panel({ code = '', arState = null } = {}) {
  const cm = fakeCm(code);
  const logged = [];
  const env = {
    cm,
    arState,
    arrangeMod,
    labelsMod,
    arSuppressClose: false,
    logLine: (line) => logged.push(line),
    refoldAll: () => {},
    arSizeCanvas: () => {},
    writeArrangeCall: () => {},
    drawArrange: () => {},
  };
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(env), `${LIFTED}\nreturn { arFindDef, arMigrateLegacy, arReadDef, serializeArrangeCall, arRefreshRows, arReconcileTracks, arFillClip, arRowLabel, arRowOfLabel };`);
  return { fns: build(...Object.values(env)), cm, logged, arState };
}

/** Just enough panel state for the row functions - the fields they actually touch. */
const state = (clips = []) => ({ clips, rows: [], track: null });

// ---------------------------------------------------------------------------------------------
// Rows are tracks
// ---------------------------------------------------------------------------------------------

const SONG = [
  'kick: pianoroll("kick")',
  'bass: pianoroll("bass")',
  'hats: s("hh*8")',
  '$: setbpm(140)',
].join('\n');

test('a row per labelled block, in the order the buffer writes them', () => {
  const st = state();
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats']);
  assert.ok(st.rows.every((r) => r.own));
  assert.equal(st.track, 'kick', 'and the first is selected, so a key press has a target');
});

test('an anonymous block is not a track and gets no row', () => {
  const st = state();
  panel({ code: SONG, arState: st }).fns.arRefreshRows();
  assert.ok(!st.rows.some((r) => r.label.startsWith('$')));
});

test('clips whose block is gone keep an orphan row, after the real ones', () => {
  const st = state(arrangeMod.parseArrangement('kick,0,8 ghost,0,4'));
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats', 'ghost']);
  assert.equal(st.rows.at(-1).own, false, 'drawn faded, and clearable - not invisible');
});

test('a clip finds its row by label, and a row its label', () => {
  const st = state(arrangeMod.parseArrangement('hats,0,8'));
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.equal(fns.arRowOfLabel('hats'), 2);
  assert.equal(fns.arRowLabel(2), 'hats');
  assert.equal(fns.arRowLabel(9), null, 'past the last track is not a row');
});

// ---------------------------------------------------------------------------------------------
// The fill: what makes an empty row mean silence
// ---------------------------------------------------------------------------------------------

test('a track joins the arrangement playing throughout', () => {
  const { fns } = panel();
  assert.deepEqual(fns.arFillClip('pad', 24), { label: 'pad', start: 0, len: 24, roll: null });
  assert.equal(fns.arFillClip('pad', 0).len, 1, 'never zero-length, whatever the song says');
});

test('a track typed since the last evaluation is filled into the definition, panel shut', () => {
  const p = panel({ code: `${SONG}\n\n_arrange("kick,0,8", { len: 8, tracks: ["kick", "bass"] })\n` });
  assert.equal(p.fns.arReconcileTracks(), true);
  const read = p.fns.arReadDef();
  assert.deepEqual(read.opts.tracks, ['kick', 'bass', 'hats'], 'hats has joined');
  assert.deepEqual(read.clips.filter((c) => c.label === 'hats'), [{ label: 'hats', start: 0, len: 8, roll: null }]);
  assert.deepEqual(read.clips.filter((c) => c.label === 'bass'), [], 'bass was already in it, and silent on purpose');
  assert.equal(p.fns.arReconcileTracks(), false, 'and again is a no-op');
});

test('a buffer with no arrangement is left completely alone', () => {
  const p = panel({ code: SONG });
  assert.equal(p.fns.arReconcileTracks(), false);
  assert.equal(p.cm.text, SONG);
});

// ---------------------------------------------------------------------------------------------
// Writing the definition
// ---------------------------------------------------------------------------------------------

test('the painter writes _arrange(...), options only when they say something', () => {
  const { fns } = panel();
  const base = { clips: arrangeMod.parseArrangement('kick,0,8'), snap: 'auto', len: null, autos: [], loops: [] };
  assert.equal(fns.serializeArrangeCall(base), '_arrange("kick,0,8")');
  assert.equal(
    fns.serializeArrangeCall({ ...base, len: 24, snap: 4, autos: ['filter'] }),
    '_arrange("kick,0,8", { snap: 4, len: 24, autos: ["filter"] })',
  );
  assert.equal(fns.serializeArrangeCall({ ...base, clips: [] }), '_arrange()');
});

test('a bound clip round-trips through the call', () => {
  const { fns } = panel();
  const text = fns.serializeArrangeCall({ clips: arrangeMod.parseArrangement('kick,0,8 kick:fill,12,4'), snap: 'auto', len: null, autos: [], loops: [] });
  const read = panel({ code: text }).fns.arReadDef();
  assert.deepEqual(read.clips.map((c) => c.roll), [null, 'fill']);
});

// ---------------------------------------------------------------------------------------------
// The migration off `$: arrange(…)`
// ---------------------------------------------------------------------------------------------

test('an old song\'s arrange() block becomes an _arrange(...) definition', () => {
  const old = `${SONG}\n\n$: arrange("kick,0,0,8 bass,1,4,4", { len: 8 })\n`;
  const p = panel({ code: old });
  assert.equal(p.fns.arMigrateLegacy(), true);
  assert.match(p.cm.text, /^_arrange\("kick,0,0,8 bass,1,4,4", \{ len: 8 \}\)$/m);
  assert.ok(!/\$: arrange/.test(p.cm.text), 'the label goes with it - a definition is a bare statement');
  // ...and what it now reads as is the same song, on the new clip format
  const read = p.fns.arReadDef();
  assert.deepEqual(read.clips, [
    { label: 'kick', start: 0, len: 8, roll: null },
    { label: 'bass', start: 4, len: 4, roll: null },
  ]);
  assert.equal(read.opts.len, 8);
});

test('a buffer already on _arrange is left alone', () => {
  const p = panel({ code: `${SONG}\n\n_arrange("kick,0,8")\n` });
  assert.equal(p.fns.arMigrateLegacy(), false);
  assert.match(p.cm.text, /_arrange\("kick,0,8"\)/);
  assert.ok(p.fns.arFindDef(), 'and it is found as the buffer\'s arrangement');
});

test('the word arrange inside a comment or a string is not a call', () => {
  const p = panel({ code: `// arrange("nope,0,0,4")\nkick: s("bd").fx("Rearrange")\n` });
  assert.equal(p.fns.arMigrateLegacy(), false);
  assert.equal(p.fns.arFindDef(), null);
});
