// The arrangement painter's track model (public/client.js): one row per labeled block, the
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
import * as mixctlMod from '../pattern-core/src/mixctl.mjs';

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
  'arCallOpts', 'serializeArrangeCall', 'arRefreshRows', 'arBlocks', 'arLabels', 'arTrackLabels', 'arRowOfLabel',
  'arReconcileTracks', 'arWriteDefText', 'arCreateBlock', 'arCreateVariation', 'arNextVariantName', 'arFollowHandRenames',
  'arMakeGroup', 'arGroupLabels', 'arSetBrush']
  .map(grab)
  .concat([grabConst('arRowLabel'), grabConst('arFillClip'), grabConst('arIsGroup')])
  .join('\n\n');

/** The lifted functions over a fake editor and (optionally) a fake open panel. */
function panel({ code = '', arState = null } = {}) {
  const cm = fakeCm(code);
  const logged = [];
  const env = {
    // The painter reads and writes the deck it is on, not "the editor" - arCM is cm outside DJ
    // mode and deckBCM on deck B (see openArrangePainter).
    arCM: cm,
    arState,
    arrangeMod,
    labelsMod,
    mixctlMod,
    arLastBlocks: { a: null, b: null }, // what the last evaluation saw, per deck (see arFollowHandRenames)
    arPassDeck: 'a',
    arApplyRename: () => {},
    arSuppressClose: false,
    logLine: (line) => logged.push(line),
    arRefold: () => {}, // refoldAll, but only for the main buffer - deck B has no folds
    arSizeCanvas: () => {},
    arSyncBrushHead: () => {}, // the head is DOM; the brush it shows is on arState, which is what is tested
    writeArrangeCall: () => {},
    drawArrange: () => {},
    arScheduleEval: () => {},
    expandedFolds: new Set(),
    collapsedGroups: new Set(), // a member just made opens its group, if the group was folded shut
  };
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(env), `${LIFTED}\nreturn { arFindDef, arMigrateLegacy, arReadDef, serializeArrangeCall, arRefreshRows, arReconcileTracks, arFillClip, arRowLabel, arRowOfLabel, arCreateBlock, arCreateVariation, arNextVariantName, arFollowHandRenames, arMakeGroup, arGroupLabels, arSetBrush };`);
  return { fns: build(...Object.values(env)), cm, logged, arState };
}

/** Just enough panel state for the row functions - the fields they actually touch. */
const state = (clips = []) => ({ clips, rows: [], track: null, brush: null });

// ---------------------------------------------------------------------------------------------
// Rows are tracks
// ---------------------------------------------------------------------------------------------

const SONG = [
  'setbpm(140)', // bare, at column 0: setup, and never a row
  'kick: pianoroll("kick")',
  'bass: pianoroll("bass")',
  'hats: s("hh*8")',
  '$: s("perc*4")', // a track you didn't feel like naming - a row like any other
].join('\n');

// ...and the same song with two variations of the kick, one of them written ABOVE its base
const FAMILY = [
  'kick#fill: s("mbd*8")',
  'setbpm(140)',
  'kick: s("mbd*4")',
  'kick#outro: s("mbd*4").fx("FilterFreak 1")',
  'hats: s("hh*8")',
].join('\n');

test('variations share their base\'s row, base first, however the buffer orders them', () => {
  const st = state();
  panel({ code: FAMILY, arState: st }).fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => [r.label, r.variants]), [
    ['kick', ['kick', 'kick#fill', 'kick#outro']],
    ['hats', ['hats']],
  ]);
  assert.equal(st.brush, 'kick', 'the brush starts on the selected row\'s base');
});

test('a group\'s row carries its variations and nothing of its own; the brush lands on the first', () => {
  const st = state();
  const { fns } = panel({ code: 'kick: group().postgain(0.8)\n  #main: s("mbd*4")\n  #fill: s("mbd*8")\nhats: s("hh*8")', arState: st });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => [r.label, r.variants]), [
    ['kick', ['kick#main', 'kick#fill']],
    ['hats', ['hats']],
  ]);
  assert.equal(st.brush, 'kick#main', 'the group has nothing to paint; its first variation is what the pencil takes');
  fns.arSetBrush('hats');
  assert.equal(st.brush, 'hats');
  fns.arSetBrush('kick');
  assert.equal(st.brush, 'kick#main', 'the group\'s own name dips in its first variation');
  fns.arSetBrush('kick#fill');
  assert.equal(st.brush, 'kick#fill');
  fns.arSetBrush('nobody');
  assert.equal(st.brush, 'kick#fill', 'a label no row carries is ignored');
});

test('a variation whose base is gone is a row of its own, under its full name', () => {
  const st = state();
  panel({ code: 'kick#fill: s("mbd*8")\nhats: s("hh*8")', arState: st }).fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => [r.label, r.own]), [['kick#fill', true], ['hats', true]]);
});

test('a variation\'s clip finds the base\'s row; a brush the rows no longer carry falls back', () => {
  const st = state(arrangeMod.parseArrangement('kick#outro,12,4'));
  st.brush = 'kick#gone';
  const { fns } = panel({ code: FAMILY, arState: st });
  fns.arRefreshRows();
  assert.equal(fns.arRowOfLabel('kick#outro'), 0);
  assert.equal(fns.arRowOfLabel('kick'), 0);
  assert.equal(fns.arRowOfLabel('hats'), 1);
  assert.equal(st.brush, 'kick', 'kick#gone is nobody\'s; the brush is back on the track');
});

test('a clip naming a variation the buffer has lost keeps it on the base\'s row', () => {
  const st = state(arrangeMod.parseArrangement('kick#old,0,4'));
  const { fns } = panel({ code: FAMILY, arState: st });
  fns.arRefreshRows();
  assert.equal(fns.arRowOfLabel('kick#old'), 0, 'on kick, faded - not an orphan row of its own');
  assert.ok(st.rows[0].variants.includes('kick#old'));
});

test('a row per labeled block, in the order the buffer writes them', () => {
  const st = state();
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats', '$2']);
  assert.ok(st.rows.every((r) => r.own));
  assert.equal(st.track, 'kick', 'and the first is selected, so a key press has a target');
});

test('a $: track gets a row; a bare setup statement never does', () => {
  // Both are anonymous by label - every block that isn't named gets a `$n` - but they were WRITTEN
  // differently, and labels.mjs keeps that: `$:` promises sound, a column-0 statement is setup.
  const st = state();
  panel({ code: SONG, arState: st }).fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats', '$2'],
    'the $: track is arrangeable, in its place in the buffer; setbpm() is not there at all');
});

test('clips whose block is gone keep an orphan row, after the real ones', () => {
  const st = state(arrangeMod.parseArrangement('kick,0,8 ghost,0,4'));
  const { fns } = panel({ code: SONG, arState: st });
  fns.arRefreshRows();
  assert.deepEqual(st.rows.map((r) => r.label), ['kick', 'bass', 'hats', '$2', 'ghost']);
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
  assert.deepEqual(fns.arFillClip('pad', 24), { label: 'pad', start: 0, len: 24 });
  assert.equal(fns.arFillClip('pad', 0).len, 1, 'never zero-length, whatever the song says');
});

test('a track typed since the last evaluation is filled into the definition, panel shut', () => {
  const p = panel({ code: `${SONG}\n\n_arrange("kick,0,8", { len: 8, tracks: ["kick", "bass"] })\n` });
  assert.equal(p.fns.arReconcileTracks(), true);
  const read = p.fns.arReadDef();
  assert.deepEqual(read.opts.tracks, ['kick', 'bass', 'hats', '$2'], 'hats and the $: track have joined');
  assert.deepEqual(read.clips.filter((c) => c.label === 'hats'), [{ label: 'hats', start: 0, len: 8 }]);
  assert.deepEqual(read.clips.filter((c) => c.label === '$2'), [{ label: '$2', start: 0, len: 8 }],
    'a $: track is filled like any other - it is a track you did not name, not setup');
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

test('a variation\'s clip, and a chosen color, round-trip through the call', () => {
  const { fns } = panel();
  const text = fns.serializeArrangeCall({ clips: arrangeMod.parseArrangement('kick,0,8 kick#fill,12,4'), snap: 'auto', len: null, autos: [], loops: [], colors: { 'kick#fill': '#ff8800' } });
  assert.equal(text, '_arrange("kick,0,8 kick#fill,12,4", { colors: {"kick#fill":"#ff8800"} })');
  const read = panel({ code: text }).fns.arReadDef();
  assert.deepEqual(read.clips.map((c) => c.label), ['kick', 'kick#fill']);
  assert.deepEqual(read.opts.colors, { 'kick#fill': '#ff8800' });
});

test('a group joins the arrangement unfilled, panel open and shut', () => {
  const st = { ...state(arrangeMod.parseArrangement('hats,0,8')), tracks: ['hats'], len: 8 };
  const open = panel({ code: 'kick: group()\n  #main: s("mbd*4")\nhats: s("hh*8")\n\n_arrange("hats,0,8", { tracks: "hats" })', arState: st });
  assert.equal(open.fns.arReconcileTracks(), true);
  assert.deepEqual(st.tracks, ['hats', 'kick', 'kick#main']);
  assert.deepEqual(st.clips.map((c) => c.label), ['hats'], 'neither the group nor its variation is filled');
  const shut = panel({ code: 'kick: group()\n  #main: s("mbd*4")\nhats: s("hh*8")\n\n_arrange("hats,0,8", { len: 8, tracks: "hats" })' });
  assert.equal(shut.fns.arReconcileTracks(), true);
  const read = shut.fns.arReadDef();
  assert.deepEqual(read.clips.map((c) => c.label), ['hats'], 'no clip was written for the group');
  assert.deepEqual([...read.opts.tracks].sort(), ['hats', 'kick', 'kick#main']);
});

test('a variation typed since the last evaluation joins the arrangement UNFILLED', () => {
  // Filling it would lay it over its base for the whole song; a variation is the thing you paint.
  const p = panel({ code: `${FAMILY}\n\n_arrange("kick,0,8 hats,0,8", { len: 8, tracks: ["kick", "hats"] })\n` });
  assert.equal(p.fns.arReconcileTracks(), true);
  const read = p.fns.arReadDef();
  assert.deepEqual([...read.opts.tracks].sort(), ['hats', 'kick', 'kick#fill', 'kick#outro'], 'in the membership (which is not an order)');
  assert.deepEqual(read.clips.map((c) => c.label).sort(), ['hats', 'kick'], 'and not a clip painted for either');
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
    { label: 'kick', start: 0, len: 8 },
    { label: 'bass', start: 4, len: 4 },
  ]);
  assert.equal(read.opts.len, 8);
});

test('a buffer already on _arrange is left alone', () => {
  const p = panel({ code: `${SONG}\n\n_arrange("kick,0,8")\n` });
  assert.equal(p.fns.arMigrateLegacy(), false);
  assert.match(p.cm.text, /_arrange\("kick,0,8"\)/);
  assert.ok(p.fns.arFindDef(), 'and it is found as the buffer\'s arrangement');
});

// ---------------------------------------------------------------------------------------------
// An orphan row's block, written on demand
// ---------------------------------------------------------------------------------------------

test('a missing base becomes a silent stub after the last track, above the foot', () => {
  const p = panel({ code: 'kick: s("bd*4")\n\nhats: s("hh*8")\n\n_arrange("kick,0,8 pad,0,8")\n_roll("x", "")\n' });
  assert.equal(p.fns.arCreateBlock('pad'), true);
  assert.equal(p.cm.text, 'kick: s("bd*4")\n\nhats: s("hh*8")\n\npad: note("~")\n\n_arrange("kick,0,8 pad,0,8")\n_roll("x", "")\n');
  assert.match(p.logged.join('\n'), /new track pad/);
});

test('a missing variation of a track that exists makes the track a group, and is a copy of what it played', () => {
  const p = panel({ code: 'keys2: n("0 2").synth("Diva")\n' });
  assert.equal(p.fns.arCreateBlock('keys2#1'), true);
  assert.equal(p.cm.text, 'keys2: group()\n  #main: n("0 2").synth("Diva")\n  #1: n("0 2").synth("Diva")\n',
    'the track is the mixdown; what it played is #main; the new one is a copy of that, nested under it');
  assert.match(p.logged.join('\n'), /keys2 is a group now: what it played is #main/);
});

test('a new variation is written nested under the last of its family, markers off, fold opened', () => {
  const p = panel({ code: '_kick: group()\n  #main: s("mbd*4")\n  .gain(0.8)\n  #fill: s("mbd*8")\n\nhats: s("hh*8")\n' });
  assert.equal(p.fns.arNextVariantName('kick'), '1');
  assert.equal(p.fns.arCreateVariation('kick', '1'), 'kick#1');
  assert.equal(p.cm.text, '_kick: group()\n  #main: s("mbd*4")\n  .gain(0.8)\n  #fill: s("mbd*8")\n  #1: s("mbd*4")\n  .gain(0.8)\n\nhats: s("hh*8")\n',
    'a copy of #main - the base has nothing to copy');
  const [, main, fill, one] = labelsMod.splitLabeledBlocks(p.cm.text);
  assert.deepEqual([main.label, fill.label, one.label, one.nested, one.muted], ['kick#main', 'kick#fill', 'kick#1', true, true],
    'the family reads back - muted by the base, its own marker gone');
  assert.equal(p.fns.arCreateVariation('kick', 'fill'), 'kick#fill', 'one that exists is simply used');
});

test('a family written without group() becomes one when the painter adds to it', () => {
  // Variations of a plain track play directly (see groups.mjs); the painter's rule is that a track
  // with variations is a group, and its first edit to such a family makes it so - sound unchanged.
  const p = panel({ code: 'kick: s("mbd*4")\n  #fill: s("mbd*8")\n' });
  assert.equal(p.fns.arCreateVariation('kick', 'outro', 'kick#fill'), 'kick#outro');
  assert.equal(p.cm.text, 'kick: group()\n  #main: s("mbd*4")\n  #fill: s("mbd*8")\n  #outro: s("mbd*8")\n');
});

test('making a group, panel shut: the clips that named the track name #main, the membership keeps the track', () => {
  const p = panel({ code: 'kick: s("mbd*4").postgain(0.8)\nhats: s("hh*8")\n\n_arrange("kick,0,8 kick,12,4 hats,0,16", { len: 16, tracks: "kick hats" })\n' });
  assert.equal(p.fns.arMakeGroup('kick'), 'kick#main');
  assert.equal(p.cm.text, 'kick: group()\n  #main: s("mbd*4").postgain(0.8)\nhats: s("hh*8")\n\n_arrange("kick#main,0,8 kick#main,12,4 hats,0,16", { len: 16, tracks: "kick hats" })\n');
  assert.deepEqual(p.fns.arGroupLabels(), ['kick']);
  assert.equal(p.fns.arMakeGroup('kick'), null, 'a group already');
  assert.equal(p.fns.arMakeGroup('kick#main'), null, 'a variation is not a track to group');
});

test('making a group, panel open: the panel\'s clips, color and brush follow', () => {
  const st = { ...state(arrangeMod.parseArrangement('kick,0,8 hats,0,8')), tracks: ['kick', 'hats'], colors: { kick: '#ff8800' }, brush: 'kick', track: 'kick' };
  const p = panel({ code: 'kick: s("mbd*4")\nhats: s("hh*8")\n\n_arrange("kick,0,8 hats,0,8", { tracks: "kick hats" })\n', arState: st });
  assert.equal(p.fns.arMakeGroup('kick'), 'kick#main');
  assert.deepEqual(st.clips.map((c) => c.label), ['kick#main', 'hats']);
  assert.equal(st.colors['kick#main'], '#ff8800', 'the same part, in the same color');
  assert.equal(st.colors.kick, '#ff8800', 'and the row keeps it');
  assert.equal(st.brush, 'kick#main');
  assert.deepEqual(st.tracks, ['kick', 'hats'], 'the track is still the row');
});

test('the #main name steps aside for one the family already uses', () => {
  const p = panel({ code: 'kick: s("mbd*4")\n  #main: s("mbd*8")\n' });
  assert.equal(p.fns.arMakeGroup('kick'), 'kick#main2');
  assert.match(p.cm.text, /^kick: group\(\)\n  #main2: s\("mbd\*4"\)\n  #main: /);
});

test('a missing variation of a missing base is a stub under the full name', () => {
  const p = panel({ code: 'hats: s("hh*8")\n' });
  assert.equal(p.fns.arCreateBlock('keys2#1'), true);
  assert.match(p.cm.text, /\n\nkeys2#1: note\("~"\)\n$/);
});

test('an empty buffer gets the stub as its first line', () => {
  const p = panel({ code: '' });
  assert.equal(p.fns.arCreateBlock('pad'), true);
  assert.equal(p.cm.text, 'pad: note("~")\n');
});

// ---------------------------------------------------------------------------------------------
// A base renamed by hand takes its family with it - at the evaluation, once the typing has settled
// ---------------------------------------------------------------------------------------------

const FAMILY_ARR = '\n\n_arrange("kick,0,8 kick#fill,6,2 hats,0,8 kick#outro,8,4")\n';

test('renaming a group by hand carries its tracks and their clips, on the next evaluation', () => {
  const p = panel({ code: FAMILY + FAMILY_ARR });
  p.fns.arFollowHandRenames(); // the evaluation that saw `kick`
  p.cm.text = p.cm.text.replace('kick: s("mbd*4")', 'mainKick: s("mbd*4")'); // the hand edit
  p.fns.arFollowHandRenames(); // the next one
  assert.equal(p.cm.text, [
    'mainKick#fill: s("mbd*8")',
    'setbpm(140)',
    'mainKick: s("mbd*4")',
    'mainKick#outro: s("mbd*4").fx("FilterFreak 1")',
    'hats: s("hh*8")',
    '',
    '_arrange("mainKick,0,8 mainKick#fill,6,2 hats,0,8 mainKick#outro,8,4")',
    '',
  ].join('\n'));
  assert.match(p.logged.join('\n'), /kick is mainKick now - the 2 tracks in it and their clips followed/);
});

test('a hand-renamed group with NESTED tracks: their code needs nothing, their clips follow', () => {
  const nested = 'kick: s("mbd*4")\n  #fill: s("mbd*8")\n  #outro: s("mbd*4").fx("FilterFreak 1")\nhats: s("hh*8")' + FAMILY_ARR;
  const p = panel({ code: nested });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('kick: s("mbd*4")', 'mainKick: s("mbd*4")');
  p.fns.arFollowHandRenames();
  assert.equal(p.cm.text, [
    'mainKick: s("mbd*4")',
    '  #fill: s("mbd*8")', // untouched - the name was never in it
    '  #outro: s("mbd*4").fx("FilterFreak 1")',
    'hats: s("hh*8")',
    '',
    '_arrange("mainKick,0,8 mainKick#fill,6,2 hats,0,8 mainKick#outro,8,4")',
    '',
  ].join('\n'));
  assert.match(p.logged.join('\n'), /kick is mainKick now - the 2 tracks in it and their clips followed/);
});

test('a rename that also changed the body is left alone - it might be a new track', () => {
  const p = panel({ code: FAMILY });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('kick: s("mbd*4")', 'mainKick: s("mbd*2")');
  p.fns.arFollowHandRenames();
  assert.match(p.cm.text, /^kick#fill: /m, 'the family is untouched');
  assert.equal(p.logged.length, 0);
});

test('two new bases with the same body is ambiguous, so nothing moves', () => {
  const p = panel({ code: FAMILY });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('kick: s("mbd*4")', 'a: s("mbd*4")\n\nb: s("mbd*4")');
  p.fns.arFollowHandRenames();
  assert.match(p.cm.text, /^kick#fill: /m);
});

test('the first evaluation has nothing to compare against, and a base without variations is nobody\'s business', () => {
  const p = panel({ code: 'hats: s("hh*8")\n\n_arrange("hats,0,8")\n' });
  p.fns.arFollowHandRenames();
  p.cm.text = p.cm.text.replace('hats:', 'hh:');
  p.fns.arFollowHandRenames();
  assert.match(p.cm.text, /_arrange\("hats,0,8"\)/, 'no family, no follow - the orphan row says so instead');
});

test('the word arrange inside a comment or a string is not a call', () => {
  const p = panel({ code: `// arrange("nope,0,0,4")\nkick: s("bd").fx("Rearrange")\n` });
  assert.equal(p.fns.arMigrateLegacy(), false);
  assert.equal(p.fns.arFindDef(), null);
});
